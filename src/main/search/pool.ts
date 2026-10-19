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
  /** Set once the worker signals `ready`. */
  started: boolean;
  /** Set when the worker died/errored; idle-scan skips it and jobs fail fast. */
  dead: boolean;
}

/** Map a message id -> chunk position so results can be reassembled. */
class JobTracker {
  private byId = new Map<
    number,
    { owner: number; resolve: (r: EvalResult[]) => void; reject: (e: Error) => void }
  >();
  private nextId = 0;

  register(owner: number, chunkSize: number): { id: number; promise: Promise<EvalResult[]> } {
    const id = this.nextId++;
    let resolve!: (r: EvalResult[]) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<EvalResult[]>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    void chunkSize;
    this.byId.set(id, { owner, resolve, reject });
    return { id, promise };
  }

  settle(id: number, results: EvalResult[]) {
    const entry = this.byId.get(id);
    if (entry) {
      this.byId.delete(id);
      entry.resolve(results);
    }
  }

  /** Fail the jobs owned by a dead worker (leaves healthy workers' jobs intact). */
  rejectForOwner(owner: number, message: string) {
    for (const [id, entry] of this.byId) {
      if (entry.owner === owner) {
        this.byId.delete(id);
        entry.reject(new Error(message));
      }
    }
  }

  /** Fail every pending job (used on pool stop). */
  rejectAll(message: string) {
    for (const entry of this.byId.values()) entry.reject(new Error(message));
    this.byId.clear();
  }
}

export class SearchPool {
  private workers: WorkerRec[] = [];
  private readyWaiters: Array<() => void> = [];
  private tracker = new JobTracker();
  private stopped = false;
  /** Resolve functions keyed by worker index — called from worker "ready". */
  private startResolvers = new Map<number, () => void>();

  async start(
    levelData: RawLevelData,
    arrowName: string,
    levelId: string,
    count?: number,
  ): Promise<void> {
    const n = Math.max(1, count ?? Math.max(1, cpus().length - 1));
    const workerCount = Math.min(n, 8);
    const script = workerScriptPath();
    const boots: Promise<void>[] = [];
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(script, {
        workerData: { levelData, arrowName, levelId },
      });
      const boot = new Promise<void>((resolve, reject) => {
        this.startResolvers.set(i, resolve);
        this.startRejecters.set(i, reject);
      });
      boots.push(boot);
      worker.on("message", (msg) => {
        const rec = this.workers[i];
        if (!rec) return;
        const type = (msg as { type?: string })?.type;
        if (type === "ready") {
          rec.started = true;
          this.startResolvers.get(i)?.();
          this.startResolvers.delete(i);
          this.startRejecters.delete(i);
          // Resume any waiting idle-scan.
          void this.readyWaiters.splice(0).forEach((r) => r());
          return;
        }
        if (type === "fatal") {
          const err = (msg as { error?: string })?.error ?? "worker init failed";
          this.markDead(i, err);
          return;
        }
        this.onEvalMessage(rec, msg);
      });
      worker.on("error", (err) => {
        this.markDead(i, `worker crash: ${err?.message ?? err}`);
      });
      worker.on("exit", (code) => {
        if (code !== 0) this.markDead(i, `worker exited with code ${code}`);
        else if (!this.stopped) this.markDead(i, "worker exited");
      });
      this.workers.push({ worker, busy: false, started: false, dead: false });
    }
    // Fail fast if any worker can't boot (e.g. missing engine/wasm).
    await Promise.allSettled(boots).then((results) => {
      const failed = results.some((r) => r.status === "rejected");
      if (failed) this.tracker.rejectAll("One or more search workers failed to start.");
    });
    await this.waitForReady();
  }

  private startRejecters = new Map<number, (e: Error) => void>();

  private markDead(index: number, message: string) {
    const rec = this.workers[index];
    if (!rec || rec.dead) return;
    rec.dead = true;
    rec.busy = false;
    this.startRejecters.get(index)?.(new Error(message));
    this.startRejecters.delete(index);
    this.startResolvers.delete(index);
    // Fail only the jobs this worker was carrying; the dispatcher's retry
    // loop re-runs them on a healthy worker instead of failing the batch.
    this.tracker.rejectForOwner(index, message);
    // Wake waiters so evalMany can continue with remaining workers.
    void this.readyWaiters.splice(0).forEach((r) => r());
  }

  get size(): number {
    return this.workers.filter((w) => !w.dead && w.started).length;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  private onEvalMessage(rec: WorkerRec, msg: unknown) {
    if (rec.dead) return;
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type?: string };
    if (m.type !== "eval") return;
    rec.busy = false;
    const evalMsg = m as { id: number; results: EvalResult[] };
    this.tracker.settle(evalMsg.id, evalMsg.results);
    // A worker just freed up; let an idle-scan waiting on it continue.
    void this.readyWaiters.splice(0).forEach((r) => r());
  }

  private async waitForReady(bootTimeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + bootTimeoutMs;
    for (;;) {
      if (this.stopped) throw new Error("Search stopped.");
      const pending = this.workers.filter((w) => !w.started && !w.dead);
      if (pending.length === 0) return;
      if (Date.now() > deadline) {
        // Treat the still-booting workers as dead so no dispatcher ever posts
        // to them (a post to a worker that never handshakes would hang); the
        // retry loop re-queues to the workers that did boot.
        for (let i = 0; i < this.workers.length; i++) {
          const w = this.workers[i];
          if (!w.started && !w.dead) this.markDead(i, "worker failed to boot in time");
        }
        void this.readyWaiters.splice(0).forEach((r) => r());
        return;
      }
      await new Promise<void>((resolve) => this.readyWaiters.push(resolve));
    }
  }

  /**
   * Evaluate `candidates` (each a symbol array), dispatching in parallel
   * across the worker pool. Results align with the input order.
   */
  async evalMany(candidates: number[][]): Promise<RolloutOutcome[]> {
    if (candidates.length === 0) return [];
    if (this.stopped || this.workers.length === 0) throw new Error("Pool not started.");
    const live = this.workers.filter((w) => !w.dead);
    if (live.length === 0) throw new Error("All search workers are dead.");
    const results = new Array<RolloutOutcome>(candidates.length);

    // Split candidates into per-worker chunks.
    const chunkSize = 64;
    const taskList: Array<{ from: number; chunk: number[][] }> = [];
    for (let i = 0; i < candidates.length; i += chunkSize) {
      taskList.push({ from: i, chunk: candidates.slice(i, i + chunkSize) });
    }

    // Dispatch all chunks in a work-stealing loop: each dispatcher grabs the
    // next task, sends it to the next free worker, awaits, repeats. If the
    // worker it landed a chunk on dies mid-job, the job is re-enqueued (the
    // chunk's results stay undefined until retried).
    let cursor = 0;
    // Chunks that failed on a dead worker and are waiting to be re-run.
    const retryQueue: Array<{ from: number; chunk: number[][] }> = [];
    const nextTask = (): { from: number; chunk: number[][] } | null => {
      if (cursor < taskList.length) return taskList[cursor++];
      return retryQueue.shift() ?? null;
    };

    const dispatchOne = async (): Promise<void> => {
      for (;;) {
        if (this.stopped) return;
        const task = nextTask();
        if (!task) return;
        const rec = await this.nextIdleWorker();
        if (!rec) {
          // No healthy workers left; if any are still booting, wait and retry.
          retryQueue.push(task);
          continue;
        }
        if (rec.dead) {
          // Died between nextIdleWorker returning and this dispatch; re-run the
          // chunk rather than posting to a terminated worker (posts to a
          // thread that has exited are dropped silently and would hang).
          retryQueue.push(task);
          continue;
        }
        const workerIndex = this.workers.indexOf(rec);
        const { id, promise } = this.tracker.register(workerIndex, task.chunk.length);
        rec.busy = true;
        try {
          rec.worker.postMessage({ id, symbols: task.chunk });
        } catch {
          rec.busy = false;
          this.markDead(workerIndex, "worker unresponsive");
          // Re-run this chunk elsewhere.
          retryQueue.push(task);
          continue;
        }
        let batch: EvalResult[];
        try {
          batch = await promise;
        } catch {
          // The worker carrying this chunk died. If any healthy worker remains,
          // re-queue the chunk; otherwise give up on the whole batch.
          if (this.workers.some((w) => !w.dead)) {
            retryQueue.push(task);
            continue;
          }
          throw new Error("All search workers are dead.");
        }
        batch.forEach((r, i) => {
          results[task.from + i] = r;
        });
      }
    };

    // One dispatcher per healthy worker; each loops grabbing tasks until the
    // queues are drained (a dispatcher that finishes early picks up retries).
    const dispatchers = live.map(() => dispatchOne());
    // If all workers die or the pool is stopped, dispatchers reject — propagate
    // the failure rather than hanging.
    await Promise.all(dispatchers);
    return results;
  }

  /** Wait until a non-dead, non-busy worker is available, or fail fast. */
  private async nextIdleWorker(): Promise<WorkerRec | null> {
    for (;;) {
      if (this.stopped) throw new Error("Search stopped.");
      const idle = this.workers.find((w) => !w.dead && !w.busy);
      if (idle) return idle;
      const anyAlive = this.workers.some((w) => !w.dead);
      if (!anyAlive) throw new Error("All search workers are dead.");
      // Wait for a worker to free up (woken by onEvalMessage/markDead).
      await new Promise<void>((resolve) => this.readyWaiters.push(resolve));
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.tracker.rejectAll("Search cancelled.");
    for (const rec of this.workers) {
      try {
        rec.worker.postMessage({ type: "shutdown" });
      } catch {
        /* already dead */
      }
      void rec.worker.terminate();
    }
    this.workers = [];
    void this.readyWaiters.splice(0).forEach((r) => r());
  }
}