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
}

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
    `     From: ${env.MAIL_FROM} -->\n`;
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
      from: env.MAIL_FROM,
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
