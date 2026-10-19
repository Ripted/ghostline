/**
 * Search worker: one per CPU core. Each worker owns a WASM engine instance for
 * the current level+arrow and rolls out batches of candidate input sequences,
 * reporting the terminal code, finish tick, progress and — for finished runs —
 * the exact time.
 *
 * The engine accumulates state, so the worker resets it before every rollout.
 * Because `Engine.reset()` rebuilds the underlying WASM state via the level
 * build function, each candidate is rolled out from a clean spawn exactly as
 * the game would.
 */
import { parentPort, workerData } from "node:worker_threads";
import { Engine } from "./engine.ts";
import type { RawLevelData } from "../../shared/types.ts";

interface WorkerInit {
  levelData: RawLevelData;
  arrowName: string;
  levelId: string;
}

interface EvalTask {
  type?: string;
  id: number;
  /** Candidate symbol streams to roll out (deliberately small batches). */
  symbols: number[][];
}

interface EvalResponse {
  type: "eval";
  id: number;
  results: Array<{
    code: number;
    finishTick: number | null;
    survivedTicks: number;
    progress: number;
    timeMs: number | null;
  }>;
}

interface ReadyMessage {
  type: "ready";
}

interface FatalMessage {
  type: "fatal";
  error: string;
}

const ctx = workerData as WorkerInit;

let engine: Engine | null = null;

function respond(msg: EvalResponse | ReadyMessage | FatalMessage) {
  parentPort?.postMessage(msg);
}

async function main() {
  try {
    engine = await Engine.create(ctx.levelData, ctx.arrowName, ctx.levelId);
    if (!engine) throw new Error("engine init failed");
  } catch (err) {
    // Signal the pool that this worker is unusable and exit cleanly so the
    // pool can keep running the remaining workers.
    respond({ type: "fatal", error: err instanceof Error ? err.message : String(err) });
    process.exit(0);
  }

  respond({ type: "ready" });
  parentPort?.on("message", (msg: EvalTask) => {
    if (!msg || msg.type === "shutdown") return;
    const task = msg;
    if (!engine) {
      respond({ type: "eval", id: task.id, results: [] });
      return;
    }
    const results = task.symbols.map((symbols) => {
      engine!.reset();
      const { code, finishTick, lastPoint, survivedTicks } = engine!.rollout(symbols);
      const timeMs = finishTick !== null ? (finishTick * 1000) / 240 : null;
      // progress is relative to the spawn->finish direction; recompute directly
      // on the final point so we don't need to re-read the engine (progressOf
      // is cheap).
      const progress = engine!.progressOf(lastPoint);
      return { code, finishTick, survivedTicks, progress, timeMs };
    });
    respond({ type: "eval", id: task.id, results });
  });
}

void main();