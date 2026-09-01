type JsonRecord = Record<string, unknown>;

type ApiStatus = {
  id: string;
  url: string;
  text: string;
  createdTimestamp: number;
  likes: number;
  reposts: number;
  quotes: number;
  replies: number;
  author: { id: string; screenName: string; name: string };
  quote: JsonRecord | null;
  details: JsonRecord | null;
  isReply: boolean;
};

type ApiAccount = {
  id: string;
  handle: string;
  name: string;
  protected: boolean;
};

type DbAccount = {
  id: string;
  handle: string;
  name: string;
  protected: number;
  last_post_timestamp: number | null;
  last_checked_at: string | null;
};

type AccountStatusCheckpoint = {
  cursor: string | null;
  queuedCursor: string | null;
  since: number | null;
  latest: number | null;
  latestIds: string[];
};

type SearchQueryCheckpoint = {
  query: string;
  backlogCursor: string | null;
  queuedCursor: string | null;
  stopWatermark: number | null;
  stopIds: string[];
  pendingLatest: number | null;
  pendingLatestIds: string[];
};

type DbQuery = {
  id: number;
  query: string;
  last_checked_at: string | null;
};

type ManagedQuery = {
  query: string;
  last_checked_at: string | null;
};

type DbFeedRow = {
  id: string;
  url: string;
  text: string;
  created_timestamp: number;
  likes: number;
  reposts: number;
  quotes: number;
  replies: number;
  author_id: string;
  author_screen_name: string;
  author_name: string;
  quote_json: string | null;
  details_json: string | null;
  source_kind: string;
  source_key: string;
};

type WorkerEnv = Cloudflare.Env;
type RuntimeEnv = Pick<WorkerEnv, "DB"> & { SOURCE_HANDLE: string };

const API_BASE = "https://api.fxtwitter.com";
const FETCH_TIMEOUT_MS = 10_000;
const FOLLOWING_API_COUNT = 50;
const FOLLOWING_DB_CHUNK = 20;
const STATUS_API_COUNT = 25;
const SEARCH_API_COUNT = 25;
const POST_DB_CHUNK = 6;
const MAX_ACCOUNTS_PER_RUN = 1;
const MAX_QUERIES_PER_RUN = 1;
const MAX_MANAGED_QUERIES = 20;
const MAX_QUERY_LENGTH = 200;
const MAX_QUERY_BODY_BYTES = 32 * 1024;
const MAX_CANDIDATE_LIMIT = 50;
const MAX_CANDIDATE_SCAN = 1_000;
const FOLLOWING_RESYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
// No-following runs make at most 4 upstream requests (1 account + 1 query, each fresh/backlog), so 40 seconds at timeout; the 10-minute lease is ample and below the 15-minute Cron interval.
const COLLECTION_LEASE_MS = 10 * 60 * 1000;
const ACCOUNT_STATUS_STATE_PREFIX = "account_status:";
const SEARCH_QUERY_STATE_PREFIX = "search_query:";
const FOLLOWING_PENDING_SOURCE_KEY = "following_pending_source_handle";
const COLLECTION_LEASE_KEY = "collection_lease";

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function asNumber(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : fallback;
}

function asOptionalCount(value: unknown): number | null {
  const number = asNumber(value, NaN);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function asTimestamp(value: unknown): number | null {
  const number = asNumber(value, NaN);
  if (!Number.isFinite(number) || number <= 0) return null;
  const seconds = Math.floor(number > 100_000_000_000 ? number / 1000 : number);
  return Number.isSafeInteger(seconds) && Number.isFinite(new Date(seconds * 1000).getTime()) ? seconds : null;
}

function copyObject(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  try {
    const copied: unknown = JSON.parse(JSON.stringify(value));
    return isRecord(copied) ? copied : null;
  } catch {
    return null;
  }
}

function statusDetails(value: JsonRecord): JsonRecord | null {
  const details: JsonRecord = {};
  const views = asOptionalCount(value.views);
  const bookmarks = asOptionalCount(value.bookmarks);
  const media = copyObject(value.media);
  if (views !== null) details.views = views;
  if (bookmarks !== null) details.bookmarks = bookmarks;
  if (media && Object.keys(media).length) details.media = media;
  if (typeof value.possibly_sensitive === "boolean") details.possibly_sensitive = value.possibly_sensitive;
  return Object.keys(details).length ? details : null;
}

function isReply(value: JsonRecord): boolean {
  if (value.is_reply === true || value.isReply === true) return true;
  return ["replying_to", "replying_to_status_id", "in_reply_to_status_id", "in_reply_to_user_id"]
    .some((key) => value[key] !== undefined && value[key] !== null && value[key] !== "");
}

export function normalizeStatus(value: unknown): ApiStatus | null {
  if (!isRecord(value)) return null;
  const authorValue = isRecord(value.author) ? value.author : null;
  const id = asId(value.id);
  const screenName = authorValue ? asString(authorValue.screen_name ?? authorValue.screenName) : null;
  const timestamp = asTimestamp(value.created_timestamp ?? value.createdTimestamp);
  if (!id || !screenName || !timestamp) return null;

  const authorId = asId(authorValue?.id) ?? screenName;
  const name = asString(authorValue?.name) ?? screenName;
  const url = asString(value.url) ?? `https://x.com/${encodeURIComponent(screenName)}/status/${id}`;
  return {
    id,
    url,
    text: typeof value.text === "string" ? value.text : "",
    createdTimestamp: timestamp,
    likes: Math.max(0, Math.floor(asNumber(value.likes))),
    reposts: Math.max(0, Math.floor(asNumber(value.retweets ?? value.reposts))),
    quotes: Math.max(0, Math.floor(asNumber(value.quotes))),
    replies: Math.max(0, Math.floor(asNumber(value.replies))),
    author: { id: authorId, screenName, name },
    quote: copyObject(value.quote),
    details: statusDetails(value),
    isReply: isReply(value),
  };
}

export function normalizeAccount(value: unknown): ApiAccount | null {
  if (!isRecord(value)) return null;
  const handle = asString(value.screen_name ?? value.screenName ?? value.username);
  if (!handle) return null;
  return {
    id: asId(value.id) ?? handle,
    handle,
    name: asString(value.name) ?? handle,
    protected: value.protected === true || value.protected === 1 || value.is_protected === true,
  };
}

function findArray(value: unknown, names: string[], depth = 0): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isRecord(value) || depth > 3) return null;
  for (const name of names) {
    if (Array.isArray(value[name])) return value[name];
  }
  for (const child of Object.values(value)) {
    const result = findArray(child, names, depth + 1);
    if (result) return result;
  }
  return null;
}

function responseCursor(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.cursor)) throw new Error("upstream payload has an invalid cursor");
  const cursor = value.cursor;
  const key = Object.prototype.hasOwnProperty.call(cursor, "bottom")
    ? "bottom"
    : Object.prototype.hasOwnProperty.call(cursor, "next")
      ? "next"
      : null;
  if (!key) throw new Error("upstream payload has an invalid cursor");
  const next = cursor[key];
  if (next === null) return null;
  if (typeof next !== "string" || !next.trim()) throw new Error("upstream payload has an invalid cursor");
  const normalized = next.trim();
  return normalized.startsWith("0|") ? null : normalized;
}

type FetchOptions = { allowNoContent?: boolean; allowNotFoundEmpty?: boolean };

function isEmptyResult(value: unknown): boolean {
  const items = findArray(value, ["timeline", "tweets", "statuses", "results"]);
  return items !== null && items.length === 0;
}

async function fetchApi(url: string, source: string, options: FetchOptions = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "rss-curator (https://github.com/naorbieta/rss)",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`${source}: fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 204) {
    if (options.allowNoContent) return { code: 204, results: { timeline: [] }, cursor: { bottom: null } };
    throw new Error(`${source}: HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`${source}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    if (options.allowNotFoundEmpty && response.status === 404 && isRecord(body) && asNumber(body.code, NaN) === 404 && isEmptyResult(body)) {
      return { ...body, cursor: { bottom: null } };
    }
    throw new Error(`${source}: HTTP ${response.status}`);
  }
  if (isRecord(body) && typeof body.code === "number" && body.code >= 400) {
    throw new Error(`${source}: API code ${body.code}`);
  }
  return body;
}

function normalizeStatusPage(body: unknown): { statuses: ApiStatus[]; cursor: string | null } {
  const items = findArray(body, ["timeline", "tweets", "statuses", "results"]);
  if (!items) throw new Error("upstream payload has no status list");
  const statuses = items.map(normalizeStatus);
  if (statuses.some((status) => status === null)) throw new Error("upstream payload has an invalid status");
  return { statuses: statuses.filter((status): status is ApiStatus => status !== null), cursor: responseCursor(body) };
}

function normalizeFollowingPage(body: unknown): { accounts: ApiAccount[]; cursor: string | null } {
  const items = findArray(body, ["users", "following", "accounts", "results"]);
  if (!items) throw new Error("upstream payload has no following list");
  const accounts = items.map(normalizeAccount);
  if (accounts.some((account) => account === null)) throw new Error("upstream payload has an invalid account");
  return { accounts: accounts.filter((account): account is ApiAccount => account !== null), cursor: responseCursor(body) };
}

function stateStatement(db: D1Database, key: string, value: string, updatedAt: string): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(key, value, updatedAt);
}

async function readState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM collector_state WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

function accountStatusStateKey(accountId: string): string {
  return `${ACCOUNT_STATUS_STATE_PREFIX}${accountId}`;
}

async function readAccountStatusCheckpoint(db: D1Database, accountId: string): Promise<AccountStatusCheckpoint | null> {
  const value = await readState(db, accountStatusStateKey(accountId));
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;
    const rawCursor = parsed.cursor;
    const cursor = rawCursor === undefined || rawCursor === null ? null : asString(rawCursor);
    if (rawCursor !== undefined && rawCursor !== null && !cursor) return null;
    const rawQueuedCursor = parsed.queued_cursor;
    const queuedCursor = rawQueuedCursor === undefined || rawQueuedCursor === null ? null : asString(rawQueuedCursor);
    if (rawQueuedCursor !== undefined && rawQueuedCursor !== null && !queuedCursor) return null;
    const sinceValue = parsed.since;
    const latestValue = parsed.latest;
    const latestIds = readStateIds(parsed.latest_ids);
    if (!latestIds) return null;
    return {
      cursor,
      queuedCursor,
      since: sinceValue === undefined || sinceValue === null ? null : asTimestamp(sinceValue),
      latest: latestValue === undefined || latestValue === null ? null : asTimestamp(latestValue),
      latestIds,
    };
  } catch {
    return null;
  }
}

function readStateIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const ids = value.map(asId);
  return ids.every((id): id is string => id !== null) ? [...new Set(ids)] : null;
}

function searchQueryStateKey(queryId: number): string {
  return `${SEARCH_QUERY_STATE_PREFIX}${queryId}`;
}

async function readSearchQueryCheckpoint(db: D1Database, query: DbQuery): Promise<SearchQueryCheckpoint | null> {
  const value = await readState(db, searchQueryStateKey(query.id));
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.query !== query.query) return null;
    const rawCursor = Object.prototype.hasOwnProperty.call(parsed, "backlog_cursor") ? parsed.backlog_cursor : parsed.cursor;
    const backlogCursor = rawCursor === undefined || rawCursor === null ? null : asString(rawCursor);
    if (rawCursor !== undefined && rawCursor !== null && !backlogCursor) return null;
    const rawQueuedCursor = parsed.queued_cursor;
    const queuedCursor = rawQueuedCursor === undefined || rawQueuedCursor === null ? null : asString(rawQueuedCursor);
    if (rawQueuedCursor !== undefined && rawQueuedCursor !== null && !queuedCursor) return null;
    const stopValue = parsed.stop_watermark;
    const pendingValue = parsed.pending_latest;
    const stopIds = readStateIds(parsed.stop_ids);
    const pendingLatestIds = readStateIds(parsed.pending_latest_ids);
    if (!stopIds || !pendingLatestIds) return null;
    return {
      query: query.query,
      backlogCursor,
      queuedCursor,
      stopWatermark: stopValue === undefined || stopValue === null ? null : asTimestamp(stopValue),
      stopIds,
      pendingLatest: pendingValue === undefined || pendingValue === null ? null : asTimestamp(pendingValue),
      pendingLatestIds,
    };
  } catch {
    return null;
  }
}

function postsStatements(
  db: D1Database,
  posts: ApiStatus[],
  sourceKind: "following" | "search",
  sourceKey: string,
  collectedAt: string,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < posts.length; offset += POST_DB_CHUNK) {
    const chunk = posts.slice(offset, offset + POST_DB_CHUNK);
    const values: Array<string | number | null> = [];
    const rows = chunk.map((post) => {
      values.push(
        post.id,
        post.url,
        post.text,
        post.createdTimestamp,
        post.likes,
        post.reposts,
        post.quotes,
        post.replies,
        post.author.id,
        post.author.screenName,
        post.author.name,
        post.quote ? JSON.stringify(post.quote) : null,
        post.details ? JSON.stringify(post.details) : null,
        sourceKind,
        sourceKey,
        collectedAt,
      );
      return "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    }).join(", ");
    statements.push(db.prepare(`
      INSERT INTO posts
        (id, url, text, created_timestamp, likes, reposts, quotes, replies,
         author_id, author_screen_name, author_name, quote_json, details_json, source_kind, source_key, collected_at)
      VALUES ${rows}
      ON CONFLICT(id) DO UPDATE SET
        likes = MAX(posts.likes, excluded.likes),
        reposts = MAX(posts.reposts, excluded.reposts),
        quotes = MAX(posts.quotes, excluded.quotes),
        replies = MAX(posts.replies, excluded.replies),
        quote_json = COALESCE(excluded.quote_json, posts.quote_json),
        details_json = CASE
          WHEN excluded.details_json IS NULL THEN posts.details_json
          WHEN posts.details_json IS NULL THEN excluded.details_json
          ELSE json_patch(posts.details_json, excluded.details_json)
        END,
        source_kind = CASE WHEN excluded.source_kind = 'following' THEN excluded.source_kind ELSE posts.source_kind END,
        source_key = CASE WHEN excluded.source_kind = 'following' THEN excluded.source_key ELSE posts.source_key END,
        collected_at = excluded.collected_at
    `).bind(...values));
  }
  return statements;
}

function accountCheckpointValue(checkpoint: AccountStatusCheckpoint): string {
  return JSON.stringify({
    cursor: checkpoint.cursor,
    queued_cursor: checkpoint.queuedCursor,
    since: checkpoint.since,
    latest: checkpoint.latest,
    latest_ids: checkpoint.latestIds,
  });
}

function latestTimestamp(account: DbAccount, checkpoint: AccountStatusCheckpoint | null, page: ApiStatus[]): number | null {
  const latest = page.reduce(
    (max, post) => Math.max(max, post.createdTimestamp),
    Math.max(account.last_post_timestamp ?? 0, checkpoint?.latest ?? 0),
  );
  return latest || null;
}

function latestAccountIds(account: DbAccount, checkpoint: AccountStatusCheckpoint | null, page: ApiStatus[], latest: number | null): string[] {
  const pageIds = statusIdsAtTimestamp(page, latest);
  if (checkpoint?.latest === latest) return mergeIds(checkpoint.latestIds, pageIds);
  if (!checkpoint && account.last_post_timestamp === latest) return pageIds;
  return pageIds;
}

async function saveAccountFresh(
  db: D1Database,
  account: DbAccount,
  checkpoint: AccountStatusCheckpoint | null,
  page: { statuses: ApiStatus[]; cursor: string | null },
  since: number | null,
  checkedAt: string,
): Promise<AccountStatusCheckpoint> {
  const latest = latestTimestamp(account, checkpoint, page.statuses);
  const latestIds = latestAccountIds(account, checkpoint, page.statuses, latest);
  const statements: D1PreparedStatement[] = [];
  statements.push(...postsStatements(db, page.statuses.filter((post) => !post.isReply), "following", account.handle, checkedAt));
  const stateKey = accountStatusStateKey(account.id);
  let next: AccountStatusCheckpoint;
  if (checkpoint?.cursor) {
    const queuedCursor = page.cursor === null
      ? checkpoint.queuedCursor
      : page.cursor === checkpoint.cursor ? checkpoint.queuedCursor : page.cursor;
    next = { ...checkpoint, queuedCursor, latest, latestIds };
  } else if (account.last_post_timestamp === null) {
    const baseline = Math.floor(Date.parse(checkedAt) / 1000);
    const initialLatest = latest ?? (Number.isFinite(baseline) && baseline > 0 ? baseline : null);
    next = { cursor: null, queuedCursor: null, since: null, latest: initialLatest, latestIds: initialLatest === latest ? latestIds : [] };
  } else {
    const watermark = checkpoint?.latest ?? account.last_post_timestamp;
    const hasNew = latest !== null && watermark !== null && (
      latest > watermark ||
      (latest === watermark && latestIds.some((id) => !((checkpoint?.latestIds ?? []).includes(id))))
    );
    if (page.cursor && hasNew) {
      next = { cursor: page.cursor, queuedCursor: null, since: checkpoint?.since ?? account.last_post_timestamp, latest, latestIds };
    } else {
      const nextLatest = Math.max(account.last_post_timestamp, latest ?? 0) || null;
      next = {
        cursor: null,
        queuedCursor: null,
        since: null,
        latest: nextLatest,
        latestIds: nextLatest === latest ? latestIds : checkpoint?.latestIds ?? [],
      };
    }
  }
  if (next.cursor) {
    statements.push(db.prepare("UPDATE accounts SET last_checked_at = ? WHERE id = ?").bind(checkedAt, account.id));
  } else {
    statements.push(db.prepare(`
      UPDATE accounts
      SET last_post_timestamp = CASE WHEN ? > COALESCE(last_post_timestamp, 0) THEN ? ELSE last_post_timestamp END,
          last_checked_at = ?
      WHERE id = ?
    `).bind(next.latest ?? 0, next.latest, checkedAt, account.id));
  }
  statements.push(stateStatement(db, stateKey, accountCheckpointValue(next), checkedAt));
  await db.batch(statements);
  return next;
}

async function saveAccountBacklog(
  db: D1Database,
  account: DbAccount,
  checkpoint: AccountStatusCheckpoint,
  page: { statuses: ApiStatus[]; cursor: string | null },
  checkedAt: string,
): Promise<AccountStatusCheckpoint> {
  const latest = latestTimestamp(account, checkpoint, page.statuses);
  const latestIds = latestAccountIds(account, checkpoint, page.statuses, latest);
  const statements: D1PreparedStatement[] = [];
  statements.push(...postsStatements(db, page.statuses.filter((post) => !post.isReply), "following", account.handle, checkedAt));
  const stateKey = accountStatusStateKey(account.id);
  let next: AccountStatusCheckpoint;
  if (page.cursor) {
    next = {
      ...checkpoint,
      cursor: page.cursor,
      queuedCursor: page.cursor === checkpoint.queuedCursor ? null : checkpoint.queuedCursor,
      latest,
      latestIds,
    };
  } else if (checkpoint.queuedCursor) {
    next = { cursor: checkpoint.queuedCursor, queuedCursor: null, since: checkpoint.since, latest, latestIds };
  } else {
    next = { cursor: null, queuedCursor: null, since: null, latest, latestIds };
  }
  if (next.cursor) {
    statements.push(db.prepare("UPDATE accounts SET last_checked_at = ? WHERE id = ?").bind(checkedAt, account.id));
  } else {
    statements.push(db.prepare(`
      UPDATE accounts
      SET last_post_timestamp = CASE WHEN ? > COALESCE(last_post_timestamp, 0) THEN ? ELSE last_post_timestamp END,
          last_checked_at = ?
      WHERE id = ?
    `).bind(next.latest ?? 0, next.latest, checkedAt, account.id));
  }
  statements.push(stateStatement(db, stateKey, accountCheckpointValue(next), checkedAt));
  await db.batch(statements);
  return next;
}

function searchCheckpointValue(query: DbQuery, checkpoint: SearchQueryCheckpoint): string {
  return JSON.stringify({
    query: query.query,
    backlog_cursor: checkpoint.backlogCursor,
    queued_cursor: checkpoint.queuedCursor,
    stop_watermark: checkpoint.stopWatermark,
    stop_ids: checkpoint.stopIds,
    pending_latest: checkpoint.pendingLatest,
    pending_latest_ids: checkpoint.pendingLatestIds,
  });
}

function newestStatusTimestamp(posts: ApiStatus[]): number | null {
  const latest = posts.reduce((max, post) => Math.max(max, post.createdTimestamp), 0);
  return latest || null;
}

function oldestStatusTimestamp(posts: ApiStatus[]): number | null {
  const oldest = posts.reduce((min, post) => Math.min(min, post.createdTimestamp), Number.MAX_SAFE_INTEGER);
  return oldest === Number.MAX_SAFE_INTEGER ? null : oldest;
}

function statusIdsAtTimestamp(posts: ApiStatus[], timestamp: number | null): string[] {
  if (timestamp === null) return [];
  return [...new Set(posts.filter((post) => post.createdTimestamp === timestamp).map((post) => post.id))];
}

function mergeIds(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}

function idsForTimestamp(timestamp: number | null, ...sources: Array<{ timestamp: number | null; ids: string[] }>): string[] {
  if (timestamp === null) return [];
  return sources.reduce<string[]>((ids, source) => source.timestamp === timestamp ? mergeIds(ids, source.ids) : ids, []);
}

async function saveSearchLatest(
  db: D1Database,
  query: DbQuery,
  checkpoint: SearchQueryCheckpoint | null,
  page: { statuses: ApiStatus[]; cursor: string | null },
  checkedAt: string,
): Promise<SearchQueryCheckpoint> {
  const latest = newestStatusTimestamp(page.statuses);
  let next: SearchQueryCheckpoint = checkpoint ?? {
    query: query.query,
    backlogCursor: null,
    queuedCursor: null,
    stopWatermark: latest,
    stopIds: statusIdsAtTimestamp(page.statuses, latest),
    pendingLatest: null,
    pendingLatestIds: [],
  };
  if (checkpoint) {
    const pendingLatest = Math.max(checkpoint.pendingLatest ?? 0, latest ?? 0) || null;
    const pendingLatestIds = latest !== null && latest === pendingLatest
      ? (checkpoint.pendingLatest === pendingLatest ? mergeIds(checkpoint.pendingLatestIds, statusIdsAtTimestamp(page.statuses, latest)) : statusIdsAtTimestamp(page.statuses, latest))
      : checkpoint.pendingLatestIds;
    if (checkpoint.backlogCursor) {
      const pendingWatermark = checkpoint.pendingLatest ?? checkpoint.stopWatermark;
      const pendingIds = checkpoint.pendingLatest !== null && checkpoint.pendingLatest === latest
        ? checkpoint.pendingLatestIds
        : checkpoint.pendingLatest === null && checkpoint.stopWatermark === latest ? checkpoint.stopIds : [];
      const hasNewLatest = latest !== null && (pendingWatermark === null || latest > pendingWatermark ||
        (latest === pendingWatermark && statusIdsAtTimestamp(page.statuses, latest).some((id) => !pendingIds.includes(id))));
      const shouldQueue = page.cursor && hasNewLatest && page.cursor !== checkpoint.backlogCursor && page.cursor !== checkpoint.queuedCursor;
      next = shouldQueue
        ? { ...checkpoint, queuedCursor: page.cursor, pendingLatest, pendingLatestIds }
        : { ...checkpoint, pendingLatest, pendingLatestIds };
    } else if (
      latest !== null && page.cursor &&
      (checkpoint.stopWatermark === null || latest > checkpoint.stopWatermark ||
        (latest === checkpoint.stopWatermark && statusIdsAtTimestamp(page.statuses, latest).some((id) => !checkpoint.stopIds.includes(id))))
    ) {
      next = { ...checkpoint, backlogCursor: page.cursor, pendingLatest, pendingLatestIds };
    } else {
      const stopWatermark = Math.max(checkpoint.stopWatermark ?? 0, pendingLatest ?? 0) || null;
      next = {
        ...checkpoint,
        queuedCursor: null,
        stopWatermark,
        stopIds: idsForTimestamp(stopWatermark,
          { timestamp: checkpoint.stopWatermark, ids: checkpoint.stopIds },
          { timestamp: checkpoint.pendingLatest, ids: pendingLatestIds },
          { timestamp: latest, ids: statusIdsAtTimestamp(page.statuses, latest) },
        ),
        pendingLatest: null,
        pendingLatestIds: [],
      };
    }
  }
  const statements: D1PreparedStatement[] = [];
  statements.push(...postsStatements(db, page.statuses, "search", query.query, checkedAt));
  statements.push(db.prepare("UPDATE search_queries SET last_checked_at = ? WHERE id = ?").bind(checkedAt, query.id));
  statements.push(stateStatement(db, searchQueryStateKey(query.id), searchCheckpointValue(query, next), checkedAt));
  await db.batch(statements);
  return next;
}

async function saveSearchBacklog(
  db: D1Database,
  query: DbQuery,
  checkpoint: SearchQueryCheckpoint,
  page: { statuses: ApiStatus[]; cursor: string | null },
  checkedAt: string,
): Promise<void> {
  const oldest = oldestStatusTimestamp(page.statuses);
  const latest = newestStatusTimestamp(page.statuses);
  const pageIdsAtStop = statusIdsAtTimestamp(page.statuses, checkpoint.stopWatermark);
  const reachedStop = checkpoint.stopWatermark !== null && oldest !== null &&
    (oldest < checkpoint.stopWatermark || (oldest === checkpoint.stopWatermark && pageIdsAtStop.some((id) => checkpoint.stopIds.includes(id))));
  const complete = page.cursor === null || reachedStop;
  const reachedQueuedCursor = page.cursor !== null && page.cursor === checkpoint.queuedCursor;
  const pendingLatest = Math.max(checkpoint.pendingLatest ?? 0, latest ?? 0) || null;
  const pendingLatestIds = latest !== null && latest === pendingLatest
    ? (checkpoint.pendingLatest === pendingLatest ? mergeIds(checkpoint.pendingLatestIds, statusIdsAtTimestamp(page.statuses, latest)) : statusIdsAtTimestamp(page.statuses, latest))
    : checkpoint.pendingLatestIds;
  const next: SearchQueryCheckpoint = complete && checkpoint.queuedCursor
    ? { ...checkpoint, backlogCursor: checkpoint.queuedCursor, queuedCursor: null, pendingLatest, pendingLatestIds }
    : complete
      ? {
          query: query.query,
          backlogCursor: null,
          queuedCursor: null,
          stopWatermark: Math.max(checkpoint.stopWatermark ?? 0, pendingLatest ?? 0) || null,
          stopIds: idsForTimestamp(Math.max(checkpoint.stopWatermark ?? 0, pendingLatest ?? 0) || null,
            { timestamp: checkpoint.stopWatermark, ids: checkpoint.stopIds },
            { timestamp: checkpoint.pendingLatest, ids: checkpoint.pendingLatestIds },
            { timestamp: pendingLatest, ids: pendingLatestIds },
          ),
          pendingLatest: null,
          pendingLatestIds: [],
        }
      : { ...checkpoint, backlogCursor: page.cursor, queuedCursor: reachedQueuedCursor ? null : checkpoint.queuedCursor, pendingLatest, pendingLatestIds };
  const statements: D1PreparedStatement[] = [];
  statements.push(...postsStatements(db, page.statuses, "search", query.query, checkedAt));
  statements.push(stateStatement(db, searchQueryStateKey(query.id), searchCheckpointValue(query, next), checkedAt));
  await db.batch(statements);
}

export async function syncFollowingPage(db: D1Database, sourceHandle: string, nowMs = Date.now()): Promise<{ complete: boolean; count: number }> {
  const savedSourceHandle = await readState(db, "following_source_handle");
  const sameSource = savedSourceHandle === sourceHandle;
  const currentCursor = sameSource ? await readState(db, "following_cursor") : null;
  const marker = (sameSource ? await readState(db, "following_marker") : null) || crypto.randomUUID();
  const query = new URLSearchParams({ count: String(FOLLOWING_API_COUNT) });
  if (currentCursor) query.set("cursor", currentCursor);
  const updatedAt = new Date(nowMs).toISOString();
  await db.batch([stateStatement(db, FOLLOWING_PENDING_SOURCE_KEY, sourceHandle, updatedAt)]);
  const body = await fetchApi(`${API_BASE}/2/profile/${encodeURIComponent(sourceHandle)}/following?${query}`, "following");
  const page = normalizeFollowingPage(body);
  if (page.accounts.length > FOLLOWING_API_COUNT) throw new Error(`following: upstream returned more than ${FOLLOWING_API_COUNT} accounts`);
  for (let offset = 0; offset < page.accounts.length; offset += FOLLOWING_DB_CHUNK) {
    const accounts = page.accounts.slice(offset, offset + FOLLOWING_DB_CHUNK);
    const accountIdentityValues = accounts.flatMap((account) => [account.id, account.handle]);
    const accountValues = accounts.flatMap((account) => [account.id, account.handle, account.name, account.protected ? 1 : 0, marker]);
    const accountIdentityRows = accounts.map(() => "(?, ?)").join(", ");
    const accountRows = accounts.map(() => "(?, ?, ?, ?, ?)").join(", ");
    await db.batch([
      db.prepare(`
        WITH incoming(id, handle) AS (VALUES ${accountIdentityRows})
        DELETE FROM collector_state
        WHERE key IN (
          SELECT 'account_status:' || incoming.id
          FROM incoming
          JOIN accounts AS existing ON existing.id = incoming.id
          WHERE existing.handle <> incoming.handle
        )
      `).bind(...accountIdentityValues),
      db.prepare(`
        INSERT INTO accounts (id, handle, name, protected, sync_marker) VALUES ${accountRows}
        ON CONFLICT(id) DO UPDATE SET handle = excluded.handle, name = excluded.name,
          protected = excluded.protected, sync_marker = excluded.sync_marker
      `).bind(...accountValues),
    ]);
  }

  const stateStatements: D1PreparedStatement[] = [];
  if (page.cursor) {
    stateStatements.push(stateStatement(db, "following_source_handle", sourceHandle, updatedAt));
    stateStatements.push(stateStatement(db, "following_cursor", page.cursor, updatedAt));
    stateStatements.push(stateStatement(db, "following_marker", marker, updatedAt));
  } else {
    stateStatements.push(db.prepare("DELETE FROM accounts WHERE sync_marker IS NULL OR sync_marker <> ?").bind(marker));
    stateStatements.push(db.prepare(`
      DELETE FROM collector_state
      WHERE key LIKE ?
        AND substr(key, ?) NOT IN (SELECT id FROM accounts WHERE sync_marker = ?)
    `).bind(`${ACCOUNT_STATUS_STATE_PREFIX}%`, ACCOUNT_STATUS_STATE_PREFIX.length + 1, marker));
    stateStatements.push(db.prepare("DELETE FROM collector_state WHERE key = ?").bind(FOLLOWING_PENDING_SOURCE_KEY));
    stateStatements.push(stateStatement(db, "following_source_handle", sourceHandle, updatedAt));
    stateStatements.push(stateStatement(db, "following_cursor", "", updatedAt));
    stateStatements.push(stateStatement(db, "following_marker", "", updatedAt));
    stateStatements.push(stateStatement(db, "following_sync_at", updatedAt, updatedAt));
  }
  await db.batch(stateStatements);
  return { complete: !page.cursor, count: page.accounts.length };
}

async function listAccountsForRun(db: D1Database): Promise<{ all: DbAccount[]; selected: DbAccount[]; start: number }> {
  const rows = await db.prepare(`
    SELECT id, handle, name, protected, last_post_timestamp, last_checked_at
    FROM accounts ORDER BY handle COLLATE NOCASE, id
  `).all<DbAccount>();
  const all = rows.results;
  if (!all.length) return { all, selected: [], start: 0 };
  const savedPosition = Number(await readState(db, "following_scan_position") ?? 0);
  const start = Number.isSafeInteger(savedPosition) && savedPosition >= 0 ? savedPosition % all.length : 0;
  const selected = Array.from({ length: Math.min(MAX_ACCOUNTS_PER_RUN, all.length) }, (_, offset) => all[(start + offset) % all.length]);
  return { all, selected, start };
}

async function collectAccountStatuses(db: D1Database, nowMs: number): Promise<number> {
  const { all, selected, start } = await listAccountsForRun(db);
  if (!all.length) return 0;
  const checkedAt = new Date(nowMs).toISOString();
  for (const account of selected) {
    if (account.protected) {
      continue;
    }
    try {
      const checkpoint = await readAccountStatusCheckpoint(db, account.id);
      const since = checkpoint?.since ?? account.last_post_timestamp;
      let nextCheckpoint = checkpoint;
      let freshSucceeded = false;
      try {
        const freshQuery = new URLSearchParams({ count: String(STATUS_API_COUNT) });
        if (since) freshQuery.set("since", String(since));
        const freshBody = await fetchApi(
          `${API_BASE}/2/profile/${encodeURIComponent(account.handle)}/statuses?${freshQuery}`,
          `account:${account.handle}`,
          { allowNoContent: true },
        );
        const freshPage = normalizeStatusPage(freshBody);
        if (freshPage.statuses.length > STATUS_API_COUNT) throw new Error(`account:${account.handle}: upstream returned more than ${STATUS_API_COUNT} statuses`);
        nextCheckpoint = await saveAccountFresh(db, account, checkpoint, freshPage, since, checkedAt);
        freshSucceeded = true;
      } catch (error) {
        logSourceFailure(`account:${account.handle}:fresh`, error);
      }
      if (freshSucceeded && nextCheckpoint?.cursor) {
        const backlogQuery = new URLSearchParams({ count: String(STATUS_API_COUNT), cursor: nextCheckpoint.cursor });
        if (nextCheckpoint.since) backlogQuery.set("since", String(nextCheckpoint.since));
        try {
          const backlogBody = await fetchApi(
            `${API_BASE}/2/profile/${encodeURIComponent(account.handle)}/statuses?${backlogQuery}`,
            `account:${account.handle}:backlog`,
            { allowNoContent: true },
          );
          const backlogPage = normalizeStatusPage(backlogBody);
          if (backlogPage.statuses.length > STATUS_API_COUNT) throw new Error(`account:${account.handle}: upstream returned more than ${STATUS_API_COUNT} backlog statuses`);
          await saveAccountBacklog(db, account, nextCheckpoint, backlogPage, checkedAt);
        } catch (error) {
          logSourceFailure(`account:${account.handle}:backlog`, error);
        }
      }
    } catch (error) {
      logSourceFailure(`account:${account.handle}`, error);
    }
  }

  const nextPosition = (start + selected.length) % all.length;
  await db.batch([stateStatement(db, "following_scan_position", String(nextPosition), checkedAt)]);
  return selected.length;
}

async function collectSearchQueries(db: D1Database, nowMs: number): Promise<number> {
  const countRow = await db.prepare("SELECT COUNT(*) AS count FROM search_queries WHERE enabled = 1").first<{ count: number }>();
  const total = countRow?.count ?? 0;
  if (!total) return 0;
  const savedPosition = Number(await readState(db, "search_scan_position") ?? 0);
  const start = Number.isSafeInteger(savedPosition) && savedPosition >= 0 ? savedPosition % total : 0;
  const firstLimit = Math.min(MAX_QUERIES_PER_RUN, total - start);
  const firstRows = await db.prepare(`
    SELECT id, query, last_checked_at FROM search_queries
    WHERE enabled = 1
    ORDER BY id
    LIMIT ? OFFSET ?
  `).bind(firstLimit, start).all<DbQuery>();
  const selected = [...firstRows.results];
  if (selected.length < Math.min(MAX_QUERIES_PER_RUN, total)) {
    const remaining = Math.min(MAX_QUERIES_PER_RUN, total) - selected.length;
    const wrappedRows = await db.prepare(`
      SELECT id, query, last_checked_at FROM search_queries
      WHERE enabled = 1
      ORDER BY id
      LIMIT ? OFFSET 0
    `).bind(remaining).all<DbQuery>();
    selected.push(...wrappedRows.results);
  }
  const checkedAt = new Date(nowMs).toISOString();
  for (const query of selected) {
    try {
      const checkpoint = await readSearchQueryCheckpoint(db, query);
      const latestParams = new URLSearchParams({ q: query.query, feed: "latest", count: String(SEARCH_API_COUNT) });
      const latestBody = await fetchApi(`${API_BASE}/2/search?${latestParams}`, `query:${query.query}`, { allowNotFoundEmpty: true });
      const latestPage = normalizeStatusPage(latestBody);
      if (latestPage.statuses.length > SEARCH_API_COUNT) throw new Error(`query:${query.query}: upstream returned more than ${SEARCH_API_COUNT} statuses`);
      const next = await saveSearchLatest(db, query, checkpoint, latestPage, checkedAt);
      if (next.backlogCursor) {
        const backlogParams = new URLSearchParams({ q: query.query, feed: "latest", count: String(SEARCH_API_COUNT), cursor: next.backlogCursor });
        const backlogBody = await fetchApi(`${API_BASE}/2/search?${backlogParams}`, `query:${query.query}:backlog`, { allowNotFoundEmpty: true });
        const backlogPage = normalizeStatusPage(backlogBody);
        if (backlogPage.statuses.length > SEARCH_API_COUNT) throw new Error(`query:${query.query}: upstream returned more than ${SEARCH_API_COUNT} backlog statuses`);
        await saveSearchBacklog(db, query, next, backlogPage, checkedAt);
      }
    } catch (error) {
      logSourceFailure(`query:${query.query}`, error);
    }
  }
  const nextPosition = (start + selected.length) % total;
  await db.batch([stateStatement(db, "search_scan_position", String(nextPosition), checkedAt)]);
  return selected.length;
}

function logSourceFailure(source: string, error: unknown): void {
  console.error(JSON.stringify({
    event: "source_failed",
    source,
    error: error instanceof Error ? error.message : String(error),
  }));
}

async function shouldSyncFollowing(db: D1Database, sourceHandle: string, nowMs: number): Promise<boolean> {
  if (await readState(db, "following_source_handle") !== sourceHandle) return true;
  const cursor = await readState(db, "following_cursor");
  const marker = await readState(db, "following_marker");
  if (cursor || marker) return true;
  const lastSyncAt = await readState(db, "following_sync_at");
  if (!lastSyncAt) return true;
  const lastSyncMs = Date.parse(lastSyncAt);
  return !Number.isFinite(lastSyncMs) || nowMs - lastSyncMs >= FOLLOWING_RESYNC_INTERVAL_MS;
}

async function canCollectAccountStatuses(db: D1Database, sourceHandle: string): Promise<boolean> {
  if (await readState(db, "following_source_handle") !== sourceHandle) return false;
  if (await readState(db, FOLLOWING_PENDING_SOURCE_KEY)) return false;
  return Boolean(await readState(db, "following_sync_at"));
}

async function claimCollectionLease(db: D1Database, nowMs: number): Promise<string | null> {
  const token = crypto.randomUUID();
  const value = `${nowMs + COLLECTION_LEASE_MS}:${token}`;
  const result = await db.prepare(`
    INSERT INTO collector_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    WHERE CAST(substr(collector_state.value, 1, instr(collector_state.value, ':') - 1) AS INTEGER) <= ?
  `).bind(COLLECTION_LEASE_KEY, value, new Date(nowMs).toISOString(), nowMs).run();
  return result.meta.changes > 0 ? value : null;
}

async function releaseCollectionLease(db: D1Database, value: string): Promise<void> {
  await db.prepare("DELETE FROM collector_state WHERE key = ? AND value = ?").bind(COLLECTION_LEASE_KEY, value).run();
}

export async function collectOnce(env: RuntimeEnv, nowMs = Date.now()): Promise<{ following: boolean; accounts: number; queries: number }> {
  const leaseValue = await claimCollectionLease(env.DB, Date.now());
  if (!leaseValue) return { following: false, accounts: 0, queries: 0 };

  try {
    const sourceHandle = env.SOURCE_HANDLE.trim();
    let following = false;
    let followingRun = false;
    if (sourceHandle && await shouldSyncFollowing(env.DB, sourceHandle, nowMs)) {
      followingRun = true;
      try {
        await syncFollowingPage(env.DB, sourceHandle, nowMs);
        following = true;
      } catch (error) {
        logSourceFailure("following", error);
      }
    }

    let accounts = 0;
    if (sourceHandle && !followingRun && await canCollectAccountStatuses(env.DB, sourceHandle)) {
      try {
        accounts = await collectAccountStatuses(env.DB, nowMs);
      } catch (error) {
        logSourceFailure("accounts", error);
      }
    }

    let queries = 0;
    try {
      queries = await collectSearchQueries(env.DB, nowMs);
    } catch (error) {
      logSourceFailure("queries", error);
    }
    return { following, accounts, queries };
  } finally {
    try {
      await releaseCollectionLease(env.DB, leaseValue);
    } catch (error) {
      logSourceFailure("collection_lease", error);
    }
  }
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), {
    status,
    headers: responseHeaders,
  });
}

async function hasAdminAccess(request: Request, expectedToken: string): Promise<boolean> {
  const authorization = request.headers.get("authorization") ?? "";
  const providedToken = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  const encoder = new TextEncoder();
  // Vitest also loads Node's WebCrypto type, which omits this Workers runtime method.
  const subtle = crypto.subtle as typeof crypto.subtle & {
    timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
  };
  const [providedHash, expectedHash] = await Promise.all([
    subtle.digest("SHA-256", encoder.encode(providedToken)),
    subtle.digest("SHA-256", encoder.encode(expectedToken)),
  ]);
  return subtle.timingSafeEqual(providedHash, expectedHash);
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_QUERY_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function listManagedQueries(db: D1Database): Promise<ManagedQuery[]> {
  const rows = await db.prepare(`
    SELECT query, last_checked_at
    FROM search_queries
    WHERE enabled = 1
    ORDER BY id
  `).all<ManagedQuery>();
  return rows.results;
}

async function replaceManagedQueries(request: Request, env: WorkerEnv): Promise<Response> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return json({ error: "unsupported_media_type", message: "Content-Type は application/json を指定してください" }, 415);
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_QUERY_BODY_BYTES) {
    return json({ error: "payload_too_large", message: `リクエスト本文は ${MAX_QUERY_BODY_BYTES} bytes 以下にしてください` }, 413);
  }
  const bytes = await readBoundedBody(request);
  if (bytes === null) {
    return json({ error: "payload_too_large", message: `リクエスト本文は ${MAX_QUERY_BODY_BYTES} bytes 以下にしてください` }, 413);
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return json({ error: "invalid_json", message: "有効な JSON を送信してください" }, 400);
  }
  if (!isRecord(value) || !Array.isArray(value.queries)) {
    return json({ error: "invalid_queries", message: "queries は文字列の配列で指定してください" }, 400);
  }
  if (value.queries.length > MAX_MANAGED_QUERIES) {
    return json({ error: "invalid_queries", message: `queries は ${MAX_MANAGED_QUERIES} 件以下にしてください` }, 400);
  }

  const queries: string[] = [];
  for (const item of value.queries) {
    if (typeof item !== "string" || !item.trim() || Array.from(item.trim()).length > MAX_QUERY_LENGTH) {
      return json({ error: "invalid_queries", message: `各検索語は1〜${MAX_QUERY_LENGTH}文字の文字列にしてください` }, 400);
    }
    queries.push(item.trim());
  }
  if (new Set(queries.map((query) => query.toLowerCase())).size !== queries.length) {
    return json({ error: "invalid_queries", message: "queries に重複した検索語を指定しないでください" }, 400);
  }

  const statements = [env.DB.prepare("UPDATE search_queries SET enabled = 0 WHERE enabled = 1")];
  if (queries.length) {
    statements.push(env.DB.prepare(`
      INSERT INTO search_queries (query, enabled) VALUES ${queries.map(() => "(?, 1)").join(", ")}
      ON CONFLICT(query) DO UPDATE SET enabled = 1
    `).bind(...queries));
  }
  await env.DB.batch(statements);
  return json({ queries: await listManagedQueries(env.DB) });
}

async function manageQueries(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "GET" && request.method !== "PUT") {
    return json({ error: "method_not_allowed", message: "GET または PUT を使用してください" }, 405, { allow: "GET, PUT" });
  }
  if (!env.ADMIN_TOKEN) {
    console.error(JSON.stringify({ event: "configuration_error", binding: "ADMIN_TOKEN" }));
    return json({ error: "configuration_error", message: "ADMIN_TOKEN が設定されていません" }, 500);
  }
  if (!await hasAdminAccess(request, env.ADMIN_TOKEN)) {
    return json({ error: "unauthorized", message: "有効な Bearer token を指定してください" }, 401, {
      "www-authenticate": 'Bearer realm="queries"',
    });
  }
  if (request.method === "GET") return json({ queries: await listManagedQueries(env.DB) });
  return replaceManagedQueries(request, env);
}

function parsePositiveNumber(value: string | null, fallback: number): number | null {
  if (value === null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseQuote(value: string | null): JsonRecord | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseDetails(value: string | null): { views: number | null; bookmarks: number | null; media: JsonRecord | null; possiblySensitive: boolean | null } {
  const details = parseQuote(value);
  const media = copyObject(details?.media);
  return {
    views: asOptionalCount(details?.views),
    bookmarks: asOptionalCount(details?.bookmarks),
    media: media && Object.keys(media).length ? media : null,
    possiblySensitive: typeof details?.possibly_sensitive === "boolean" ? details.possibly_sensitive : null,
  };
}

function feedPost(row: DbFeedRow) {
  const details = parseDetails(row.details_json);
  return {
    id: row.id,
    url: row.url,
    text: row.text,
    created_at: new Date(row.created_timestamp * 1000).toISOString(),
    likes: row.likes,
    reposts: row.reposts,
    quotes: row.quotes,
    replies: row.replies,
    views: details.views,
    bookmarks: details.bookmarks,
    author: { id: row.author_id, screen_name: row.author_screen_name, name: row.author_name },
    quote: parseQuote(row.quote_json),
    media: details.media,
    possibly_sensitive: details.possiblySensitive,
    source: { kind: row.source_kind, key: row.source_key },
  };
}

export async function feed(request: Request, env: RuntimeEnv): Promise<Response> {
  const url = new URL(request.url);
  const pageValue = url.searchParams.get("page") ?? "1";
  const limitValue = url.searchParams.get("limit") ?? "100";
  const page = /^\d+$/.test(pageValue) ? Number(pageValue) : NaN;
  const limit = /^\d+$/.test(limitValue) ? Number(limitValue) : NaN;
  const hours = parsePositiveNumber(url.searchParams.get("hours"), 24);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || hours === null) {
    return json({ error: "invalid_query", message: "page は1以上、limit は1〜100、hours は0より大きい数を指定してください" }, 400);
  }
  const offset = (page - 1) * limit;
  if (!Number.isSafeInteger(offset)) return json({ error: "invalid_query", message: "page が大きすぎます" }, 400);
  const generatedAtMs = Date.now();
  const cutoff = Math.floor((generatedAtMs - hours * 60 * 60 * 1000) / 1000);
  const rows = await env.DB.prepare(`
    SELECT id, url, text, created_timestamp, likes, reposts, quotes, replies,
      author_id, author_screen_name, author_name, quote_json, details_json, source_kind, source_key
    FROM posts
    WHERE created_timestamp >= ?
    ORDER BY created_timestamp DESC, id DESC
    LIMIT ? OFFSET ?
  `).bind(cutoff, limit, offset).all<DbFeedRow>();
  return json({
    generated_at: new Date(generatedAtMs).toISOString(),
    page,
    limit,
    hours,
    posts: rows.results.map(feedPost),
  });
}

function requiredLikes(ageHours: number): number {
  return Math.max(10, Math.ceil(Math.min(ageHours, 24) * 100 / 24));
}

function candidateFor(row: DbFeedRow, generatedAtMs: number) {
  const post = feedPost(row);
  const ageHours = Math.max(0, (generatedAtMs / 1000 - row.created_timestamp) / 3600);
  const minimumLikes = requiredLikes(ageHours);
  const minimumBookmarks = Math.max(5, Math.ceil(minimumLikes / 4));
  const followingMinimum = Math.max(10, Math.ceil(minimumLikes / 2));
  const eligible = row.likes >= minimumLikes ||
    (post.bookmarks !== null && post.bookmarks >= minimumBookmarks) ||
    (row.source_kind === "following" && row.likes >= followingMinimum);
  if (!eligible) return null;

  const signals: string[] = [];
  if (row.likes >= 100) signals.push("popular");
  if (post.bookmarks !== null && post.bookmarks >= 40) signals.push("bookmarked_by_many");
  if (post.media) signals.push("media");
  if (post.quote) signals.push("quote");
  if (Array.from(row.text).length >= 120) signals.push("detailed");
  if (row.source_kind === "following") signals.push("following");

  const engagement = row.likes + row.reposts * 2 + row.quotes * 3 + (post.bookmarks ?? 0) * 3;
  const formatFactor = 1 + (post.media ? 0.15 : 0) + (post.quote ? 0.1 : 0) + (signals.includes("detailed") ? 0.1 : 0);
  return {
    ...post,
    selection: {
      score: Math.round(Math.log10(engagement + 1) * formatFactor * 100) / 100,
      signals,
      minimum_likes_at_collection_age: minimumLikes,
    },
  };
}

export async function candidates(request: Request, env: RuntimeEnv): Promise<Response> {
  const url = new URL(request.url);
  const limitValue = url.searchParams.get("limit") ?? "20";
  const limit = /^\d+$/.test(limitValue) ? Number(limitValue) : NaN;
  const hours = parsePositiveNumber(url.searchParams.get("hours"), 24);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CANDIDATE_LIMIT || hours === null) {
    return json({ error: "invalid_query", message: `limit は1〜${MAX_CANDIDATE_LIMIT}、hours は0より大きい数を指定してください` }, 400);
  }

  const generatedAtMs = Date.now();
  const cutoff = Math.floor((generatedAtMs - hours * 60 * 60 * 1000) / 1000);
  // ponytail: scan the strongest 1,000 engagement-ranked rows; move full scoring into SQL only if daily volume hides candidates.
  const scanLimit = Math.min(MAX_CANDIDATE_SCAN, Math.max(200, limit * 20));
  const rows = await env.DB.prepare(`
    SELECT id, url, text, created_timestamp, likes, reposts, quotes, replies,
      author_id, author_screen_name, author_name, quote_json, details_json, source_kind, source_key
    FROM posts
    WHERE created_timestamp >= ?
    ORDER BY (likes + reposts * 2 + quotes * 3 + COALESCE(CAST(json_extract(details_json, '$.bookmarks') AS INTEGER), 0) * 3) DESC,
      created_timestamp DESC, id DESC
    LIMIT ?
  `).bind(cutoff, scanLimit).all<DbFeedRow>();
  const ranked = rows.results
    .map((row) => candidateFor(row, generatedAtMs))
    .filter((post) => post !== null)
    .sort((left, right) => right.selection.score - left.selection.score || right.created_at.localeCompare(left.created_at));
  const selected: typeof ranked = [];
  const deferred: typeof ranked = [];
  const authors = new Set<string>();
  const sources = new Set<string>();
  for (const post of ranked) {
    const source = `${post.source.kind}:${post.source.key}`;
    if (authors.has(post.author.screen_name) || sources.has(source)) {
      deferred.push(post);
      continue;
    }
    selected.push(post);
    authors.add(post.author.screen_name);
    sources.add(source);
    if (selected.length === limit) break;
  }
  selected.push(...deferred.slice(0, limit - selected.length));

  return json({
    generated_at: new Date(generatedAtMs).toISOString(),
    hours,
    limit,
    evaluated: rows.results.length,
    criteria: {
      search_minimum_likes_at_24h: 100,
      recent_minimum_likes: 10,
      bookmarks_can_qualify: true,
      following_threshold_ratio: 0.5,
      diversify_author_and_source_before_backfill: true,
    },
    posts: selected,
  });
}

const worker = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/feed") return await feed(request, env);
      if (request.method === "GET" && url.pathname === "/candidates") return await candidates(request, env);
      if (url.pathname === "/queries") return await manageQueries(request, env);
      return json({ error: "not_found" }, 404);
    } catch (error) {
      console.error(JSON.stringify({ event: "request_failed", error: error instanceof Error ? error.message : String(error) }));
      return json({ error: "internal_error" }, 500);
    }
  },

  async scheduled(controller: ScheduledController, env: WorkerEnv): Promise<void> {
    console.log(JSON.stringify({ event: "collection_started", cron: controller.cron, scheduled_time: controller.scheduledTime }));
    const result = await collectOnce(env, controller.scheduledTime);
    console.log(JSON.stringify({ event: "collection_finished", ...result }));
  },
} satisfies ExportedHandler<WorkerEnv>;

export { worker as default };
