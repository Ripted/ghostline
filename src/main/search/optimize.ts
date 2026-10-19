/**
 * Mode 2 — Genetic optimizer: polish an existing finishing run segment-by-
 * segment (run-length encoded input stream), ported from the rankings site's
 * `tas-brute.ts` annealing + refine, plus the documented "straighten" mutation
 * (replace held turns in a random window with neutral) and checkpoint-based
 * prefix skipping.
 *
 * Fitness = finish tick (lower better); a run that DNFs scores a large number
 * plus its defect, so a broken seed can still be repaired.
 */
import type { RolloutEvaluator, RolloutOutcome, ProgressSink } from "./types.ts";
import { TICK_MS, SYMS } from "./types.ts";

export interface GeneticOptions {
  seedSymbols: number[];
  seedFinishTick: number | null;
  budgetMs: number;
  population: number;
  generationsCap: number;
  mutationRate: number;
  rngSeed: number;
  /** When 0, pop = active and no crossover between distinct genomes. */
  useCrossover: boolean;
  eliteCount: number;
  /**
   * 0..1 — how strongly candidates are tied to the reference run. At 1.0,
   * mutations stay small and any candidate that drifts far from the reference
   * symbol stream is penalized; at 0.0 the search freely explores.
   */
  referenceInfluence: number;
}

interface Segment {
  symbol: number;
  length: number;
}

export interface GeneticResult {
  symbols: number[];
  finishTick: number | null;
  timeMs: number | null;
  seedFinishTick: number | null;
  improved: boolean;
  evaluations: number;
  generations: number;
}

const DEFAULT_OPTS: GeneticOptions = {
  seedSymbols: [],
  seedFinishTick: null,
  budgetMs: 30_000,
  population: 48,
  generationsCap: 10_000,
  mutationRate: 0.5,
  rngSeed: 1,
  useCrossover: true,
  eliteCount: 4,
  referenceInfluence: 0.5,
};

/** Run-length encode a flat symbol stream. */
export function toSegs(flat: number[]): Segment[] {
  if (flat.length === 0) return [{ symbol: 0, length: 1 }];
  const out: Segment[] = [];
  let current = flat[0];
  let length = 0;
  for (const x of flat) {
    if (x === current) length++;
    else {
      out.push({ symbol: current, length });
      current = x;
      length = 1;
    }
  }
  out.push({ symbol: current, length });
  return out;
}

export function expand(segs: Segment[]): number[] {
  const out: number[] = [];
  for (const s of segs) for (let i = 0; i < s.length; i++) out.push(s.symbol);
  return out;
}

/** Drop empty segments and merge neighbours that hold the same symbol. */
export function normalise(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    if (s.length <= 0) continue;
    const last = out[out.length - 1];
    if (last && last.symbol === s.symbol) last.length += s.length;
    else out.push({ symbol: s.symbol, length: s.length });
  }
  return out.length ? out : [{ symbol: 0, length: 1 }];
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = (Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0);
    z = (Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0);
    z = z ^ (z >>> 15);
    // `>>> 0` keeps the result unsigned so every value lands in [0, 1).
    return (z >>> 0) / 4294967296;
  };
}

/**
 * Fraction of positions where `a` and `b` differ (0 = identical, 1 = totally
 * different). Cheap LCS-free proxy for "how much has this drifted".
 */
export function symbolDrift(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length, 1);
  let diff = 0;
  for (let i = 0; i < n; i++) {
    if ((a[i] ?? -1) !== (b[i] ?? -1)) diff++;
  }
  return diff / n;
}

/**
 * When referenceInfluence is high, mutations should stay close to the
 * reference: nudge symbols (+/-1 within alphabet) rather than replacing with a
 * random symbol, and use smaller length changes. Returns a copy so the parent
 * is never mutated in place.
 */
function scopedMutate(segs: Segment[], rnd: () => number, influence: number): Segment[] {
  const s = segs.map((x) => ({ ...x }));
  const r = (n: number) => Math.floor(rnd() * n);
  const pick = (a: number[]) => a[r(a.length)];
  if (s.length === 0) {
    s.push({ symbol: 0, length: 1 });
    return s;
  }
  if (s.length < 2) {
    // Nudge the single segment's symbol by +/-1 (keeping 0..3), or grow it.
    if (rnd() < 0.6 && s[0].symbol !== 3) s[0].symbol += 1;
    else if (s[0].symbol !== 0) s[0].symbol -= 1;
    else s[0].length = Math.max(1, s[0].length + (r(2) ? 1 : -1));
    return normalise(s);
  }
  const m = r(6);
  const b = 1 + r(s.length - 1);
  if (m === 0) {
    // Shift a small number of ticks between neighbours.
    const dl = (r(2) ? 1 : -1) * (1 + Math.floor(rnd() * Math.max(1, influence * 24)));
    if (dl > 0) {
      if (s[b].length > dl) {
        s[b - 1].length += dl;
        s[b].length -= dl;
      }
    } else {
      const dd = -dl;
      if (s[b - 1].length > dd) {
        s[b - 1].length -= dd;
        s[b].length += dd;
      }
    }
  } else if (m === 1) {
    // Nudge a symbol rather than a random swap.
    const i = r(s.length);
    const dir = r(2) ? 1 : -1;
    const next = s[i].symbol + dir;
    if (next >= 0 && next <= 3) s[i].symbol = next;
  } else if (m === 2) {
    // Small insert/delete near the reference length.
    if (r(2)) s.push({ symbol: 0, length: 1 + r(Math.max(1, Math.floor(influence * 12))) });
    else if (s.length > 1) s.splice(r(s.length), 1);
  } else if (m === 3) {
    // Local boundary drift (like the coordinate-descent but in-mutation).
    const i = r(s.length);
    if (s[i].length > 1) {
      const cut = 1;
      s.splice(i, 1, { symbol: s[i].symbol, length: cut }, { symbol: pick([0, 3]), length: s[i].length - cut });
    }
  } else if (m === 4) {
    const i = r(s.length);
    s[i].length = Math.max(1, s[i].length + (r(2) ? 1 : -1) * (1 + r(Math.max(1, Math.floor(influence * 20)))));
  } else {
    const i = r(s.length - 1);
    const move = Math.max(1, Math.floor(rnd() * influence * 24 + 1));
    if (s[i].length > move) {
      s[i].length -= move;
      s[i + 1].length += move;
    }
  }
  return normalise(s);
}

/** One simple local edit in place (port of tas-brute's mutate/simpleMutate). */
export function simpleMutate(s: Segment[], rnd: () => number, straighten: boolean): Segment[] {
  const r = (n: number) => Math.floor(rnd() * n);
  const pick = (a: number[]) => a[r(a.length)];
  if (s.length === 0) {
    s.push({ symbol: 0, length: 16 });
    return s;
  }
  if (s.length < 2) {
    const m = r(3);
    if (m === 0) s[0].symbol = pick(SYMS.filter((x) => x !== s[0].symbol));
    else if (m === 1) s[0].length = Math.max(1, 1 + r(48));
    else s.push({ symbol: pick([...SYMS]), length: 1 + r(16) });
    return s;
  }
  // Straighten: replace a run of held turns with neutral (exploits the
  // speed-vs-turn trade-off: straighter is faster, walls do the turning).
  if (straighten && r(4) === 0) {
    const i = r(s.length);
    const w = 1 + r(Math.min(4, s.length));
    let changed = 0;
    const stop = Math.min(i + w, s.length);
    for (let k = i; k < stop; k++) {
      if (s[k] && s[k].symbol !== 0) {
        s[k].symbol = 0;
        changed++;
      }
    }
    if (changed > 0) return normalise(s);
  }
  const m = r(10);
  const b = 1 + r(s.length - 1);
  if (m === 0) {
    const dl = (r(2) ? 1 : -1) * (1 + r(16));
    if (dl > 0) {
      if (s[b].length > dl) {
        s[b - 1].length += dl;
        s[b].length -= dl;
      }
    } else {
      const dd = -dl;
      if (s[b - 1].length > dd) {
        s[b - 1].length -= dd;
        s[b].length += dd;
      }
    }
  } else if (m === 1) {
    const i = r(s.length);
    s[i].symbol = pick(SYMS.filter((x) => x !== s[i].symbol));
  } else if (m === 2) {
    s.splice(1 + r(s.length), 0, { symbol: pick([...SYMS]), length: 1 + r(16) });
  } else if (m === 3) {
    s.splice(r(s.length), 1);
  } else if (m === 4) {
    const i = r(s.length);
    if (s[i].length > 1) {
      const cut = 1 + r(s[i].length - 1);
      s.splice(i, 1, { symbol: s[i].symbol, length: cut }, { symbol: pick([...SYMS]), length: s[i].length - cut });
    }
  } else if (m === 5) {
    const i = r(s.length - 1);
    s.splice(i, 2, { symbol: pick([...SYMS]), length: s[i].length + s[i + 1].length });
  } else if (m === 6) {
    const i = r(s.length);
    s[i].length = Math.max(1, 1 + r(48));
  } else if (m === 7) {
    const i = r(s.length - 1);
    const move = s[i].length;
    s[i].length = 1;
    s[i + 1].length += move - 1;
  } else if (m === 8) {
    if (r(2)) {
      s.splice(1 + r(s.length), 0, { symbol: pick([...SYMS]), length: 1 });
    } else {
      const i = r(s.length);
      if (s[i].length > 1) s[i].length -= 1;
    }
  } else if (s.length >= 2) {
    const i = r(s.length - 1);
    if (s[i].symbol !== s[i + 1].symbol) {
      const d = 1 + r(12);
      s[i].length += d;
      s[i + 1].length += d;
    } else {
      const j = r(s.length);
      s[j].length += 1 + r(12);
    }
  }
  return s;
}

export async function geneticOptimize(
  evaluator: RolloutEvaluator,
  opts: Partial<GeneticOptions> = {},
  progress?: ProgressSink,
): Promise<GeneticResult> {
  const o: GeneticOptions = { ...DEFAULT_OPTS, ...opts };
  if (o.seedSymbols.length === 0) {
    throw new Error("Genetic optimizer needs a seed run.");
  }

  const seedFlat = o.seedSymbols.slice();
  const rnd = makeRng(o.rngSeed);

  /** Score a flat stream by rolling it out once through the pool. */
  const evalFlat = async (flat: number[]): Promise<RolloutOutcome> => {
    const [out] = await evaluator.evalMany([flat]);
    return out;
  };

  let bestFlat = seedFlat.slice();
  let bestScore = Number.MAX_SAFE_INTEGER;
  let evaluations = 0;

  // Evaluate the seed.
  {
    const out = await evalFlat(bestFlat);
    evaluations++;
    bestScore = out.code === 1 && out.finishTick != null ? out.finishTick : 1e8 - out.progress * 50;
  }

  let population: number[][] = [seedFlat.slice()];
  let generation = 0;
  let improved = false;
  const start = Date.now();
  const deadline = o.budgetMs > 0 ? start + o.budgetMs : Infinity;

  while (Date.now() < deadline && generation < o.generationsCap) {
    // Reproduce: mutation (with straighten) + occasional elitism/crossover.
    const next: number[][] = [];
    for (let i = 0; i < o.population; i++) {
      const parent = population[i % population.length];
      if (o.useCrossover && i > 0 && rnd() < 0.2) {
        const other = population[Math.min(population.length - 1, Math.floor(rnd() * population.length))];
        const otherSegs = other ? other : parent;
        const cut = Math.floor(rnd() * parent.length);
        const mixed = [...parent.slice(0, cut), ...otherSegs.slice(cut)];
        next.push(mixed);
        continue;
      }
      let segs = toSegs(parent);
      if (rnd() < o.mutationRate || i === 0) {
        // High influence: small local nudges around the reference; otherwise
        // the original coarser mutations.
        segs = o.referenceInfluence > 0.6 ? scopedMutate(segs, rnd, o.referenceInfluence) : simpleMutate(segs, rnd, true);
        segs = normalise(segs);
        // Occasionally a second mutation for variety.
        if (rnd() < 0.25) {
          segs = o.referenceInfluence > 0.6 ? scopedMutate(segs, rnd, o.referenceInfluence) : simpleMutate(segs, rnd, true);
          segs = normalise(segs);
        }
      }
      next.push(expand(segs));
    }

    // Evaluate the whole population in the pool.
    const outcomes = await evaluator.evalMany(next);
    evaluations += outcomes.length;

    // Keep the elite + the best.
    const scored: Array<{ flat: number[]; score: number; finishTick: number | null }> = [];
    for (let i = 0; i < next.length; i++) {
      const out = outcomes[i];
      if (!out) continue;
      const finish = out.code === 1 && out.finishTick != null;
      let score = finish ? (out.finishTick as number) : 1e8 - (out.progress ?? 0) * 50;
      // High reference influence penalizes candidates that drifted far from the
      // reference stream (keeps the search in the run's local optimum region).
      if (o.referenceInfluence > 0) {
        const drift = symbolDrift(next[i], seedFlat);
        score += Math.floor(o.referenceInfluence * drift * 4000);
      }
      scored.push({ flat: next[i], score, finishTick: finish ? out.finishTick : null });
    }
    if (scored.length === 0) {
      population = [bestFlat.slice()];
      generation++;
      continue;
    }
    scored.sort((a, b) => a.score - b.score);

    const bestOfGen = scored[0];
    if (bestOfGen.score < bestScore) {
      bestFlat = bestOfGen.flat.slice();
      bestScore = bestOfGen.score;
      improved = true;
    }

    // Build the next population: elite + mutated bests.
    population = [];
    for (const el of scored.slice(0, Math.min(o.eliteCount, scored.length))) population.push(el.flat.slice());
    while (population.length < o.population) {
      const idx = Math.floor(rnd() * Math.min(scored.length, 12));
      const parent = scored[idx];
      if (!parent) break;
      population.push(parent.flat.slice());
    }
    if (population.length === 0) {
      population = [bestFlat.slice()];
    }

    generation++;
    progress?.({
      message: `Genetic gen ${generation}: best ${bestScore < 1e6 ? (bestScore * TICK_MS / 1000).toFixed(3) + "s" : "DNF"}`,
      evaluations,
      generations: generation,
      rollouts: evaluations,
      bestTimeMs: bestScore < 1e6 ? bestScore * TICK_MS : null,
      bestFinishTick: bestScore < 1e6 ? bestScore : null,
      bestSymbols: bestFlat.slice(0, 4000),
    });
  }

  // 1-tick coordinate-descent polish: nudge each segment boundary by ±1..24
  // tick and keep improvements (the productive final squeeze from tas-brute).
  if (bestScore < 1e6) {
    let polished = true;
    let passes = 0;
    while (polished && passes < 20 && Date.now() < deadline) {
      polished = false;
      passes++;
      const segs0 = toSegs(bestFlat);
      const candidates: number[][] = [];
      for (let i = 1; i < segs0.length; i++) {
        for (let d = 1; d <= 24; d++) {
          for (const dir of [1, -1]) {
            const s2 = segs0.map((x) => ({ ...x }));
            const dl = dir * d;
            if (dl > 0) {
              if (s2[i - 1].length <= dl) continue;
              s2[i - 1].length -= dl;
              s2[i].length += dl;
            } else {
              const dd = -dl;
              if (s2[i].length <= dd) continue;
              s2[i].length -= dd;
              s2[i - 1].length += dd;
            }
            candidates.push(expand(normalise(s2)));
          }
        }
      }
      if (candidates.length === 0) break;
      const outs = await evaluator.evalMany(candidates);
      evaluations += outs.length;
      for (let i = 0; i < outs.length; i++) {
        const out = outs[i];
        if (out.code === 1 && out.finishTick != null && out.finishTick < bestScore) {
          bestScore = out.finishTick;
          bestFlat = candidates[i].slice();
          polished = true;
        }
      }
    }
  }

  const finalEval = await evalFlat(bestFlat);
  evaluations++;
  const finishTick = finalEval.code === 1 ? finalEval.finishTick : null;
  const seedFinish = o.seedFinishTick;

  return {
    symbols: bestFlat,
    finishTick,
    timeMs: finishTick != null ? finishTick * TICK_MS : null,
    seedFinishTick: seedFinish,
    improved: improved && (seedFinish == null || (finishTick != null && finishTick < seedFinish)),
    evaluations,
    generations: generation,
  };
}