import { describe, expect, test } from "bun:test";
import { isSensitiveTarget } from "./eventPolicy.ts";

describe("stake.com targets: harmless controls mirror, money and login never do", () => {
  const allowed = [
    { tag: "a", text: "Stake Originals", href: "https://stake.com/casino/group/stake-originals" },
    { tag: "a", text: "Stake", name: "Stake home" },
    { tag: "button", role: "tab", text: "My Bets" },
    { tag: "button", role: "tab", text: "All Bets" },
    { tag: "a", text: "Casino", href: "https://stake.com/casino/home" },
    { tag: "button", text: "Promotions" },
    { tag: "button", name: "Open menu" },
    { tag: "a", text: "Slots" },
  ];
  const blocked = [
    { tag: "button", text: "Place Bet" },
    { tag: "button", text: "Bet" + " Slip" },
    { tag: "input", type: "text", placeholder: "Bet Amount" },
    { tag: "input", type: "text", name: "stake-amount" },
    { tag: "button", text: "Cash Out" },
    { tag: "button", text: "Auto Bet" },
    { tag: "button", text: "Wallet" },
    { tag: "button", text: "Deposit" },
    { tag: "button", text: "Withdraw" },
    { tag: "button", text: "Sign In" },
    { tag: "input", type: "text", name: "promo code" },
    { tag: "button", text: "Tip" },
  ];
  for (const target of allowed) test(`mirrors ${target.text ?? target.name}`, () => expect(isSensitiveTarget(target)).toBe(false));
  for (const target of blocked) test(`keeps ${target.text ?? target.placeholder ?? target.name} manual`, () => expect(isSensitiveTarget(target)).toBe(true));
});

import { validateActionPacket } from "./eventPolicy.ts";
describe("hover and Escape mirroring", () => {
  const base = { type: "ACTION", id: "event_000001", seq: 1, epoch: 3, origin: "https://stake.com", url: "https://stake.com/casino/home" };
  const ctx = { origins: ["https://stake.com"], epoch: 3 };
  test("Escape is mirrored", () => expect(validateActionPacket({ ...base, action: "key", value: "Escape" }, ctx).ok).toBe(true));
  test("other keys are not", () => { for (const value of ["Enter", "a", " ", "Tab"]) expect(validateActionPacket({ ...base, action: "key", value }, ctx).ok).toBe(false); });
  test("hover on a menu control is mirrored", () => expect(validateActionPacket({ ...base, action: "hover", selector: "button[aria-label=\"Menu\"]", fingerprint: { tag: "button", name: "Menu" } }, ctx).ok).toBe(true));
  test("hover never targets money controls", () => expect(validateActionPacket({ ...base, action: "hover", selector: "button[aria-label=\"Wallet\"]", fingerprint: { tag: "button", name: "Wallet" } }, ctx).ok).toBe(false));
});
