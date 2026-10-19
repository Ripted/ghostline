/**
 * Mode 3 — Action-repeat brute force: exhaustive enumeration over coarsely
 * quantized input sequences. Each "decision" is a symbol held for `actionTicks`
 * consecutive ticks, and the search enumerates the frontier BFS-style to
 * `maxDepth` decisions, pruning by progress when the candidate cap is hit.
 *
 * This is a genuine brute forcer within a bounded horizon — ideal for short
 * maps and for polishing the tail of a longer run (drop-in at a given prefix).
 */
import type { RolloutEvaluator, FoundRun, ProgressSink } from "./types.ts";
import { TICK_MS, SYMS } from "./types.ts";

export interface BruteOptions {
  actionTicks: number;
  maxDepth: number;
  maxCandidates: number;
  budgetMs: number;
  /** Optional fixed prefix every candidate starts from (polish mode). */
  prefixSymbols: number[];
  rngSeed: number;
}

export interface BruteResult {
  symbols: number[];
  finishTick: number | null;
  timeMs: number | null;
  progress: number;
  evaluations: number;
  improved: boolean;
}

const DEFAULT_OPTS: BruteOptions = {
  actionTicks: 4,
  maxDepth: 1200,
  maxCandidates: 50_000,
  budgetMs: 30_000,
  prefixSymbols: [],
  rngSeed: 1,
};

interface FrontierNode {
  symbols: number[];
  progress: number;
  survivedTicks: number;
  code: number;
  finishTick: number | null;
}

export async function bruteSearch(
  evaluator: RolloutEvaluator,
  opts: Partial<BruteOptions> = {},
  progress?: ProgressSink,
): Promise<BruteResult> {
  const o: BruteOptions = { ...DEFAULT_OPTS, ...opts };
  const actionTicks = Math.max(1, Math.floor(o.actionTicks));
  const prefix = o.prefixSymbols ?? [];

  // BFS frontier of completed decision sequences (minus the fixed prefix).
  let frontier: FrontierNode[] = [{ symbols: [], progress: 0, survivedTicks: 0, code: 0, finishTick: null }];
  let best: FoundRun | null = null;
  let evaluations = 0;
  let nodesExplored = 0;
  let lastProgress = 0;
  // Last live-preview best we published (see beam.ts for the rationale — the
  // live ghost only advances on genuine new bests).
  let publishedBest: { symbols: number[]; finishTick: number | null; progress: number } | null = null;
  // During discovery (no finish yet) the furthest *surviving* node is the live
  // "best". The frontier isn't kept sorted when it stays under the cap, so
  // track it explicitly.
  let discoveryBest: { symbols: number[]; progress: number; survivedTicks: number } | null = null;
  const start = Date.now();
  const deadline = o.budgetMs > 0 ? start + o.budgetMs : Infinity;

  while (
    frontier.length > 0 &&
    nodesExplored < o.maxCandidates &&
    Date.now() < deadline
  ) {
    // Expand each node by every symbol held `actionTicks` times.
    const children: Array<{ parent: FrontierNode; symbols: number[] }> = [];
    for (const node of frontier) {
      if (node.code !== 0) continue;
      for (const sym of SYMS) {
        // maxDepth counts ticks *after* the fixed prefix (tail budget), so
        // polish mode (long prefix + short tail) works without blowing up.
        const depth = node.symbols.length + actionTicks;
        if (depth > o.maxDepth) continue;
        const next = node.symbols.slice();
        for (let k = 0; k < actionTicks; k++) next.push(sym);
        children.push({ parent: node, symbols: next });
      }
    }
    if (children.length === 0) break;
    nodesExplored += children.length;

    // Roll out each candidate with the fixed prefix prepended.
    const outcomes = await evaluator.evalMany(
      children.map((c) => [...prefix, ...c.symbols]),
    );
    evaluations += outcomes.length;

    const nextFrontier: FrontierNode[] = [];
    for (let i = 0; i < children.length; i++) {
      const out = outcomes[i];
      if (!out) continue;
      // frontier nodes store the tail only (prefixed once at eval/return).
      const symbols = children[i].symbols;
      const fullSymbols = [...prefix, ...symbols];
      if (out.code === 1 && out.finishTick != null) {
        if (!best || out.finishTick < best.finishTick) {
          best = {
            symbols: fullSymbols,
            finishTick: out.finishTick,
            timeMs: out.finishTick * TICK_MS,
            progress: out.progress,
          };
        }
        continue; // don't extend past a finish
      }
      if (out.code === 2) continue; // dead
      // Track the furthest surviving node for the live discovery preview.
      if (!discoveryBest || out.progress > discoveryBest.progress) {
        discoveryBest = { symbols: fullSymbols, progress: out.progress, survivedTicks: out.survivedTicks };
      }
      nextFrontier.push({ symbols, progress: out.progress, survivedTicks: out.survivedTicks, code: out.code, finishTick: null });
    }

    // Prune by progress (negative distance to finish) when over the cap.
    if (nextFrontier.length > o.maxCandidates) {
      nextFrontier.sort((a, b) => b.progress - a.progress || b.survivedTicks - a.survivedTicks);
      nextFrontier.length = o.maxCandidates;
    }
    frontier = nextFrontier;

    // During discovery (no finish yet) the furthest surviving node is the live
    // "best"; once a finish exists, only a faster finish is a new best.
    const previewBase = best ?? discoveryBest;
    let isNewBest = false;
    if (previewBase) {
      const full = previewBase.symbols;
      let finish: number | null;
      let prog: number;
      if (best) {
        finish = best.finishTick;
        prog = best.progress;
      } else {
        finish = null;
        prog = discoveryBest?.progress ?? 0;
      }
      isNewBest =
        !publishedBest ||
        (finish != null && (publishedBest.finishTick == null || finish < publishedBest.finishTick)) ||
        (finish == null && publishedBest.finishTick == null && prog > publishedBest.progress);
      if (isNewBest) {
        publishedBest = { symbols: full, finishTick: finish, progress: prog };
      }
    }

    // Throttle progress to ~75ms so fast bursts don't flood the IPC event bus;
    // a new best is always published immediately.
    const now = Date.now();
    if (now - lastProgress >= 75 || isNewBest) {
      lastProgress = now;
      progress?.({
        message: `Brute depth ${frontier.length ? prefix.length + frontier[0].symbols.length : "-"}: explored ${nodesExplored} candidates, best ${best ? (best.timeMs / 1000).toFixed(3) + "s" : "not yet"}`,
        evaluations,
        generations: 0,
        rollouts: evaluations,
        bestTimeMs: best ? best.timeMs : null,
        bestFinishTick: best ? best.finishTick : null,
        bestSymbols: isNewBest && publishedBest ? publishedBest.symbols.slice() : undefined,
      });
    }
  }

  if (!best) {
    const furthest = frontier.sort((a, b) => b.progress - a.progress)[0];
    return {
      symbols: furthest ? [...prefix, ...furthest.symbols] : prefix,
      finishTick: null,
      timeMs: null,
      progress: furthest ? furthest.progress : 0,
      evaluations,
      improved: false,
    };
  }

  return {
    symbols: best.symbols,
    finishTick: best.finishTick,
    timeMs: best.timeMs,
    progress: best.progress,
    evaluations,
    improved: true,
  };
}