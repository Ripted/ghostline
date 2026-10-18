/**
 * Runtime loader for the Narrow Arrow physics engine (Rust/WASM).
 *
 * The glue (`rust.js`) is a wasm-bindgen ESM module that by default fetches
 * `rust_bg.wasm` via `new URL(...)`, which is browser-oriented and fails inside
 * Electron / plain Node. We therefore:
 *   - locate the physics directory on disk (dev tree or packaged resources),
 *   - dynamic-import the glue module from its file path (never bundled), and
 *   - hand the wasm **bytes** to `initSync({ module: bytes })`, which accepts
 *     raw bytes and needs no fetch.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface GameEngineHandle {
  process_ticks(inputs: Array<{ left: boolean; right: boolean }>): void;
  player_state_code(): number;
  get_ticks(): number;
  readonly state: string;
  run_stats(): string;
  free(): void;
}

/** The Engine class plus its static factory on the module namespace. */
export interface GameEngineCtor {
  new (state: unknown): GameEngineHandle;
  from_state: (state: unknown) => GameEngineHandle;
}

export interface PhysicsModule {
  GameMechanicsEngine: GameEngineCtor;
  from_state: (state: unknown) => GameEngineHandle;
  create_default_game_state: () => unknown;
  initSync: (module: { module: ArrayBuffer | WebAssembly.Module }) => void;
}

let physicsDirCache: string | null = null;

function fileExists(p: string): boolean {
  try {
    return readFileSync(p).length > 0;
  } catch {
    return false;
  }
}

function appPathFallback(): string | null {
  try {
    // `electron` is not importable under plain Node tests; only use it live.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("electron")?.app?.getAppPath?.() ?? null;
  } catch {
    return null;
  }
}

/** Candidate locations of rust.js + rust_bg.wasm, best to worst. */
function candidates(): string[] {
  const out: string[] = [];
  if (typeof process.resourcesPath === "string") {
    out.push(join(process.resourcesPath, "physics"));
  }
  const appPath = appPathFallback();
  if (appPath) {
    out.push(join(appPath, "resources", "physics"));
    out.push(join(appPath, "physics"));
  }
  // Built main lives in out/main; resources live at the project root.
  out.push(join(process.cwd(), "resources", "physics"));
  out.push(join(process.cwd(), "physics"));
  return out;
}

/** Absolute directory containing rust.js and rust_bg.wasm, or null. */
export function physicsDir(): string | null {
  if (physicsDirCache) return physicsDirCache;
  for (const dir of candidates()) {
    if (fileExists(join(dir, "rust.js")) && fileExists(join(dir, "rust_bg.wasm"))) {
      physicsDirCache = dir;
      return dir;
    }
  }
  return null;
}

let modulePromise: Promise<PhysicsModule> | null = null;

/** Load (once per process) the physics module and initialise its wasm. */
export function loadPhysicsModule(): Promise<PhysicsModule> {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const dir = physicsDir();
    if (!dir) throw new Error(
      "Physics engine not found — expected rust.js + rust_bg.wasm alongside the app " +
      "(looked in resources/physics and packaged resources).",
    );
    const wasmBytes = readFileSync(join(dir, "rust_bg.wasm"));
    const mod = await import(pathToFileURL(join(dir, "rust.js")).href);
    mod.initSync({ module: wasmBytes });
    return mod as unknown as PhysicsModule;
  })();
  return modulePromise;
}

/** Synchronous read of the wasm bytes for a worker's initSync. */
export function physicsWasmBytes(): Buffer {
  const dir = physicsDir();
  if (!dir) throw new Error("Physics engine not found.");
  return readFileSync(join(dir, "rust_bg.wasm"));
}