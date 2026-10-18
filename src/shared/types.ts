/** Raw level payload as returned by `/level-details` (site shape). */
export interface RawLevelData {
  map_name?: string;
  game_mode?: string;
  obstacles?: Array<{
    points?: Array<{ x?: number; y?: number }>;
    wall_type?: string;
    obstacle_type?: string;
    wall_thickness?: number;
    rotation_pivot?: { x?: number; y?: number } | null;
    rotation_speed?: number | null;
    zone_type?: string;
    zone_direction?: number;
    portal_id?: string;
    side?: string;
    speed?: number;
  }>;
}

/** The shape `/api/level-details/<id>` wraps the level data in. */
export interface LevelDetailsEnvelope {
  levelInfo?: { data?: RawLevelData };
}

/** What a level looks like after geometry flattening (walls/zones/portals). */
export interface LevelGeometryPayload {
  level: LevelInfo;
  geometry: SimGeometry;
}

export interface SimWall {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  type: string;
  thickness: number;
  pivot?: { x: number; y: number };
  rotationSpeed?: number;
}

export interface SimZone {
  points: Array<{ x: number; y: number }>;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  type: string;
}

export interface SimPortal {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface SimGeometry {
  walls: SimWall[];
  zones: SimZone[];
  portals: SimPortal[];
}

/** Result of a completed search: symbols + summary + full path. */
export interface SimPoint {
  x: number;
  y: number;
  /** Facing angle in radians (engine rotation minus 90°, i.e. "forward"). */
  rot: number;
  finished?: boolean;
  thrustPower?: number;
  input?: number;
}

export interface SimResult {
  path: SimPoint[];
  finishTick: number | null;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface LevelInfo {
  id: string;
  name: string;
  gameOrder: number;
  packId: string;
}

export interface LevelPack {
  id: string;
  name: string;
}

export type SearchMode = "beam" | "genetic" | "brute";

/** A run entry from `GET /leaderboard?levelId=...` (public). */
export interface LeaderboardEntry {
  run_id: number;
  completion_time: number;
  username: string;
  arrow_name?: string;
  created_at?: string;
  replay_available?: number;
  is_verifier?: boolean;
}

/** A published/custom level summary from `GET /published-levels`. */
export interface PublishedLevel {
  id?: string | number;
  level_id?: string;
  name?: string;
  title?: string;
  creator_name?: string;
  author?: string;
  username?: string;
  plays?: number;
  play_count?: number;
  likes?: number;
  like_count?: number;
  worldRecord?: WorldRecordInfo | null;
  world_record?: WorldRecordInfo | null;
  runCount?: number;
  map_name?: string;
  data?: RawLevelData;
}

/** A level's world-record summary (snake_case returned by the API). */
export interface WorldRecordInfo {
  runId?: number;
  run_id?: number;
  completion_time?: number;
  arrow_name?: string;
  username?: string;
}

/** A replay payload from `GET /runs/{id}`. */
export interface RunReplayPayload {
  inputs?: string;
  input_count?: number;
  completion_time?: number;
  mapName?: string;
  level_id?: string;
  arrow_name?: string;
  skinConfig?: unknown;
}

export interface SearchParams {
  mode: SearchMode;
  levelId: string;
  arrowName: string;
  beamWidth?: number;
  actionRepeat?: number;
  maxDepth?: number;
  budgetSec?: number;
  population?: number;
  generations?: number;
  mutationRate?: number;
  actionTicks?: number;
  maxCandidates?: number;
  rngSeed?: number;
  /** Seed run for genetic mode: base64 inputs (or null to require a source). */
  seedInputs?: string;
  seedArrowName?: string;
  /** Seed run's finish tick (tick count), used to report improvement. */
  seedFinishTick?: number | null;
}

export interface ProgressUpdate {
  searchId: string;
  mode: SearchMode;
  levelId: string;
  arrowName: string;
  /** 0..1 — wall-clock budget approx. */
  elapsedMs: number;
  budgetMs: number;
  bestTimeMs: number | null;
  bestFinishTick: number | null;
  evaluations: number;
  generations: number;
  rollouts: number;
  /** Throttled trace of the current best run's full symbol stream. */
  bestSymbols?: number[];
  done: boolean;
  message?: string;
}

export interface SearchResult {
  searchId: string;
  mode: SearchMode;
  levelId: string;
  levelName: string;
  arrowName: string;
  symbols: number[];
  inputs: string;
  inputCount: number;
  finishTick: number | null;
  timeMs: number | null;
  seedTimeMs: number | null;
  improved: boolean;
  evaluations: number;
  generations: number;
  rollouts: number;
  stats: {
    bestTick: number | null;
    seedTick: number | null;
  };
  path: SimPoint[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}