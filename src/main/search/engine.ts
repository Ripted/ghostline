/**
 * Wrapper around the real Narrow Arrow physics engine for headless rollouts.
 *
 * The engine is the same Rust/WASM `GameMechanicsEngine` the game runs. It
 * steps 240 discrete physics ticks per second, takes an array of `{left,
 * right}` inputs through `process_ticks`, and reports a terminal state code
 * (0 playing / 1 finish / 2 dead) via `player_state_code`. Deterministic:
 * same state + same inputs = same result.
 */
import { loadPhysicsModule, type GameEngineHandle, type PhysicsModule } from "./physics-loader.ts";
import type { RawLevelData, SimPoint } from "../../shared/types.ts";
import { engineObstacles } from "../../shared/geometry.ts";

/** Per-arrow physics constants recovered from the game's compiled Dart. */
export const ARROW_CONSTANTS: Record<string, Record<string, number>> = {
  narrow: {
    radius: 16, engine_power: 0.002, engine_startup_ticks: 60,
    energy_capacity: 0.6, energy_regeneration: 0.002,
    traction_power: 0.006, brake_power: 0.01,
    aerodynamics: 0.9992, oiliness: 0.996, turning_speed: 0.00032,
  },
  speedy: {
    radius: 20, engine_power: 0.0028, engine_startup_ticks: 120,
    energy_capacity: 0.2, energy_regeneration: 0.001,
    traction_power: 0.002, brake_power: 0.012,
    aerodynamics: 0.9996, oiliness: 0.996, turning_speed: 0.00028,
  },
  energy: {
    radius: 12, engine_power: 0.0016, engine_startup_ticks: 40,
    energy_capacity: 1.8, energy_regeneration: 0.004,
    traction_power: 0.005, brake_power: 0.02,
    aerodynamics: 0.999, oiliness: 0.998, turning_speed: 0.00038,
  },
};

/** Resolve an arrow name to its physics constants (default: Narrow). */
export function arrowConstants(arrowName: string | null | undefined): Record<string, number> {
  const name = (arrowName ?? "").toLowerCase();
  if (name.includes("speedy")) return ARROW_CONSTANTS.speedy;
  if (name.includes("energy")) return ARROW_CONSTANTS.energy;
  return ARROW_CONSTANTS.narrow;
}

/** Map a decoded 2-bit symbol to the engine's binary input. */
export function symbolToInput(symbol: number): { left: boolean; right: boolean } {
  switch (symbol) {
    case 1: return { left: false, right: true };
    case 2: return { left: true, right: false };
    case 3: return { left: true, right: true };
    default: return { left: false, right: false };
  }
}

interface EnginePlayerState {
  player: {
    state: string;
    translation: { x: number; y: number };
    rotation: number;
    thrust_power?: number;
  };
}

/** Parse the engine's JSON `state` into a SimPoint. */
function poseOf(stateJson: string): SimPoint {
  const s = JSON.parse(stateJson) as EnginePlayerState;
  return {
    x: s.player.translation.x,
    y: s.player.translation.y,
    rot: s.player.rotation - Math.PI / 2,
    finished: s.player.state === "finish",
    thrustPower: s.player.thrust_power ?? 0,
  };
}

interface GameStateLike {
  player: { constants: Record<string, number> };
  effects: unknown;
}

/** A level-bound engine that can be reset to the spawn and rolled out. */
export class Engine {
  readonly levelId: string;
  readonly arrowName: string;
  readonly spawn: SimPoint;
  readonly finishTarget: { x: number; y: number } | null;
  private handle: GameEngineHandle;
  private readonly mod: PhysicsModule;
  private readonly buildState: () => unknown;

  private constructor(build: {
    mod: PhysicsModule;
    handle: GameEngineHandle;
    arrowName: string;
    levelId: string;
    buildState: () => unknown;
  }) {
    this.mod = build.mod;
    this.handle = build.handle;
    this.arrowName = build.arrowName;
    this.levelId = build.levelId;
    this.buildState = build.buildState;
    this.spawn = poseOf(build.handle.state);
    this.finishTarget = null;
  }

  /** Build an engine from level data + arrow; null if the wasm can't load. */
  static async create(
    data: RawLevelData,
    arrowName?: string | null,
    levelId = "",
  ): Promise<Engine | null> {
    const mod = await loadPhysicsModule().catch(() => null);
    if (!mod) return null;
    try {
      const map = {
        game_mode: data.game_mode ?? "speedrun",
        map_name: data.map_name ?? "",
        obstacles: engineObstacles(data),
      };
      const buildState = () => {
        const base = mod.create_default_game_state() as GameStateLike;
        const player = {
          ...base.player,
          constants: { ...base.player.constants, ...arrowConstants(arrowName) },
        };
        return { player, map, ticks: 0, effects: base.effects };
      };
      const handle = new mod.GameMechanicsEngine(buildState()) as GameEngineHandle;
      const engine = new Engine({
        mod,
        handle,
        arrowName: arrowName ?? "Narrow Arrow",
        levelId,
        buildState,
      });
      // finishTarget needs the level data; set it after construction.
      (engine as { finishTarget: { x: number; y: number } | null }).finishTarget =
        findFinishTarget(data);
      return engine;
    } catch {
      return null;
    }
  }

  free() {
    this.handle.free();
  }

  /** Terminal code without stepping. */
  code(): number {
    return this.handle.player_state_code();
  }

  /** Current pose without stepping (parses the engine's full state). */
  readPose(): SimPoint {
    return poseOf(this.handle.state);
  }

  /**
 * Progress heuristic: distance the arrow has traveled from spawn, i.e. how far
 * along the road it got regardless of turn direction. Higher = farther into the
 * level. (A signed projection toward the finish would punish the initial
 * up-screen drive most Narrow Arrow roads need; straight-line distance to the
 * finish misranks curved roads. Distance-from-spawn stays monotonic while the
 * run doesn't loop back near the start, which holds for every road map.)
 */
  progressOf(point: SimPoint): number {
    return Math.hypot(point.x - this.spawn.x, point.y - this.spawn.y);
  }

  /** Reset to a fresh spawn state. */
  reset(): SimPoint {
    this.handle.free();
    this.handle = new this.mod.GameMechanicsEngine(this.buildState()) as GameEngineHandle;
    return this.spawn;
  }

  /**
   * Step `symbols` (one 240Hz tick each) from the current state and report the
   * terminal code, finish tick (engine tick counter when finished), final pose,
   * progress heuristic and how many ticks the run survived before a terminal
   * state (may exceed symbols.length only in the case of a stale terminal).
   */
  rollout(
    symbols: ArrayLike<number>,
  ): {
    code: number;
    finishTick: number | null;
    lastPoint: SimPoint;
    progress: number;
    /** Ticks survived before reaching the terminal state (engine's own counter). */
    survivedTicks: number;
  } {
    const n = symbols.length;
    const curCode = this.code();
    if (n === 0) {
      const p = this.readPose();
      return {
        code: curCode,
        finishTick: null,
        lastPoint: p,
        progress: this.progressOf(p),
        survivedTicks: curCode === 0 ? 0 : this.handle.get_ticks(),
      };
    }
    const inputs: Array<{ left: boolean; right: boolean }> = new Array(n);
    for (let i = 0; i < n; i++) inputs[i] = symbolToInput(symbols[i]);
    this.handle.process_ticks(inputs);
    const code = this.handle.player_state_code();
    let finishTick: number | null = null;
    if (code === 1) finishTick = this.handle.get_ticks();
    const lastPoint = this.readPose();
    const progress = this.progressOf(lastPoint);
    // get_ticks() freezes at the terminal tick, so after any code != 0 it is
    // exactly how many ticks the arrow survived.
    return {
      code,
      finishTick,
      lastPoint,
      progress,
      survivedTicks: code === 0 ? n : this.handle.get_ticks(),
    };
  }

  /** Step one tick; used by precise trajectory rebuilds. */
  stepSymbol(symbol: number): { point: SimPoint; code: number } {
    this.handle.process_ticks([symbolToInput(symbol)]);
    const code = this.handle.player_state_code();
    return { point: this.readPose(), code };
  }

  /** Snapshot the full engine state (JSON), for checkpointing. */
  snapshot(): string {
    return this.handle.state;
  }

  /** Restore from a snapshot; returns false on failure. */
  restore(snapshot: string): boolean {
    try {
      const handle = this.mod.GameMechanicsEngine.from_state(
        JSON.parse(snapshot),
      ) as GameEngineHandle;
      this.handle.free();
      this.handle = handle;
      return true;
    } catch {
      return false;
    }
  }
}

function findFinishTarget(data: RawLevelData): { x: number; y: number } | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const obstacle of data?.obstacles ?? []) {
    if (obstacle.wall_type !== "finish") continue;
    for (const p of obstacle.points ?? []) {
      if (p?.x == null || p?.y == null) continue;
      sx += p.x;
      sy += p.y;
      n++;
    }
  }
  return n > 0 ? { x: sx / n, y: sy / n } : null;
}

/**
 * Step a run tick-by-tick from a fresh engine and recover the exact finish
 * tick and full path. Used once per winning candidate (validation / playback)
 * — not in search hot loops.
 */
export async function simulateRunExact(
  data: RawLevelData,
  arrowName: string | null | undefined,
  symbols: ArrayLike<number>,
): Promise<{ path: SimPoint[]; finishTick: number | null }> {
  const engine = await Engine.create(data, arrowName);
  if (!engine) return { path: [], finishTick: null };
  engine.reset();
  const path: SimPoint[] = [engine.spawn];
  let finishTick: number | null = null;
  for (let i = 0; i < symbols.length; i++) {
    const { point, code } = engine.stepSymbol(symbols[i]);
    point.input = symbols[i];
    path.push(point);
    if (finishTick === null && point.finished) finishTick = path.length - 1;
    if (code === 2) break;
  }
  engine.free();
  return { path, finishTick };
}