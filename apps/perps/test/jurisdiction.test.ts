import { afterEach, describe, expect, it } from "vitest";
import {
  RESTRICTED_COUNTRIES,
  countryFromHeaders,
  countryName,
  eligibility,
} from "../lib/jurisdiction";

afterEach(() => {
  delete process.env.RESTRICTED_COUNTRIES_EXTRA;
});

describe("eligibility", () => {
  it("blocks every country in the venue's terms", () => {
    for (const code of RESTRICTED_COUNTRIES) {
      expect(eligibility(code)).toEqual({ status: "restricted", country: code });
    }
  });

  it("carries the full list from the terms, not the shorter one in the reference docs", () => {
    // The reference repo listed Switzerland, the UAE and Singapore, which the
    // terms do not restrict, and omitted these, which they do.
    for (const code of ["CN", "KP", "RU", "UA", "CU", "IR", "VE", "SD", "BY", "MM", "SY"]) {
      expect(eligibility(code).status).toBe("restricted");
    }
    for (const code of ["CH", "AE", "SG"]) {
      expect(eligibility(code).status).toBe("allowed");
    }
  });

  it("allows a country the terms do not name", () => {
    expect(eligibility("ID")).toEqual({ status: "allowed", country: "ID" });
  });

  it("is case and whitespace insensitive", () => {
    expect(eligibility(" us ").status).toBe("restricted");
    expect(eligibility("id").status).toBe("allowed");
  });

  it("reports unknown rather than guessing", () => {
    // No header locally, a malformed value, or Vercel's placeholder.
    for (const v of [null, undefined, "", "U", "USA", "XX"]) {
      expect(eligibility(v).status).toBe("unknown");
    }
  });

  it("takes extra codes from the environment without a deploy", () => {
    process.env.RESTRICTED_COUNTRIES_EXTRA = "sg, ae";
    expect(eligibility("SG").status).toBe("restricted");
    expect(eligibility("AE").status).toBe("restricted");
    expect(eligibility("ID").status).toBe("allowed");
  });
});

describe("countryFromHeaders", () => {
  it("reads the edge header", () => {
    expect(countryFromHeaders(new Headers({ "x-vercel-ip-country": "ID" }))).toBe("ID");
  });

  it("falls back to the Cloudflare header, then null", () => {
    expect(countryFromHeaders(new Headers({ "cf-ipcountry": "DE" }))).toBe("DE");
    expect(countryFromHeaders(new Headers())).toBeNull();
  });
});

describe("countryName", () => {
  it("names the restricted ones and passes anything else through", () => {
    expect(countryName("GB")).toBe("the United Kingdom");
    expect(countryName("kp")).toBe("North Korea");
    expect(countryName("ID")).toBe("ID");
  });
});
