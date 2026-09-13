import { describe, expect, it } from "vitest";
import { GATEWAY_HOSTS } from "../lib/ipfs";
import { isAllowedImageUrl } from "../lib/image-policy";

describe("token card image fetches", () => {
  it("allow https on the site's IPFS gateways only", () => {
    for (const host of GATEWAY_HOSTS) expect(isAllowedImageUrl(`https://${host}/ipfs/bafkreiabc`)).toBe(true);
    expect(isAllowedImageUrl("https://gateway.pinata.cloud/ipfs/bafkreiabc")).toBe(true);
  });

  it("refuse everything a launch could point the server at", () => {
    expect(isAllowedImageUrl("http://gateway.pinata.cloud/ipfs/bafkreiabc")).toBe(false);
    expect(isAllowedImageUrl("https://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowedImageUrl("http://127.0.0.1:3000/api/health")).toBe(false);
    expect(isAllowedImageUrl("https://internal-service.local:8080/admin")).toBe(false);
    expect(isAllowedImageUrl("https://evil.example/ipfs/bafkreiabc")).toBe(false);
    expect(isAllowedImageUrl("https://gateway.pinata.cloud.evil.example/ipfs/x")).toBe(false);
    expect(isAllowedImageUrl("ipfs://bafkreiabc")).toBe(false);
    expect(isAllowedImageUrl("not a url")).toBe(false);
  });
});
