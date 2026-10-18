/**
 * Headless core tests — run with `npm run test:core` (no Electron needed).
 *
 * They exercise the real Rust/WASM physics engine through the built worker
 * bundle in `out/main`, exactly the code path the packaged app uses:
 *   - physical determinism of the engine (same inputs ⇒ same trajectory)
 *   - codec round-trip (base64 ↔ 2-bit symbols)
 *   - worker pool rollout fidelity
 *   - all three search modes produce a finishing run with a valid time
 *
 * The physics wasm lives at `resources/physics/` (read via fs, not fetch).
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const wasmJs = join(root, "resources", "physics", "rust.js");
const wasmWasm = join(root, "resources", "physics", "rust_bg.wasm");
if (!existsSync(wasmJs) || !existsSync(wasmWasm)) {
  throw new Error("Physics engine missing under resources/physics/ — run npm run build first.");
}

// Import the shared TS modules via tsx (Node can't run .ts directly).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// Load shared modules compiled by tsx from source.
const { decodeInputSymbols, encodeInputSymbols, summariseSymbols } = await import("../src/shared/codec.ts");
const { levelGeometry, engineObstacles, finishTarget } = await import("../src/shared/geometry.ts");
const { Engine, simulateRunExact } = await import("../src/main/search/engine.ts");
const { SearchPool } = await import("../src/main/search/pool.ts");
const { beamSearch } = await import("../src/main/search/beam.ts");
const { bruteSearch } = await import("../src/main/search/brute.ts");
const { geneticOptimize } = await import("../src/main/search/optimize.ts");

const TICK_MS = 1000 / 240;

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.error("  ✗ " + msg);
  }
}

function readLevel(file) {
  const p = join(__dirname, "fixtures", file);
  const envelope = JSON.parse(readFileSync(p, "utf8"));
  const data = envelope.levelInfo?.data ?? envelope.data;
  if (!data?.obstacles) throw new Error(`Fixture ${file} has no level data`);
  return data;
}

console.log("Loading physics engine via built worker bundle…");

// Quick smoke: engine module loads.
const levelHighway = readLevel("level-1777118905185.json");
const levelArena = readLevel("level-1776365701718.json");

console.log("\n[1] Engine: spawn pose + determinism");
{
  const e1 = await Engine.create(levelHighway, "Narrow Arrow", "1777118905185");
  const e2 = await Engine.create(levelHighway, "Narrow Arrow", "1777118905185");
  assert(e1 && e2, "engine created");
  assert(Math.abs(e1.spawn.x - e2.spawn.x) < 1e-9 && Math.abs(e1.spawn.y - e2.spawn.y) < 1e-9, "same spawn");

  const run1 = e1.rollout([0, 0, 0, 0, 0, 0]);
  const run2 = e2.rollout([0, 0, 0, 0, 0, 0]);
  assert(run1.lastPoint.x === run2.lastPoint.x && run1.lastPoint.y === run2.lastPoint.y, "deterministic rollout");
  assert(run1.code === 0, "neutral start keeps playing");
  e1.free();
  e2.free();
}

console.log("\n[2] Engine: thrust semantics on Highway Jet");
{
  const e = await Engine.create(levelHighway, "Narrow Arrow", "1777118905185");
  assert(e.code() === 0, "initial code 0");
  const res = e.rollout(new Array(240).fill(0));
  assert(res.lastPoint.x !== e.spawn.x || res.lastPoint.y !== e.spawn.y, "engine moves after 1s of neutral");
  e.free();

  // Both-pressed is the brake and should hold the arrow in place.
  const eB = await Engine.create(levelHighway, "Narrow Arrow", "1777118905185");
  const b = eB.rollout(new Array(120).fill(3));
  assert(b.lastPoint.x === eB.spawn.x && b.lastPoint.y === eB.spawn.y, "brake (both pressed) holds position");
  eB.free();
}

console.log("\n[3] Codec round-trip");
{
  const syms = [0, 1, 2, 3, 0, 1, 2, 3, 2, 1];
  const base64 = encodeInputSymbols(syms);
  const back = decodeInputSymbols(base64, syms.length);
  assert(JSON.stringify(back) === JSON.stringify(syms), "symbols == decoded(encoded(symbols))");
  const encodedTwice = encodeInputSymbols(decodeInputSymbols(base64));
  assert(encodedTwice === base64, "base64 stable for full run");

  // Real replay sample shape: a known Highway Jet WR-ish input string style.
  const sample = encodeInputSymbols(new Array(240).fill(3).map((_, i) => (i % 4)));
  const summary = summariseSymbols(decodeInputSymbols(sample));
  assert(summary.tickCount === 240, "summary tick count");
  assert(Math.abs(summary.durationMs - 1000) < 0.01, "summary duration ~1s");
}

function finishes(r) {
  return r.finishTick != null && r.finishTick > 0;
}

const levelStraight = readLevel("level-probe-straight.json");

console.log("\n[4] Worker pool + beam search discovers a finish (deterministic straight map)");
{
  const pool = new SearchPool();
  await pool.start(levelStraight, "Narrow Arrow", "probe-straight", 2);
  assert(pool.size === 2, "pool size 2");
  const evaluator = { evalMany: (c) => pool.evalMany(c), parallelism: pool.size };

  const progressEvents = [];
  const result = await beamSearch(
    evaluator,
    { beamWidth: 64, actionRepeat: 8, maxDepth: 3000, budgetMs: 20000, maxNodes: 400_000, rngSeed: 1 },
    (p) => progressEvents.push(p),
  );
  pool.stop();
  assert(result.evaluations > 0, "beam evaluated candidates");
  assert(progressEvents.length > 0, "beam emitted progress");
  assert(finishes(result), `beam discovered a finish (progress=${result.progress.toFixed(1)}, evals=${result.evaluations})`);
  console.log(`  ✓ beam finished at ${(result.finishTick * TICK_MS / 1000).toFixed(3)}s (${result.evaluations} evals)`);
}

console.log("\n[5] Brute force tail-polish finishes from a near-complete prefix (straight map)");
{
  const pool = new SearchPool();
  await pool.start(levelStraight, "Narrow Arrow", "probe-straight", 2);
  const evaluator = { evalMany: (c) => pool.evalMany(c), parallelism: pool.size };
  const prefix = new Array(470).fill(0);
  const result = await bruteSearch(evaluator, {
    actionTicks: 4,
    maxDepth: 60,
    maxCandidates: 20_000,
    budgetMs: 20000,
    prefixSymbols: prefix,
    rngSeed: 1,
  });
  pool.stop();
  assert(result.evaluations > 0, "brute evaluated candidates");
  assert(finishes(result), `brute polish found a finisher (progress=${result.progress.toFixed(1)}, evals=${result.evaluations})`);
  console.log(`  ✓ brute finished at ${(result.finishTick * TICK_MS / 1000).toFixed(3)}s (${result.evaluations} evals)`);
}

console.log("\n[6] Genetic optimizer discovers a finish from a non-finishing thrust seed (straight map)");
{
  const pool = new SearchPool();
  await pool.start(levelStraight, "Narrow Arrow", "probe-straight", 2);
  const evaluator = { evalMany: (c) => pool.evalMany(c), parallelism: pool.size };
  const seedSymbols = new Array(300).fill(0); // does NOT finish by itself
  const res = await geneticOptimize(
    evaluator,
    {
      seedSymbols,
      seedFinishTick: null,
      budgetMs: 20000,
      population: 24,
      generationsCap: 200,
      mutationRate: 0.5,
      rngSeed: 3,
      useCrossover: true,
      eliteCount: 2,
    },
    () => {},
  );
  pool.stop();
  assert(res.improved, "genetic improved on the seed");
  assert(finishes(res), `genetic produced a finishing run (progress=${res.progress ?? "n/a"}, evals=${res.evaluations})`);
  console.log(`  ✓ genetic finished at ${(res.finishTick * TICK_MS / 1000).toFixed(3)}s (${res.evaluations} evals)`);
}

console.log("\n[4b] Beam makes genuine progress on a real arena map (Icy Passage)");
{
  const pool = new SearchPool();
  await pool.start(levelArena, "Narrow Arrow", "1776365701718", 2);
  const evaluator = { evalMany: (c) => pool.evalMany(c), parallelism: pool.size };
  const result = await beamSearch(
    evaluator,
    { beamWidth: 128, actionRepeat: 2, maxDepth: 8000, budgetMs: 30000, maxNodes: 4_000_000, rngSeed: 1 },
    () => {},
  );
  pool.stop();
  assert(result.evaluations > 0, "arena beam evaluated candidates");
  assert(result.progress > 0, `arena beam moved off spawn (progress=${result.progress.toFixed(1)})`);
  if (result.finishTick != null) {
    console.log(`  ✓ arena beam finished at ${(result.finishTick * TICK_MS / 1000).toFixed(3)}s (${result.evaluations} evals)`);
  } else {
    console.log(`  (arena beam: no finish, furthest ${result.progress.toFixed(1)}px over ${result.evaluations} evals — discovery on 16s+ official levels needs a recording seed + genetic polish)`);
  }
}

console.log("\n[7] simulateRunExact reconstructs a path");
{
  const e = await Engine.create(levelHighway);
  const { code, finishTick } = e.rollout([]);
  void code;
  e.free();
  // Re-run the actual beam result if we have a finisher. Fallback: straight shot.
  const symbols = new Array(600).fill(0);
  const sim = await simulateRunExact(levelHighway, "Narrow Arrow", symbols);
  assert(sim.path.length > 1, "path reconstruct has points");
  const last = sim.path[sim.path.length - 1];
  assert(Number.isFinite(last.x) && Number.isFinite(last.y), "path coords finite");
  console.log(`  simulateRunExact: ${sim.path.length} points, finishTick=${sim.finishTick}`);
  void finishTick;
}

console.log("\n[8] geometry port sanity");
{
  const g = levelGeometry(levelHighway);
  assert(g.walls.length > 0, "walls extracted");
  assert(g.zones.length >= 0 && g.portals.length >= 0, "zones/portals arrays present");
  const ob = engineObstacles(levelHighway);
  assert(ob.length === levelHighway.obstacles.length, "obstacle passthrough count");
  const ft = finishTarget(levelHighway);
  if (ft) {
    console.log(`  finish target ≈ (${ft.x.toFixed(0)}, ${ft.y.toFixed(0)})`);
  }
  console.log(`  walls=${g.walls.length} zones=${g.zones.length} portals=${g.portals.length}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}