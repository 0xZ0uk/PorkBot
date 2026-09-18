export const moduleInfo = {
  name: "@porkbot/adapter-kit",
  summary: "Provider interfaces and types only. No implementations.",
} as const;

// The transactional mail seam: password reset and verification depend on this,
// so the auth gate names no SMTP client and no vendor (PRD module map). The
// implementations and the offline mailbox emulator land in @porkbot/adapters
// with slice 3.5.
export type {
  TransactionalEmailMessage,
  TransactionalEmailProvider,
  TransactionalEmailReceipt,
} from "./mail.ts";
