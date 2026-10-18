/* tslint:disable */
/* eslint-disable */
export function create_default_game_state(): ApiGameState;
export function init_panic_hook(): void;
export interface ApiXYR {
    x: number;
    y: number;
    r: number;
}

export interface ApiXY {
    x: number;
    y: number;
}

export interface ApiPlayer {
    state: ApiPlayerState;
    translation: ApiXY;
    rotation: number;
    velocity: ApiXYR;
    energy: number;
    thrust_power: number;
    constants: ApiPlayerConstants;
    portal_transition?: ApiPortalTransition;
}

export type ApiPlayerState = "playing" | "finish" | "dnf";

export interface ApiPlayerConstants {
    radius: number;
    engine_power: number;
    engine_startup_ticks: number;
    energy_capacity: number;
    energy_regeneration: number;
    traction_power: number;
    brake_power: number;
    aerodynamics: number;
    oiliness: number;
    turning_speed: number;
}

export interface ApiPortalTransition {
    source_index: number;
    target_index: number;
    entry_sign: number;
}

export interface ApiPlayerConstantsOverride {
    engine_power: number | null;
}

export type ApiObstacle = { obstacle_type: "wall"; wall_type: string; wall_thickness: number | null; points: ApiXY[]; rotation_pivot: ApiXY | null; rotation_speed: number | null } | { obstacle_type: "portal"; portal_id: string; side: string; points: ApiXY[]; rotation_pivot: ApiXY | null; rotation_speed: number | null } | { obstacle_type: "zone"; zone_type: string; points: ApiXY[]; rotation_pivot: ApiXY | null; rotation_speed: number | null; zone_direction?: number };

export interface ApiMap {
    game_mode: string;
    map_name: string;
    obstacles: ApiObstacle[];
}

export interface ApiGameState {
    player: ApiPlayer;
    ticks: number;
    map: ApiMap;
    effects: ApiEffects;
}

export interface ApiWallContactEffect {
    intensity: number;
    wall_type: string;
    translation: ApiXY;
    direction: ApiXY;
    duration: number;
    inactive_since: number;
    obstacle_index: number;
}

export interface ApiThrustEffect {
    position: ApiXY;
    direction: ApiXY;
    duration: number;
    inactive_since: number;
}

export interface ApiEffects {
    flight_velocity_deltas?: number[];
    zone_energy_boosts?: number[];
    movement_sounds?: MovementSoundSample[];
    wall_sound_impulses?: WallSoundImpulse[];
    wall_contact_effects: ApiWallContactEffect[];
    thrusts: ApiThrustEffect[];
}

export interface MovementSoundSample {
    ice_slip: number;
    rail_delta: number;
    portal_toward: number;
    portal_away: number;
    brake_delta?: number;
    traction_delta?: number;
}

export interface WallSoundImpulse {
    tick: number;
    wall_type: string;
    velocity_delta: number;
    friction_velocity_delta?: number;
    obstacle_index: number;
}

export class GameMechanicsEngine {
  free(): void;
  static from_state(state: ApiGameState): GameMechanicsEngine;
  /**
   * Process the ticks of the game based on the inputs. The amount of processed ticks is equal to the amount of inputs.
   */
  process_ticks(inputs: any): void;
  /**
   * The player's terminal state as a cheap scalar: 0 playing, 1 finish,
   * 2 dead. The verifier polls this between input chunks; the full JSON
   * `state` serializes the whole map every call, which is far too heavy
   * for a per-chunk "are we done yet".
   */
  player_state_code(): number;
  /**
   * JS-friendly constructor that creates the engine from an ApiGameState.
   */
  constructor(state: ApiGameState);
  get_ticks(): number;
  /**
   * The run's cumulative statistics counters as a small JSON object.
   * Observation-only: reading them cannot perturb the simulation, and the
   * terminal-state latch means they froze at the finish or death tick.
   */
  run_stats(): string;
  readonly state: string;
}
export class MultiPlayerEngine {
  free(): void;
  process_multi_player_ticks(players_js: any, effects_js: any, inputs_js: any): any;
  /**
   * Create a new MultiPlayerEngine from an API map.
   */
  constructor(api_map: ApiMap);
  get_ticks(): number;
  set_ticks(ticks: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_gamemechanicsengine_free: (a: number, b: number) => void;
  readonly __wbg_multiplayerengine_free: (a: number, b: number) => void;
  readonly create_default_game_state: () => any;
  readonly gamemechanicsengine_from_state: (a: any) => number;
  readonly gamemechanicsengine_get_ticks: (a: number) => number;
  readonly gamemechanicsengine_player_state_code: (a: number) => number;
  readonly gamemechanicsengine_process_ticks: (a: number, b: any) => void;
  readonly gamemechanicsengine_run_stats: (a: number) => [number, number];
  readonly gamemechanicsengine_state: (a: number) => [number, number];
  readonly multiplayerengine_from_map: (a: any) => number;
  readonly multiplayerengine_get_ticks: (a: number) => number;
  readonly multiplayerengine_process_multi_player_ticks: (a: number, b: any, c: any, d: any) => [number, number, number];
  readonly multiplayerengine_set_ticks: (a: number, b: number) => void;
  readonly init_panic_hook: () => void;
  readonly gamemechanicsengine_new: (a: any) => number;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_4: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
