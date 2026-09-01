import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { collectOnce, normalizeStatus, syncFollowingPage } from "../src/index";

const db = env.DB;
const runtimeEnv = { DB: db, SOURCE_HANDLE: "" };
const accountRuntimeEnv = { DB: db, SOURCE_HANDLE: "source" };
const adminRuntimeEnv = { DB: db, SOURCE_HANDLE: "", ADMIN_TOKEN: "test-admin-token" } as const;

async function markFollowingAsCurrent(): Promise<void> {
  const timestamp = "2999-01-01T00:00:00.000Z";
  await db.batch([
    db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_source_handle", "source", timestamp),
    db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_cursor", "", timestamp),
    db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_marker", "", timestamp),
    db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_sync_at", timestamp, timestamp),
  ]);
}

function countD1Queries(database: D1Database): { db: D1Database; queries: string[] } {
  const queries: string[] = [];
  const originals = new WeakMap<object, D1PreparedStatement>();
  const sqlByStatement = new WeakMap<object, string>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === "bind" && typeof value === "function") {
          return (...args: unknown[]) => wrap(Reflect.apply(value, target, args) as D1PreparedStatement, sql);
        }
        if (["run", "first", "all", "raw"].includes(String(property)) && typeof value === "function") {
          return (...args: unknown[]) => {
            queries.push(sql);
            return Reflect.apply(value, target, args);
          };
        }
        return value;
      },
    });
    originals.set(proxy, statement);
    sqlByStatement.set(proxy, sql);
    sqlByStatement.set(statement, sql);
    return proxy;
  };
  const db = new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch") return (statements: D1PreparedStatement[]) => {
        const unwrapped = statements.map((statement) => originals.get(statement) ?? statement);
        unwrapped.forEach((statement) => queries.push(sqlByStatement.get(statement) ?? ""));
        return target.batch(unwrapped);
      };
      return Reflect.get(target, property, receiver);
    },
  });
  return { db, queries };
}

function statusFixture(prefix: string, count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    url: `https://x.com/alice/status/${prefix}-${index}`,
    text: `${prefix}-${index}`,
    created_timestamp: 1_700_000_000 + index,
    author: { id: "author", screen_name: "alice", name: "Alice" },
  }));
}

beforeAll(async () => {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY, url TEXT NOT NULL, text TEXT NOT NULL, created_timestamp INTEGER NOT NULL,
      likes INTEGER NOT NULL DEFAULT 0, reposts INTEGER NOT NULL DEFAULT 0, quotes INTEGER NOT NULL DEFAULT 0,
      replies INTEGER NOT NULL DEFAULT 0, author_id TEXT NOT NULL, author_screen_name TEXT NOT NULL,
      author_name TEXT NOT NULL, quote_json TEXT, details_json TEXT, source_kind TEXT NOT NULL, source_key TEXT NOT NULL,
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
      views: 600,
      bookmarks: 7,
      author: { id: "a", screen_name: "alice", name: "Alice" },
      quote: { id: "99", text: "引用本文" },
      media: { photos: [{ type: "photo", url: "https://example.com/photo.jpg", width: 100, height: 100 }] },
      possibly_sensitive: false,
    });
    expect(status?.quote).toEqual({ id: "99", text: "引用本文" });
    expect(status?.details).toEqual({
      views: 600,
      bookmarks: 7,
      media: { photos: [{ type: "photo", url: "https://example.com/photo.jpg", width: 100, height: 100 }] },
      possibly_sensitive: false,
    });
    expect(status?.isReply).toBe(false);
    expect(normalizeStatus({ ...status, created_timestamp: 1e100 })).toBeNull();
  });

  it("maps the FxEmbed retweets counter to internal reposts", () => {
    const status = normalizeStatus({
      id: "101",
      url: "https://x.com/alice/status/101",
      text: "本文",
      created_timestamp: 1_700_000_000,
      likes: 2,
      retweets: 7,
      quotes: 1,
      replies: 0,
      author: { id: "a", screen_name: "alice", name: "Alice" },
      quote: null,
      media: {},
    });
    expect(status?.reposts).toBe(7);
    expect(status?.details).toBeNull();
  });

  it("refreshes explicit counter changes and preserves omitted counters and details", async () => {
    await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("refresh").run();
    let run = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      run += 1;
      const counters = run === 1
        ? { likes: 250, reposts: 30, quotes: 20, replies: 10 }
        : run === 2
          ? { likes: 125, reposts: 15, quotes: 8, replies: 4 }
          : {};
      return new Response(JSON.stringify({ results: { timeline: [{
        id: "growing",
        url: run === 1 ? "https://x.com/alice/status/growing" : "https://x.com/alice-new/status/growing",
        ...(run === 2 ? { text: "更新後の本文" } : {}),
        created_timestamp: 1_700_000_000,
        ...counters,
        bookmarks: run === 1 ? 40 : 80,
        views: run === 1 ? 10 : run === 2 ? 20_000 : 30_000,
        ...(run === 1 ? {
          media: { photos: [{ type: "photo", url: "https://example.com/growing.jpg", width: 100, height: 100 }] },
          possibly_sensitive: true,
        } : {}),
        author: run === 1
          ? { id: "a", screen_name: "alice", name: "Alice" }
          : run === 2
            ? { id: "a-new", screen_name: "alice-new", name: "Alice New" }
            : { screen_name: "alice-new" },
      }] }, cursor: { bottom: null } }));
    });

    await collectOnce(runtimeEnv, 1_700_000_100_000);
    await collectOnce(runtimeEnv, 1_700_000_101_000);
    await collectOnce(runtimeEnv, 1_700_000_102_000);

    const post = await db.prepare("SELECT url, text, author_id, author_screen_name, author_name, likes, reposts, quotes, replies, details_json FROM posts WHERE id = ?").bind("growing").first<{ url: string; text: string; author_id: string; author_screen_name: string; author_name: string; likes: number; reposts: number; quotes: number; replies: number; details_json: string }>();
    expect(post?.url).toBe("https://x.com/alice-new/status/growing");
    expect(post?.text).toBe("更新後の本文");
    expect(post?.author_id).toBe("a-new");
    expect(post?.author_screen_name).toBe("alice-new");
    expect(post?.author_name).toBe("Alice New");
    expect(post?.likes).toBe(125);
    expect(post?.reposts).toBe(15);
    expect(post?.quotes).toBe(8);
    expect(post?.replies).toBe(4);
    expect(JSON.parse(post?.details_json ?? "null")).toMatchObject({
      bookmarks: 80,
      views: 30_000,
      media: { photos: [{ type: "photo", url: "https://example.com/growing.jpg" }] },
      possibly_sensitive: true,
      _counter_presence: { authorId: false, authorName: false },
    });
  });

  it("excludes account replies but keeps search replies and checkpoints each source", async () => {
    await db.prepare("INSERT INTO accounts (id, handle, name, last_post_timestamp) VALUES (?, ?, ?, ?)").bind("a", "alice", "Alice", 1_699_999_900).run();
    await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("cloudflare").run();
    await markFollowingAsCurrent();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(new Headers(init?.headers).get("user-agent")).toContain("rss-curator");
      const url = String(input);
      const parsed = new URL(url);
      if (parsed.pathname === "/2/profile/alice/statuses") {
        expect(parsed.searchParams.get("since")).toBe("1699999900");
        expect(parsed.searchParams.get("count")).toBe("25");
        expect(parsed.searchParams.get("with_replies")).toBeNull();
        return new Response(JSON.stringify({ code: 200, results: { timeline: [
          { id: "1", url: "https://x.com/alice/status/1", text: "投稿", created_timestamp: 1_700_000_000, author: { id: "a", screen_name: "alice", name: "Alice" } },
          { id: "2", url: "https://x.com/alice/status/2", text: "返信", created_timestamp: 1_700_000_001, replying_to: "1", author: { id: "a", screen_name: "alice", name: "Alice" } },
        ] }, cursor: { bottom: null } }));
      }
      if (parsed.pathname === "/2/search") {
        expect(parsed.searchParams.get("feed")).toBe("latest");
        expect(parsed.searchParams.get("count")).toBe("25");
        return new Response(JSON.stringify({ code: 200, results: { timeline: [
          { id: "1", url: "https://x.com/alice/status/1", text: "重複検索結果", created_timestamp: 1_700_000_000, author: { id: "a", screen_name: "alice", name: "Alice" } },
          { id: "3", url: "https://x.com/bob/status/3", text: "検索結果", created_timestamp: 1_700_000_002, author: { id: "b", screen_name: "bob", name: "Bob" }, quote: { id: "2", text: "引用" } },
          { id: "4", url: "https://x.com/bob/status/4", text: "検索返信", created_timestamp: 1_700_000_003, replying_to: "3", author: { id: "b", screen_name: "bob", name: "Bob" } },
        ] }, cursor: { bottom: "history-cursor" } }));
      }
      return new Response("not found", { status: 404 });
    });

    const result = await collectOnce(accountRuntimeEnv, 1_700_000_100_000);
    expect(result).toEqual({ following: false, accounts: 1, queries: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const posts = await db.prepare("SELECT id, quote_json FROM posts ORDER BY id").all<{ id: string; quote_json: string | null }>();
    expect(posts.results.map((post) => post.id)).toEqual(["1", "3", "4"]);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts WHERE id = ?").bind("1").first<{ count: number }>())?.count).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts WHERE id = ?").bind("2").first<{ count: number }>())?.count).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts WHERE id = ?").bind("4").first<{ count: number }>())?.count).toBe(1);
    expect(JSON.parse(posts.results[1].quote_json ?? "null")).toEqual({ id: "2", text: "引用" });
    expect((await db.prepare("SELECT last_post_timestamp FROM accounts WHERE id = ?").bind("a").first<{ last_post_timestamp: number }>())?.last_post_timestamp).toBe(1_700_000_001);
    expect((await db.prepare("SELECT last_checked_at FROM accounts WHERE id = ?").bind("a").first<{ last_checked_at: string }>())?.last_checked_at).toBe("2023-11-14T22:15:00.000Z");
    expect((await db.prepare("SELECT last_checked_at FROM search_queries WHERE query = ?").bind("cloudflare").first<{ last_checked_at: string }>())?.last_checked_at).toBe("2023-11-14T22:15:00.000Z");
  });

  it("chunks 50 following accounts and 20 posts into bounded statements", async () => {
    const start = 1_700_000_100_000;
    const counter = countD1Queries(db);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const parsed = new URL(String(input));
      if (parsed.pathname === "/2/profile/source/following") {
        expect(parsed.searchParams.get("count")).toBe("50");
        return new Response(JSON.stringify({ results: { users: Array.from({ length: 50 }, (_, index) => ({
          id: `following-${index}`, screen_name: `following-${index}`, name: `Following ${index}`,
        })) }, cursor: { bottom: null } }));
      }
      if (parsed.pathname === "/2/profile/alice/statuses") {
        expect(parsed.searchParams.get("count")).toBe("25");
        return new Response(JSON.stringify({ results: { timeline: statusFixture("account", 20) }, cursor: { bottom: null } }));
      }
      throw new Error(`unexpected fetch: ${parsed.pathname}`);
    });

    await syncFollowingPage(counter.db, "source", start);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM accounts").first<{ count: number }>())?.count).toBe(50);
    const accountStatements = counter.queries.filter((sql) => sql.includes("INSERT INTO accounts"));
    expect(accountStatements).toHaveLength(3);
    expect(accountStatements.map((sql) => (sql.match(/\?/g) ?? []).length)).toEqual([100, 100, 50]);

    await db.batch([
      db.prepare("DELETE FROM accounts"),
      db.prepare("DELETE FROM collector_state"),
      db.prepare("DELETE FROM posts"),
    ]);
    await db.prepare("INSERT INTO accounts (id, handle, name) VALUES (?, ?, ?)").bind("a", "alice", "Alice").run();
    await markFollowingAsCurrent();
    counter.queries.length = 0;

    await collectOnce({ DB: counter.db, SOURCE_HANDLE: "source" }, start);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts").first<{ count: number }>())?.count).toBe(20);
    const postStatements = counter.queries.filter((sql) => sql.includes("INSERT INTO posts"));
    expect(postStatements).toHaveLength(4);
    expect(postStatements.map((sql) => (sql.match(/\?/g) ?? []).length)).toEqual([96, 96, 96, 32]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not advance following state when the upstream exceeds count=50", async () => {
    const previous = "2023-11-14T22:00:00.000Z";
    await db.batch([
      db.prepare("INSERT INTO accounts (id, handle, name, sync_marker) VALUES (?, ?, ?, ?)").bind("old", "old", "Old", "old-marker"),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_source_handle", "source", previous),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_cursor", "old-cursor", previous),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_marker", "old-marker", previous),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_sync_at", previous, previous),
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/profile/source/following");
      expect(parsed.searchParams.get("count")).toBe("50");
      expect(parsed.searchParams.get("cursor")).toBe("old-cursor");
      return new Response(JSON.stringify({ results: { users: Array.from({ length: 51 }, (_, index) => ({
        id: `too-many-${index}`, screen_name: `too-many-${index}`, name: `Too Many ${index}`,
      })) }, cursor: { bottom: null } }));
    });

    expect(await collectOnce(accountRuntimeEnv, 1_700_000_100_000)).toEqual({ following: false, accounts: 0, queries: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("following_cursor").first<{ value: string }>())?.value).toBe("old-cursor");
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("following_marker").first<{ value: string }>())?.value).toBe("old-marker");
    expect((await db.prepare("SELECT handle FROM accounts").all<{ handle: string }>()).results).toEqual([{ handle: "old" }]);
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("following_pending_source_handle").first<{ value: string }>())?.value).toBe("source");
  });

  it("does not advance account state when statuses exceed count=25", async () => {
    await db.prepare("INSERT INTO accounts (id, handle, name) VALUES (?, ?, ?)").bind("a", "alice", "Alice").run();
    await markFollowingAsCurrent();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/profile/alice/statuses");
      expect(parsed.searchParams.get("count")).toBe("25");
      return new Response(JSON.stringify({ results: { timeline: statusFixture("too-many-statuses", 26) }, cursor: { bottom: "unexpected" } }));
    });

    expect((await collectOnce(accountRuntimeEnv, 1_700_000_100_000)).accounts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts").first<{ count: number }>())?.count).toBe(0);
    expect((await db.prepare("SELECT last_post_timestamp, last_checked_at FROM accounts WHERE id = ?").bind("a").first<{ last_post_timestamp: number | null; last_checked_at: string | null }>())).toEqual({ last_post_timestamp: null, last_checked_at: null });
    expect((await db.prepare("SELECT COUNT(*) AS count FROM collector_state WHERE key = ?").bind("account_status:a").first<{ count: number }>())?.count).toBe(0);
  });

  it("does not advance search state when results exceed count=25", async () => {
    await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("too-many-results").run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/search");
      expect(parsed.searchParams.get("count")).toBe("25");
      return new Response(JSON.stringify({ results: { timeline: statusFixture("too-many-results", 26) }, cursor: { bottom: "unexpected" } }));
    });

    expect((await collectOnce(runtimeEnv, 1_700_000_100_000)).queries).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts").first<{ count: number }>())?.count).toBe(0);
    expect((await db.prepare("SELECT last_checked_at FROM search_queries WHERE query = ?").bind("too-many-results").first<{ last_checked_at: string | null }>())?.last_checked_at).toBeNull();
    expect((await db.prepare("SELECT COUNT(*) AS count FROM collector_state WHERE key LIKE ?").bind("search_query:%").first<{ count: number }>())?.count).toBe(0);
  });

  it("does not delete following accounts when the response cursor is missing", async () => {
    const previous = "2023-11-14T22:00:00.000Z";
    await db.batch([
      db.prepare("INSERT INTO accounts (id, handle, name, sync_marker) VALUES (?, ?, ?, ?)").bind("old", "old", "Old", "old-marker"),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_source_handle", "source", previous),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_cursor", "old-cursor", previous),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_marker", "old-marker", previous),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_sync_at", previous, previous),
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: { users: [] } })));

    await expect(syncFollowingPage(db, "source", 1_700_000_100_000)).rejects.toThrow(/invalid cursor/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await db.prepare("SELECT handle FROM accounts").all<{ handle: string }>()).results).toEqual([{ handle: "old" }]);
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("following_cursor").first<{ value: string }>())?.value).toBe("old-cursor");
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("following_marker").first<{ value: string }>())?.value).toBe("old-marker");
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("following_sync_at").first<{ value: string }>())?.value).toBe(previous);
  });

  it("does not checkpoint an account when the response cursor is missing", async () => {
    await db.prepare("INSERT INTO accounts (id, handle, name) VALUES (?, ?, ?)").bind("a", "alice", "Alice").run();
    await markFollowingAsCurrent();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: { timeline: statusFixture("missing-cursor", 1) } })));

    expect((await collectOnce(accountRuntimeEnv, 1_700_000_100_000)).accounts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts").first<{ count: number }>())?.count).toBe(0);
    expect((await db.prepare("SELECT last_checked_at FROM accounts WHERE id = ?").bind("a").first<{ last_checked_at: string | null }>())?.last_checked_at).toBeNull();
    expect((await db.prepare("SELECT COUNT(*) AS count FROM collector_state WHERE key = ?").bind("account_status:a").first<{ count: number }>())?.count).toBe(0);
  });

  it("does not checkpoint a search query when the response cursor is missing", async () => {
    await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("missing-cursor-query").run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: { timeline: statusFixture("missing-search-cursor", 1) } })));

    expect((await collectOnce(runtimeEnv, 1_700_000_100_000)).queries).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts").first<{ count: number }>())?.count).toBe(0);
    expect((await db.prepare("SELECT last_checked_at FROM search_queries WHERE query = ?").bind("missing-cursor-query").first<{ last_checked_at: string | null }>())?.last_checked_at).toBeNull();
  });

  it("keeps the worst no-following run within 50 D1 queries", async () => {
    for (let index = 0; index < 2; index += 1) {
      await db.prepare("INSERT INTO accounts (id, handle, name, last_post_timestamp) VALUES (?, ?, ?, ?)").bind(`account-${index}`, `account-${index}`, `Account ${index}`, 1_699_999_900).run();
    }
    for (let index = 1; index <= 6; index += 1) {
      await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind(`q${index}`).run();
    }
    await markFollowingAsCurrent();
    await db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("search_scan_position", "4", "2999-01-01T00:00:00.000Z").run();
    const queryRows = await db.prepare("SELECT id, query FROM search_queries ORDER BY id").all<{ id: number; query: string }>();
    await db.batch(queryRows.results.map((query) => db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind(
      `search_query:${query.id}`,
      JSON.stringify({ query: query.query, backlog_cursor: "backlog-cursor", stop_watermark: 1_699_999_900, pending_latest: 1_700_000_000 }),
      "2023-11-14T22:00:00.000Z",
    )));
    const counter = countD1Queries(db);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const parsed = new URL(String(input));
      if (parsed.pathname.endsWith("/statuses")) {
        expect(parsed.searchParams.get("count")).toBe("25");
        return new Response(JSON.stringify({ results: { timeline: statusFixture(parsed.pathname.split("/").at(-2) ?? "account", 20) }, cursor: { bottom: parsed.searchParams.has("cursor") ? null : "account-backlog" } }));
      }
      if (parsed.pathname === "/2/search") {
        expect(parsed.searchParams.get("count")).toBe("25");
        const isBacklog = parsed.searchParams.has("cursor");
        return new Response(JSON.stringify({ results: { timeline: statusFixture(parsed.searchParams.get("q") ?? "query", 20) }, cursor: { bottom: isBacklog ? null : "fresh-cursor" } }));
      }
      throw new Error(`unexpected fetch: ${parsed.pathname}`);
    });

    const result = await collectOnce({ DB: counter.db, SOURCE_HANDLE: "source" }, 1_700_000_100_000);
    expect(result).toEqual({ following: false, accounts: 1, queries: 1 });
    expect(counter.queries.length).toBeLessThanOrEqual(50);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps a following final page and one search within 50 D1 queries", async () => {
    const start = 1_700_000_100_000;
    const previousSync = new Date(start - 25 * 60 * 60 * 1000).toISOString();
    await db.batch([
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_source_handle", "source", previousSync),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_cursor", "", previousSync),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_marker", "", previousSync),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_sync_at", previousSync, previousSync),
    ]);
    for (let index = 1; index <= 6; index += 1) {
      await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind(`q${index}`).run();
    }
    await db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("search_scan_position", "4", previousSync).run();
    const queryRows = await db.prepare("SELECT id, query FROM search_queries ORDER BY id").all<{ id: number; query: string }>();
    await db.batch(queryRows.results.map((query) => db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind(
      `search_query:${query.id}`,
      JSON.stringify({ query: query.query, backlog_cursor: "backlog-cursor", stop_watermark: 1_699_999_900, pending_latest: 1_700_000_000 }),
      previousSync,
    )));
    const counter = countD1Queries(db);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const parsed = new URL(String(input));
      if (parsed.pathname === "/2/profile/source/following") {
        expect(parsed.searchParams.get("count")).toBe("50");
        return new Response(JSON.stringify({ results: { users: Array.from({ length: 20 }, (_, index) => ({
          id: `following-${index}`, screen_name: `following-${index}`, name: `Following ${index}`,
        })) }, cursor: { bottom: null } }));
      }
      if (parsed.pathname === "/2/search") {
        expect(parsed.searchParams.get("count")).toBe("25");
        const isBacklog = parsed.searchParams.has("cursor");
        return new Response(JSON.stringify({ results: { timeline: statusFixture(parsed.searchParams.get("q") ?? "query", 20) }, cursor: { bottom: isBacklog ? null : "fresh-cursor" } }));
      }
      throw new Error(`unexpected fetch: ${parsed.pathname}`);
    });

    const result = await collectOnce({ DB: counter.db, SOURCE_HANDLE: "source" }, start);
    expect(result).toEqual({ following: true, accounts: 0, queries: 1 });
    expect(counter.queries.length).toBeLessThanOrEqual(50);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/2/profile/source/following",
      "/2/search",
      "/2/search",
    ]);
  });

  it("keeps old following accounts until the final cursor page succeeds", async () => {
    await db.prepare("INSERT INTO accounts (id, handle, name) VALUES (?, ?, ?)").bind("old", "old", "Old").run();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/profile/source/following");
      expect(parsed.searchParams.get("count")).toBe("50");
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
      return new Response(JSON.stringify({ results: { users: [{ id: "b", screen_name: "bob", name: "Bob", protected: true }] }, cursor: { bottom: "0|end" } }));
    });
    await syncFollowingPage(db, "source", 1_700_000_101_000);
    expect((await db.prepare("SELECT handle FROM accounts ORDER BY handle").all<{ handle: string }>()).results.map((row) => row.handle)).toEqual(["alice", "bob"]);
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("following_sync_at").first<{ value: string }>())?.value).toBe("2023-11-14T22:15:01.000Z");
  });

  it("resumes account status pagination with its fixed since checkpoint", async () => {
    await db.prepare("INSERT INTO accounts (id, handle, name, last_post_timestamp) VALUES (?, ?, ?, ?)").bind("a", "alice", "Alice", 1_699_999_900).run();
    await markFollowingAsCurrent();
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
    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/profile/alice/statuses");
      expect(parsed.searchParams.get("cursor")).toBe("page-2");
      expect(parsed.searchParams.get("since")).toBe("1699999900");
      return new Response(JSON.stringify({ results: { timeline: [
        { id: "older", url: "https://x.com/alice/status/older", text: "過去", created_timestamp: 1_699_999_950, author: { id: "a", screen_name: "alice", name: "Alice" } },
      ] }, cursor: { bottom: "page-3" } }));
    });
    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/profile/alice/statuses");
      expect(parsed.searchParams.get("cursor")).toBeNull();
      expect(parsed.searchParams.get("since")).toBe("1699999900");
      return new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: "page-3" } }));
    });
    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/profile/alice/statuses");
      expect(parsed.searchParams.get("cursor")).toBe("page-3");
      expect(parsed.searchParams.get("since")).toBe("1699999900");
      return new Response(JSON.stringify({ results: { timeline: [
        { id: "older-2", url: "https://x.com/alice/status/older-2", text: "過去2", created_timestamp: 1_699_999_900, author: { id: "a", screen_name: "alice", name: "Alice" } },
      ] }, cursor: { bottom: null } }));
    });

    await collectOnce(accountRuntimeEnv, 1_700_000_100_000);
    expect((await db.prepare("SELECT last_post_timestamp FROM accounts WHERE id = ?").bind("a").first<{ last_post_timestamp: number }>())?.last_post_timestamp).toBe(1_699_999_900);
    expect(JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("account_status:a").first<{ value: string }>())?.value ?? "null")).toMatchObject({
      cursor: "page-3",
      queued_cursor: null,
      since: 1_699_999_900,
      latest: 1_700_000_000,
    });

    await collectOnce(accountRuntimeEnv, 1_700_000_101_000);
    expect((await db.prepare("SELECT last_post_timestamp FROM accounts WHERE id = ?").bind("a").first<{ last_post_timestamp: number }>())?.last_post_timestamp).toBe(1_700_000_000);
    expect(JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("account_status:a").first<{ value: string }>())?.value ?? "null")).toMatchObject({ cursor: null, latest: 1_700_000_000, latest_ids: ["new"] });
    expect((await db.prepare("SELECT id FROM posts ORDER BY id").all<{ id: string }>()).results.map((post) => post.id)).toEqual(["new", "older", "older-2"]);
  });

  it("keeps an account status cursor unchanged when its next page fails", async () => {
    await db.prepare("INSERT INTO accounts (id, handle, name, last_post_timestamp) VALUES (?, ?, ?, ?)").bind("a", "alice", "Alice", 1_699_999_900).run();
    await markFollowingAsCurrent();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: [
        { id: "new", url: "https://x.com/alice/status/new", text: "新着", created_timestamp: 1_700_000_000, author: { id: "a", screen_name: "alice", name: "Alice" } },
      ] }, cursor: { bottom: "page-2" } })))
      .mockResolvedValueOnce(new Response("upstream failed", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: "page-2" } })))
      .mockResolvedValueOnce(new Response("upstream failed", { status: 500 }));

    await collectOnce(accountRuntimeEnv, 1_700_000_100_000);
    await collectOnce(accountRuntimeEnv, 1_700_000_101_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((await db.prepare("SELECT last_post_timestamp FROM accounts WHERE id = ?").bind("a").first<{ last_post_timestamp: number }>())?.last_post_timestamp).toBe(1_699_999_900);
    expect(JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("account_status:a").first<{ value: string }>())?.value ?? "null")).toMatchObject({ cursor: "page-2" });
  });

  it("checks account fresh first and switches a queued cursor only after backlog ends", async () => {
    await db.prepare("INSERT INTO accounts (id, handle, name, last_post_timestamp) VALUES (?, ?, ?, ?)").bind("a", "alice", "Alice", 1_699_999_900).run();
    await markFollowingAsCurrent();
    const status = (id: string, timestamp: number) => ({ id, url: `https://x.com/alice/status/${id}`, text: id, created_timestamp: timestamp, author: { id: "a", screen_name: "alice", name: "Alice" } });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: [status("fresh-1", 1_700_000_000)] }, cursor: { bottom: "cursor-1" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: [status("older-1", 1_699_999_950)] }, cursor: { bottom: "cursor-2" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: [status("fresh-2", 1_700_000_001)] }, cursor: { bottom: "queued-cursor" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: "queued-cursor" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: [status("older-2", 1_699_999_900)] }, cursor: { bottom: null } })));

    await collectOnce(accountRuntimeEnv, 1_700_000_100_000);
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("cursor")).toBeNull();
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("cursor")).toBe("cursor-1");
    expect(JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("account_status:a").first<{ value: string }>())?.value ?? "null")).toMatchObject({ cursor: "cursor-2", queued_cursor: null });

    await collectOnce(accountRuntimeEnv, 1_700_000_101_000);
    expect(new URL(String(fetchMock.mock.calls[2][0])).searchParams.get("cursor")).toBeNull();
    expect(new URL(String(fetchMock.mock.calls[3][0])).searchParams.get("cursor")).toBe("cursor-2");
    expect(JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("account_status:a").first<{ value: string }>())?.value ?? "null")).toMatchObject({ cursor: "queued-cursor", queued_cursor: null });
    expect((await db.prepare("SELECT last_post_timestamp FROM accounts WHERE id = ?").bind("a").first<{ last_post_timestamp: number }>())?.last_post_timestamp).toBe(1_699_999_900);

    await collectOnce(accountRuntimeEnv, 1_700_000_102_000);
    expect(new URL(String(fetchMock.mock.calls[4][0])).searchParams.get("cursor")).toBeNull();
    expect(new URL(String(fetchMock.mock.calls[5][0])).searchParams.get("cursor")).toBe("queued-cursor");
    expect(JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("account_status:a").first<{ value: string }>())?.value ?? "null")).toMatchObject({ cursor: null, latest: 1_700_000_001, latest_ids: ["fresh-2"] });
    expect((await db.prepare("SELECT last_post_timestamp FROM accounts WHERE id = ?").bind("a").first<{ last_post_timestamp: number }>())?.last_post_timestamp).toBe(1_700_000_001);
  });

  it("preserves an existing queued cursor when fresh repeats the current cursor", async () => {
    const checkedAt = "2023-11-14T22:00:00.000Z";
    await db.batch([
      db.prepare("INSERT INTO accounts (id, handle, name, last_post_timestamp) VALUES (?, ?, ?, ?)").bind("a", "alice", "Alice", 1_699_999_900),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("account_status:a", JSON.stringify({ cursor: "current", queued_cursor: "queued", since: 1_699_999_900, latest: 1_700_000_000 }), checkedAt),
    ]);
    await markFollowingAsCurrent();
    let freshRuns = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const cursor = new URL(String(input)).searchParams.get("cursor");
      if (cursor === null) {
        freshRuns += 1;
        const freshCursor = freshRuns === 1 ? "current" : "queued";
        return new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: freshCursor } }));
      }
      if (cursor === "current") return new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: "queued" } }));
      if (cursor === "queued") return new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } }));
      throw new Error(`unexpected cursor: ${cursor}`);
    });

    await collectOnce(accountRuntimeEnv, 1_700_000_100_000);
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("cursor")).toBeNull();
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("cursor")).toBe("current");
    expect(JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("account_status:a").first<{ value: string }>())?.value ?? "null")).toMatchObject({ cursor: "queued", queued_cursor: null });

    await collectOnce(accountRuntimeEnv, 1_700_000_101_000);
    expect(new URL(String(fetchMock.mock.calls[2][0])).searchParams.get("cursor")).toBeNull();
    expect(new URL(String(fetchMock.mock.calls[3][0])).searchParams.get("cursor")).toBe("queued");
    expect(JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("account_status:a").first<{ value: string }>())?.value ?? "null")).toMatchObject({ cursor: null, latest: 1_700_000_000, latest_ids: [] });
  });

  it("does not start account history pagination when the initial timestamp is empty", async () => {
    await db.prepare("INSERT INTO accounts (id, handle, name) VALUES (?, ?, ?)").bind("a", "alice", "Alice").run();
    await markFollowingAsCurrent();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: { timeline: [
      { id: "initial", url: "https://x.com/alice/status/initial", text: "初回", created_timestamp: 1_700_000_000, author: { id: "a", screen_name: "alice", name: "Alice" } },
    ] }, cursor: { bottom: "history" } })));

    await collectOnce(accountRuntimeEnv, 1_700_000_100_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await db.prepare("SELECT last_post_timestamp FROM accounts WHERE id = ?").bind("a").first<{ last_post_timestamp: number }>())?.last_post_timestamp).toBe(1_700_000_000);
    expect(JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("account_status:a").first<{ value: string }>())?.value ?? "null")).toMatchObject({ cursor: null, latest: 1_700_000_000, latest_ids: ["initial"] });
  });

  it("keeps an account backlog cursor when its fresh page fails", async () => {
    const checkedAt = "2023-11-14T22:00:00.000Z";
    await db.batch([
      db.prepare("INSERT INTO accounts (id, handle, name, last_post_timestamp) VALUES (?, ?, ?, ?)").bind("a", "alice", "Alice", 1_699_999_900),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("account_status:a", JSON.stringify({ cursor: "page-2", since: 1_699_999_900, latest: 1_700_000_000 }), checkedAt),
    ]);
    await markFollowingAsCurrent();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("fresh failed", { status: 500 }));

    await collectOnce(accountRuntimeEnv, 1_700_000_100_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("account_status:a").first<{ value: string }>())?.value).toContain("page-2");

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: "page-2" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } })));
    await collectOnce(accountRuntimeEnv, 1_700_000_101_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("account_status:a").first<{ value: string }>())?.value ?? "null")).toMatchObject({ cursor: null, latest: 1_700_000_000, latest_ids: [] });
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

  it("keeps the account scan position after same-source full sync completion", async () => {
    const start = 1_700_000_100_000;
    const previousSync = new Date(start - 25 * 60 * 60 * 1000).toISOString();
    await db.batch([
      ...Array.from({ length: 5 }, (_, index) => db.prepare("INSERT INTO accounts (id, handle, name) VALUES (?, ?, ?)").bind(`a${index}`, `h${String(index).padStart(2, "0")}`, `H${index}`)),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_source_handle", "source", previousSync),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_cursor", "", previousSync),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_marker", "", previousSync),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_sync_at", previousSync, previousSync),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_scan_position", "3", previousSync),
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const parsed = new URL(String(input));
      if (parsed.pathname === "/2/profile/source/following") {
        return new Response(JSON.stringify({ results: { users: Array.from({ length: 5 }, (_, index) => ({
          id: `a${index}`, screen_name: `h${String(index).padStart(2, "0")}`, name: `H${index}`,
        })) }, cursor: { bottom: null } }));
      }
      if (parsed.pathname.endsWith("/statuses")) {
        return new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } }));
      }
      throw new Error(`unexpected fetch: ${parsed.pathname}`);
    });

    expect((await collectOnce(accountRuntimeEnv, start)).following).toBe(true);
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("following_scan_position").first<{ value: string }>())?.value).toBe("3");
    expect((await collectOnce(accountRuntimeEnv, start + 15 * 60 * 1000)).accounts).toBe(1);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/2/profile/source/following",
      "/2/profile/h03/statuses",
    ]);
  });

  it("stops status polling during a same-source refresh until its final page", async () => {
    const start = 1_700_000_100_000;
    const previousSync = new Date(start - 25 * 60 * 60 * 1000).toISOString();
    await db.batch([
      db.prepare("INSERT INTO accounts (id, handle, name, sync_marker) VALUES (?, ?, ?, ?)").bind("old", "old", "Old", "old-marker"),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_source_handle", "source", previousSync),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_cursor", "", previousSync),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_marker", "", previousSync),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_sync_at", previousSync, previousSync),
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { users: [{ id: "new", screen_name: "new-account", name: "New" }] }, cursor: { bottom: "next" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { users: [{ id: "new", screen_name: "new-account", name: "New" }] }, cursor: { bottom: null } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } })));

    expect((await collectOnce(accountRuntimeEnv, start)).accounts).toBe(0);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(["/2/profile/source/following"]);
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("following_pending_source_handle").first<{ value: string }>())?.value).toBe("source");

    expect((await collectOnce(accountRuntimeEnv, start + 15 * 60 * 1000)).accounts).toBe(0);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/2/profile/source/following",
      "/2/profile/source/following",
    ]);

    expect((await collectOnce(accountRuntimeEnv, start + 30 * 60 * 1000)).accounts).toBe(1);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/2/profile/source/following",
      "/2/profile/source/following",
      "/2/profile/new-account/statuses",
    ]);
    expect((await db.prepare("SELECT handle FROM accounts ORDER BY handle").all<{ handle: string }>()).results).toEqual([{ handle: "new-account" }]);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM collector_state WHERE key = ?").bind("following_pending_source_handle").first<{ count: number }>())?.count).toBe(0);
  });

  it("seeds new following accounts at discovery and drains their delayed status pages", async () => {
    const start = 1_700_000_100_000;
    const baseline = Math.floor(start / 1000);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (input) => {
        const parsed = new URL(String(input));
        expect(parsed.pathname).toBe("/2/profile/source/following");
        expect(parsed.searchParams.get("cursor")).toBeNull();
        return new Response(JSON.stringify({ results: { users: [{ id: "new", screen_name: "new-account", name: "New" }] }, cursor: { bottom: "following-next" } }));
      })
      .mockImplementationOnce(async (input) => {
        const parsed = new URL(String(input));
        expect(parsed.pathname).toBe("/2/profile/source/following");
        expect(parsed.searchParams.get("cursor")).toBe("following-next");
        return new Response(JSON.stringify({ results: { users: [] }, cursor: { bottom: null } }));
      })
      .mockImplementationOnce(async (input) => {
        const parsed = new URL(String(input));
        expect(parsed.pathname).toBe("/2/profile/new-account/statuses");
        expect(parsed.searchParams.get("cursor")).toBeNull();
        expect(parsed.searchParams.get("since")).toBe(String(baseline));
        return new Response(JSON.stringify({ results: { timeline: [
          { id: "newest", url: "https://x.com/new-account/status/newest", text: "新着", created_timestamp: baseline + 60, author: { id: "new", screen_name: "new-account", name: "New" } },
        ] }, cursor: { bottom: "status-next" } }));
      })
      .mockImplementationOnce(async (input) => {
        const parsed = new URL(String(input));
        expect(parsed.pathname).toBe("/2/profile/new-account/statuses");
        expect(parsed.searchParams.get("cursor")).toBe("status-next");
        expect(parsed.searchParams.get("since")).toBe(String(baseline));
        return new Response(JSON.stringify({ results: { timeline: [
          { id: "older", url: "https://x.com/new-account/status/older", text: "過去", created_timestamp: baseline + 30, author: { id: "new", screen_name: "new-account", name: "New" } },
        ] }, cursor: { bottom: null } }));
      });

    expect((await collectOnce(accountRuntimeEnv, start)).following).toBe(true);
    expect((await db.prepare("SELECT last_post_timestamp FROM accounts WHERE id = ?").bind("new").first<{ last_post_timestamp: number }>())?.last_post_timestamp).toBe(baseline);
    expect((await collectOnce(accountRuntimeEnv, start + 15 * 60 * 1000)).following).toBe(true);
    expect((await collectOnce(accountRuntimeEnv, start + 30 * 60 * 1000)).accounts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((await db.prepare("SELECT id FROM posts ORDER BY created_timestamp DESC").all<{ id: string }>()).results.map((post) => post.id)).toEqual(["newest", "older"]);
    expect((await db.prepare("SELECT last_post_timestamp FROM accounts WHERE id = ?").bind("new").first<{ last_post_timestamp: number }>())?.last_post_timestamp).toBe(baseline + 60);
  });

  it("keeps status polling stopped when a same-source refresh fetch fails", async () => {
    const start = 1_700_000_100_000;
    const previousSync = new Date(start - 25 * 60 * 60 * 1000).toISOString();
    await db.batch([
      db.prepare("INSERT INTO accounts (id, handle, name, sync_marker) VALUES (?, ?, ?, ?)").bind("old", "old", "Old", "old-marker"),
      db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("still-searches"),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_source_handle", "source", previousSync),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_cursor", "", previousSync),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_marker", "", previousSync),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_sync_at", previousSync, previousSync),
    ]);
    let followingCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const parsed = new URL(String(input));
      if (parsed.pathname === "/2/profile/source/following") {
        followingCalls += 1;
        if (followingCalls === 1) return new Response(JSON.stringify({ error: "failed" }), { status: 500 });
        return new Response(JSON.stringify({ results: { users: [{ id: "new", screen_name: "new-account", name: "New" }] }, cursor: { bottom: null } }));
      }
      if (parsed.pathname === "/2/profile/new-account/statuses") {
        return new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } }));
      }
      if (parsed.pathname === "/2/search") {
        return new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } }));
      }
      throw new Error(`unexpected fetch: ${parsed.pathname}`);
    });

    expect(await collectOnce(accountRuntimeEnv, start)).toEqual({ following: false, accounts: 0, queries: 1 });
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/2/profile/source/following",
      "/2/search",
    ]);
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("following_pending_source_handle").first<{ value: string }>())?.value).toBe("source");

    expect(await collectOnce(accountRuntimeEnv, start + 15 * 60 * 1000)).toEqual({ following: true, accounts: 0, queries: 1 });
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/2/profile/source/following",
      "/2/search",
      "/2/profile/source/following",
      "/2/search",
    ]);
    expect(await collectOnce(accountRuntimeEnv, start + 30 * 60 * 1000)).toEqual({ following: false, accounts: 1, queries: 1 });
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/2/profile/source/following",
      "/2/search",
      "/2/profile/source/following",
      "/2/search",
      "/2/profile/new-account/statuses",
      "/2/search",
    ]);
    expect((await db.prepare("SELECT handle FROM accounts ORDER BY handle").all<{ handle: string }>()).results).toEqual([{ handle: "new-account" }]);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM collector_state WHERE key = ?").bind("following_pending_source_handle").first<{ count: number }>())?.count).toBe(0);
  });

  it("updates a following account by stable id when its handle changes", async () => {
    await db.prepare("INSERT INTO accounts (id, handle, name) VALUES (?, ?, ?)").bind("a", "oldname", "Old").run();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: { users: [{ id: "a", screen_name: "newname", name: "New" }] }, cursor: { bottom: null } })));

    await syncFollowingPage(db, "source", 1_700_000_100_000);
    expect((await db.prepare("SELECT id, handle, name FROM accounts").all<{ id: string; handle: string; name: string }>()).results).toEqual([{ id: "a", handle: "newname", name: "New" }]);
  });

  it("clears a stale account status cursor when a following handle changes", async () => {
    const previous = "2023-11-14T22:00:00.000Z";
    await db.batch([
      db.prepare("INSERT INTO accounts (id, handle, name, last_post_timestamp) VALUES (?, ?, ?, ?)").bind("a", "oldname", "Old", 1_699_999_900),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("account_status:a", JSON.stringify({ cursor: "stale-status", since: 1_699_999_900, latest: 1_700_000_000 }), previous),
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (input) => {
        expect(new URL(String(input)).pathname).toBe("/2/profile/source/following");
        return new Response(JSON.stringify({ results: { users: [{ id: "a", screen_name: "newname", name: "New" }] }, cursor: { bottom: null } }));
      })
      .mockImplementationOnce(async (input) => {
        const parsed = new URL(String(input));
        expect(parsed.pathname).toBe("/2/profile/newname/statuses");
        expect(parsed.searchParams.get("cursor")).toBeNull();
        expect(parsed.searchParams.get("since")).toBe("1699999900");
        return new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } }));
      });

    await syncFollowingPage(db, "source", 1_700_000_100_000);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM collector_state WHERE key = ?").bind("account_status:a").first<{ count: number }>())?.count).toBe(0);
    await collectOnce({ DB: db, SOURCE_HANDLE: "source" }, 1_700_000_101_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("does not poll old accounts until a changed source full sync completes", async () => {
    const timestamp = "2023-11-14T22:00:00.000Z";
    await db.batch([
      db.prepare("INSERT INTO accounts (id, handle, name, sync_marker) VALUES (?, ?, ?, ?)").bind("old", "old", "Old", "old-marker"),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_source_handle", "old-source", timestamp),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_cursor", "", timestamp),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_marker", "", timestamp),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("following_sync_at", timestamp, timestamp),
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { users: [] }, cursor: { bottom: "next" } })))
      .mockResolvedValueOnce(new Response("upstream failed", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { users: [{ id: "new", screen_name: "new-account", name: "New" }] }, cursor: { bottom: null } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } })));
    const newRuntimeEnv = { DB: db, SOURCE_HANDLE: "new-source" };

    expect((await collectOnce(newRuntimeEnv, 1_700_000_100_000)).accounts).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM accounts").first<{ count: number }>())?.count).toBe(1);
    expect((await collectOnce(newRuntimeEnv, 1_700_000_101_000)).accounts).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM accounts").first<{ count: number }>())?.count).toBe(1);
    const completed = await collectOnce(newRuntimeEnv, 1_700_000_102_000);
    expect(completed.accounts).toBe(0);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/2/profile/new-source/following",
      "/2/profile/new-source/following",
      "/2/profile/new-source/following",
    ]);
    const resumed = await collectOnce(newRuntimeEnv, 1_700_000_103_000);
    expect(resumed.accounts).toBe(1);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/2/profile/new-source/following",
      "/2/profile/new-source/following",
      "/2/profile/new-source/following",
      "/2/profile/new-account/statuses",
    ]);
    expect((await db.prepare("SELECT handle FROM accounts").all<{ handle: string }>()).results).toEqual([{ handle: "new-account" }]);
  });

  it("treats status 204 as a successful empty check", async () => {
    await db.prepare("INSERT INTO accounts (id, handle, name, last_post_timestamp) VALUES (?, ?, ?, ?)").bind("a", "alice", "Alice", 1_699_999_900).run();
    await markFollowingAsCurrent();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    const checkedAt = 1_700_000_100_000;
    expect((await collectOnce(accountRuntimeEnv, checkedAt)).accounts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const account = await db.prepare("SELECT last_post_timestamp, last_checked_at FROM accounts WHERE id = ?").bind("a").first<{ last_post_timestamp: number; last_checked_at: string }>();
    expect(account).toEqual({ last_post_timestamp: 1_699_999_900, last_checked_at: "2023-11-14T22:15:00.000Z" });
  });

  it("uses an empty initial status check time as the next since baseline", async () => {
    await db.prepare("INSERT INTO accounts (id, handle, name) VALUES (?, ?, ?)").bind("a", "alice", "Alice").run();
    await markFollowingAsCurrent();
    const status = (id: string, timestamp: number) => ({ id, url: `https://x.com/alice/status/${id}`, text: id, created_timestamp: timestamp, author: { id: "a", screen_name: "alice", name: "Alice" } });
    const checkedAt = 1_700_000_100_000;
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await collectOnce(accountRuntimeEnv, checkedAt);
    expect((await db.prepare("SELECT last_post_timestamp, last_checked_at FROM accounts WHERE id = ?").bind("a").first<{ last_post_timestamp: number; last_checked_at: string }>())).toEqual({
      last_post_timestamp: 1_700_000_100,
      last_checked_at: "2023-11-14T22:15:00.000Z",
    });

    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.searchParams.get("since")).toBe("1700000100");
      expect(parsed.searchParams.get("cursor")).toBeNull();
      return new Response(JSON.stringify({ results: { timeline: Array.from({ length: 6 }, (_, index) => status(`fresh-${index}`, 1_700_000_101 + index)) }, cursor: { bottom: "account-history" } }));
    });
    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.searchParams.get("since")).toBe("1700000100");
      expect(parsed.searchParams.get("cursor")).toBe("account-history");
      return new Response(JSON.stringify({ results: { timeline: Array.from({ length: 6 }, (_, index) => status(`older-${index}`, 1_700_000_100 + index)) }, cursor: { bottom: null } }));
    });
    await collectOnce(accountRuntimeEnv, checkedAt + 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts").first<{ count: number }>())?.count).toBe(12);
    expect((await db.prepare("SELECT last_post_timestamp FROM accounts WHERE id = ?").bind("a").first<{ last_post_timestamp: number }>())?.last_post_timestamp).toBe(1_700_000_106);
    expect(JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("account_status:a").first<{ value: string }>())?.value ?? "null")).toMatchObject({ cursor: null, latest: 1_700_000_106, latest_ids: ["fresh-5"] });
  });

  it("drains same-second account statuses past an idle watermark once", async () => {
    const checkedAt = "2023-11-14T22:15:00.000Z";
    const knownIds = ["known-1", "known-2", "known-3", "known-4", "known-5", "known-6"];
    const status = (id: string) => ({ id, url: `https://x.com/alice/status/${id}`, text: id, created_timestamp: 1_700_000_000, author: { id: "a", screen_name: "alice", name: "Alice" } });
    const freshStatuses = [...knownIds.slice(0, 5), "new-7"].map(status);
    await db.batch([
      db.prepare("INSERT INTO accounts (id, handle, name, last_post_timestamp) VALUES (?, ?, ?, ?)").bind("a", "alice", "Alice", 1_700_000_000),
      db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind("account_status:a", JSON.stringify({ cursor: null, queued_cursor: null, since: null, latest: 1_700_000_000, latest_ids: knownIds }), checkedAt),
    ]);
    await markFollowingAsCurrent();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: freshStatuses }, cursor: { bottom: "backlog-a" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: [status("known-6"), status("new-8")] }, cursor: { bottom: "backlog-b" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: freshStatuses }, cursor: { bottom: "backlog-a" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: [status("new-9")] }, cursor: { bottom: null } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: freshStatuses }, cursor: { bottom: "backlog-a" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } })));

    await collectOnce(accountRuntimeEnv, 1_700_000_101_000);
    await collectOnce(accountRuntimeEnv, 1_700_000_102_000);
    await collectOnce(accountRuntimeEnv, 1_700_000_103_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect((await db.prepare("SELECT id FROM posts ORDER BY id").all<{ id: string }>()).results.map((post) => post.id)).toEqual([
      "known-1", "known-2", "known-3", "known-4", "known-5", "known-6", "new-7", "new-8", "new-9",
    ]);
    const state = JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("account_status:a").first<{ value: string }>())?.value ?? "null") as { cursor: string | null; latest: number; latest_ids: string[] };
    expect(state.cursor).toBeNull();
    expect(state.latest).toBe(1_700_000_000);
    expect(state.latest_ids).toEqual(expect.arrayContaining([...knownIds, "new-7", "new-8", "new-9"]));
    expect(state.latest_ids).toHaveLength(9);

    const postCount = (await db.prepare("SELECT COUNT(*) AS count FROM posts").first<{ count: number }>())?.count;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: freshStatuses }, cursor: { bottom: "should-not-restart" } })));
    await collectOnce(accountRuntimeEnv, 1_700_000_104_000);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts").first<{ count: number }>())?.count).toBe(postCount);
    const afterIdle = JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("account_status:a").first<{ value: string }>())?.value ?? "null") as { cursor: string | null; latest: number; latest_ids: string[] };
    expect(afterIdle.cursor).toBeNull();
    expect(afterIdle.latest).toBe(state.latest);
    expect(afterIdle.latest_ids).toEqual(expect.arrayContaining(state.latest_ids));
    expect(afterIdle.latest_ids).toHaveLength(state.latest_ids.length);
  });

  it("advances the batch position after a failed account and retries it next cycle", async () => {
    for (let index = 0; index < 4; index += 1) {
      const handle = `h${String(index).padStart(2, "0")}`;
      await db.prepare("INSERT INTO accounts (id, handle, name) VALUES (?, ?, ?)").bind(handle, handle, handle).run();
    }
    await markFollowingAsCurrent();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const parsed = new URL(String(input));
      if (parsed.pathname.endsWith("/h00/statuses")) return new Response("failed", { status: 500 });
      return new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } }));
    });

    await collectOnce(accountRuntimeEnv, 1_700_000_100_000);
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("following_scan_position").first<{ value: string }>())?.value).toBe("1");
    fetchMock.mockClear();
    await collectOnce(accountRuntimeEnv, 1_700_000_101_000);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/2/profile/h01/statuses",
    ]);
    fetchMock.mockClear();
    await collectOnce(accountRuntimeEnv, 1_700_000_102_000);
    await collectOnce(accountRuntimeEnv, 1_700_000_103_000);
    await collectOnce(accountRuntimeEnv, 1_700_000_104_000);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toContain("/2/profile/h00/statuses");
  });

  it("checkpoints a search query for an empty 404 result", async () => {
    await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("missing").run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ code: 404, results: [] }), { status: 404 }));

    await collectOnce(runtimeEnv, 1_700_000_100_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await db.prepare("SELECT last_checked_at FROM search_queries WHERE query = ?").bind("missing").first<{ last_checked_at: string }>())?.last_checked_at).toBe("2023-11-14T22:15:00.000Z");
  });

  it("drains backlog after an empty latest checkpoint and does not restart it", async () => {
    await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("empty-then-new").run();
    const queryRow = await db.prepare("SELECT id FROM search_queries WHERE query = ?").bind("empty-then-new").first<{ id: number }>();
    const queryId = queryRow?.id;
    expect(queryId).toBeDefined();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 404, results: [] }), { status: 404 }));
    await collectOnce(runtimeEnv, 1_700_000_100_000);

    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.searchParams.get("cursor")).toBeNull();
      return new Response(JSON.stringify({ results: { timeline: statusFixture("new-latest", 6) }, cursor: { bottom: "old-history" } }));
    });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: Array.from({ length: 6 }, (_, index) => ({
      id: `old-page-1-${index}`, url: `https://x.com/a/status/old-page-1-${index}`, text: "過去1", created_timestamp: 1_699_999_994 + index,
      author: { id: "a", screen_name: "alice", name: "Alice" },
    })) }, cursor: { bottom: "older-history" } })));
    await collectOnce(runtimeEnv, 1_700_000_101_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts").first<{ count: number }>())?.count).toBe(12);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: statusFixture("new-latest", 6) }, cursor: { bottom: "old-history" } })));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: Array.from({ length: 6 }, (_, index) => ({
      id: `old-page-2-${index}`, url: `https://x.com/a/status/old-page-2-${index}`, text: "過去2", created_timestamp: 1_699_999_988 + index,
      author: { id: "a", screen_name: "alice", name: "Alice" },
    })) }, cursor: { bottom: null } })));
    await collectOnce(runtimeEnv, 1_700_000_102_000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts").first<{ count: number }>())?.count).toBe(18);
    expect(JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind(`search_query:${queryId}`).first<{ value: string }>())?.value ?? "null")).toEqual({
      query: "empty-then-new",
      backlog_cursor: null,
      queued_cursor: null,
      stop_watermark: 1_700_000_005,
      stop_ids: ["new-latest-5"],
      pending_latest: null,
      pending_latest_ids: [],
    });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: statusFixture("new-latest", 6) }, cursor: { bottom: "should-not-start" } })));
    await collectOnce(runtimeEnv, 1_700_000_103_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts").first<{ count: number }>())?.count).toBe(18);
  });

  it("rotates search attempts after persistent failures", async () => {
    for (let index = 1; index <= 6; index += 1) {
      await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind(`q${index}`).run();
    }
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const query = new URL(String(input)).searchParams.get("q");
      if (query !== "q6") return new Response("upstream failed", { status: 500 });
      return new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } }));
    });

    for (let index = 0; index < 5; index += 1) {
      await collectOnce(runtimeEnv, 1_700_000_100_000 + index);
    }
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("q"))).toEqual(["q1", "q2", "q3", "q4", "q5"]);
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("search_scan_position").first<{ value: string }>())?.value).toBe("5");

    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } })));
    await collectOnce(runtimeEnv, 1_700_000_105_000);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("q"))).toEqual(["q6"]);
    expect((await db.prepare("SELECT last_checked_at FROM search_queries WHERE query = ?").bind("q6").first<{ last_checked_at: string }>())?.last_checked_at).toBe("2023-11-14T22:15:05.000Z");
  });

  it("fetches fresh latest before backlog and stops at its watermark", async () => {
    await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("cursor-query").run();
    const queryRow = await db.prepare("SELECT id FROM search_queries WHERE query = ?").bind("cursor-query").first<{ id: number }>();
    const queryId = queryRow?.id;
    expect(queryId).toBeDefined();
    await db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind(
      `search_query:${queryId}`,
      JSON.stringify({ query: "cursor-query", backlog_cursor: "search-page-2", stop_watermark: 1_699_999_900, pending_latest: 1_700_000_000 }),
      "2023-11-14T22:00:00.000Z",
    ).run();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/search");
      expect(parsed.searchParams.get("q")).toBe("cursor-query");
      expect(parsed.searchParams.get("feed")).toBe("latest");
      expect(parsed.searchParams.get("cursor")).toBeNull();
      return new Response(JSON.stringify({ results: { timeline: [
        { id: "latest-1", url: "https://x.com/a/status/latest-1", text: "latest 1", created_timestamp: 1_700_000_001, author: { id: "a", screen_name: "alice", name: "Alice" } },
      ] }, cursor: { bottom: "latest-cursor-1" } }));
    });
    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/search");
      expect(parsed.searchParams.get("q")).toBe("cursor-query");
      expect(parsed.searchParams.get("cursor")).toBe("search-page-2");
      return new Response(JSON.stringify({ results: { timeline: [
        { id: "search-1", url: "https://x.com/a/status/search-1", text: "1", created_timestamp: 1_699_999_950, author: { id: "a", screen_name: "alice", name: "Alice" } },
      ] }, cursor: { bottom: "search-page-3" } }));
    });

    await collectOnce(runtimeEnv, 1_700_000_100_000);
    expect((await db.prepare("SELECT last_checked_at FROM search_queries WHERE id = ?").bind(queryId).first<{ last_checked_at: string }>())?.last_checked_at).toBe("2023-11-14T22:15:00.000Z");
    expect(JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind(`search_query:${queryId}`).first<{ value: string }>())?.value ?? "null")).toEqual({
      query: "cursor-query",
      backlog_cursor: "search-page-3",
      queued_cursor: "latest-cursor-1",
      stop_watermark: 1_699_999_900,
      stop_ids: [],
      pending_latest: 1_700_000_001,
      pending_latest_ids: ["latest-1"],
    });

    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/search");
      expect(parsed.searchParams.get("q")).toBe("cursor-query");
      expect(parsed.searchParams.get("cursor")).toBeNull();
      return new Response(JSON.stringify({ results: { timeline: [
        { id: "latest-2", url: "https://x.com/a/status/latest-2", text: "latest 2", created_timestamp: 1_700_000_002, author: { id: "a", screen_name: "alice", name: "Alice" } },
      ] }, cursor: { bottom: "latest-cursor-2" } }));
    });
    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/search");
      expect(parsed.searchParams.get("q")).toBe("cursor-query");
      expect(parsed.searchParams.get("cursor")).toBe("search-page-3");
      return new Response(JSON.stringify({ results: { timeline: [
        { id: "search-2", url: "https://x.com/a/status/search-2", text: "2", created_timestamp: 1_699_999_950, author: { id: "a", screen_name: "alice", name: "Alice" } },
        { id: "search-boundary", url: "https://x.com/a/status/search-boundary", text: "boundary", created_timestamp: 1_699_999_850, author: { id: "a", screen_name: "alice", name: "Alice" } },
      ] }, cursor: { bottom: "ignored-old-page" } }));
    });

    await collectOnce(runtimeEnv, 1_700_000_101_000);
    expect((await db.prepare("SELECT last_checked_at FROM search_queries WHERE id = ?").bind(queryId).first<{ last_checked_at: string }>())?.last_checked_at).toBe("2023-11-14T22:15:01.000Z");
    expect(JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind(`search_query:${queryId}`).first<{ value: string }>())?.value ?? "null")).toEqual({
      query: "cursor-query",
      backlog_cursor: "latest-cursor-2",
      queued_cursor: null,
      stop_watermark: 1_699_999_900,
      stop_ids: [],
      pending_latest: 1_700_000_002,
      pending_latest_ids: ["latest-2"],
    });
    expect((await db.prepare("SELECT id FROM posts ORDER BY id").all<{ id: string }>()).results.map((post) => post.id)).toEqual(["latest-1", "latest-2", "search-1", "search-2", "search-boundary"]);

    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.searchParams.get("cursor")).toBeNull();
      return new Response(JSON.stringify({ results: { timeline: [
        { id: "latest-2", url: "https://x.com/a/status/latest-2", text: "latest 2", created_timestamp: 1_700_000_002, author: { id: "a", screen_name: "alice", name: "Alice" } },
      ] }, cursor: { bottom: "latest-cursor-2" } }));
    });
    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.searchParams.get("cursor")).toBe("latest-cursor-2");
      return new Response(JSON.stringify({ results: { timeline: [
        { id: "queued-new", url: "https://x.com/a/status/queued-new", text: "queued new", created_timestamp: 1_699_999_800, author: { id: "a", screen_name: "alice", name: "Alice" } },
      ] }, cursor: { bottom: null } }));
    });
    await collectOnce(runtimeEnv, 1_700_000_102_000);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts").first<{ count: number }>())?.count).toBe(6);
    expect((await db.prepare("SELECT id FROM posts WHERE id = ?").bind("queued-new").first<{ id: string }>())?.id).toBe("queued-new");
    const idleState = JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind(`search_query:${queryId}`).first<{ value: string }>())?.value ?? "null");
    expect(idleState).toEqual({
      query: "cursor-query",
      backlog_cursor: null,
      queued_cursor: null,
      stop_watermark: 1_700_000_002,
      stop_ids: ["latest-2"],
      pending_latest: null,
      pending_latest_ids: [],
    });

    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/search");
      expect(parsed.searchParams.get("cursor")).toBeNull();
      return new Response(JSON.stringify({ results: { timeline: [
        { id: "latest-2", url: "https://x.com/a/status/latest-2", text: "latest 2", created_timestamp: 1_700_000_002, author: { id: "a", screen_name: "alice", name: "Alice" } },
      ] }, cursor: { bottom: "should-not-start-backlog" } }));
    });
    await collectOnce(runtimeEnv, 1_700_000_103_000);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts").first<{ count: number }>())?.count).toBe(6);
    expect(JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind(`search_query:${queryId}`).first<{ value: string }>())?.value ?? "null")).toEqual(idleState);
  });

  it("starts a backlog only when a newer latest page has a cursor", async () => {
    await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("starts-backlog").run();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.searchParams.get("cursor")).toBeNull();
      return new Response(JSON.stringify({ results: { timeline: [
        { id: "initial", url: "https://x.com/a/status/initial", text: "initial", created_timestamp: 1_700_000_000, author: { id: "a", screen_name: "alice", name: "Alice" } },
      ] }, cursor: { bottom: "initial-history" } }));
    });
    await collectOnce(runtimeEnv, 1_700_000_100_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.searchParams.get("cursor")).toBeNull();
      return new Response(JSON.stringify({ results: { timeline: [
        { id: "newest", url: "https://x.com/a/status/newest", text: "newest", created_timestamp: 1_700_000_001, author: { id: "a", screen_name: "alice", name: "Alice" } },
      ] }, cursor: { bottom: "new-history" } }));
    });
    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.searchParams.get("cursor")).toBe("new-history");
      return new Response(JSON.stringify({ results: { timeline: [
        { id: "older", url: "https://x.com/a/status/older", text: "older", created_timestamp: 1_699_999_999, author: { id: "a", screen_name: "alice", name: "Alice" } },
      ] }, cursor: { bottom: null } }));
    });
    await collectOnce(runtimeEnv, 1_700_000_101_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await db.prepare("SELECT id FROM posts ORDER BY id").all<{ id: string }>()).results.map((post) => post.id)).toEqual(["initial", "newest", "older"]);
  });

  it("tracks same-second search IDs so a new post starts backlog once", async () => {
    await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("same-second").run();
    const sameSecond = (id: string) => ({
      id,
      url: `https://x.com/a/status/${id}`,
      text: id,
      created_timestamp: 1_700_000_000,
      author: { id: "a", screen_name: "alice", name: "Alice" },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: ["s1", "s2", "s3", "s4", "s5", "s6"].map(sameSecond) }, cursor: { bottom: "initial-history" } })));
    await collectOnce(runtimeEnv, 1_700_000_100_000);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: ["s1", "s2", "s3", "s4", "s5", "new-7"].map(sameSecond) }, cursor: { bottom: "same-second-history" } })));
    fetchMock.mockImplementationOnce(async (input) => {
      expect(new URL(String(input)).searchParams.get("cursor")).toBe("same-second-history");
      return new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } }));
    });
    await collectOnce(runtimeEnv, 1_700_000_101_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts").first<{ count: number }>())?.count).toBe(7);

    fetchMock.mockImplementationOnce(async (input) => {
      expect(new URL(String(input)).searchParams.get("cursor")).toBeNull();
      return new Response(JSON.stringify({ results: { timeline: ["s1", "s2", "s3", "s4", "s5", "s6"].map(sameSecond) }, cursor: { bottom: "should-not-start" } }));
    });
    await collectOnce(runtimeEnv, 1_700_000_102_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts").first<{ count: number }>())?.count).toBe(7);
  });

  it("keeps a search cursor when its next page fails", async () => {
    await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("failed-cursor-query").run();
    const queryRow = await db.prepare("SELECT id FROM search_queries WHERE query = ?").bind("failed-cursor-query").first<{ id: number }>();
    const queryId = queryRow?.id;
    expect(queryId).toBeDefined();
    await db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind(
      `search_query:${queryId}`,
      JSON.stringify({ query: "failed-cursor-query", backlog_cursor: "search-page-2", stop_watermark: 1_699_999_900, pending_latest: 1_700_000_000 }),
      "2023-11-14T22:00:00.000Z",
    ).run();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { timeline: statusFixture("fresh", 1) }, cursor: { bottom: null } })))
      .mockResolvedValueOnce(new Response("upstream failed", { status: 500 }));

    await collectOnce(runtimeEnv, 1_700_000_100_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts WHERE id = ?").bind("fresh-0").first<{ count: number }>())?.count).toBe(1);
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind(`search_query:${queryId}`).first<{ value: string }>())?.value).toContain("search-page-2");
    expect((await db.prepare("SELECT last_checked_at FROM search_queries WHERE query = ?").bind("failed-cursor-query").first<{ last_checked_at: string | null }>())?.last_checked_at).toBe("2023-11-14T22:15:00.000Z");
  });

  it("resets a saved search cursor when the query text changes", async () => {
    await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("old-query").run();
    const queryRow = await db.prepare("SELECT id FROM search_queries WHERE query = ?").bind("old-query").first<{ id: number }>();
    const queryId = queryRow?.id;
    expect(queryId).toBeDefined();
    await db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind(
      `search_query:${queryId}`,
      JSON.stringify({ query: "old-query", cursor: "stale-cursor" }),
      "2023-11-14T22:00:00.000Z",
    ).run();
    await db.prepare("UPDATE search_queries SET query = ? WHERE id = ?").bind("new-query", queryId).run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/search");
      expect(parsed.searchParams.get("q")).toBe("new-query");
      expect(parsed.searchParams.get("cursor")).toBeNull();
      return new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } }));
    });

    await collectOnce(runtimeEnv, 1_700_000_100_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const state = JSON.parse((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind(`search_query:${queryId}`).first<{ value: string }>())?.value ?? "null") as { query: string; backlog_cursor: string | null };
    expect(state.query).toBe("new-query");
    expect(state.backlog_cursor).toBeNull();
  });

  it("skips saved account statuses when SOURCE_HANDLE is blank but still searches", async () => {
    await db.prepare("INSERT INTO accounts (id, handle, name) VALUES (?, ?, ?)").bind("a", "alice", "Alice").run();
    await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("still-searches").run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/search");
      expect(parsed.searchParams.get("q")).toBe("still-searches");
      return new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } }));
    });

    const result = await collectOnce(runtimeEnv, 1_700_000_100_000);
    expect(result).toEqual({ following: false, accounts: 0, queries: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await db.prepare("SELECT last_checked_at FROM search_queries WHERE query = ?").bind("still-searches").first<{ last_checked_at: string }>())?.last_checked_at).toBe("2023-11-14T22:15:00.000Z");
  });

  it("serializes overlapping collection runs and releases the lease after completion", async () => {
    let releaseFollowing!: () => void;
    let markFollowingStarted!: () => void;
    const followingGate = new Promise<void>((resolve) => { releaseFollowing = resolve; });
    const followingStarted = new Promise<void>((resolve) => { markFollowingStarted = resolve; });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const parsed = new URL(String(input));
      if (parsed.pathname === "/2/profile/source/following") {
        markFollowingStarted();
        await followingGate;
        return new Response(JSON.stringify({ results: { users: [{ id: "a", screen_name: "alice", name: "Alice" }] }, cursor: { bottom: null } }));
      }
      if (parsed.pathname === "/2/profile/alice/statuses") {
        return new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } }));
      }
      return new Response(JSON.stringify({ code: 404, results: [] }), { status: 404 });
    });

    const start = 1_700_000_100_000;
    const firstRun = collectOnce(accountRuntimeEnv, start);
    await followingStarted;
    expect(await collectOnce(accountRuntimeEnv, start)).toEqual({ following: false, accounts: 0, queries: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const leaseReadAt = Date.now();
    const lease = await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("collection_lease").first<{ value: string }>();
    const leaseExpiresAt = Number(lease?.value.split(":", 1)[0]);
    expect(leaseExpiresAt).toBeGreaterThan(leaseReadAt + 8 * 60 * 1000);
    expect(leaseExpiresAt).toBeLessThan(leaseReadAt + 12 * 60 * 1000);

    releaseFollowing();
    expect(await firstRun).toEqual({ following: true, accounts: 0, queries: 0 });
    expect((await db.prepare("SELECT COUNT(*) AS count FROM accounts").first<{ count: number }>())?.count).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM collector_state WHERE key = ?").bind("collection_lease").first<{ count: number }>())?.count).toBe(0);

    expect((await collectOnce(accountRuntimeEnv, start + 25 * 60 * 60 * 1000)).following).toBe(true);
    expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname === "/2/profile/source/following")).toHaveLength(2);
  });

  it("releases the collection lease when following fails so a later run can retry", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "failed" }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { users: [] }, cursor: { bottom: null } })));
    const start = 1_700_000_100_000;

    expect(await collectOnce(accountRuntimeEnv, start)).toEqual({ following: false, accounts: 0, queries: 0 });
    expect((await db.prepare("SELECT COUNT(*) AS count FROM collector_state WHERE key = ?").bind("collection_lease").first<{ count: number }>())?.count).toBe(0);
    expect((await collectOnce(accountRuntimeEnv, start + 1_000)).following).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers an expired collection lease and releases it after the run", async () => {
    const start = 1_700_000_100_000;
    await db.prepare("INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)").bind(
      "collection_lease",
      `${start - 1}:expired-token`,
      new Date(start - 1).toISOString(),
    ).run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: { users: [] }, cursor: { bottom: null } })));

    expect(await collectOnce(accountRuntimeEnv, start)).toEqual({ following: true, accounts: 0, queries: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM collector_state WHERE key = ?").bind("collection_lease").first<{ count: number }>())?.count).toBe(0);
  });

  it("runs collection from the scheduled handler", async () => {
    await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("scheduled").run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ code: 200, results: { timeline: [] }, cursor: { bottom: null } })));

    await worker.scheduled({ scheduledTime: 1_700_000_100_000, cron: "*/15 * * * *", noRetry() {} }, adminRuntimeEnv);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await db.prepare("SELECT last_checked_at FROM search_queries WHERE query = ?").bind("scheduled").first<{ last_checked_at: string }>())?.last_checked_at).toBe("2023-11-14T22:15:00.000Z");
  });
});

describe("feed", () => {
  it("returns the feed envelope, pagination, ISO dates, quote objects, and ordering", async () => {
    const now = Math.floor(Date.now() / 1000);
    const collectedAt = new Date(now * 1000).toISOString();
    await db.batch([
      ["z", now, null, { views: 1_000, bookmarks: 20, media: { photos: [{ type: "photo", url: "https://example.com/z.jpg", width: 100, height: 100 }] } }],
      ["2", now - 10, null, null],
      ["1", now - 10, { id: "q", text: "引用" }, null],
      ["old", now - 7200, null, null],
    ].map(([id, timestamp, quote, details]) => db.prepare(`INSERT INTO posts
      (id, url, text, created_timestamp, author_id, author_screen_name, author_name, quote_json, details_json, source_kind, source_key, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      id,
      `https://x.com/a/status/${id}`,
      "本文",
      timestamp,
      "a",
      "alice",
      "Alice",
      quote ? JSON.stringify(quote) : null,
      details ? JSON.stringify(details) : null,
      "search",
      "cloudflare",
      collectedAt,
    )));

    const first = await worker.fetch(new Request("https://localhost/feed?page=1&limit=2&hours=1"), env);
    expect(first.status).toBe(200);
    const body = await first.json() as { generated_at: string; page: number; limit: number; hours: number; posts: Array<{ id: string; created_at: string; quote: unknown; views: number | null; bookmarks: number | null; media: unknown }>; items?: unknown };
    expect(body.generated_at).toMatch(/Z$/);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(2);
    expect(body.hours).toBe(1);
    expect(body.items).toBeUndefined();
    expect(body.posts.map((post) => post.id)).toEqual(["z", "2"]);
    expect(body.posts[0].created_at).toBe(new Date(now * 1000).toISOString());
    expect(body.posts[0]).toMatchObject({ views: 1_000, bookmarks: 20 });
    expect(body.posts[0].media).toEqual({ photos: [{ type: "photo", url: "https://example.com/z.jpg", width: 100, height: 100 }] });

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

describe("candidates", () => {
  it("removes near-zero search results and ranks bookmark-like posts with media details", async () => {
    const now = Math.floor(Date.now() / 1000);
    const collectedAt = new Date(now * 1000).toISOString();
    const insert = (post: {
      id: string;
      ageHours: number;
      likes: number;
      reposts?: number;
      quotes?: number;
      quote?: Record<string, unknown> | null;
      details?: Record<string, unknown> | null;
      sourceKind?: "search" | "following";
      author?: string;
      sourceKey?: string;
    }) => db.prepare(`INSERT INTO posts
      (id, url, text, created_timestamp, likes, reposts, quotes, author_id, author_screen_name,
       author_name, quote_json, details_json, source_kind, source_key, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      post.id,
      `https://x.com/alice/status/${post.id}`,
      post.id === "useful" ? "現場で得た具体的な知見".repeat(8) : post.id,
      now - post.ageHours * 3600,
      post.likes,
      post.reposts ?? 0,
      post.quotes ?? 0,
      post.author ?? "a",
      post.author ?? "alice",
      post.author ?? "Alice",
      post.quote ? JSON.stringify(post.quote) : null,
      post.details ? JSON.stringify(post.details) : null,
      post.sourceKind ?? "search",
      post.sourceKey ?? (post.sourceKind === "following" ? "alice" : "test query"),
      collectedAt,
    );

    await db.batch([
      insert({ id: "popular-image", ageHours: 12, likes: 300, reposts: 50, quotes: 10, quote: { id: "quoted" }, details: {
        bookmarks: 500,
        views: 50_000,
        media: { photos: [{ type: "photo", url: "https://example.com/popular.jpg", width: 100, height: 100 }] },
      } }),
      insert({ id: "useful", ageHours: 12, likes: 60, details: { bookmarks: 30, views: 5_000 } }),
      insert({ id: "followed", ageHours: 20, likes: 50, sourceKind: "following" }),
      insert({ id: "different", ageHours: 12, likes: 55, details: { bookmarks: 20 }, author: "bob", sourceKey: "other query" }),
      insert({ id: "one-like-image", ageHours: 1, likes: 1, details: {
        bookmarks: 0,
        views: 20,
        media: { photos: [{ type: "photo", url: "https://example.com/weak.jpg", width: 100, height: 100 }] },
      } }),
    ]);

    const response = await worker.fetch(new Request("https://localhost/candidates?hours=24&limit=10"), env);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      criteria: { search_minimum_likes_at_24h: number };
      posts: Array<{ id: string; bookmarks: number | null; views: number | null; media: unknown; selection: { signals: string[] } }>;
    };
    expect(body.criteria.search_minimum_likes_at_24h).toBe(100);
    expect(body.posts.map((post) => post.id)).toEqual(["popular-image", "different", "useful", "followed"]);
    expect(body.posts[0]).toMatchObject({ bookmarks: 500, views: 50_000 });
    expect(body.posts[0].media).toEqual({ photos: [{ type: "photo", url: "https://example.com/popular.jpg", width: 100, height: 100 }] });
    expect(body.posts[0].selection.signals).toEqual(expect.arrayContaining(["popular", "bookmarked_by_many", "media", "quote"]));

    const diverse = await worker.fetch(new Request("https://localhost/candidates?hours=24&limit=2"), env);
    expect((await diverse.json() as { posts: Array<{ id: string }> }).posts.map((post) => post.id)).toEqual(["popular-image", "different"]);
  });

  it("rejects invalid candidate limits", async () => {
    const response = await worker.fetch(new Request("https://localhost/candidates?limit=51"), env);
    expect(response.status).toBe(400);
  });

  it("limits candidate hours before querying D1 while leaving feed hours unrestricted", async () => {
    const tracked = countD1Queries(db);
    for (const hours of ["0", "24.0001", "1000000", "Infinity", "NaN"]) {
      const response = await worker.fetch(new Request(`https://localhost/candidates?hours=${hours}`), { ...env, DB: tracked.db });
      expect(response.status).toBe(400);
    }
    expect(tracked.queries).toHaveLength(0);

    const candidatesAtLimit = await worker.fetch(new Request("https://localhost/candidates?hours=24"), env);
    expect(candidatesAtLimit.status).toBe(200);

    const feed = await worker.fetch(new Request("https://localhost/feed?hours=48"), env);
    expect(feed.status).toBe(200);
    expect((await feed.json() as { hours: number }).hours).toBe(48);
  });

  it("uses stable author IDs for diversity after a handle change", async () => {
    const now = Math.floor(Date.now() / 1000);
    const collectedAt = new Date(now * 1000).toISOString();
    const insert = (id: string, author: string, authorId: string, likes: number, sourceKey: string) => db.prepare(`INSERT INTO posts
      (id, url, text, created_timestamp, likes, reposts, quotes, author_id, author_screen_name,
       author_name, quote_json, details_json, source_kind, source_key, collected_at)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, NULL, NULL, 'search', ?, ?)`).bind(
      id,
      `https://x.com/${author}/status/${id}`,
      id,
      now - 12 * 3600,
      likes,
      authorId,
      author,
      author,
      sourceKey,
      collectedAt,
    );
    await db.batch([
      insert("handle-before", "alice-old", "stable-author", 300, "query-before"),
      insert("handle-after", "alice-new", "stable-author", 250, "query-after"),
      insert("other-author", "bob", "other-author", 100, "query-other"),
    ]);

    const response = await worker.fetch(new Request("https://localhost/candidates?hours=24&limit=2"), env);
    expect(response.status).toBe(200);
    const body = await response.json() as { posts: Array<{ id: string; author: { id: string } }> };
    expect(body.posts.map((post) => post.id)).toEqual(["handle-before", "other-author"]);
    expect(body.posts.map((post) => post.author.id)).toEqual(["stable-author", "other-author"]);
  });

  it("keeps a bookmark-qualified post among all eligible rows", async () => {
    const now = Math.floor(Date.now() / 1000);
    const createdTimestamp = now - 23 * 3600;
    const collectedAt = new Date(now * 1000).toISOString();
    await db.prepare(`WITH RECURSIVE noise(n) AS (
      SELECT 1
      UNION ALL
      SELECT n + 1 FROM noise WHERE n < 200
    )
    INSERT INTO posts
      (id, url, text, created_timestamp, likes, reposts, quotes, replies, author_id,
       author_screen_name, author_name, quote_json, details_json, source_kind, source_key, collected_at)
    SELECT
      'noise-' || n, 'https://x.com/noise/status/' || n, 'ノイズ', ?, 10, 0, 0, 0,
      'noise', 'noise', 'Noise', NULL, NULL, 'search', 'noise query', ?
    FROM noise`).bind(createdTimestamp, collectedAt).run();
    await db.prepare(`INSERT INTO posts
      (id, url, text, created_timestamp, likes, reposts, quotes, replies, author_id,
       author_screen_name, author_name, quote_json, details_json, source_kind, source_key, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      "bookmark-qualified",
      "https://x.com/alice/status/bookmark-qualified",
      "保存されそうな投稿",
      createdTimestamp,
      0,
      0,
      0,
      0,
      "a",
      "alice",
      "Alice",
      null,
      JSON.stringify({ bookmarks: 100 }),
      "search",
      "bookmark query",
      collectedAt,
    ).run();

    const response = await worker.fetch(new Request("https://localhost/candidates?hours=24&limit=1"), env);
    expect(response.status).toBe(200);
    const body = await response.json() as { posts: Array<{ id: string; bookmarks: number | null }> };
    expect(body.posts).toHaveLength(1);
    expect(body.posts[0]).toMatchObject({ id: "bookmark-qualified", bookmarks: 100 });
  });

  it("keeps a format-rich candidate when all eligible rows are scored", async () => {
    const now = Math.floor(Date.now() / 1000);
    const createdTimestamp = now - 23 * 3600;
    const collectedAt = new Date(now * 1000).toISOString();
    await db.prepare(`WITH RECURSIVE noise(n) AS (
      SELECT 1
      UNION ALL
      SELECT n + 1 FROM noise WHERE n < 200
    )
    INSERT INTO posts
      (id, url, text, created_timestamp, likes, reposts, quotes, replies, author_id,
       author_screen_name, author_name, quote_json, details_json, source_kind, source_key, collected_at)
    SELECT
      'plain-' || n, 'https://x.com/plain/status/' || n, 'プレーンな適格投稿', ?, 130, 0, 0, 0,
      'plain-' || n, 'plain-' || n, 'Plain', NULL, NULL, 'search', 'plain query', ?
    FROM noise`).bind(createdTimestamp, collectedAt).run();
    await db.prepare(`INSERT INTO posts
      (id, url, text, created_timestamp, likes, reposts, quotes, replies, author_id,
       author_screen_name, author_name, quote_json, details_json, source_kind, source_key, collected_at)
      VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, 'search', ?, ?)`).bind(
      "format-rich",
      "https://x.com/target/status/format-rich",
      "具体的な長文の知見".repeat(40),
      createdTimestamp,
      96,
      "target",
      "target",
      "Target",
      JSON.stringify({ id: "quoted" }),
      JSON.stringify({ media: { photos: [{ url: "https://example.com/target.jpg" }] } }),
      "target query",
      collectedAt,
    ).run();

    const response = await worker.fetch(new Request("https://localhost/candidates?hours=24&limit=1"), env);
    expect(response.status).toBe(200);
    const body = await response.json() as { posts: Array<{ id: string; selection: { signals: string[] } }> };
    expect(body.posts.map((post) => post.id)).toEqual(["format-rich"]);
    expect(body.posts[0].selection.signals).toEqual(expect.arrayContaining(["media", "quote", "detailed"]));
  });

  it("keeps a following-qualified post after SQL eligibility filtering", async () => {
    const now = Math.floor(Date.now() / 1000);
    const createdTimestamp = now - 23 * 3600;
    const collectedAt = new Date(now * 1000).toISOString();
    await db.prepare(`WITH RECURSIVE noise(n) AS (
      SELECT 1
      UNION ALL
      SELECT n + 1 FROM noise WHERE n < 200
    )
    INSERT INTO posts
      (id, url, text, created_timestamp, likes, reposts, quotes, replies, author_id,
       author_screen_name, author_name, quote_json, details_json, source_kind, source_key, collected_at)
    SELECT
      'noise-' || n, 'https://x.com/noise/status/' || n, 'ノイズ', ?, 95, 0, 0, 0,
      'noise', 'noise', 'Noise', NULL, NULL, 'search', 'noise query', ?
    FROM noise`).bind(createdTimestamp, collectedAt).run();
    await db.prepare(`INSERT INTO posts
      (id, url, text, created_timestamp, likes, reposts, quotes, replies, author_id,
       author_screen_name, author_name, quote_json, details_json, source_kind, source_key, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      "following-qualified",
      "https://x.com/alice/status/following-qualified",
      "フォロー中の投稿",
      createdTimestamp,
      48,
      0,
      0,
      0,
      "a",
      "alice",
      "Alice",
      null,
      null,
      "following",
      "alice",
      collectedAt,
    ).run();

    const response = await worker.fetch(new Request("https://localhost/candidates?hours=24&limit=1"), env);
    expect(response.status).toBe(200);
    const body = await response.json() as { evaluated: number; posts: Array<{ id: string }> };
    expect(body.evaluated).toBe(1);
    expect(body.posts.map((post) => post.id)).toEqual(["following-qualified"]);
  });

  it("applies the ten-like minimum to recent search rows in SQL eligibility", async () => {
    const now = Math.floor(Date.now() / 1000);
    const createdTimestamp = now - 3600;
    const collectedAt = new Date(now * 1000).toISOString();
    await db.prepare(`WITH RECURSIVE noise(n) AS (
      SELECT 1
      UNION ALL
      SELECT n + 1 FROM noise WHERE n < 200
    )
    INSERT INTO posts
      (id, url, text, created_timestamp, likes, reposts, quotes, replies, author_id,
       author_screen_name, author_name, quote_json, details_json, source_kind, source_key, collected_at)
    SELECT
      'noise-' || n, 'https://x.com/noise/status/' || n, 'ノイズ', ?, 9, 100, 100, 0,
      'noise', 'noise', 'Noise', NULL, NULL, 'search', 'noise query', ?
    FROM noise`).bind(createdTimestamp, collectedAt).run();
    await db.prepare(`INSERT INTO posts
      (id, url, text, created_timestamp, likes, reposts, quotes, replies, author_id,
       author_screen_name, author_name, quote_json, details_json, source_kind, source_key, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      "recent-following-qualified",
      "https://x.com/alice/status/recent-following-qualified",
      "フォロー中の新しい投稿",
      createdTimestamp,
      10,
      0,
      0,
      0,
      "a",
      "alice",
      "Alice",
      null,
      null,
      "following",
      "alice",
      collectedAt,
    ).run();

    const response = await worker.fetch(new Request("https://localhost/candidates?hours=24&limit=1"), env);
    expect(response.status).toBe(200);
    const body = await response.json() as { evaluated: number; posts: Array<{ id: string }> };
    expect(body.evaluated).toBe(1);
    expect(body.posts.map((post) => post.id)).toEqual(["recent-following-qualified"]);
  });

  it("preserves author and source diversity after scoring all eligible rows", async () => {
    const now = Math.floor(Date.now() / 1000);
    const createdTimestamp = now - 23 * 3600;
    const collectedAt = new Date(now * 1000).toISOString();
    const insert = (id: string, author: string, sourceKey: string, likes: number) => db.prepare(`INSERT INTO posts
      (id, url, text, created_timestamp, likes, reposts, quotes, replies, author_id,
       author_screen_name, author_name, quote_json, details_json, source_kind, source_key, collected_at)
      VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, NULL, NULL, 'search', ?, ?)`).bind(
      id,
      `https://x.com/${author}/status/${id}`,
      id,
      createdTimestamp,
      likes,
      author,
      author,
      author,
      sourceKey,
      collectedAt,
    );
    await db.batch([
      ...Array.from({ length: 30 }, (_, index) => insert(`same-author-${index + 1}`, "duplicate-author", `same-author-source-${index + 1}`, 130)),
      ...Array.from({ length: 30 }, (_, index) => insert(`same-source-${index + 1}`, `same-source-author-${index + 1}`, "same-source", 130)),
      ...Array.from({ length: 20 }, (_, index) => insert(`diverse-${index + 1}`, `diverse-author-${index + 1}`, `diverse-source-${index + 1}`, 100)),
    ]);

    const tracked = countD1Queries(db);
    const response = await worker.fetch(new Request("https://localhost/candidates"), { ...env, DB: tracked.db });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      evaluated: number;
      posts: Array<{ id: string; author: { id: string }; source: { key: string } }>;
    };
    expect(tracked.queries).toHaveLength(1);
    expect(body.evaluated).toBe(80);
    expect(body.posts).toHaveLength(20);
    expect(new Set(body.posts.map((post) => post.author.id)).size).toBe(20);
    expect(new Set(body.posts.map((post) => post.source.key)).size).toBe(20);
    expect(body.posts.filter((post) => post.id.startsWith("diverse-")).length).toBeGreaterThanOrEqual(18);
  });
});

describe("queries", () => {
  function request(path: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${adminRuntimeEnv.ADMIN_TOKEN}`);
    return new Request(`https://localhost${path}`, { ...init, headers });
  }

  it("requires the configured bearer token", async () => {
    await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("keep").run();

    const missing = await worker.fetch(new Request("https://localhost/queries"), adminRuntimeEnv);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe('Bearer realm="queries"');

    const wrong = await worker.fetch(new Request("https://localhost/queries", {
      headers: { authorization: "Bearer wrong-token" },
    }), adminRuntimeEnv);
    expect(wrong.status).toBe(401);
    expect((await db.prepare("SELECT enabled FROM search_queries WHERE query = ?").bind("keep").first<{ enabled: number }>())?.enabled).toBe(1);
  });

  it("lists and atomically replaces the active search terms", async () => {
    await db.batch([
      db.prepare("INSERT INTO search_queries (query, enabled, last_checked_at) VALUES (?, 1, ?)").bind("Cloudflare Workers", "2026-08-31T00:00:00.000Z"),
      db.prepare("INSERT INTO search_queries (query, enabled) VALUES (?, 1)").bind("old query"),
      db.prepare("INSERT INTO search_queries (query, enabled) VALUES (?, 0)").bind("disabled query"),
    ]);

    const before = await worker.fetch(request("/queries"), adminRuntimeEnv);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ queries: [
      { query: "Cloudflare Workers", last_checked_at: "2026-08-31T00:00:00.000Z" },
      { query: "old query", last_checked_at: null },
    ] });

    const replaced = await worker.fetch(request("/queries", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: [" Cloudflare Workers ", "Astro web framework"] }),
    }), adminRuntimeEnv);
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toEqual({ queries: [
      { query: "Cloudflare Workers", last_checked_at: "2026-08-31T00:00:00.000Z" },
      { query: "Astro web framework", last_checked_at: null },
    ] });
    expect((await db.prepare("SELECT query, enabled FROM search_queries ORDER BY id").all<{ query: string; enabled: number }>()).results).toEqual([
      { query: "Cloudflare Workers", enabled: 1 },
      { query: "old query", enabled: 0 },
      { query: "disabled query", enabled: 0 },
      { query: "Astro web framework", enabled: 1 },
    ]);

    const emptied = await worker.fetch(request("/queries", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: [] }),
    }), adminRuntimeEnv);
    expect(await emptied.json()).toEqual({ queries: [] });
  });

  it("rejects invalid and oversized replacements without changing the active terms", async () => {
    await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("keep").run();

    const duplicate = await worker.fetch(request("/queries", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: ["Cloudflare", " cloudflare "] }),
    }), adminRuntimeEnv);
    expect(duplicate.status).toBe(400);

    const oversized = await worker.fetch(request("/queries", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: ["x".repeat(33_000)] }),
    }), adminRuntimeEnv);
    expect(oversized.status).toBe(413);
    expect((await db.prepare("SELECT query, enabled FROM search_queries").all<{ query: string; enabled: number }>()).results).toEqual([
      { query: "keep", enabled: 1 },
    ]);
  });
});
