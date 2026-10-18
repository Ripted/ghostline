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
import type { LevelInfo, SearchParams, SearchResult, RawLevelData } from "../shared/types.ts";
import { LEVELS, LEVEL_PACKS } from "../shared/levels.ts";
import { fetchLevelData, normalizeCustomMap } from "./fetch/upstream.ts";
import { Coordinator } from "./search/coordinator.ts";
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
      const level = LEVELS.find((l) => l.id === id);
      if (!level) throw new Error(`Unknown level ${id}`);
      const cached = readCachedLevel(id);
      let data: RawLevelData | null = null;
      if (cached) data = cached.data;
      else {
        data = await fetchLevelData(id);
        cacheLevel({ id, name: level.name, data, fetchedAt: Date.now() });
      }
      return { level, geometry: levelGeometry(data) };
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
        },
        onError: (err) => {
          emitProgress({ error: String(err?.message ?? err), done: true, searchId });
          activeSearch = null;
        },
      })
      .catch((err) => {
        emitProgress({ error: String(err?.message ?? err), done: true, searchId });
        activeSearch = null;
      });

    return { searchId };
  });

  ipcMain.handle("nf:cancelSearch", () => {
    activeSearch?.coordinator.stop();
    activeSearch = null;
    return true;
  });

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