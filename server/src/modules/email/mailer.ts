import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Who it comes from, when the caller knows. The address is always the
   * platform's — this names the store beside it, and says where a reply goes.
   * Omitted, the envelope falls back to MAIL_FROM alone, which is what every
   * message looked like before stores could set a sender.
   */
  fromName?: string;
  replyTo?: string | null;
}

/**
 * The bare address out of a configured From, which may already be `Name <a@b>`.
 *
 * Without this, naming a store produced `"Acme" <Returns <a@b>>` — a header no
 * server will accept — because MAIL_FROM is written either way in practice.
 */
export const mailAddress = (from: string): string =>
  from.match(/<([^>]+)>/)?.[1]?.trim() ?? from.trim();

/**
 * `Name <address>`, with anything that could break the header taken out.
 *
 * A quote or a newline in a display name is how a header injection starts, and
 * a store's name is merchant-supplied text.
 */
export const envelopeFrom = (from: string, name?: string): string => {
  const clean = name?.replace(/["\\\r\n]/g, "").trim();
  return clean ? `"${clean}" <${mailAddress(from)}>` : from;
};

const MAIL_DIR = resolve(process.cwd(), ".mail");

let transporter: Transporter | null = null;

const getTransporter = (): Transporter => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      ...(env.SMTP_USER
        ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }
        : {}),
    });
  }
  return transporter;
};

/**
 * Writes the message to server/.mail/ instead of sending it. Used whenever
 * SMTP isn't configured, so local development never silently drops mail and
 * never accidentally emails a real customer.
 */
const writeToDisk = async (mail: Mail): Promise<void> => {
  await mkdir(MAIL_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = mail.subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  const file = resolve(MAIL_DIR, `${stamp}_${slug}.html`);

  // Keep the envelope visible in the file itself so the preview is self-contained.
  const header =
    `<!-- To: ${mail.to}\n     Subject: ${mail.subject}\n` +
    `     From: ${envelopeFrom(env.MAIL_FROM, mail.fromName)}\n` +
    `     Reply-To: ${mail.replyTo ?? "(none)"} -->\n`;
  await writeFile(file, header + mail.html, "utf8");

  logger.info(
    { to: mail.to, subject: mail.subject, file },
    "Email written to disk (SMTP not configured)",
  );
};

/** Why a message didn't go out, when it didn't. */
export interface Delivery {
  delivered: boolean;
  /** SMTP's own words. Carried so the failure is visible without server logs. */
  reason?: string;
}

/**
 * Delivers one message. Resolves rather than throwing when delivery fails — a
 * bounced notification must never roll back the return it describes.
 *
 * The reason comes back with it: a boolean alone meant every failure looked
 * identical in the app, and the only way to tell an unverified sender from a
 * bad password was to go and read the host's logs.
 */
export const sendMail = async (mail: Mail): Promise<Delivery> => {
  try {
    if (!env.smtpConfigured) {
      await writeToDisk(mail);
      return { delivered: true };
    }

    const info = await getTransporter().sendMail({
      from: envelopeFrom(env.MAIL_FROM, mail.fromName),
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });

    logger.info(
      { to: mail.to, subject: mail.subject, messageId: info.messageId },
      "Email sent",
    );
    return { delivered: true };
  } catch (error) {
    /**
     * SMTP errors carry the useful part in `response` — the server's actual
     * reply, like "The domain is not verified". `message` alone is often just
     * the status code.
     */
    const smtp = error as { response?: string; message?: string };
    const reason = (smtp.response ?? smtp.message ?? "unknown error")
      .toString()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);

    logger.error(
      { err: error, to: mail.to, subject: mail.subject, reason },
      "Email delivery failed",
    );
    return { delivered: false, reason };
  }
};
