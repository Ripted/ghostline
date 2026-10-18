/**
 * Reliable fetch of level data from the game's API (api.narrowarrow.xyz).
 *
 * The upstream API rate-limits aggressively (429) — roughly 120 requests per
 * 60s window — so all calls go through a small concurrency queue with a per
 * request gap and exponential backoff on failures, exactly like the site's
 * `na-proxy.ts`.
 */
import type { LevelDetailsEnvelope, RawLevelData } from "../../shared/types.ts";

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