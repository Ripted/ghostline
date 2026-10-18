/**
 * Preload: exposes the typed `window.nf` bridge to the renderer.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { LevelGeometryPayload, LevelInfo, LevelPack, SearchParams, SearchResult, SimPoint } from "../shared/types";

export type { LevelGeometryPayload };

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