import type { TransactionalEmailProvider } from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { MailEmulator } from "./mail-emulator.ts";

describe("the mail emulator", () => {
  it("is a transactional email provider", () => {
    const provider: TransactionalEmailProvider = new MailEmulator();

    expect(typeof provider.send).toBe("function");
  });

  it("delivers to the mailbox and returns deterministic receipt ids", async () => {
    const mail = new MailEmulator();

    const first = await mail.send({
      to: "operator@example.invalid",
      subject: "Reset your PorkBot password",
      text: "Open https://bots.example.invalid/reset?token=abc",
    });
    const second = await mail.send({
      to: "operator@example.invalid",
      subject: "Verify your PorkBot email",
      text: "Confirm with https://bots.example.invalid/verify?token=def",
    });

    expect(first.id).toBe("mail-1");
    expect(second.id).toBe("mail-2");
    expect(mail.size).toBe(2);
    expect(mail.mailbox.map((message) => message.sequence)).toEqual([1, 2]);
    expect(mail.mailbox.map((message) => message.id)).toEqual(["mail-1", "mail-2"]);
  });

  it("keeps the message the caller composed, including an optional HTML part", async () => {
    const mail = new MailEmulator();

    await mail.send({
      to: "operator@example.invalid",
      subject: "Verify your PorkBot email",
      text: "plain",
      html: "<p>rich</p>",
    });

    const message = mail.lastMessage();

    expect(message).toMatchObject({
      id: "mail-1",
      sequence: 1,
      to: "operator@example.invalid",
      subject: "Verify your PorkBot email",
      text: "plain",
      html: "<p>rich</p>",
    });
  });

  it("filters by recipient without caring about case or surrounding spaces", async () => {
    const mail = new MailEmulator();

    await mail.send({ to: "Operator@Example.invalid", subject: "first", text: "one" });
    await mail.send({ to: "other@example.invalid", subject: "second", text: "two" });
    await mail.send({ to: " operator@example.invalid ", subject: "third", text: "three" });

    expect(mail.messagesTo("operator@example.invalid").map((message) => message.subject)).toEqual([
      "first",
      "third",
    ]);
    expect(mail.messagesTo("nobody@example.invalid")).toEqual([]);
    expect(mail.lastMessageTo("OPERATOR@EXAMPLE.INVALID")?.subject).toBe("third");
    expect(mail.lastMessage()?.subject).toBe("third");
  });

  it("starts empty and clears back to a deterministic start", async () => {
    const mail = new MailEmulator();

    expect(mail.lastMessage()).toBeUndefined();
    expect(mail.size).toBe(0);

    await mail.send({ to: "operator@example.invalid", subject: "first", text: "one" });
    mail.clear();

    expect(mail.mailbox).toEqual([]);
    expect(mail.size).toBe(0);

    const afterClear = await mail.send({
      to: "operator@example.invalid",
      subject: "second",
      text: "two",
    });

    expect(afterClear.id).toBe("mail-1");
    expect(mail.lastMessageTo("operator@example.invalid")?.subject).toBe("second");
  });
});
