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

/**
 * Delivers one message. Resolves false rather than throwing when delivery
 * fails — a bounced notification must never roll back the return it describes.
 */
export const sendMail = async (mail: Mail): Promise<boolean> => {
  try {
    if (!env.smtpConfigured) {
      await writeToDisk(mail);
      return true;
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
    return true;
  } catch (error) {
    logger.error(
      { err: error, to: mail.to, subject: mail.subject },
      "Email delivery failed",
    );
    return false;
  }
};
