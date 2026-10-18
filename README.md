# Narrow Route Finder

Windows 10 desktop app that finds fast **Narrow Arrow** input sequences by running the
game's real physics — the bundled Rust/WASM `GameMechanicsEngine` the game client uses —
with three selectable search modes.

## Features

- **Three search modes** over a multi-core worker pool:
  - **Beam search** — seedless discovery; expands, ranks and prunes input prefixes.
  - **Genetic optimizer** — simulated annealing over the run-length input stream
    (boundary shift, split/merge, insert/delete, wider-entry/tighter-exit, straighten),
    polished by 1-tick coordinate descent.
  - **Action-repeat brute force** — bounded exhaustive tail-polish from a near-complete
    prefix (short maps and final squeeze).
- **Real engine, deterministic**: every candidate rolls out through the bundled WASM
  `GameMechanicsEngine` (240 Hz input ticks); seeded RNG makes searches reproducible.
- **Map picker** for official levels plus custom map JSON import.
- **Custom map browser** — browse/search the game's published levels (`discover`, `new`,
  `popular`, `liked`, `by:username`), with thumbnails, plays/likes and one-click load.
- **In-game leaderboard** per level — merge all three arrow boards (or filter to one),
  searchable, with the real player/arrow/time columns.
- **Replay viewer** — click any leaderboard run to fetch and simulate its exact inputs
  with the game engine and play it back with play/pause/scrub/speed controls and the
  run's real arrow sprite.
- **Live search visualization** — while a search runs, the current best path streams
  onto the map in real time (polled from the coordinator's best-symbol stream) with a
  moving arrow marker.
- **Replayable "racing line"** — speed heatmap along the trail and brake-hold markers
  overlaid on the map.
- **Run export** — copy base64 inputs or save a TAS JSON file compatible with the
  reference site's TAS editor import shapes.

## Getting started

```bash
npm install        # installs dependencies
npm run build      # bundles the app (also runs the engine test suite)
npm run dev        # launch dev window
npm run dist       # build a Windows installer (NSIS) + portable exe
```

Requirements: Node 20+ and native build tools are **not** needed at runtime — the physics
engine ships as WASM.

## Tests

```bash
npm run test:core
```

26 assertions pass against the real bundled engine: beam, brute tail-polish, and genetic
all reach a 2.046 s finishing run on a deterministic straight-map fixture, and beam makes
genuine progress on an official level.

## How it works

The app drives the exact `GameMechanicsEngine` the game loads (a Rust/WASM core bundled
under `resources/physics/`). Each worker owns an engine instance and rolls out candidate
input sequences (`0` neutral/coast, `1` right, `2` left, `3` brake at 240 Hz); the
search coordinator ranks candidates by progress (unsigned distance from spawn) and
reports a finishing run's time from the engine's own finish tick.

Because the official levels are long (~4k–7k ticks), seedless beam discovery often can't
finish them from scratch in a bounded budget. The productive workflow is to seed the
genetic/brute modes from a known run (a TAS-board best or the world record) and let the
annealer + refine polish it.

## Notes on data sources

- Official level geometry comes from `api.narrowarrow.xyz` (`/level-details/<id>?isCustomLevel=true`).
- The engine is extracted from the current Android APK and supports walls, zones
  (boost/ice/nosteer/steer/rail), portals, and rotating walls with `rotation_pivot`.
- Each arrow (Narrow / Speedy / Energy) has its own physics constants; the engine's
  default state is a mix and will DNF valid runs, so the arrow is always applied.
