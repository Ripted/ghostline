# Narrow Route Finder — engine ground truth & project notes

## Where the knowledge lives
- `nar-s/` at the workspace root is a local clone of **`https://github.com/PolarNA0/narrowarrowrankings`**
  (remote name `sirsqm`). It is a *slightly older* snapshot of that repo's `main`.
  The canonical, up-to-date copy is the **PolarNA0/narrowarrowrankings** GitHub repo.
- The site (and this desktop app's search) drives the **real game engine**: a Rust/WASM
  `GameMechanicsEngine` bundled at `nar-s/src/lib/physics/{rust.js,rust_bg.wasm}`, the same
  core the Flutter game loads via `physics_core_capacitor.js`. Extracted from the current
  Android APK; the old web build (play.narrowarrow.xyz) predates rails/portals — don't swap.
- `nar-s/src/lib/replay-sim.ts` = authoritative engine wrapper (`createReplayEngine`),
  `ARROW_CONSTANTS`, `symbolToInput`, `engineObstacles`, `levelGeometry`, `finishTarget`.
- `nar-s/src/lib/replay.ts` = base64 ⇄ 2-bit input codec (`encode/decodeInputSymbols`,
  `summariseReplay` RLE segments, `parseTasFile`, `detectCombo`).
- `nar-s/src/lib/tas-brute.ts` = GA/simulated-annealing optimizer; **`PolarNA0` repo's `main`
  is far ahead** (CheckpointSim prefix-reuse, `wider-entry/tighter-exit` mutate m===12,
  `<1 tick` coordinate-descent refine, per-arrow TAS boards).

## Input model (verified)
- 240 Hz input ticks (`TICK_MS = 1000/240 ≈ 4.1667 ms`).
- base64 `inputs` field packs **4 two-bit symbols per byte, MSB pair first**.
  `0=neutral/coast (thrust straight)`, `1=right steer`, `2=left steer`, `3=brake (both held)`.
- On open ground 0 coasts and thrusts ahead to terminal ~2.39 speed for Narrow; a held turn
  rotates heading ~0.013 rad/tick but the thrust points away from velocity → speed bleeds
  (circling settles ~0.52); 3 scrubs speed hard. Trajectory is slidey (oiliness 0.996).
  → **straighter is faster; the level walls do the turning.**
- Engine `rotation` is 0 facing **-y**; renderer/sim uses `rot = engineRotation - π/2`.
- Determinism: same level+arrow+inputs ⇒ same trajectory (byte-identical).
- `player_state_code()`: 0 playing / 1 finish / 2 dead. `get_ticks()` freezes at the terminal
  tick, so a survived-ticks metric can be read straight after a death.

## Arrow physics (must feed the engine or valid runs DNF)
Per-arrow `constants` override on top of `create_default_game_state()` (the default is a
mixed bag — using it makes replays DNF). Ten values, recovered from the game's compiled Dart:
`radius, engine_power, engine_startup_ticks, energy_capacity, energy_regeneration,
traction_power, brake_power, aerodynamics, oiliness, turning_speed`.
Narrow: radius 16, power .002, startup 60, capacity .6, regen .002, traction .006, brake .01,
aero .9992, oil .996, turn .00032. Speedy/Energy values in `ARROW_CONSTANTS`.

## Obstacle model
`engineObstacles` must pass every field the level uses **verbatim**
(`wall_type, wall_thickness, zone_type, zone_direction, portal_id, side, rotation_pivot,
rotation_speed, speed`) and only infer `obstacle_type`. Static single-point walls still collide.
Spinning walls rotate `rotation_speed * tick` rad/tick about `rotation_pivot` (engine simulates
it; only render needs it). Force fields (wind/suction, `field_type`) are **site-only**: stripped
before the engine, applied as per-tick velocity deltas by the sim layer.

## TAS editor mechanics (`TasEditorView.tsx`)
- Run shown as RLE segments; +/- grows/shrinks a hold by 1 tick (splice/merge keeps exact RLE).
- Owns one `ReplayEngine`; `resimulate(fromTick, next)` restores the **latest checkpoint at or
  before `fromTick`** (checkpoints every `CHECKPOINT=600` inputs), fast-forwards, then re-steps
  the changed tail. `path[0]` = spawn, so input `i` lands at `path[i+1]`.
- Rewind/scrub via `snapshot()`/`restore()`; never re-runs the whole run.

## Optimizer (site + our port)
- SA over RLE segment list: `makeRng` is the numeric-recipes LCG
  `(Math.imul(s,1664525)+1013904223) >>> 0` → **stay unsigned** (`>>>0` on the multiply is
  load-bearing: a negative value breaks `Math.floor(rnd()*n)` array indexing).
- Fitness: finish ⇒ 1-based finish tick; DNF ⇒ `1e6 + minDist/3 + ticks*0.002` (DNF gradient
  toward the level's **finish-wall midpoint**, `finishTarget()`).
- `CheckpointSim`: snapshots reference stream every `stride` ticks, restores deepest matching
  checkpoint, steps only the tail (bit-identical scores, ~1.2–1.6× more evals). `onRef` re-anchors.
- Reheat at `T<0.15` or 6000 non-improving steps; 1-tick coordinate-descent `refine` afterward
  is what squeezes records. `straighten` mutation (held turns → neutral) exploits speed-vs-turn.
- Worker topologies: many workers, each an independent seeded anneal from the same seed; keep
  best; simulate winner's trajectory exactly once.

## Test fixtures & finish-discovery reality
- Official levels are 16–30 s runs (~4k–7k ticks) — far too long for a bounded beam/brute to
  *discover* a finish. Real use: record/seed (TAS board best or WR) + genetic/anneal polish.
- For deterministic finish tests we use `tests/fixtures/level-probe-straight.json` (synthetic):
  wide-open corridor, no bumper walls, finish segment at y=-220 → pure thrust ~491 ticks = 2.046 s.
  All modes finish it: beam (actionRepeat 8, width 64) 2.046 s in ~15 k evals; brute tail-polish
  from a 470-tick prefix; genetic from a non-finishing 300-tick thrust seed.
- Official level IDs/names live in `nar-s/src/constants.ts` (`LEVELS`). `fetchLevelData` hits
  `api.narrowarrow.xyz/level-details/<id>?isCustomLevel=true`.

## Desktop app (route-finder/) — search architecture
- `Coordinator.run()` streams `ProgressSink` with `bestSymbols`; renderer polls `nf:getLivePath`
  which re-simulates the best-symbol stream (downsampled ≤2000 pts) on demand. The ghost arrow
  rides that path at game speed via a ref-based clock; a bright trail = covered, faint = road ahead.
- "Learn from a run": reference seed flows `SearchParams.referenceInfluence` (0..1) →
  `GeneticOptions.referenceInfluence` → `scopedMutate` (small local nudges when influence >0.6)
  and a `symbolDrift` penalty (`refInfluence * drift * 4000` added to candidate score). Seeds
  decode via `decodeInputsFromSeed(inputs, inputCount)` — **always pass inputCount** so the
  zero-padded tail of the final base64 byte is trimmed (up to 3 phantom neutral ticks).
- Saved runs export to JSON with `format: "narrow-route-finder/run"`; `nf:importRun` re-imports
  those (or raw `SavedRun`/`SearchResult` shapes) as a learn seed. Custom/imported/browsed levels
  are cached on disk under userData/levels and listed by `nf:listCachedLevels` so all three search
  modes can run on them.