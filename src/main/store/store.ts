/**
 * Persistence for saved runs and the level-geometry cache, as JSON files under
 * the app's userData directory (so runs survive restarts).
 */
import { app } from "electron";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RawLevelData, SearchResult } from "../../shared/types.ts";

export interface SavedRun extends SearchResult {
  id: string;
  savedAt: string;
  name: string;
}

let baseDir: string | null = null;

/** Resolve the storage root; falls back to a temp dir outside Electron. */
function root(): string {
  if (baseDir) return baseDir;
  let dir: string;
  try {
    dir = app.getPath("userData");
  } catch {
    dir = "/tmp/narrow-route-finder-data";
  }
  baseDir = dir;
  try {
    mkdirSync(join(dir, "runs"), { recursive: true });
    mkdirSync(join(dir, "levels"), { recursive: true });
  } catch {
    /* best effort */
  }
  return dir;
}

/** Allow tests/CLI runs to point the store somewhere deterministic. */
export function setStoreRoot(dir: string): void {
  baseDir = dir;
  mkdirSync(join(dir, "runs"), { recursive: true });
  mkdirSync(join(dir, "levels"), { recursive: true });
}

// ---- Level geometry cache -------------------------------------------------

export interface CachedLevel {
  id: string;
  name: string;
  data: RawLevelData;
  fetchedAt: number;
}

const LEVEL_TTL_MS = 15 * 60 * 1000;

export function cacheLevel(level: CachedLevel): void {
  try {
    writeFileSync(join(root(), "levels", `${sanitize(level.id)}.json`), JSON.stringify(level), {
      encoding: "utf8",
    });
  } catch {
    /* best effort */
  }
}

export function readCachedLevel(id: string): CachedLevel | null {
  try {
    const file = join(root(), "levels", `${sanitize(id)}.json`);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as CachedLevel;
    if (!parsed?.data?.obstacles) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isLevelCacheFresh(level: CachedLevel): boolean {
  return Date.now() - level.fetchedAt < LEVEL_TTL_MS;
}

// ---- Saved runs -----------------------------------------------------------

export function listRuns(): SavedRun[] {
  try {
    const dir = join(root(), "runs");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    const runs = files.map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf8")) as SavedRun;
      } catch {
        return null;
      }
    });
    return runs
      .filter((r): r is SavedRun => r !== null)
      .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  } catch {
    return [];
  }
}

export function saveRun(run: SearchResult): SavedRun {
  const saved: SavedRun = {
    ...run,
    id: crypto.randomUUID(),
    savedAt: new Date().toISOString(),
    name: `${run.levelName} · ${run.arrowName} · ${(run.timeMs ?? 0) / 1000}s`,
  };
  try {
    writeFileSync(
      join(root(), "runs", `${saved.id}.json`),
      JSON.stringify(saved),
      { encoding: "utf8" },
    );
  } catch {
    /* best effort */
  }
  return saved;
}

export function deleteRun(id: string): void {
  try {
    rmSync(join(root(), "runs", `${sanitize(id)}.json`), { force: true });
  } catch {
    /* best effort */
  }
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}