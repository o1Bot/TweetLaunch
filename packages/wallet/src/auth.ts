import { privy } from "./privy";
import { findUserByPrivyId } from "./resolve";
import type { LinkedUser } from "./types";

/** Pull a Privy access token from `Authorization: Bearer …`. */
export function bearerToken(headers: Headers): string | null {
  const raw = headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1]?.trim() || null;
}

export async function verifyAccessToken(token: string): Promise<{ privyUserId: string; sessionId: string }> {
  const claims = await privy().verifyAuthToken(token);
  return { privyUserId: claims.userId, sessionId: claims.sessionId };
}

/** Resolve the calling user from a request, or null when unauthenticated. */
export async function userFromRequest(req: Request): Promise<LinkedUser | null> {
  const token = bearerToken(req.headers);
  if (!token) return null;
  try {
    const { privyUserId } = await verifyAccessToken(token);
    return await findUserByPrivyId(privyUserId);
  } catch {
    return null;
  }
}
