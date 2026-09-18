import type {
  TransactionalEmailMessage,
  TransactionalEmailProvider,
  TransactionalEmailReceipt,
} from "@porkbot/adapter-kit";

/**
 * The offline mailbox emulator: the transactional mail provider tests read.
 *
 * It is deterministic on purpose. Sequence numbers start at one and carry no
 * timestamp, random id or clock value, so the same sends produce the same
 * receipts and a test can assert the mailbox by position instead of by waiting
 * or by pattern-matching an unknown format. Delivery always succeeds — there is
 * no network and no key to be missing — so the emulator exercises the flows that
 * consume mail without a vendor anywhere in the process.
 *
 * The mailbox is the second half of the interface: auth suites call
 * `lastMessage()`/`lastMessageTo()` to pull the reset or verification link out
 * of the body the flow composed, and `clear()` between tests so one test's mail
 * cannot satisfy another's assertion.
 */
export interface DeliveredMail extends TransactionalEmailMessage {
  /** The receipt id, `mail-1`, `mail-2`, ... */
  readonly id: string;
  /** 1-based position in the mailbox, matching the receipt. */
  readonly sequence: number;
}

export class MailEmulator implements TransactionalEmailProvider {
  readonly #delivered: DeliveredMail[] = [];
  #nextSequence = 1;

  /** Everything delivered so far, oldest first. */
  get mailbox(): readonly DeliveredMail[] {
    return this.#delivered;
  }

  /** How many messages the mailbox holds. */
  get size(): number {
    return this.#delivered.length;
  }

  send(message: TransactionalEmailMessage): Promise<TransactionalEmailReceipt> {
    const sequence = this.#nextSequence;
    this.#nextSequence += 1;

    const delivered: DeliveredMail = { ...message, id: `mail-${sequence}`, sequence };

    this.#delivered.push(delivered);

    return Promise.resolve({ id: delivered.id });
  }

  /** The messages addressed to one recipient, compared case-insensitively. */
  messagesTo(address: string): readonly DeliveredMail[] {
    const wanted = address.trim().toLowerCase();

    return this.#delivered.filter((mail) => mail.to.trim().toLowerCase() === wanted);
  }

  /** The most recent message, or `undefined` when the mailbox is empty. */
  lastMessage(): DeliveredMail | undefined {
    return this.#delivered.at(-1);
  }

  /** The most recent message to one recipient, or `undefined`. */
  lastMessageTo(address: string): DeliveredMail | undefined {
    return this.messagesTo(address).at(-1);
  }

  /** Empty the mailbox and restart the sequence, for the next test. */
  clear(): void {
    this.#delivered.length = 0;
    this.#nextSequence = 1;
  }
}
