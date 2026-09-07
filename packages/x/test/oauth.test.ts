import { describe, expect, it } from "vitest";
import { hmacSha1Signature, oauthAuthorizationHeader, percentEncode, signatureBaseString } from "../src/oauth";

/** The worked example from X's "Creating a signature" documentation. */
const creds = {
  consumerKey: "xvz1evFS4wEEPTGEFPHBog",
  consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
  token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
  tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
};
const nonce = "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg";
const timestamp = "1318622958";
const url = "https://api.twitter.com/1.1/statuses/update.json";
const params = { include_entities: "true", status: "Hello Ladies + Gentlemen, a signed OAuth request!" };

describe("OAuth 1.0a", () => {
  it("percent-encodes per RFC 3986", () => {
    expect(percentEncode("Hello Ladies + Gentlemen, a signed OAuth request!")).toBe("Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21");
    expect(percentEncode("a*b'c(d)")).toBe("a%2Ab%27c%28d%29");
  });

  it("reproduces X's documented signature", () => {
    const oauth = {
      oauth_consumer_key: creds.consumerKey,
      oauth_nonce: nonce,
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: timestamp,
      oauth_token: creds.token,
      oauth_version: "1.0",
    };
    const base = signatureBaseString("POST", url, { ...oauth, ...params });
    expect(base.startsWith("POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key")).toBe(true);
    expect(hmacSha1Signature(base, creds.consumerSecret, creds.tokenSecret)).toBe("hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
  });

  it("builds a sorted Authorization header with the signature", () => {
    const header = oauthAuthorizationHeader("POST", url, creds, { params, nonce, timestamp });
    expect(header.startsWith('OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="')).toBe(true);
    expect(header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
    expect(header).toContain('oauth_version="1.0"');
    expect(header).not.toContain("include_entities");
  });
});
