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
  listRuns,
  readCachedLevel,
  saveRun,
} from "./store/store.ts";
import { levelGeometry } from "../shared/geometry.ts";

interface ActiveSearch {
  coordinator: Coordinator;
  params: SearchParams;
}

let activeSearch: ActiveSearch | null = null;
/** Cache the level data for the active search (needed for live path sims). */
let activeLevelData: RawLevelData | null = null;

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
    activeSearch = { coordinator, params };
    activeLevelData = data;

    // Run the search without holding up the invoke; resolve immediately with a
    // searchId, and stream progress/results over events.
    const searchId = params.levelId + ":" + Date.now();
    void coordinator
      .run(params, {
        onProgress: (p) => emitProgress({ ...p, searchId }),
        onResult: (r) => {
          saveRun(r);
          emitProgress({ ...r, done: true, searchId });
          activeSearch = null;
          activeLevelData = null;
        },
        onError: (err) => {
          emitProgress({ error: String(err?.message ?? err), done: true, searchId });
          activeSearch = null;
          activeLevelData = null;
        },
      })
      .catch((err) => {
        emitProgress({ error: String(err?.message ?? err), done: true, searchId });
        activeSearch = null;
        activeLevelData = null;
      });

    return { searchId };
  });

  ipcMain.handle("nf:cancelSearch", () => {
    activeSearch?.coordinator.stop();
    activeSearch = null;
    activeLevelData = null;
    return true;
  });

  ipcMain.handle("nf:getLivePath", async (): Promise<unknown | null> => {
    const search = activeSearch;
    if (!search || !activeLevelData) return null;
    const bestSymbols = search.coordinator.bestSymbols;
    if (!bestSymbols || bestSymbols.length === 0) {
      return { searchId: search.params.levelId, bestSymbols: [], path: [] as unknown[], done: false };
    }
    // Downsample for cheap live preview (cap 2000 pts, stride ~8).
    const stride = Math.max(1, Math.floor(bestSymbols.length / 2000));
    let sampled: number[] = bestSymbols;
    if (stride > 1) {
      sampled = [];
      for (let i = 0; i < bestSymbols.length; i += stride) sampled.push(bestSymbols[i]);
    }
    const sim = await simulateRunExact(activeLevelData, search.params.arrowName, sampled);
    return {
      searchId: search.params.levelId,
      bestSymbols,
      path: sim.path,
      finishTick: sim.finishTick,
      mode: search.params.mode,
      arrowName: search.params.arrowName,
    };
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