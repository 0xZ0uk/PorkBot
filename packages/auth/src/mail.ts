import type { TransactionalEmailMessage } from "@porkbot/adapter-kit";
import { emailVerificationTokenExpirySeconds, passwordResetTokenExpirySeconds } from "./config.ts";

/**
 * The two messages auth sends, composed as plain data.
 *
 * Better Auth hands the flow a `url` that already carries the single-use token
 * and the deployment's base URL; the message builders only add the words. Both
 * bodies say what the link is for, how long it lives, and what to do if the
 * recipient did not ask for it — the last line is what turns a misdirected
 * reset into noise instead of a support question.
 *
 * Nothing here logs or returns anything beyond the message; the token is only
 * ever inside the body the provider delivers.
 */

function expiryWords(seconds: number): string {
  return seconds === 60 * 60 ? "one hour" : `${Math.round(seconds / 60)} minutes`;
}

export function passwordResetEmail(to: string, url: string): TransactionalEmailMessage {
  return {
    to,
    subject: "Reset your PorkBot password",
    text:
      "Someone asked to reset the password for this PorkBot address.\n\n" +
      `Open this link to choose a new password: ${url}\n\n` +
      `The link expires in ${expiryWords(passwordResetTokenExpirySeconds)}. ` +
      "If you did not ask, you can ignore this message; the password stays unchanged.",
  };
}

export function verificationEmail(to: string, url: string): TransactionalEmailMessage {
  return {
    to,
    subject: "Verify your PorkBot email",
    text:
      "Confirm this address for your PorkBot account:\n\n" +
      `${url}\n\n` +
      `The link expires in ${expiryWords(emailVerificationTokenExpirySeconds)}.`,
  };
}
