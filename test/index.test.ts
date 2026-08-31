import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { collectOnce, normalizeStatus, syncFollowingPage } from "../src/index";

const db = env.DB;
const runtimeEnv = { DB: db, SOURCE_HANDLE: "" };

beforeAll(async () => {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY, url TEXT NOT NULL, text TEXT NOT NULL, created_timestamp INTEGER NOT NULL,
      likes INTEGER NOT NULL DEFAULT 0, reposts INTEGER NOT NULL DEFAULT 0, quotes INTEGER NOT NULL DEFAULT 0,
      replies INTEGER NOT NULL DEFAULT 0, author_id TEXT NOT NULL, author_screen_name TEXT NOT NULL,
      author_name TEXT NOT NULL, quote_json TEXT, source_kind TEXT NOT NULL, source_key TEXT NOT NULL,
      collected_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, handle TEXT NOT NULL, name TEXT NOT NULL,
      protected INTEGER NOT NULL DEFAULT 0, last_post_timestamp INTEGER, last_checked_at TEXT, sync_marker TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS search_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1, last_checked_at TEXT
    )`),
    db.prepare("CREATE TABLE IF NOT EXISTS collector_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"),
  ]);
});

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM posts"),
    db.prepare("DELETE FROM accounts"),
    db.prepare("DELETE FROM search_queries"),
    db.prepare("DELETE FROM collector_state"),
  ]);
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("FxEmbed collector", () => {
  it("normalizes a status and keeps quote data as an object", () => {
    const status = normalizeStatus({
      id: "100",
      url: "https://x.com/alice/status/100",
      text: "本文",
      created_timestamp: 1_700_000_000,
      likes: 2,
      reposts: 3,
      quotes: 4,
      replies: 5,
      author: { id: "a", screen_name: "alice", name: "Alice" },
      quote: { id: "99", text: "引用本文" },
    });
    expect(status?.quote).toEqual({ id: "99", text: "引用本文" });
    expect(status?.isReply).toBe(false);
    expect(normalizeStatus({ ...status, created_timestamp: 1e100 })).toBeNull();
  });

  it("collects accounts and queries, excludes replies, and checkpoints each source", async () => {
    await db.prepare("INSERT INTO accounts (id, handle, name, last_post_timestamp) VALUES (?, ?, ?, ?)").bind("a", "alice", "Alice", 1_699_999_900).run();
    await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("cloudflare").run();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(new Headers(init?.headers).get("user-agent")).toContain("rss-curator");
      const url = String(input);
      const parsed = new URL(url);
      if (parsed.pathname === "/2/profile/alice/statuses") {
        expect(parsed.searchParams.get("since")).toBe("1699999900");
        expect(parsed.searchParams.get("with_replies")).toBeNull();
        return new Response(JSON.stringify({ code: 200, results: { timeline: [
          { id: "1", url: "https://x.com/alice/status/1", text: "投稿", created_timestamp: 1_700_000_000, author: { id: "a", screen_name: "alice", name: "Alice" } },
          { id: "2", url: "https://x.com/alice/status/2", text: "返信", created_timestamp: 1_700_000_001, replying_to: "1", author: { id: "a", screen_name: "alice", name: "Alice" } },
        ] }, cursor: { bottom: null } }));
      }
      if (parsed.pathname === "/2/search") {
        expect(parsed.searchParams.get("feed")).toBe("latest");
        return new Response(JSON.stringify({ code: 200, results: { timeline: [
          { id: "1", url: "https://x.com/alice/status/1", text: "重複検索結果", created_timestamp: 1_700_000_000, author: { id: "a", screen_name: "alice", name: "Alice" } },
          { id: "3", url: "https://x.com/bob/status/3", text: "検索結果", created_timestamp: 1_700_000_002, author: { id: "b", screen_name: "bob", name: "Bob" }, quote: { id: "2", text: "引用" } },
        ] }, cursor: { bottom: null } }));
      }
      return new Response("not found", { status: 404 });
    });

    const result = await collectOnce(runtimeEnv, 1_700_000_100_000);
    expect(result).toEqual({ following: false, accounts: 1, queries: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const posts = await db.prepare("SELECT id, quote_json FROM posts ORDER BY id").all<{ id: string; quote_json: string | null }>();
    expect(posts.results.map((post) => post.id)).toEqual(["1", "3"]);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts WHERE id = ?").bind("1").first<{ count: number }>())?.count).toBe(1);
    expect(JSON.parse(posts.results[1].quote_json ?? "null")).toEqual({ id: "2", text: "引用" });
    expect((await db.prepare("SELECT last_post_timestamp FROM accounts WHERE id = ?").bind("a").first<{ last_post_timestamp: number }>())?.last_post_timestamp).toBe(1_700_000_001);
    expect((await db.prepare("SELECT last_checked_at FROM accounts WHERE id = ?").bind("a").first<{ last_checked_at: string }>())?.last_checked_at).toBe("2023-11-14T22:15:00.000Z");
    expect((await db.prepare("SELECT last_checked_at FROM search_queries WHERE query = ?").bind("cloudflare").first<{ last_checked_at: string }>())?.last_checked_at).toBe("2023-11-14T22:15:00.000Z");
  });

  it("keeps old following accounts until the final cursor page succeeds", async () => {
    await db.prepare("INSERT INTO accounts (id, handle, name) VALUES (?, ?, ?)").bind("old", "old", "Old").run();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/profile/source/following");
      expect(parsed.searchParams.get("count")).toBe("100");
      expect(parsed.searchParams.get("cursor")).toBeNull();
      return new Response(JSON.stringify({ results: { users: [{ id: "a", screen_name: "alice", name: "Alice" }] }, cursor: { bottom: "next" } }));
    });
    await syncFollowingPage(db, "source", 1_700_000_100_000);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM accounts").first<{ count: number }>())?.count).toBe(2);
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("following_cursor").first<{ value: string }>())?.value).toBe("next");

    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/profile/source/following");
      expect(parsed.searchParams.get("cursor")).toBe("next");
      return new Response(JSON.stringify({ results: { users: [{ id: "b", screen_name: "bob", name: "Bob", protected: true }] }, cursor: { bottom: null } }));
    });
    await syncFollowingPage(db, "source", 1_700_000_101_000);
    expect((await db.prepare("SELECT handle FROM accounts ORDER BY handle").all<{ handle: string }>()).results.map((row) => row.handle)).toEqual(["alice", "bob"]);
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("following_sync_at").first<{ value: string }>())?.value).toBe("2023-11-14T22:15:01.000Z");
  });

  it("resumes account status pagination with its fixed since checkpoint", async () => {
    await db.prepare("INSERT INTO accounts (id, handle, name, last_post_timestamp) VALUES (?, ?, ?, ?)").bind("a", "alice", "Alice", 1_699_999_900).run();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/profile/alice/statuses");
      expect(parsed.searchParams.get("since")).toBe("1699999900");
      expect(parsed.searchParams.get("cursor")).toBeNull();
      return new Response(JSON.stringify({ results: { timeline: [
        { id: "new", url: "https://x.com/alice/status/new", text: "新着", created_timestamp: 1_700_000_000, author: { id: "a", screen_name: "alice", name: "Alice" } },
      ] }, cursor: { bottom: "page-2" } }));
    });

    await collectOnce(runtimeEnv, 1_700_000_100_000);
    expect((await db.prepare("SELECT last_post_timestamp FROM accounts WHERE id = ?").bind("a").first<{ last_post_timestamp: number }>())?.last_post_timestamp).toBe(1_699_999_900);
    expect(JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("account_status:a").first<{ value: string }>())?.value ?? "null")).toEqual({
      cursor: "page-2",
      since: 1_699_999_900,
      latest: 1_700_000_000,
    });

    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/profile/alice/statuses");
      expect(parsed.searchParams.get("cursor")).toBe("page-2");
      expect(parsed.searchParams.get("since")).toBe("1699999900");
      return new Response(JSON.stringify({ results: { timeline: [
        { id: "older", url: "https://x.com/alice/status/older", text: "過去", created_timestamp: 1_699_999_950, author: { id: "a", screen_name: "alice", name: "Alice" } },
      ] }, cursor: { bottom: null } }));
    });

    await collectOnce(runtimeEnv, 1_700_000_101_000);
    expect((await db.prepare("SELECT last_post_timestamp FROM accounts WHERE id = ?").bind("a").first<{ last_post_timestamp: number }>())?.last_post_timestamp).toBe(1_700_000_000);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM collector_state WHERE key = ?").bind("account_status:a").first<{ count: number }>())?.count).toBe(0);
    expect((await db.prepare("SELECT id FROM posts ORDER BY id").all<{ id: string }>()).results.map((post) => post.id)).toEqual(["new", "older"]);
  });

  it("keeps an account status cursor unchanged when its next page fails", async () => {
    await db.prepare("INSERT INTO accounts (id, handle, name, last_post_timestamp) VALUES (?, ?, ?, ?)").bind("a", "alice", "Alice", 1_699_999_900).run();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: [
        { id: "new", url: "https://x.com/alice/status/new", text: "新着", created_timestamp: 1_700_000_000, author: { id: "a", screen_name: "alice", name: "Alice" } },
      ] }, cursor: { bottom: "page-2" } })))
      .mockResolvedValueOnce(new Response("upstream failed", { status: 500 }));

    await collectOnce(runtimeEnv, 1_700_000_100_000);
    await collectOnce(runtimeEnv, 1_700_000_101_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await db.prepare("SELECT last_post_timestamp FROM accounts WHERE id = ?").bind("a").first<{ last_post_timestamp: number }>())?.last_post_timestamp).toBe(1_699_999_900);
    expect(JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("account_status:a").first<{ value: string }>())?.value ?? "null")).toMatchObject({ cursor: "page-2" });
  });

  it("continues an in-progress following sync and waits 24 hours after completion", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { users: [] }, cursor: { bottom: "next" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { users: [] }, cursor: { bottom: null } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { users: [] }, cursor: { bottom: null } })));

    const start = 1_700_000_100_000;
    expect((await collectOnce({ DB: db, SOURCE_HANDLE: "source" }, start)).following).toBe(true);
    expect((await collectOnce({ DB: db, SOURCE_HANDLE: "source" }, start + 60 * 60 * 1000)).following).toBe(true);
    expect((await collectOnce({ DB: db, SOURCE_HANDLE: "source" }, start + 2 * 60 * 60 * 1000)).following).toBe(false);
    expect((await collectOnce({ DB: db, SOURCE_HANDLE: "source" }, start + 25 * 60 * 60 * 1000)).following).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("updates a following account by stable id when its handle changes", async () => {
    await db.prepare("INSERT INTO accounts (id, handle, name) VALUES (?, ?, ?)").bind("a", "oldname", "Old").run();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: { users: [{ id: "a", screen_name: "newname", name: "New" }] }, cursor: { bottom: null } })));

    await syncFollowingPage(db, "source", 1_700_000_100_000);
    expect((await db.prepare("SELECT id, handle, name FROM accounts").all<{ id: string; handle: string; name: string }>()).results).toEqual([{ id: "a", handle: "newname", name: "New" }]);
  });

  it("restarts following pagination when SOURCE_HANDLE changes", async () => {
    await db.batch([
      db.prepare("INSERT INTO accounts (id, handle, name, sync_marker) VALUES (?, ?, ?, ?)").bind("old", "old", "Old", "old-marker"),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_source_handle", "old-source", "2023-11-14T22:00:00.000Z"),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_cursor", "stale-cursor", "2023-11-14T22:00:00.000Z"),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_marker", "old-marker", "2023-11-14T22:00:00.000Z"),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("account_status:old", JSON.stringify({ cursor: "stale-status-cursor", since: 1_699_999_900, latest: 1_700_000_000 }), "2023-11-14T22:00:00.000Z"),
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/profile/new-source/following");
      expect(parsed.searchParams.get("cursor")).toBeNull();
      return new Response(JSON.stringify({ results: { users: [{ id: "new", screen_name: "new-account", name: "New" }] }, cursor: { bottom: null } }));
    });

    await syncFollowingPage(db, "new-source", 1_700_000_100_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await db.prepare("SELECT id, handle FROM accounts").all<{ id: string; handle: string }>()).results).toEqual([{ id: "new", handle: "new-account" }]);
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("following_source_handle").first<{ value: string }>())?.value).toBe("new-source");
    expect((await db.prepare("SELECT COUNT(*) AS count FROM collector_state WHERE key = ?").bind("account_status:old").first<{ count: number }>())?.count).toBe(0);
  });

  it("treats status 204 as a successful empty check", async () => {
    await db.prepare("INSERT INTO accounts (id, handle, name, last_post_timestamp) VALUES (?, ?, ?, ?)").bind("a", "alice", "Alice", 1_699_999_900).run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    const checkedAt = 1_700_000_100_000;
    expect((await collectOnce(runtimeEnv, checkedAt)).accounts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const account = await db.prepare("SELECT last_post_timestamp, last_checked_at FROM accounts WHERE id = ?").bind("a").first<{ last_post_timestamp: number; last_checked_at: string }>();
    expect(account).toEqual({ last_post_timestamp: 1_699_999_900, last_checked_at: "2023-11-14T22:15:00.000Z" });
  });

  it("advances the batch position after a failed account and retries it next cycle", async () => {
    for (let index = 0; index < 21; index += 1) {
      const handle = `h${String(index).padStart(2, "0")}`;
      await db.prepare("INSERT INTO accounts (id, handle, name) VALUES (?, ?, ?)").bind(handle, handle, handle).run();
    }
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const parsed = new URL(String(input));
      if (parsed.pathname.endsWith("/h00/statuses")) return new Response("failed", { status: 500 });
      return new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } }));
    });

    await collectOnce(runtimeEnv, 1_700_000_100_000);
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("following_scan_position").first<{ value: string }>())?.value).toBe("20");
    fetchMock.mockClear();
    await collectOnce(runtimeEnv, 1_700_000_101_000);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toContain("/2/profile/h20/statuses");
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toContain("/2/profile/h00/statuses");
  });

  it("checkpoints a search query for an empty 404 result", async () => {
    await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("missing").run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ code: 404, results: [] }), { status: 404 }));

    await collectOnce(runtimeEnv, 1_700_000_100_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await db.prepare("SELECT last_checked_at FROM search_queries WHERE query = ?").bind("missing").first<{ last_checked_at: string }>())?.last_checked_at).toBe("2023-11-14T22:15:00.000Z");
  });

  it("rotates search attempts after five persistent failures", async () => {
    for (let index = 1; index <= 6; index += 1) {
      await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind(`q${index}`).run();
    }
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const query = new URL(String(input)).searchParams.get("q");
      if (query !== "q6") return new Response("upstream failed", { status: 500 });
      return new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } }));
    });

    await collectOnce(runtimeEnv, 1_700_000_100_000);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("q"))).toEqual(["q1", "q2", "q3", "q4", "q5"]);
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("search_scan_position").first<{ value: string }>())?.value).toBe("5");

    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } })));
    await collectOnce(runtimeEnv, 1_700_000_101_000);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("q"))).toEqual(["q6", "q1", "q2", "q3", "q4"]);
    expect((await db.prepare("SELECT last_checked_at FROM search_queries WHERE query = ?").bind("q6").first<{ last_checked_at: string }>())?.last_checked_at).toBe("2023-11-14T22:15:01.000Z");
  });

  it("runs collection from the scheduled handler", async () => {
    await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("scheduled").run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ code: 200, results: { timeline: [] }, cursor: { bottom: null } })));

    await worker.scheduled({ scheduledTime: 1_700_000_100_000, cron: "*/15 * * * *", noRetry() {} }, runtimeEnv);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await db.prepare("SELECT last_checked_at FROM search_queries WHERE query = ?").bind("scheduled").first<{ last_checked_at: string }>())?.last_checked_at).toBe("2023-11-14T22:15:00.000Z");
  });
});

describe("feed", () => {
  it("returns the feed envelope, pagination, ISO dates, quote objects, and ordering", async () => {
    const now = Math.floor(Date.now() / 1000);
    const collectedAt = new Date(now * 1000).toISOString();
    await db.batch([
      ["z", now, null],
      ["2", now - 10, null],
      ["1", now - 10, { id: "q", text: "引用" }],
      ["old", now - 7200, null],
    ].map(([id, timestamp, quote]) => db.prepare(`INSERT INTO posts
      (id, url, text, created_timestamp, author_id, author_screen_name, author_name, quote_json, source_kind, source_key, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id,
      `https://x.com/a/status/${id}`,
      "本文",
      timestamp,
      "a",
      "alice",
      "Alice",
      quote ? JSON.stringify(quote) : null,
      "search",
      "cloudflare",
      collectedAt,
    )));

    const first = await worker.fetch(new Request("https://localhost/feed?page=1&limit=2&hours=1"), env);
    expect(first.status).toBe(200);
    const body = await first.json() as { generated_at: string; page: number; limit: number; hours: number; posts: Array<{ id: string; created_at: string; quote: unknown }>; items?: unknown };
    expect(body.generated_at).toMatch(/Z$/);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(2);
    expect(body.hours).toBe(1);
    expect(body.items).toBeUndefined();
    expect(body.posts.map((post) => post.id)).toEqual(["z", "2"]);
    expect(body.posts[0].created_at).toBe(new Date(now * 1000).toISOString());

    const second = await worker.fetch(new Request("https://localhost/feed?page=2&limit=2&hours=1"), env);
    const secondBody = await second.json() as { posts: Array<{ id: string; created_at: string; quote: unknown }> };
    expect(secondBody.posts.map((post) => post.id)).toEqual(["1"]);
    expect(secondBody.posts[0].created_at).toMatch(/Z$/);
    expect(secondBody.posts[0].quote).toEqual({ id: "q", text: "引用" });
  });

  it("rejects invalid pagination", async () => {
    const response = await worker.fetch(new Request("https://localhost/feed?page=0&limit=101"), env);
    expect(response.status).toBe(400);
  });
});
