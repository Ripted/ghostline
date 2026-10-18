/**
 * Mode 1 — Beam search: find the fastest finishing input prefix from nothing
 * but the level, using the engine's progress metric to rank the beam.
 *
 * Starting from the empty input, each step extends every beam node by up to 4
 * symbols (0..3). Optionally `actionRepeat` holds each chosen symbol for N
 * consecutive ticks (the "action-repeat" knob that lengthens each decision's
 * reach and shrinks the search space). All children are rolled out in the
 * worker pool, ranked by (finished first → progress), and the top `beamWidth`
 * survive. Dead nodes are dropped; nodes that regressed are penalized. The
 * first finishing node is kept as a candidate best.
 */
import type { RolloutEvaluator, FoundRun, ProgressSink } from "./types.ts";
import { TICK_MS, SYMS } from "./types.ts";

export interface BeamOptions {
  beamWidth: number;
  actionRepeat: number;
  maxDepth: number;
  budgetMs: number;
  maxNodes: number;
  rngSeed: number;
}

interface BeamNode {
  symbols: number[];
  progress: number;
  survivedTicks: number;
  code: number;
  finishTick: number | null;
  dead: boolean;
}

export interface BeamResult {
  symbols: number[];
  finishTick: number | null;
  timeMs: number | null;
  progress: number;
  evaluations: number;
  generations: number;
  improved: boolean;
}

const DEFAULT_OPTS: BeamOptions = {
  beamWidth: 64,
  actionRepeat: 1,
  maxDepth: 6000,
  budgetMs: 30_000,
  maxNodes: 1_000_000,
  rngSeed: 1,
};

export async function beamSearch(
  evaluator: RolloutEvaluator,
  opts: Partial<BeamOptions> = {},
  progress?: ProgressSink,
): Promise<BeamResult> {
  const o: BeamOptions = { ...DEFAULT_OPTS, ...opts };
  const start = Date.now();
  let beam: BeamNode[] = [{ symbols: [], progress: 0, survivedTicks: 0, code: 0, finishTick: null, dead: false }];
  let best: FoundRun | null = null;
  let evaluations = 0;
  let generations = 0;
  let nodesExplored = 0;

  const deadline = o.budgetMs > 0 ? start + o.budgetMs : Infinity;

  while (Date.now() < deadline && nodesExplored < o.maxNodes) {
    if (beam.length === 0) break;

    // Expand each live node by 4 symbols (or 1 symbol repeated `actionRepeat`).
    const children: Array<{ node: BeamNode; symbols: number[] }> = [];
    if (o.actionRepeat <= 1) {
      for (const node of beam) {
        if (node.dead || node.code !== 0) continue;
        for (const sym of SYMS) {
          if (node.symbols.length + 1 > o.maxDepth) continue;
          children.push({ node, symbols: [...node.symbols, sym] });
        }
      }
    } else {
      for (const node of beam) {
        if (node.dead || node.code !== 0) continue;
        for (const sym of SYMS) {
          if (node.symbols.length + o.actionRepeat > o.maxDepth) continue;
          const next = node.symbols.slice();
          for (let k = 0; k < o.actionRepeat; k++) next.push(sym);
          children.push({ node, symbols: next });
        }
      }
    }

    if (children.length === 0) break;
    nodesExplored += children.length;

    // Roll out every child with the pool.
    const outcomes = await evaluator.evalMany(children.map((c) => c.symbols));
    evaluations += outcomes.length;

    const nextNodes: BeamNode[] = [];
    for (let i = 0; i < children.length; i++) {
      const out = outcomes[i];
      if (!out) continue;
      const child = children[i];
      const finished = out.code === 1;
      const progress = out.progress;
      nextNodes.push({
        symbols: child.symbols,
        progress,
        survivedTicks: out.survivedTicks,
        code: out.code,
        finishTick: out.finishTick,
        dead: out.code === 2,
      });
      if (finished && out.finishTick != null) {
        if (!best || out.finishTick < best.finishTick) {
          best = { symbols: child.symbols, finishTick: out.finishTick, timeMs: out.finishTick * TICK_MS, progress };
        }
      }
    }

    // Rank: finished first (fewest ticks), then by distance-from-spawn desc
    // (farthest along the road), then by longer survival to break distance ties.
    nextNodes.sort((a, b) => {
      const af = a.finishTick != null;
      const bf = b.finishTick != null;
      if (af !== bf) return af ? -1 : 1;
      if (af && bf) {
        if ((a.finishTick ?? 0) !== (b.finishTick ?? 0)) return (a.finishTick ?? 0) - (b.finishTick ?? 0);
        return b.progress - a.progress;
      }
      if (b.progress !== a.progress) return b.progress - a.progress;
      if (b.survivedTicks !== a.survivedTicks) return b.survivedTicks - a.survivedTicks;
      return a.symbols.length - b.symbols.length;
    });

    // Keep only alive (code 0) nodes: dead nodes can't be extended and would
    // consume beam width forever without producing children.
    beam = nextNodes.filter((n) => !n.dead).slice(0, o.beamWidth);

    generations++;
    progress?.({
      message: `Beam gen ${generations}: ${beam.length} nodes, best ${best ? (best.timeMs / 1000).toFixed(3) + "s" : "not yet"}`,
      evaluations,
      generations,
      rollouts: evaluations,
      bestTimeMs: best ? best.timeMs : null,
      bestFinishTick: best ? best.finishTick : null,
      bestSymbols: best ? best.symbols.slice(0, 4000) : undefined,
    });

    // If every expanded node died / finished no progress made a finishing run would require expansion.
    if (beam.length === 0 && !best) break;
  }

  if (!best) {
    // No finishing run found — return the furthest-progressing node to inspect.
    const furthest = beam.sort((a, b) => b.progress - a.progress)[0];
    if (furthest) {
      return {
        symbols: furthest.symbols,
        finishTick: null,
        timeMs: null,
        progress: furthest.progress,
        evaluations,
        generations,
        improved: false,
      };
    }
    return {
      symbols: [],
      finishTick: null,
      timeMs: null,
      progress: 0,
      evaluations,
      generations,
      improved: false,
    };
  }

  return {
    symbols: best.symbols,
    finishTick: best.finishTick,
    timeMs: best.timeMs,
    progress: best.progress,
    evaluations,
    generations,
    improved: true,
  };
}