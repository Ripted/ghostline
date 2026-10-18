/**
 * Reliable fetch of level data from the game's API (api.narrowarrow.xyz).
 *
 * The upstream API rate-limits aggressively (429) — roughly 120 requests per
 * 60s window — so all calls go through a small concurrency queue with a per
 * request gap and exponential backoff on failures, exactly like the site's
 * `na-proxy.ts`.
 */
import type {
  LeaderboardEntry,
  LevelDetailsEnvelope,
  PublishedLevel,
  RawLevelData,
  RunReplayPayload,
} from "../../shared/types.ts";

const API_BASE = "https://api.narrowarrow.xyz";

const MAX_CONCURRENT = 6;
const MIN_GAP_MS = 520;
const TIMEOUT_MS = 8000;

let active = 0;
let nextSlot = 0;
let pausedUntil = 0;
const queue: Array<() => void> = [];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Called on 429 so every queued request waits for the window to reset. */
function pauseAll(ms: number) {
  pausedUntil = Math.max(pausedUntil, Date.now() + ms);
}

function schedule<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = async () => {
      active++;
      const slot = Math.max(Date.now(), nextSlot, pausedUntil);
      nextSlot = slot + MIN_GAP_MS;
      const wait = slot - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        resolve(await task());
      } catch (error) {
        reject(error);
      } finally {
        active--;
        const next = queue.shift();
        if (next) next();
      }
    };
    if (active < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

async function fetchWithRetry(url: string, attempts = 4): Promise<unknown> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (response.status === 429) {
        pauseAll(60_000);
        lastStatus = 429;
        await sleep(300 * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        lastStatus = response.status;
        await sleep(300 * 2 ** attempt);
        continue;
      }
      return await response.json();
    } catch {
      lastStatus = 504;
      await sleep(300 * 2 ** attempt);
    }
  }
  throw new Error(`Upstream request failed after retries (status ${lastStatus}): ${url}`);
}

/**
 * Fetch a level's raw geometry (`RawLevelData`) by id. Throws on error.
 */
export async function fetchLevelData(levelId: string): Promise<RawLevelData> {
  const url = `${API_BASE}/level-details/${encodeURIComponent(levelId)}?isCustomLevel=true`;
  const payload = (await schedule(() => fetchWithRetry(url))) as LevelDetailsEnvelope;
  const data = payload?.levelInfo?.data;
  if (!data || !Array.isArray(data.obstacles)) {
    throw new Error(`Level ${levelId} has no geometry (upstream response was empty).`);
  }
  return data;
}

/** Max rows upstream returns per leaderboard request. */
const MAX_LEADERBOARD_LIMIT = 150;
const ARROWS = ["Narrow Arrow", "Speedy Arrow", "Energy Arrow"];
const BOARD_TTL_MS = 150 * 1000;
const PUBLISHED_TTL_MS = 3 * 60 * 1000;
const RUN_TTL_MS = 15 * 60 * 1000;

function asList<T>(payload: unknown): T[] {
  return Array.isArray(payload) ? (payload as T[]) : [];
}

/** Tiny TTL cache so leaderboard/published/replay requests stay under limits. */
const cacheStore = new Map<string, { data: unknown; expiresAt: number }>();
const inflight = new Map<string, Promise<unknown>>();

async function cached<T>(key: string, ttlMs: number, fetch: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cacheStore.get(key);
  if (hit && hit.expiresAt > now) return hit.data as T;
  const request =
    inflight.get(key) ??
    (inflight.set(key, fetch().finally(() => inflight.delete(key))), inflight.get(key)!);
  try {
    const data = await request;
    cacheStore.set(key, { data, expiresAt: now + ttlMs });
    return data as T;
  } catch (error) {
    // Serve stale when throttled.
    if (hit) return hit.data as T;
    throw error;
  }
}

/**
 * Leaderboard for a level. When `deep` is true, merges the boards for all three
 * arrows (each capped at 150 rows upstream, ignoring offsets) so players far
 * outside the global top 150 surface too.
 */
export async function fetchLeaderboard(
  levelId: string,
  options: { deep?: boolean; arrowFilter?: string } = {},
): Promise<LeaderboardEntry[]> {
  const base = `${API_BASE}/leaderboard?levelId=${encodeURIComponent(levelId)}&limit=${MAX_LEADERBOARD_LIMIT}`;
  if (options.arrowFilter) {
    const url = `${base}&arrowFilter=${encodeURIComponent(options.arrowFilter)}`;
    return asList<LeaderboardEntry>(
      await cached(`${url}|${levelId}|${options.arrowFilter}`, BOARD_TTL_MS, () =>
        fetchWithRetry(url),
      ),
    );
  }
  if (!options.deep) {
    const url = base;
    return asList<LeaderboardEntry>(
      await cached(`${url}|${levelId}|all`, BOARD_TTL_MS, () => fetchWithRetry(url)),
    );
  }
  const boards = await Promise.all(
    ARROWS.map((arrow) =>
      cached(`${base}&arrowFilter=${encodeURIComponent(arrow)}|${levelId}|${arrow}`, BOARD_TTL_MS, () =>
        fetchWithRetry(`${base}&arrowFilter=${encodeURIComponent(arrow)}`).then((p) =>
          asList<LeaderboardEntry>(p),
        ),
      ).catch(() => [] as LeaderboardEntry[]),
    ),
  );
  if (boards.every((b) => b.length === 0)) {
    const url = base;
    return asList<LeaderboardEntry>(
      await cached(`${url}|${levelId}|all`, BOARD_TTL_MS, () => fetchWithRetry(url)),
    );
  }
  const merged = new Map<string, LeaderboardEntry>();
  for (const board of boards) {
    for (const entry of board) {
      const key = String(entry.run_id ?? `${entry.username}-${entry.completion_time}`);
      if (!merged.has(key)) merged.set(key, entry);
    }
  }
  return [...merged.values()].sort((a, b) => a.completion_time - b.completion_time);
}

/**
 * Browse/search published (custom) levels.
 * `filter`: `discover` | `new` | `popular` | `liked`. `search`: `by:{username}`.
 */
export async function fetchPublishedLevels(
  options: { filter?: string; page?: number; search?: string } = {},
): Promise<PublishedLevel[]> {
  const params = new URLSearchParams({
    filter: options.filter ?? "discover",
    page: String(options.page ?? 0),
  });
  if (options.search) params.set("search", options.search);
  const url = `${API_BASE}/published-levels?${params.toString()}`;
  const payload = await cached(`${url}|published|${options.filter ?? "discover"}|${options.page ?? 0}|${options.search ?? ""}`, PUBLISHED_TTL_MS, () => fetchWithRetry(url));
  return asList<PublishedLevel>(payload).filter(Boolean);
}

/** Fetch a run's full payload (inputs base64 etc.) from the replay API. */
export async function fetchRunReplay(runId: string | number): Promise<RunReplayPayload> {
  const url = `${API_BASE}/runs/${encodeURIComponent(String(runId))}`;
  return (await cached(`${url}|run|${runId}`, RUN_TTL_MS, () =>
    fetchWithRetry(url),
  )) as RunReplayPayload;
}

/** Level embed/preview image URL (for the custom map browser). */
export function levelImageUrl(levelId: string | number): string {
  return `${API_BASE}/level-image/${encodeURIComponent(String(levelId))}.png`;
}

/**
 * Validate a user-supplied custom map JSON: must be an object with a `map_name`
 * (or `name`) and an `obstacles` array. Returns a normalized `RawLevelData`.
 * Accepts the site's raw payload shape or a `.nalvl`/game file shape.
 */
export function normalizeCustomMap(json: unknown): RawLevelData {
  const obj = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  // The game's custom-level file wraps the level under `data`.
  const source =
    obj.data && typeof obj.data === "object" ? (obj.data as Record<string, unknown>) : obj;
  const obstacles = source.obstacles;
  if (!Array.isArray(obstacles)) {
    throw new Error("Not a valid map file — expected a JSON object with an `obstacles` array.");
  }
  const map_name =
    typeof source.map_name === "string" && source.map_name.trim()
      ? source.map_name.trim()
      : typeof obj.name === "string" && obj.name.trim()
        ? obj.name.trim()
        : "Custom Map";
  const game_mode =
    typeof source.game_mode === "string" && source.game_mode.trim()
      ? source.game_mode.trim()
      : "speedrun";
  return { map_name, game_mode, obstacles: obstacles as RawLevelData["obstacles"] };
}