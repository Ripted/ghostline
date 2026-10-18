/** Shared search primitives. */

/** Outcome of rolling out one candidate input stream. */
export interface RolloutOutcome {
  /** 0 playing, 1 finish, 2 dead. */
  code: number;
  /** Engine tick at which the run finished (1-based), or null. */
  finishTick: number | null;
  /**
   * Discovery heuristic: ticks survived before dying/finishing (engine's own
   * counter, frozen at the terminal tick). Longer survivor = farther along the
   * road = closer to the finish. Highest-ranked for non-finishing runs.
   */
  survivedTicks: number;
  /** Progress proxy along the spawn->finish direction (higher = further). */
  progress: number;
  /** Wall-clock time in ms when finished, else null. */
  timeMs: number | null;
}

/** How the search modes evaluate candidates (backed by the worker pool). */
export interface RolloutEvaluator {
  /** Evaluate many candidate symbol streams; results align with input order. */
  evalMany(symbolsList: number[][]): Promise<RolloutOutcome[]>;
  /** Number of parallel workers. */
  parallelism: number;
}

/** A candidate that finished; used to return best runs. */
export interface FoundRun {
  symbols: number[];
  finishTick: number;
  timeMs: number;
  progress: number;
}

export interface ProgressSink {
  (update: {
    message: string;
    evaluations: number;
    generations: number;
    rollouts: number;
    bestTimeMs: number | null;
    bestFinishTick: number | null;
  }): void;
}

export const TICK_MS = 1000 / 240;
export const SYMS = [0, 1, 2, 3] as const;

/** Sort candidates: finished runs first (by finish tick), then by survival. */
export function compareRuns(
  a: { code?: number; finishTick: number | null; survivedTicks?: number; symbols: number[] },
  b: { code?: number; finishTick: number | null; survivedTicks?: number; symbols: number[] },
): number {
  const af = a.finishTick != null;
  const bf = b.finishTick != null;
  if (af !== bf) return af ? -1 : 1;
  if (af && bf) {
    if (a.finishTick !== b.finishTick) return (a.finishTick ?? 0) - (b.finishTick ?? 0);
    return (a.survivedTicks ?? 0) - (b.survivedTicks ?? 0);
  }
  const as = a.survivedTicks ?? 0;
  const bs = b.survivedTicks ?? 0;
  if (bs !== as) return bs - as;
  return a.symbols.length - b.symbols.length;
}