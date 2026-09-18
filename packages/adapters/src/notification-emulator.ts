import type {
  NotificationProvider,
  NotificationReceipt,
  OperatorNotification,
} from "@porkbot/adapter-kit";

/**
 * The offline notification emulator: the delivery path the product runs on
 * with nothing configured.
 *
 * It is deterministic on purpose. Sequence numbers start at one and carry no
 * timestamp, random id or clock value, so the same deliveries produce the same
 * receipts and a test can assert the mailbox by position. Delivery always
 * succeeds — there is no network and no key to be missing — so the flows that
 * notify an operator are exercisable with no vendor anywhere in the process.
 *
 * The delivered record is built field by field from the three fields the
 * interface names, never spread from the caller's object: a notification that
 * somehow carries a credential or a raw tool argument beside the title and body
 * is dropped here, exactly as the HTTP provider's request body drops it. The
 * mailbox is the second half of the interface — tests read `last()`,
 * `deliveries()` and `clear()` between cases, the way the mail emulator's
 * mailbox is read.
 */
export interface DeliveredNotification extends OperatorNotification {
  /** The receipt id, `notification-1`, `notification-2`, ... */
  readonly id: string;
  /** 1-based position in the mailbox, matching the receipt. */
  readonly sequence: number;
}

export class NotificationEmulator implements NotificationProvider {
  readonly #delivered: DeliveredNotification[] = [];
  #nextSequence = 1;

  /** Everything delivered so far, oldest first. */
  get mailbox(): readonly DeliveredNotification[] {
    return this.#delivered;
  }

  /** How many notifications the mailbox holds. */
  get size(): number {
    return this.#delivered.length;
  }

  deliver(notification: OperatorNotification): Promise<NotificationReceipt> {
    const sequence = this.#nextSequence;
    this.#nextSequence += 1;

    const id = `notification-${sequence}`;
    const delivered: DeliveredNotification = {
      title: notification.title,
      body: notification.body,
      ...(notification.url === undefined ? {} : { url: notification.url }),
      id,
      sequence,
    };

    this.#delivered.push(delivered);

    return Promise.resolve({ id });
  }

  /** The most recent delivery, or `undefined` when the mailbox is empty. */
  last(): DeliveredNotification | undefined {
    return this.#delivered.at(-1);
  }

  /** Every delivery, oldest first. */
  deliveries(): readonly DeliveredNotification[] {
    return this.#delivered;
  }

  /** Empty the mailbox and restart the sequence, for the next test. */
  clear(): void {
    this.#delivered.length = 0;
    this.#nextSequence = 1;
  }
}
