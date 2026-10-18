/**
 * Racing-line analysis for a replay path: per-sample speed, brake detection,
 * and the derived "speed profile" stats used by the overlay.
 */
import type { SimPoint } from "../../../shared/types";

export interface SpeedSample {
  x: number;
  y: number;
  /** Approximate forward speed in px/ms (path length per tick at 240Hz). */
  speed: number;
  /** Raw thrust power from the engine (0..1 ~). */
  thrust: number;
  /** True when the 2-bit input at this tick was brake. */
  braking: boolean;
}

export interface LineAnalysis {
  samples: SpeedSample[];
  /** Distance from spawn to finish along the driven line (px). */
  distancePx: number;
  avgSpeed: number;
  maxSpeed: number;
  minSpeed: number;
  /** Fraction of ticks spent braking. */
  brakeFraction: number;
}

const TICK_MS = 1000 / 240;

/** How much of an entry is given to braking to distinguish hold from tap. */
const BRAKE_PRECENT_TICKS = 1;

/** Compute per-sample speed + braking from a path (each point = one tick). */
export function analyseLine(path: SimPoint[] | undefined | null): LineAnalysis {
  if (!path || path.length < 2) {
    return {
      samples: [],
      distancePx: 0,
      avgSpeed: 0,
      maxSpeed: 0,
      minSpeed: 0,
      brakeFraction: 0,
    };
  }

  const samples: SpeedSample[] = [];
  let distancePx = 0;
  let brakeTicks = 0;
  let maxSpeed = 0;
  let minSpeed = Infinity;

  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const prev = path[i - 1];
    const dist = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) : 0;
    distancePx += dist;
    const speed = dist / TICK_MS;
    const braking = p.input === 3 || (p.input === undefined && p.thrustPower !== undefined && p.thrustPower < 0);
    if (braking) brakeTicks++;
    if (i > 0) {
      if (speed > maxSpeed) maxSpeed = speed;
      if (speed < minSpeed) minSpeed = speed;
    }
    samples.push({
      x: p.x,
      y: p.y,
      speed,
      thrust: p.thrustPower ?? 0,
      braking,
    });
  }

  const moving = samples.slice(1);
  const avgSpeed =
    moving.length > 0 ? moving.reduce((s, m) => s + m.speed, 0) / moving.length : 0;
  // Exclude the final point if it's zero-speed (finish wall).
  void BRAKE_PRECENT_TICKS;
  void avgSpeed;

  const validSamples = samples.slice(1); // skip spawn
  const avg = validSamples.length ? validSamples.reduce((s, m) => s + m.speed, 0) / validSamples.length : 0;

  return {
    samples,
    distancePx,
    avgSpeed: avg,
    maxSpeed,
    minSpeed: validSamples.length ? Math.min(...validSamples.map((m) => m.speed)) : 0,
    brakeFraction: path.length ? brakeTicks / path.length : 0,
  };
}

/** Speed colour ramp: slow (red) → fast (green), matching the game's vibe. */
export function speedColour(speed: number, maxSpeed: number): string {
  if (maxSpeed <= 0) return "rgba(140, 200, 255, 0.6)";
  const t = Math.min(1, Math.max(0, speed / maxSpeed));
  // Red → yellow → green.
  const r = Math.round(255 * (1 - t) + 60 * t);
  const g = Math.round(60 * (1 - t) + 220 * t);
  const b = 60;
  return `rgba(${r}, ${g}, ${b}, 0.7)`;
}