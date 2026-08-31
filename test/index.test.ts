import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { collectOnce, normalizeStatus, syncFollowingPage } from "../src/index";

const db = env.DB;
const runtimeEnv = { DB: db, SOURCE_HANDLE: "" };
const accountRuntimeEnv = { DB: db, SOURCE_HANDLE: "source" };

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
    });
    expect(status?.reposts).toBe(7);
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
        expect(parsed.searchParams.get("count")).toBe("6");
        expect(parsed.searchParams.get("with_replies")).toBeNull();
        return new Response(JSON.stringify({ code: 200, results: { timeline: [
          { id: "1", url: "https://x.com/alice/status/1", text: "投稿", created_timestamp: 1_700_000_000, author: { id: "a", screen_name: "alice", name: "Alice" } },
          { id: "2", url: "https://x.com/alice/status/2", text: "返信", created_timestamp: 1_700_000_001, replying_to: "1", author: { id: "a", screen_name: "alice", name: "Alice" } },
        ] }, cursor: { bottom: null } }));
      }
      if (parsed.pathname === "/2/search") {
        expect(parsed.searchParams.get("feed")).toBe("latest");
        expect(parsed.searchParams.get("count")).toBe("6");
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

  it("uses bounded multi-row statements for 20 following accounts and 6 posts", async () => {
    const start = 1_700_000_100_000;
    const counter = countD1Queries(db);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const parsed = new URL(String(input));
      if (parsed.pathname === "/2/profile/source/following") {
        expect(parsed.searchParams.get("count")).toBe("20");
        return new Response(JSON.stringify({ results: { users: Array.from({ length: 20 }, (_, index) => ({
          id: `following-${index}`, screen_name: `following-${index}`, name: `Following ${index}`,
        })) }, cursor: { bottom: null } }));
      }
      if (parsed.pathname === "/2/profile/alice/statuses") {
        expect(parsed.searchParams.get("count")).toBe("6");
        return new Response(JSON.stringify({ results: { timeline: statusFixture("account", 6) }, cursor: { bottom: null } }));
      }
      throw new Error(`unexpected fetch: ${parsed.pathname}`);
    });

    await syncFollowingPage(counter.db, "source", start);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM accounts").first<{ count: number }>())?.count).toBe(20);
    const accountStatements = counter.queries.filter((sql) => sql.includes("INSERT INTO accounts"));
    expect(accountStatements).toHaveLength(1);
    expect((accountStatements[0].match(/\?/g) ?? []).length).toBe(100);

    await db.batch([
      db.prepare("DELETE FROM accounts"),
      db.prepare("DELETE FROM collector_state"),
      db.prepare("DELETE FROM posts"),
    ]);
    await db.prepare("INSERT INTO accounts (id, handle, name) VALUES (?, ?, ?)").bind("a", "alice", "Alice").run();
    await markFollowingAsCurrent();
    counter.queries.length = 0;

    await collectOnce({ DB: counter.db, SOURCE_HANDLE: "source" }, start);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts").first<{ count: number }>())?.count).toBe(6);
    const postStatements = counter.queries.filter((sql) => sql.includes("INSERT OR IGNORE INTO posts"));
    expect(postStatements).toHaveLength(1);
    expect((postStatements[0].match(/\?/g) ?? []).length).toBe(90);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not advance following state when the upstream exceeds count=20", async () => {
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
      expect(parsed.searchParams.get("count")).toBe("20");
      expect(parsed.searchParams.get("cursor")).toBe("old-cursor");
      return new Response(JSON.stringify({ results: { users: Array.from({ length: 21 }, (_, index) => ({
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

  it("does not advance account state when statuses exceed count=6", async () => {
    await db.prepare("INSERT INTO accounts (id, handle, name) VALUES (?, ?, ?)").bind("a", "alice", "Alice").run();
    await markFollowingAsCurrent();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/profile/alice/statuses");
      expect(parsed.searchParams.get("count")).toBe("6");
      return new Response(JSON.stringify({ results: { timeline: statusFixture("too-many-statuses", 7) }, cursor: { bottom: "unexpected" } }));
    });

    expect((await collectOnce(accountRuntimeEnv, 1_700_000_100_000)).accounts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM posts").first<{ count: number }>())?.count).toBe(0);
    expect((await db.prepare("SELECT last_post_timestamp, last_checked_at FROM accounts WHERE id = ?").bind("a").first<{ last_post_timestamp: number | null; last_checked_at: string | null }>())).toEqual({ last_post_timestamp: null, last_checked_at: null });
    expect((await db.prepare("SELECT COUNT(*) AS count FROM collector_state WHERE key = ?").bind("account_status:a").first<{ count: number }>())?.count).toBe(0);
  });

  it("does not advance search state when results exceed count=6", async () => {
    await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind("too-many-results").run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/search");
      expect(parsed.searchParams.get("count")).toBe("6");
      return new Response(JSON.stringify({ results: { timeline: statusFixture("too-many-results", 7) }, cursor: { bottom: "unexpected" } }));
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
        expect(parsed.searchParams.get("count")).toBe("6");
        return new Response(JSON.stringify({ results: { timeline: statusFixture(parsed.pathname.split("/").at(-2) ?? "account", 6) }, cursor: { bottom: parsed.searchParams.has("cursor") ? null : "account-backlog" } }));
      }
      if (parsed.pathname === "/2/search") {
        expect(parsed.searchParams.get("count")).toBe("6");
        const isBacklog = parsed.searchParams.has("cursor");
        return new Response(JSON.stringify({ results: { timeline: statusFixture(parsed.searchParams.get("q") ?? "query", 6) }, cursor: { bottom: isBacklog ? null : "fresh-cursor" } }));
      }
      throw new Error(`unexpected fetch: ${parsed.pathname}`);
    });

    const result = await collectOnce({ DB: counter.db, SOURCE_HANDLE: "source" }, 1_700_000_100_000);
    expect(result).toEqual({ following: false, accounts: 2, queries: 3 });
    expect(counter.queries.length).toBe(49);
    expect(counter.queries.length).toBeLessThanOrEqual(50);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("keeps a following final page and three searches within 50 D1 queries", async () => {
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
        expect(parsed.searchParams.get("count")).toBe("20");
        return new Response(JSON.stringify({ results: { users: Array.from({ length: 20 }, (_, index) => ({
          id: `following-${index}`, screen_name: `following-${index}`, name: `Following ${index}`,
        })) }, cursor: { bottom: null } }));
      }
      if (parsed.pathname === "/2/search") {
        expect(parsed.searchParams.get("count")).toBe("6");
        const isBacklog = parsed.searchParams.has("cursor");
        return new Response(JSON.stringify({ results: { timeline: statusFixture(parsed.searchParams.get("q") ?? "query", 6) }, cursor: { bottom: isBacklog ? null : "fresh-cursor" } }));
      }
      throw new Error(`unexpected fetch: ${parsed.pathname}`);
    });

    const result = await collectOnce({ DB: counter.db, SOURCE_HANDLE: "source" }, start);
    expect(result).toEqual({ following: true, accounts: 0, queries: 3 });
    expect(counter.queries.length).toBe(43);
    expect(counter.queries.length).toBeLessThanOrEqual(50);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/2/profile/source/following",
      "/2/search",
      "/2/search",
      "/2/search",
      "/2/search",
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
      expect(parsed.searchParams.get("count")).toBe("20");
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
    expect((await db.prepare("SELECT COUNT(*) AS count FROM collector_state WHERE key = ?").bind("account_status:a").first<{ count: number }>())?.count).toBe(0);
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
    expect((await db.prepare("SELECT COUNT(*) AS count FROM collector_state WHERE key = ?").bind("account_status:a").first<{ count: number }>())?.count).toBe(0);
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
    expect((await db.prepare("SELECT COUNT(*) AS count FROM collector_state WHERE key = ?").bind("account_status:a").first<{ count: number }>())?.count).toBe(0);
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
    expect((await db.prepare("SELECT COUNT(*) AS count FROM collector_state WHERE key = ?").bind("account_status:a").first<{ count: number }>())?.count).toBe(0);
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
    expect((await db.prepare("SELECT COUNT(*) AS count FROM collector_state WHERE key = ?").bind("account_status:a").first<{ count: number }>())?.count).toBe(0);
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
    expect((await db.prepare("SELECT COUNT(*) AS count FROM collector_state WHERE key = ?").bind("account_status:a").first<{ count: number }>())?.count).toBe(0);
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
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("following_scan_position").first<{ value: string }>())?.value).toBe("2");
    fetchMock.mockClear();
    await collectOnce(accountRuntimeEnv, 1_700_000_101_000);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/2/profile/h02/statuses",
      "/2/profile/h03/statuses",
    ]);
    fetchMock.mockClear();
    await collectOnce(accountRuntimeEnv, 1_700_000_102_000);
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

  it("rotates search attempts after three persistent failures", async () => {
    for (let index = 1; index <= 6; index += 1) {
      await db.prepare("INSERT INTO search_queries (query) VALUES (?)").bind(`q${index}`).run();
    }
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const query = new URL(String(input)).searchParams.get("q");
      if (query !== "q6") return new Response("upstream failed", { status: 500 });
      return new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } }));
    });

    await collectOnce(runtimeEnv, 1_700_000_100_000);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("q"))).toEqual(["q1", "q2", "q3"]);
    expect((await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind("search_scan_position").first<{ value: string }>())?.value).toBe("3");

    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ results: { timeline: [] }, cursor: { bottom: null } })));
    await collectOnce(runtimeEnv, 1_700_000_101_000);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("q"))).toEqual(["q4", "q5", "q6"]);
    expect((await db.prepare("SELECT last_checked_at FROM search_queries WHERE query = ?").bind("q6").first<{ last_checked_at: string }>())?.last_checked_at).toBe("2023-11-14T22:15:01.000Z");
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
      backlog_cursor: null,
      stop_watermark: 1_700_000_002,
      stop_ids: ["latest-2"],
      pending_latest: null,
      pending_latest_ids: [],
    });
    expect((await db.prepare("SELECT id FROM posts ORDER BY id").all<{ id: string }>()).results.map((post) => post.id)).toEqual(["latest-1", "latest-2", "search-1", "search-2", "search-boundary"]);

    fetchMock.mockImplementationOnce(async (input) => {
      const parsed = new URL(String(input));
      expect(parsed.pathname).toBe("/2/search");
      expect(parsed.searchParams.get("cursor")).toBeNull();
      return new Response(JSON.stringify({ results: { timeline: [
        { id: "latest-2", url: "https://x.com/a/status/latest-2", text: "latest 2", created_timestamp: 1_700_000_002, author: { id: "a", screen_name: "alice", name: "Alice" } },
      ] }, cursor: { bottom: "should-not-start-backlog" } }));
    });
    await collectOnce(runtimeEnv, 1_700_000_102_000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
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
