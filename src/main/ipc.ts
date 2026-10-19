/**
 * IPC surface exposed to the renderer via the preload bridge.
 *
 * Namespaced under `window.nf.*`. Search runs are async and stream progress via
 * `nf.onSearchProgress(cb)` events (the coordinator pushes progress through
 * `ipcRenderer.send`). Cancellation is handled by `nf.cancelSearch()`.
 */
import { app, dialog, ipcMain, BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LevelInfo, SearchParams, SearchResult, RawLevelData, LeaderboardEntry, PublishedLevel, RunReplayPayload } from "../shared/types.ts";
import { LEVELS, LEVEL_PACKS } from "../shared/levels.ts";
import {
  fetchLeaderboard,
  fetchLevelData,
  fetchPublishedLevels,
  fetchRunReplay,
  levelImageUrl,
  normalizeCustomMap,
} from "./fetch/upstream.ts";
import { Coordinator } from "./search/coordinator.ts";
import { simulateRunExact } from "./search/engine.ts";
import { decodeInputSymbols } from "../shared/codec.ts";
import {
  cacheLevel,
  deleteRun,
  listCachedLevels,
  listRuns,
  readCachedLevel,
  saveRun,
} from "./store/store.ts";
import { levelGeometry } from "../shared/geometry.ts";

interface ActiveSearch {
  coordinator: Coordinator;
  params: SearchParams;
  /** Bumped on every start/cancel so late events from a stale run are ignored. */
  generation: number;
}

/** A capped live-path preview for the renderer's ghost (transmitted data). */
interface LivePathPayload {
  searchId?: string;
  /** Monotonic "which best is this" counter — increments only on a genuine
   * new best. The renderer restarts its ghost when this changes (IPC
   * structured-clone makes reference equality useless across polls). */
  bestVersion?: number;
  /** Downsampled path (equal-stride picks, last point preserved). */
  path?: unknown[];
  /** Real tick count of the full simulated run (before downsampling). */
  tickCount?: number;
  /** Path points are `stride` real ticks apart; ghost advances at 240/stride idx/s. */
  stride?: number;
  finishTick?: number | null;
  mode?: string;
  arrowName?: string;
}

const LIVE_PATH_MAX_POINTS = 2000;

let activeSearch: ActiveSearch | null = null;
let searchGeneration = 0;
/** Cache the level data for the active search (needed for live path sims). */
let activeLevelData: RawLevelData | null = null;
/** Live-path sim cache keyed by the best VERSION — re-sims only when the
 * optimizer publishes a genuine new best (not every poll). */
let livePathCache: { version?: number; payload?: LivePathPayload } = {};

/** Downsample a full per-tick path to <= maxPoints, keeping the endpoints. */
function downsamplePath<T>(path: T[], maxPoints: number): { points: T[]; stride: number } {
  if (path.length <= maxPoints) return { points: path, stride: 1 };
  const stride = Math.ceil(path.length / maxPoints);
  const points: T[] = [];
  for (let i = 0; i < path.length; i += stride) points.push(path[i]);
  // Always keep the final sample so the ghost reaches the true end of the run.
  if (points.length === 0 || points[points.length - 1] !== path[path.length - 1]) {
    points.push(path[path.length - 1]);
  }
  return { points, stride };
}

/** Send a progress update to the renderer. */
function emitProgress(payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("nf:progress", payload);
  }
}

export function registerIpc() {
  // ---- Level catalog ------------------------------------------------------
  ipcMain.handle("nf:listLevels", () => LEVELS);
  ipcMain.handle("nf:listPacks", () => LEVEL_PACKS);
  ipcMain.handle("nf:listCachedLevels", () => listCachedLevels());

  // ---- Import a saved run/TAS file (use as a reference seed) -------------
  ipcMain.handle(
    "nf:importRun",
    async (): Promise<{
      inputs: string;
      inputCount: number;
      symbols: number[];
      arrowName: string;
      levelName?: string;
      finishTimeS?: number | null;
    } | null> => {
      const result = await dialog.showOpenDialog({
        title: "Import a saved run / TAS file (.json)",
        properties: ["openFile"],
        filters: [
          { name: "Narrow Route JSON (TAS / saved run)", extensions: ["json"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const text = await readFile(result.filePaths[0], "utf8");
      const doc = JSON.parse(text) as Record<string, unknown>;
      // Accept: the app's export doc, or a raw SavedRun / SearchResult shape.
      const inputs = typeof doc.inputs === "string" ? doc.inputs : undefined;
      const symbols = Array.isArray(doc.symbols) ? (doc.symbols as number[]) : undefined;
      const arrowName =
        (typeof doc.arrow_name === "string" && doc.arrow_name) ||
        (typeof doc.arrowName === "string" && doc.arrowName) ||
        "Narrow Arrow";
      const levelName =
        (typeof doc.level_name === "string" && doc.level_name) ||
        (typeof doc.levelName === "string" && doc.levelName) ||
        undefined;
      const finishTimeS =
        typeof doc.finish_time_s === "number"
          ? doc.finish_time_s
          : typeof doc.timeMs === "number"
            ? doc.timeMs / 1000
            : null;
      if (!inputs && !symbols) {
        throw new Error("No inputs or symbols found in this file.");
      }
      return {
        inputs: inputs ?? "",
        inputCount:
          typeof doc.input_count === "number"
            ? doc.input_count
            : (symbols?.length ?? 0),
        symbols: symbols ?? (inputs ? decodeInputSymbols(inputs) : []),
        arrowName,
        levelName,
        finishTimeS,
      };
    },
  );

  // ---- Level data (fetch + cache) ----------------------------------------
  ipcMain.handle("nf:getLevelInfo", (_e, id: string): LevelInfo | null => {
    return LEVELS.find((l) => l.id === id) ?? null;
  });

  ipcMain.handle(
    "nf:getLevelData",
    async (_e: IpcMainInvokeEvent, id: string): Promise<{ level: LevelInfo; geometry: ReturnType<typeof levelGeometry> }> => {
      const cached = readCachedLevel(id);
      if (cached) return { level: { id, name: cached.name ?? id, gameOrder: 0, packId: "custom" }, geometry: levelGeometry(cached.data) };
      const level = LEVELS.find((l) => l.id === id);
      // Unknown levels are still fetchable (published/custom maps): fetchLevelData
      // hits `level-details/{id}?isCustomLevel=true` which works for any ID.
      const data = await fetchLevelData(id);
      const name = level?.name ?? data.map_name ?? id;
      cacheLevel({ id, name, data, fetchedAt: Date.now() });
      return {
        level: level ?? { id, name, gameOrder: 0, packId: "custom" },
        geometry: levelGeometry(data),
      };
    },
  );

  // ---- Custom map import --------------------------------------------------
  ipcMain.handle(
    "nf:importCustomMap",
    async (_event): Promise<{ levelId: string; name: string; geometry: ReturnType<typeof levelGeometry> }> => {
      const result = await dialog.showOpenDialog({
        title: "Import custom map (.json)",
        properties: ["openFile"],
        filters: [
          { name: "Narrow Arrow map", extensions: ["json"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (result.canceled || result.filePaths.length === 0) {
        throw new Error("Import cancelled.");
      }
      const file = result.filePaths[0];
      const text = await readFile(file, "utf8");
      const data = normalizeCustomMap(JSON.parse(text));
      // Custom levels get a predictable local id and land in the cache.
      const levelId = `custom:${data.map_name ?? "map"}:${Date.now()}`;
      cacheLevel({ id: levelId, name: data.map_name ?? "Custom Map", data, fetchedAt: Date.now() });
      return { levelId, name: data.map_name ?? "Custom Map", geometry: levelGeometry(data) };
    },
  );

  // ---- Search -------------------------------------------------------------
  ipcMain.handle("nf:startSearch", async (_e, params: SearchParams) => {
    // Ensure the level is loaded (custom ids are already cached).
    const level = LEVELS.find((l) => l.id === params.levelId);
    let data: RawLevelData;
    if (level) {
      const cached = readCachedLevel(params.levelId);
      if (cached) data = cached.data;
      else {
        data = await fetchLevelData(params.levelId);
        cacheLevel({ id: params.levelId, name: level.name, data, fetchedAt: Date.now() });
      }
    } else {
      const cached = readCachedLevel(params.levelId);
      if (!cached) throw new Error(`Unknown level ${params.levelId} (import it first).`);
      data = cached.data;
    }

    if (activeSearch) {
      throw new Error("A search is already running — cancel it first.");
    }

    const coordinator = new Coordinator(data);
    const generation = ++searchGeneration;
    livePathCache = {};
    activeSearch = { coordinator, params, generation };
    activeLevelData = data;

    // Run the search without holding up the invoke; resolve immediately with a
    // searchId, and stream progress/results over events.
    const searchId = params.levelId + ":" + Date.now();
    void coordinator
      .run(params, {
        onProgress: (p) => {
          if (activeSearch?.generation !== generation) return; // stale run
          emitProgress({ ...p, searchId });
        },
        onResult: (r) => {
          if (activeSearch?.generation !== generation) return;
          saveRun(r);
          // The renderer's handler keys off `result` — include both the flat
          // result fields (for any progress UI) and the full result object.
          emitProgress({ ...r, done: true, result: r, searchId });
          if (activeSearch?.generation === generation) {
            activeSearch = null;
            activeLevelData = null;
          }
        },
        onError: (err) => {
          if (activeSearch?.generation !== generation) return;
          emitProgress({ error: String(err?.message ?? err), done: true, searchId });
          if (activeSearch?.generation === generation) {
            activeSearch = null;
            activeLevelData = null;
          }
        },
      })
      .catch((err) => {
        if (activeSearch?.generation !== generation) return;
        emitProgress({ error: String(err?.message ?? err), done: true, searchId });
        if (activeSearch?.generation === generation) {
          activeSearch = null;
          activeLevelData = null;
        }
      });

    return { searchId };
  });

  ipcMain.handle("nf:cancelSearch", () => {
    const current = activeSearch;
    if (current) {
      searchGeneration++; // invalidate any in-flight events from this run
      livePathCache = {};
      current.coordinator.stop();
      if (activeSearch === current) {
        activeSearch = null;
        activeLevelData = null;
      }
    }
    return true;
  });

  ipcMain.handle("nf:getLivePath", async (): Promise<LivePathPayload | null> => {
    const search = activeSearch;
    if (!search || !activeLevelData) return null;
    const bestVersion = search.coordinator.bestVersion;
    const bestSymbols = search.coordinator.bestSymbols;
    if (!bestSymbols || bestSymbols.length === 0) {
      livePathCache = {};
      return {
        searchId: search.params.levelId,
        bestVersion,
        path: [],
        tickCount: 0,
        stride: 1,
        finishTick: null,
        mode: search.params.mode,
        arrowName: search.params.arrowName,
      };
    }
    // Re-sim only when the optimum actually changed (the coordinator bumps its
    // best version on each genuine new best) — otherwise the poll would re-run
    // a blocking WASM sim every interval.
    if (livePathCache.version === bestVersion && livePathCache.payload) {
      return livePathCache.payload;
    }
    // Always simulate the FULL symbol stream: sampling symbols by stride would
    // change the physics (the engine is driven tick-by-tick), so the preview
    // would diverge from the run's real trajectory. Downsampling *after* the
    // sim only thins the rendered polyline.
    const sim = await simulateRunExact(activeLevelData, search.params.arrowName, bestSymbols);
    const { points, stride } = downsamplePath(sim.path, LIVE_PATH_MAX_POINTS);
    const payload: LivePathPayload = {
      searchId: search.params.levelId,
      bestVersion,
      path: points,
      tickCount: sim.path.length,
      stride,
      finishTick: sim.finishTick,
      mode: search.params.mode,
      arrowName: search.params.arrowName,
    };
    livePathCache = { version: bestVersion, payload };
    return payload;
  });

  ipcMain.handle(
    "nf:simulateReplay",
    async (_e, options: { levelId: string; arrowName?: string; inputs?: string; inputCount?: number }) => {
      const level = LEVELS.find((l) => l.id === options.levelId);
      let data: RawLevelData;
      if (level) {
        const cached = readCachedLevel(options.levelId);
        if (cached) data = cached.data;
        else {
          data = await fetchLevelData(options.levelId);
          cacheLevel({ id: options.levelId, name: level.name, data, fetchedAt: Date.now() });
        }
      } else {
        const cached = readCachedLevel(options.levelId);
        if (!cached) throw new Error(`Unknown level ${options.levelId} (import it first).`);
        data = cached.data;
      }
      const symbols = options.inputs
        ? decodeInputSymbols(options.inputs, options.inputCount)
        : [];
      const sim = await simulateRunExact(data, options.arrowName, symbols);
      return {
        path: sim.path,
        finishTick: sim.finishTick,
        timeMs: sim.finishTick != null ? sim.finishTick * (1000 / 240) : null,
      };
    },
  );

  // ---- Game API additions --------------------------------------------------
  ipcMain.handle(
    "nf:getLeaderboard",
    async (_e, options: { levelId: string; deep?: boolean; arrowFilter?: string }): Promise<LeaderboardEntry[]> =>
      fetchLeaderboard(options.levelId, { deep: options.deep, arrowFilter: options.arrowFilter }),
  );

  ipcMain.handle(
    "nf:listPublishedLevels",
    async (_e, options: { filter?: string; page?: number; search?: string }): Promise<PublishedLevel[]> =>
      fetchPublishedLevels({ filter: options?.filter, page: options?.page, search: options?.search }),
  );

  ipcMain.handle(
    "nf:getRunReplay",
    async (_e, runId: string | number): Promise<RunReplayPayload> => fetchRunReplay(runId),
  );

  ipcMain.handle("nf:levelImageUrl", (_e, levelId: string | number) => levelImageUrl(levelId));

  // ---- Saved runs + export ------------------------------------------------
  ipcMain.handle("nf:listRuns", () => listRuns());
  ipcMain.handle("nf:deleteRun", (_e, id: string) => {
    deleteRun(id);
    return true;
  });

  ipcMain.handle(
    "nf:exportRun",
    async (_e, run: SearchResult): Promise<{ saved: boolean; path?: string }> => {
      const defaultName = `Narrow-Route-${run.levelName.replace(/\s+/g, "-")}-${(run.timeMs ?? 0) / 1000}s.json`;
      const result = await dialog.showSaveDialog({
        title: "Export run",
        defaultPath: join(app.getPath("downloads"), defaultName),
        filters: [
          { name: "Narrow Route JSON (TAS)", extensions: ["json"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (result.canceled || !result.filePath) return { saved: false };
      const exportDoc = {
        format: "narrow-route-finder/run",
        version: 1,
        level_id: run.levelId,
        level_name: run.levelName,
        arrow_name: run.arrowName,
        finish_time_s: run.timeMs != null ? run.timeMs / 1000 : null,
        input_count: run.inputCount,
        inputs: run.inputs,
        symbols: run.symbols,
        mode: run.mode,
      };
      await writeFile(result.filePath, JSON.stringify(exportDoc, null, 2), "utf8");
      return { saved: true, path: result.filePath };
    },
  );

  // ---- Persistence root (used in tests and non-Electron contexts) ---------
  ipcMain.handle("nf:getStoreRoot", () => app.getPath("userData"));
}