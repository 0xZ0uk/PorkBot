export const moduleInfo = {
  name: "@porkbot/adapter-kit",
  summary: "Provider interfaces and types only. No implementations.",
} as const;

// The transactional mail seam: password reset and verification depend on this,
// so the auth gate names no SMTP client and no vendor (PRD module map). The
// implementations and the offline mailbox emulator live in @porkbot/adapters
// (slice 3.5).
export type {
  TransactionalEmailMessage,
  TransactionalEmailProvider,
  TransactionalEmailReceipt,
} from "./mail.ts";

// The credential seam every provider implementation resolves its secrets
// through (slice 3.5). Declared here, implemented in @porkbot/adapters, so a
// provider's key is never a hard-coded environment read in provider code.
export type { CredentialStore } from "./credentials.ts";
