/**
 * Coordinator: ties a search-mode implementation to the worker pool and streams
 * progress updates + final results back to the caller.
 */
import { SearchPool } from "./pool.ts";
import { beamSearch } from "./beam.ts";
import { geneticOptimize } from "./optimize.ts";
import { bruteSearch } from "./brute.ts";
import { simulateRunExact } from "./engine.ts";
import { decodeInputSymbols, encodeInputSymbols } from "../../shared/codec.ts";
import type { RawLevelData, SearchParams, SearchResult } from "../../shared/types.ts";
import type { RolloutEvaluator, ProgressSink } from "./types.ts";
import { levelName } from "../../shared/levels.ts";

export interface SearchProgress {
  searchId: string;
  mode: SearchParams["mode"];
  levelId: string;
  arrowName: string;
  message: string;
  done: boolean;
  bestTimeMs: number | null;
  bestFinishTick: number | null;
  evaluations: number;
  generations: number;
  rollouts: number;
  /** Current best run's symbol stream — renderer simulates it live. */
  bestSymbols?: number[];
}

export interface CoordinatorEvents {
  onProgress?: (p: SearchProgress) => void;
  onResult?: (r: SearchResult) => void;
  onError?: (err: Error) => void;
}

export class Coordinator {
  private pool: SearchPool | null = null;
  private currentBestSymbols: number[] | null = null;
  /** Bumped every time `bestSymbols` is replaced (a genuine new best). The
   * renderer's live ghost restarts only when this changes — a cheap signal
   * that survives IPC structured-clone. */
  private currentBestVersion = 0;

  constructor(private readonly levelData: RawLevelData) {}

  /** Latest best symbol stream seen during a run (null before first progress). */
  get bestSymbols(): number[] | null {
    return this.currentBestSymbols;
  }

  /** Monotonic version of the current best (1 = first best, 0 = none yet). */
  get bestVersion(): number {
    return this.currentBestVersion;
  }

  async run(params: SearchParams, events: CoordinatorEvents): Promise<SearchResult> {
    const pool = new SearchPool();
    this.pool = pool;
    const levelJson = this.levelData;
    const arrow = params.arrowName || "Narrow Arrow";

    // Spawn the pool (N-1 workers) for this level+arrow.
    await pool.start(levelJson, arrow, params.levelId);

    const evaluator: RolloutEvaluator = {
      evalMany: (c) => pool.evalMany(c),
      parallelism: pool.size,
    };

    const budgetMs = (params.budgetSec ?? 30) * 1000;
    const rngSeed = params.rngSeed ?? 1;

    const sink: ProgressSink = (u) => {
      if (u.bestSymbols) {
        // Keep the FULL stream — the live path piggy-backs on the renderer's
        // nf:getLivePath and downsamples from here, so never truncate.
        this.currentBestSymbols = u.bestSymbols.slice();
        this.currentBestVersion++;
      }
      events.onProgress?.({
        searchId: params.levelId,
        message: u.message,
        done: false,
        mode: params.mode,
        levelId: params.levelId,
        arrowName: arrow,
        bestTimeMs: u.bestTimeMs,
        bestFinishTick: u.bestFinishTick,
        evaluations: u.evaluations,
        generations: u.generations,
        rollouts: u.rollouts,
        // The renderer ignores bestSymbols on progress events; keep payloads
        // small (the live path comes back through nf:getLivePath).
        bestSymbols: undefined,
      });
    };

    let symbols: number[] = [];
    let finishTick: number | null = null;
    let evaluations = 0;
    let generations = 0;
    let seedFinishTick: number | null = null;

    try {
      switch (params.mode) {
        case "beam": {
          const res = await beamSearch(
            evaluator,
            {
              beamWidth: params.beamWidth ?? 64,
              actionRepeat: params.actionRepeat ?? 1,
              maxDepth: params.maxDepth ?? 6000,
              budgetMs,
              maxNodes: 2_000_000,
              rngSeed,
            },
            sink,
          );
          symbols = res.symbols;
          finishTick = res.finishTick;
          evaluations = res.evaluations;
          generations = res.generations;
          break;
        }
        case "genetic": {
          // Seed from the caller's inputs, if provided.
          const seedSymbols = params.seedInputs
            ? decodeInputsFromSeed(params.seedInputs, params.seedInputCount)
            : undefined;
          if (!seedSymbols || seedSymbols.length === 0) {
            throw new Error("Genetic mode needs a seed run (import one or run Beam/Brute first).");
          }
          const res = await geneticOptimize(
            evaluator,
            {
              seedSymbols,
              seedFinishTick: params.seedFinishTick ?? null,
              budgetMs,
              population: params.population ?? 48,
              generationsCap: params.generations ?? 10_000,
              mutationRate: params.mutationRate ?? 0.5,
              rngSeed,
              useCrossover: true,
              eliteCount: 4,
              referenceInfluence: params.referenceInfluence ?? 0.5,
            },
            sink,
          );
          symbols = res.symbols;
          finishTick = res.finishTick;
          evaluations = res.evaluations;
          generations = res.generations;
          seedFinishTick = res.seedFinishTick;
          break;
        }
        case "brute": {
          const prefix = params.seedInputs ? decodeInputsFromSeed(params.seedInputs, params.seedInputCount) : [];
          const res = await bruteSearch(
            evaluator,
            {
              actionTicks: params.actionTicks ?? 4,
              maxDepth: params.maxDepth ?? 1200,
              maxCandidates: params.maxCandidates ?? 50_000,
              budgetMs,
              prefixSymbols: prefix,
              rngSeed,
            },
            sink,
          );
          symbols = res.symbols;
          finishTick = res.finishTick;
          evaluations = res.evaluations;
          break;
        }
      }
    } finally {
      pool.stop();
      this.pool = null;
    }

    // Rebuild the exact trajectory for playback. The input stream is capped at
    // the finishing tick so the replay's tick count matches the recorded time:
    // a finished flag on a stale path is just a marker in the returned geometry.
    const sim =
      finishTick != null && symbols.length > finishTick
        ? await simulateRunExact(levelJson, arrow, symbols.slice(0, finishTick))
        : await simulateRunExact(levelJson, arrow, symbols);
    const exactFinish = sim.finishTick ?? finishTick;

    const result: SearchResult = {
      searchId: crypto.randomUUID(),
      mode: params.mode,
      levelId: params.levelId,
      levelName: levelName(params.levelId),
      arrowName: arrow,
      symbols,
      inputs: encodeInputSymbols(symbols),
      inputCount: symbols.length,
      finishTick: exactFinish,
      timeMs: exactFinish != null ? exactFinish * (1000 / 240) : null,
      seedTimeMs: seedFinishTick != null ? seedFinishTick * (1000 / 240) : null,
      improved:
        seedFinishTick == null || (exactFinish != null && exactFinish < seedFinishTick),
      evaluations,
      generations,
      rollouts: evaluations,
      stats: {
        bestTick: exactFinish,
        seedTick: seedFinishTick,
      },
      path: sim.path,
      bounds: sim.path.length
        ? {
            minX: Math.min(...sim.path.map((p) => p.x)),
            minY: Math.min(...sim.path.map((p) => p.y)),
            maxX: Math.max(...sim.path.map((p) => p.x)),
            maxY: Math.max(...sim.path.map((p) => p.y)),
          }
        : { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    };

    events.onResult?.(result);
    return result;
  }

  stop() {
    this.pool?.stop();
  }
}

/** Decode a seed from base64 inputs (honoring the symbol count). */
export function decodeInputsFromSeed(inputs: string, inputCount?: number): number[] {
  if (!inputs) return [];
  try {
    // Trims the zero-padded tail of the final byte when a count is known.
    return decodeInputSymbols(inputs, inputCount);
  } catch {
    return [];
  }
}