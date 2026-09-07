import { describe, expect, it } from "vitest";
import { isReservedHandle, normalizeHandle, RESERVED_HANDLES } from "../src/x-handle";

describe("normalizeHandle", () => {
  it("strips @, lowercases, validates", () => {
    expect(normalizeHandle("@Some_One")).toBe("some_one");
    expect(normalizeHandle("  alice ")).toBe("alice");
    expect(normalizeHandle("bad handle")).toBeNull();
    expect(normalizeHandle("toolonghandle_16c")).toBeNull();
    expect(normalizeHandle("")).toBeNull();
  });

  it("flags reserved handles", () => {
    expect(isReservedHandle("@O1bot_Exchange", RESERVED_HANDLES)).toBe(true);
    expect(isReservedHandle("alice", RESERVED_HANDLES)).toBe(false);
  });
});
