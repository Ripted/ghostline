/**
 * Preload: exposes the typed `window.nf` bridge to the renderer.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { LeaderboardEntry, LevelGeometryPayload, LevelInfo, LevelPack, PublishedLevel, RunReplayPayload, SearchParams, SearchResult, SimPoint } from "../shared/types";

export type { LevelGeometryPayload };

/** A live snapshot of the running search's best path. */
export interface LivePathSnapshot {
  searchId?: string;
  bestSymbols?: number[];
  path?: SimPoint[];
  finishTick?: number | null;
  mode?: SearchParams["mode"];
  arrowName?: string;
}

export interface SearchProgressEvent {
  searchId: string;
  done?: boolean;
  error?: string;
  message?: string;
  mode?: SearchParams["mode"];
  levelId?: string;
  arrowName?: string;
  bestTimeMs?: number | null;
  bestFinishTick?: number | null;
  evaluations?: number;
  generations?: number;
  rollouts?: number;
  bestSymbols?: number[];
  /** Live path snapshot (from nf:getLivePath). */
  path?: SimPoint[];
  result?: SearchResult;
}

export interface NfApi {
  listLevels(): Promise<LevelInfo[]>;
  listPacks(): Promise<LevelPack[]>;
  getLevelInfo(id: string): Promise<LevelInfo | null>;
  getLevelData(id: string): Promise<LevelGeometryPayload>;
  importCustomMap(): Promise<{ levelId: string; name: string; geometry: LevelGeometryPayload["geometry"] }>;
  startSearch(params: SearchParams): Promise<{ searchId: string }>;
  cancelSearch(): Promise<boolean>;
  listRuns(): Promise<SearchResult[]>;
  deleteRun(id: string): Promise<boolean>;
  exportRun(run: SearchResult): Promise<{ saved: boolean; path?: string }>;
  onSearchProgress(cb: (evt: SearchProgressEvent) => void): () => void;
  // ---- Game API additions -------------------------------------------------
  getLeaderboard(options: {
    levelId: string;
    deep?: boolean;
    arrowFilter?: string;
  }): Promise<LeaderboardEntry[]>;
  listPublishedLevels(options: {
    filter?: string;
    page?: number;
    search?: string;
  }): Promise<PublishedLevel[]>;
  getRunReplay(runId: string | number): Promise<RunReplayPayload>;
  levelImageUrl(levelId: string | number): string;
  /** Poll the active search's current best path (downsampled) at frame rate. */
  getLivePath(): Promise<LivePathSnapshot | null>;
  /** Simulate an arbitrary replay (inputs + arrow) on a level -> full path. */
  simulateReplay(options: {
    levelId: string;
    arrowName?: string;
    inputs?: string;
    inputCount?: number;
  }): Promise<{ path: SimPoint[]; finishTick: number | null; timeMs: number | null }>;
}

const api: NfApi = {
  listLevels: () => ipcRenderer.invoke("nf:listLevels"),
  listPacks: () => ipcRenderer.invoke("nf:listPacks"),
  getLevelInfo: (id) => ipcRenderer.invoke("nf:getLevelInfo", id),
  getLevelData: (id) => ipcRenderer.invoke("nf:getLevelData", id),
  importCustomMap: () => ipcRenderer.invoke("nf:importCustomMap"),
  startSearch: (params) => ipcRenderer.invoke("nf:startSearch", params),
  cancelSearch: () => ipcRenderer.invoke("nf:cancelSearch"),
  listRuns: () => ipcRenderer.invoke("nf:listRuns"),
  deleteRun: (id) => ipcRenderer.invoke("nf:deleteRun", id),
  exportRun: (run) => ipcRenderer.invoke("nf:exportRun", run),
  getLeaderboard: (options) => ipcRenderer.invoke("nf:getLeaderboard", options),
  listPublishedLevels: (options) => ipcRenderer.invoke("nf:listPublishedLevels", options),
  getRunReplay: (runId) => ipcRenderer.invoke("nf:getRunReplay", runId),
  levelImageUrl: (levelId) => `https://api.narrowarrow.xyz/level-image/${encodeURIComponent(String(levelId))}.png`,
  getLivePath: () => ipcRenderer.invoke("nf:getLivePath"),
  simulateReplay: (options) => ipcRenderer.invoke("nf:simulateReplay", options),
  onSearchProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, payload: SearchProgressEvent) => cb(payload);
    ipcRenderer.on("nf:progress", listener);
    return () => ipcRenderer.removeListener("nf:progress", listener);
  },
};

contextBridge.exposeInMainWorld("nf", api);

export type NfGlobal = NfApi;
export type { SimPoint };
export type { SearchResult };