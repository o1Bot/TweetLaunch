import { logger, normalizeHandle, requireEnv } from "@o1bot/shared";
import { oauthAuthorizationHeader, type OAuthCredentials } from "./oauth";
import { XPostError, XRateLimitError, type UserLookup, type XClient, type XMention, type XReference, type XUser } from "./types";

const API = "https://api.x.com";
/** Pages of 100 mentions followed per poll; more than this in one interval is not a real-world case. */
const MAX_MENTION_PAGES = 5;

/** `x-rate-limit-reset` is epoch seconds; fall back to a short wait when the header is missing. */
function resetAtFromHeaders(headers: Headers): number {
  const raw = Number(headers.get("x-rate-limit-reset"));
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : Date.now() + 60_000;
}

type TweetJson = {
  id: string;
  text: string;
  author_id: string;
  created_at?: string;
  lang?: string;
  attachments?: { media_keys?: string[] };
  referenced_tweets?: Array<{ type: "retweeted" | "quoted" | "replied_to"; id: string }>;
};
type UserJson = { id: string; username: string; name?: string; profile_image_url?: string };
type MediaJson = { media_key: string; type: string; url?: string; preview_image_url?: string };
type MentionsJson = {
  data?: TweetJson[];
  includes?: { users?: UserJson[]; media?: MediaJson[]; tweets?: TweetJson[] };
  meta?: { newest_id?: string; result_count?: number; next_token?: string };
};

/** Real X API v2 client. Reads with the app Bearer token, writes with OAuth 1.0a user context. */
export class HttpXClient implements XClient {
  private readonly bearer: string;
  private readonly botUserId: string;
  private creds: OAuthCredentials | null = null;

  constructor() {
    this.bearer = requireEnv("X_BEARER_TOKEN");
    this.botUserId = requireEnv("X_BOT_USER_ID");
  }

  private oauth(): OAuthCredentials {
    if (!this.creds) {
      this.creds = {
        consumerKey: requireEnv("X_APP_KEY"),
        consumerSecret: requireEnv("X_APP_SECRET"),
        token: requireEnv("X_APP_ACCESS_TOKEN"),
        tokenSecret: requireEnv("X_APP_ACCESS_TOKEN_SECRET"),
      };
    }
    return this.creds;
  }

  /**
   * Mentions newer than `sinceId`. X returns newest first, 100 per page; every
   * page is followed (bounded) so a burst larger than one page is never
   * skipped when the cursor advances to the newest id.
   */
  async fetchMentions(sinceId?: string): Promise<XMention[]> {
    const out: XMention[] = [];
    let paginationToken: string | undefined;
    for (let page = 0; page < MAX_MENTION_PAGES; page++) {
      const json = await this.mentionsPage(sinceId, paginationToken);
      out.push(...this.toMentions(json));
      paginationToken = json.meta?.next_token;
      if (!paginationToken || (json.data?.length ?? 0) === 0) break;
    }
    // Oldest first so the cursor only ever moves forward.
    return out.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

  private async mentionsPage(sinceId: string | undefined, paginationToken: string | undefined): Promise<MentionsJson> {
    const params = new URLSearchParams({
      max_results: "100",
      "tweet.fields": "author_id,created_at,entities,attachments,referenced_tweets,lang",
      expansions: "author_id,attachments.media_keys,referenced_tweets.id",
      "user.fields": "username,name,profile_image_url",
      "media.fields": "url,preview_image_url,type",
    });
    if (sinceId) params.set("since_id", sinceId);
    if (paginationToken) params.set("pagination_token", paginationToken);
    const res = await fetch(`${API}/2/users/${this.botUserId}/mentions?${params}`, {
      headers: { Authorization: `Bearer ${this.bearer}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429) throw new XRateLimitError("mentions", resetAtFromHeaders(res.headers));
    if (!res.ok) throw new Error(`mentions HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    return (await res.json()) as MentionsJson;
  }

  private toMentions(json: MentionsJson): XMention[] {
    const users = new Map((json.includes?.users ?? []).map((u) => [u.id, u]));
    const media = new Map((json.includes?.media ?? []).map((m) => [m.media_key, m]));
    const tweets = new Map((json.includes?.tweets ?? []).map((t) => [t.id, t]));
    return (json.data ?? []).map((t): XMention => {
      let imageUrl: string | null = null;
      for (const key of t.attachments?.media_keys ?? []) {
        const m = media.get(key);
        const url = m?.type === "photo" ? m.url : m?.preview_image_url;
        if (url) {
          imageUrl = url;
          break;
        }
      }
      const referenced: XReference[] = (t.referenced_tweets ?? []).map((r) => ({ type: r.type, id: r.id, authorId: tweets.get(r.id)?.author_id ?? null }));
      const author = users.get(t.author_id);
      return {
        id: t.id,
        text: t.text,
        authorId: t.author_id,
        authorHandle: author?.username ?? "",
        authorName: author?.name ?? null,
        authorImage: author?.profile_image_url ?? null,
        imageUrl,
        createdAt: t.created_at ?? null,
        lang: t.lang ?? null,
        referenced,
      };
    });
  }

  async lookupUser(handle: string): Promise<UserLookup> {
    const clean = normalizeHandle(handle);
    if (!clean) return { found: false, reason: "not_found" };
    let res: Response;
    try {
      res = await fetch(`${API}/2/users/by/username/${encodeURIComponent(clean)}?user.fields=profile_image_url`, {
        headers: { Authorization: `Bearer ${this.bearer}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return { found: false, reason: "unavailable" };
    }
    if (!res.ok) {
      logger.warn({ handle: clean, status: res.status }, "user lookup failed");
      return { found: false, reason: "unavailable" };
    }
    const json = (await res.json()) as { data?: UserJson; errors?: Array<{ title?: string; detail?: string }> };
    if (json.data?.id) {
      const user: XUser = { id: json.data.id, username: json.data.username, name: json.data.name ?? null, profileImageUrl: json.data.profile_image_url ?? null };
      return { found: true, user };
    }
    const detail = (json.errors ?? []).map((e) => `${e.title ?? ""} ${e.detail ?? ""}`).join(" ");
    return { found: false, reason: /suspend/i.test(detail) ? "suspended" : "not_found" };
  }

  async postReply(text: string, inReplyToTweetId: string): Promise<string> {
    const url = `${API}/2/tweets`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: oauthAuthorizationHeader("POST", url, this.oauth()), "Content-Type": "application/json" },
      body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: inReplyToTweetId } }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.text().catch(() => "");
    if (res.status === 429) throw new XRateLimitError("post", resetAtFromHeaders(res.headers));
    if (!res.ok) throw new XPostError(`post reply HTTP ${res.status}`, res.status, body.slice(0, 500));
    const json = JSON.parse(body) as { data?: { id: string } };
    return json.data?.id ?? "";
  }
}

/** In-memory client for tests and dry runs: feeds scripted mentions, records replies. */
export class FakeXClient implements XClient {
  replies: Array<{ text: string; inReplyTo: string }> = [];
  users = new Map<string, XUser>();
  constructor(private mentions: XMention[] = []) {}

  push(...mentions: XMention[]) {
    this.mentions.push(...mentions);
  }
  async fetchMentions(sinceId?: string): Promise<XMention[]> {
    return this.mentions.filter((m) => !sinceId || BigInt(m.id) > BigInt(sinceId)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }
  async lookupUser(handle: string): Promise<UserLookup> {
    const clean = normalizeHandle(handle);
    const user = clean ? this.users.get(clean) : undefined;
    return user ? { found: true, user } : { found: false, reason: "not_found" };
  }
  async postReply(text: string, inReplyToTweetId: string): Promise<string> {
    this.replies.push({ text, inReplyTo: inReplyToTweetId });
    return `reply-${this.replies.length}`;
  }
}
