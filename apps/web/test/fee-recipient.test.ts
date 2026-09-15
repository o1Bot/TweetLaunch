import { describe, expect, it } from "vitest";
import { resolveFeeTo, type Account } from "../lib/fee-recipient";

const ALICE: Account = { wallet: "0x1111111111111111111111111111111111111111", xHandle: "alice", xName: "Alice", xAvatarUrl: null };
const BOB: Account = { wallet: "0x2222222222222222222222222222222222222222", xHandle: "bob", xName: null, xAvatarUrl: "https://pbs.twimg.com/bob.jpg" };
const SPLITTER = "0x5555555555555555555555555555555555555555";
const ELSEWHERE = "0x9999999999999999999999999999999999999999";

describe("where a token's creator fees go", () => {
  it("is the creator on a plain launch", () => {
    expect(resolveFeeTo({ creator: ALICE, named: null, splitter: null, pointed: false, onChain: ALICE.wallet })).toMatchObject({ xHandle: "alice", isOther: false, sharePct: null, verified: true });
  });

  it("is the named account on a fees-to launch, matched case-insensitively", () => {
    expect(resolveFeeTo({ creator: ALICE, named: BOB, splitter: null, pointed: true, onChain: BOB.wallet.toUpperCase().replace("0X", "0x") })).toMatchObject({ xHandle: "bob", isOther: true, sharePct: null, verified: true });
  });

  it("shows the recipients' share when the splitter receives the fees", () => {
    expect(resolveFeeTo({ creator: ALICE, named: BOB, splitter: { address: SPLITTER, sharePct: 80 }, pointed: true, onChain: SPLITTER })).toMatchObject({ xHandle: "bob", isOther: true, sharePct: 80, verified: true });
    expect(resolveFeeTo({ creator: ALICE, named: null, splitter: { address: SPLITTER, sharePct: 80 }, pointed: true, onChain: SPLITTER })).toMatchObject({ xHandle: "alice", isOther: false, sharePct: 80 });
  });

  it("follows the chain when the fees still go to the creator or were sent elsewhere on o1", () => {
    expect(resolveFeeTo({ creator: ALICE, named: BOB, splitter: null, pointed: false, onChain: ALICE.wallet })).toMatchObject({ xHandle: "alice", isOther: false, verified: true });
    const moved = resolveFeeTo({ creator: ALICE, named: BOB, splitter: { address: SPLITTER, sharePct: 80 }, pointed: true, onChain: ELSEWHERE });
    expect(moved).toMatchObject({ wallet: ELSEWHERE, xHandle: null, isOther: true, sharePct: null, verified: true });
  });

  it("falls back to the launch record when the chain was not read", () => {
    expect(resolveFeeTo({ creator: ALICE, named: BOB, splitter: { address: SPLITTER, sharePct: 80 }, pointed: true, onChain: null })).toMatchObject({ xHandle: "bob", isOther: true, sharePct: 80, verified: false });
  });

  it("keeps the creator when the transaction naming another account never confirmed", () => {
    expect(resolveFeeTo({ creator: ALICE, named: BOB, splitter: { address: SPLITTER, sharePct: 80 }, pointed: false, onChain: null })).toMatchObject({ xHandle: "alice", isOther: false, sharePct: null, verified: false });
  });
});
