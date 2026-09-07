export type XUser = {
  id: string;
  username: string;
  name: string | null;
  profileImageUrl: string | null;
};

export type XReference = { type: "retweeted" | "quoted" | "replied_to"; id: string; authorId: string | null };

export type XMention = {
  id: string;
  text: string;
  authorId: string;
  authorHandle: string;
  authorName: string | null;
  authorImage: string | null;
  /** First photo attached to the post (full-size URL), if any. */
  imageUrl: string | null;
  createdAt: string | null;
  lang: string | null;
  referenced: XReference[];
};

export type UserLookup = { found: true; user: XUser } | { found: false; reason: "not_found" | "suspended" | "unavailable" };

export interface XClient {
  /** Mentions of the bot newer than `sinceId`, oldest first. */
  fetchMentions(sinceId?: string): Promise<XMention[]>;
  lookupUser(handle: string): Promise<UserLookup>;
  /** Post a reply under a post; returns the new post id. */
  postReply(text: string, inReplyToTweetId: string): Promise<string>;
}

export class XPostError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "XPostError";
  }
  /** X blocks crypto addresses in posts from young accounts. */
  get cryptoAddressBlocked(): boolean {
    return /crypto addresses are prohibited/i.test(this.body);
  }
}

/** X answered 429; `resetAt` (epoch ms) is when the 15-minute window opens again. */
export class XRateLimitError extends Error {
  constructor(
    public readonly endpoint: "mentions" | "post" | "users",
    public readonly resetAt: number,
  ) {
    super(`X rate limit hit on ${endpoint}; resets at ${new Date(resetAt).toISOString()}`);
    this.name = "XRateLimitError";
  }
}
