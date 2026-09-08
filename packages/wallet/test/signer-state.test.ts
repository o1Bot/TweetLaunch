import { describe, expect, it } from "vitest";
import { signerState } from "../src/resolve";

const SIGNER = "keo2vpo4au3jibhquiox7s3q";
const POLICY = "tb54eps4z44ed0jepousxi4n";

describe("signerState", () => {
  it("is not granted when the signer is absent", () => {
    expect(signerState({ additionalSigners: [] }, SIGNER, POLICY)).toEqual({ granted: false, stale: false });
    expect(signerState({ additionalSigners: [{ signerId: "someone-else", overridePolicyIds: [POLICY] }] }, SIGNER, POLICY)).toEqual({ granted: false, stale: false });
  });

  it("is granted only when the signer carries the required policy", () => {
    expect(signerState({ additionalSigners: [{ signerId: SIGNER, overridePolicyIds: [POLICY] }] }, SIGNER, POLICY)).toEqual({ granted: true, stale: false });
  });

  it("marks a signer granted before the policy existed as stale, not granted", () => {
    expect(signerState({ additionalSigners: [{ signerId: SIGNER }] }, SIGNER, POLICY)).toEqual({ granted: false, stale: true });
    expect(signerState({ additionalSigners: [{ signerId: SIGNER, overridePolicyIds: ["another-policy"] }] }, SIGNER, POLICY)).toEqual({ granted: false, stale: true });
  });

  it("accepts any grant while no policy is configured", () => {
    expect(signerState({ additionalSigners: [{ signerId: SIGNER }] }, SIGNER, null)).toEqual({ granted: true, stale: false });
  });

  it("treats the signer owning the wallet as granted", () => {
    expect(signerState({ ownerId: SIGNER, additionalSigners: [] }, SIGNER, POLICY)).toEqual({ granted: true, stale: false });
  });
});
