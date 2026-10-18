/**
 * Worker pool: N-1 workers (capped), each owning one WASM engine, with a simple
 * job queue: candidates are chunked and dispatched to whichever worker is
 * free; results are matched back by id and reassembled in request order.
 */
import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RawLevelData } from "../../shared/types.ts";
import type { RolloutOutcome } from "./types.ts";

/** Absolute path to the built worker bundle (dev build / packaged app). */
function workerScriptPath(): string {
  // Dev: out/main/worker.js next to this module after electron-vite build.
  // Packaged: process.resourcesPath/app.asar/out/main/worker.js won't fs-read
  // inside asar for worker_threads, so asar unpacking is configured in
  // electron-builder.yml. Prefer the unpacked copy when it exists.
  const candidates = [
    join(process.resourcesPath ?? "", "app.asar.unpacked", "out", "main", "worker.js"),
    join(process.resourcesPath ?? "", "app", "out", "main", "worker.js"),
    join(process.cwd(), "out", "main", "worker.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[candidates.length - 1];
}

interface EvalResult {
  code: number;
  finishTick: number | null;
  survivedTicks: number;
  progress: number;
  timeMs: number | null;
}

interface WorkerRec {
  worker: Worker;
  busy: boolean;
}

// (Chunk positions are tracked in the evalMany closure via taskList order.)

/** Map a message id -> chunk position so results can be reassembled. */
class JobTracker {
  private byId = new Map<number, { resolve: (r: EvalResult[]) => void }>();
  private nextId = 0;

  register(chunkSize: number): { id: number; promise: Promise<EvalResult[]> } {
    const id = this.nextId++;
    let resolve!: (r: EvalResult[]) => void;
    const promise = new Promise<EvalResult[]>((res) => {
      resolve = res;
    });
    void chunkSize;
    this.byId.set(id, { resolve });
    return { id, promise };
  }

  settle(id: number, results: EvalResult[]) {
    const entry = this.byId.get(id);
    if (entry) {
      this.byId.delete(id);
      entry.resolve(results);
    }
  }
}

export class SearchPool {
  private workers: WorkerRec[] = [];
  private ready = 0;
  private readyWaiters: Array<() => void> = [];
  private tracker = new JobTracker();
  private stopped = false;

  async start(
    levelData: RawLevelData,
    arrowName: string,
    levelId: string,
    count?: number,
  ): Promise<void> {
    const n = Math.max(1, count ?? Math.max(1, cpus().length - 1));
    const workerCount = Math.min(n, 8);
    const script = workerScriptPath();
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(script, {
        workerData: { levelData, arrowName, levelId },
      });
      worker.on("message", (msg) => this.onMessage(worker, msg));
      worker.on("error", () => {
        /* handled at the eval promise */
      });
      worker.on("exit", () => {});
      this.workers.push({ worker, busy: false });
    }
    await this.waitForReady();
  }

  get size(): number {
    return this.workers.length;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  private onMessage(worker: Worker, msg: unknown) {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type?: string };
    if (m.type === "ready") {
      this.ready++;
      if (this.ready === this.workers.length) {
        for (const r of this.readyWaiters) r();
        this.readyWaiters = [];
      }
      return;
    }
    if (m.type === "eval") {
      const rec = this.workers.find((w) => w.worker === worker);
      if (rec) rec.busy = false;
      const evalMsg = m as { id: number; results: EvalResult[] };
      this.tracker.settle(evalMsg.id, evalMsg.results);
    }
  }

  private waitForReady(): Promise<void> {
    if (this.ready >= this.workers.length) return Promise.resolve();
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  /**
   * Evaluate `candidates` (each a symbol array), dispatching in parallel
   * across the worker pool. Results align with the input order.
   */
  async evalMany(candidates: number[][]): Promise<RolloutOutcome[]> {
    if (candidates.length === 0) return [];
    if (this.stopped || this.workers.length === 0) throw new Error("Pool not started.");
    const results = new Array<RolloutOutcome>(candidates.length);

    // Split candidates into per-worker chunks.
    const chunkSize = 64;
    const taskList: Array<{ from: number; chunk: number[][] }> = [];
    for (let i = 0; i < candidates.length; i += chunkSize) {
      taskList.push({ from: i, chunk: candidates.slice(i, i + chunkSize) });
    }

    // Dispatch all chunks in a work-stealing loop: each dispatcher grabs the
    // next task, sends it to the next free worker, awaits, repeats.
    const parallel = this.workers.length;
    let cursor = 0;
    const dispatchOne = async (): Promise<void> => {
      while (cursor < taskList.length && !this.stopped) {
        const task = taskList[cursor];
        cursor++;
        const rec = await this.nextIdleWorker();
        const { id, promise } = this.tracker.register(task.chunk.length);
        rec.busy = true;
        rec.worker.postMessage({ id, symbols: task.chunk });
        const batch = await promise;
        batch.forEach((r, i) => {
          results[task.from + i] = r;
        });
      }
    };

    await Promise.all(Array.from({ length: parallel }, () => dispatchOne()));
    return results;
  }

  /** Wait until any worker is idle, then return it. */
  private async nextIdleWorker(): Promise<WorkerRec> {
    for (;;) {
      const idle = this.workers.find((w) => !w.busy);
      if (idle) return idle;
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  stop() {
    this.stopped = true;
    for (const rec of this.workers) {
      try {
        rec.worker.postMessage({ type: "shutdown" });
      } catch {
        /* already dead */
      }
      void rec.worker.terminate();
    }
    this.workers = [];
    this.ready = 0;
  }
}