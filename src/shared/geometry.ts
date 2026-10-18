import type { RawLevelData, SimGeometry, SimWall, SimZone, SimPortal } from "./types";

/**
 * Flatten a level's obstacles into what renderers draw (port of
 * `levelGeometry` from `nar-s/src/lib/replay-sim.ts`). Walls become line
 * segments, zones become filled polygons, portals become directed segments.
 * Rotating walls carry their pivot/rotation speed so the renderer can animate
 * them at the current tick.
 */

export type { SimGeometry, SimWall, SimZone, SimPortal } from "./types";

export function levelGeometry(data: RawLevelData | null | undefined): SimGeometry {
  const walls: SimWall[] = [];
  const zones: SimZone[] = [];
  const portals: SimPortal[] = [];
  for (const obstacle of data?.obstacles ?? []) {
    const pts = obstacle.points ?? [];

    const isZone = obstacle.zone_type != null || obstacle.obstacle_type === "zone";
    const isPortal = obstacle.portal_id != null || obstacle.obstacle_type === "portal";

    if (isZone) {
      const valid = pts.filter((p): p is { x: number; y: number } => p?.x != null && p?.y != null);
      if (valid.length === 0) continue;
      const xs = valid.map((p) => p.x);
      const ys = valid.map((p) => p.y);
      zones.push({
        points: valid.map((p) => ({ x: p.x, y: p.y })),
        x0: Math.min(...xs),
        y0: Math.min(...ys),
        x1: Math.max(...xs),
        y1: Math.max(...ys),
        type: obstacle.zone_type ?? "boost",
      });
      continue;
    }

    if (isPortal) {
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (a?.x == null || a?.y == null || b?.x == null || b?.y == null) continue;
        portals.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
      }
      continue;
    }

    const type = obstacle.wall_type ?? "normal";
    const thickness = obstacle.wall_thickness ?? 8;
    const pivot =
      obstacle.rotation_pivot?.x != null && obstacle.rotation_pivot?.y != null
        ? { x: obstacle.rotation_pivot.x, y: obstacle.rotation_pivot.y }
        : undefined;
    const rotationSpeed = obstacle.rotation_speed ?? undefined;

    const valid = pts.filter((p): p is { x: number; y: number } => p?.x != null && p?.y != null);
    if (valid.length === 1) {
      const p = valid[0];
      walls.push({ ax: p.x, ay: p.y, bx: p.x, by: p.y, type, thickness, pivot, rotationSpeed });
      continue;
    }
    for (let i = 0; i + 1 < valid.length; i++) {
      const a = valid[i];
      const b = valid[i + 1];
      walls.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, type, thickness, pivot, rotationSpeed });
    }
  }
  return { walls, zones, portals };
}

/** Build the obstacle list the engine expects, passing every field through. */
export function engineObstacles(data: RawLevelData): Array<Record<string, unknown>> {
  const fields = [
    "wall_type",
    "wall_thickness",
    "zone_type",
    "zone_direction",
    "portal_id",
    "side",
    "rotation_pivot",
    "rotation_speed",
    "speed",
  ] as const;
  return (data.obstacles ?? []).map((o) => {
    const out: Record<string, unknown> = {
      obstacle_type: o.obstacle_type ?? (o.zone_type ? "zone" : o.portal_id ? "portal" : "wall"),
      points: (o.points ?? []).map((p) => ({ x: p.x ?? 0, y: p.y ?? 0 })),
    };
    for (const key of fields) {
      if (o[key] != null) out[key] = o[key];
    }
    return out;
  });
}

/** Centre of the finish wall, used as the target for DNF/progress signals. */
export function finishTarget(data: RawLevelData | null | undefined): { x: number; y: number } | null {
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