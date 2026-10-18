/**
 * ReplayStage — canvas renderer for the map + replay path overlay, ported from
 * the rankings site's `ReplayViewer.tsx` draw logic (walls, zones, portals,
 * finish, arrow marker) plus a "racing line" path (speed-coloured).
 */
import { useEffect, useRef } from "react";
import type { LevelGeometryPayload, SimPoint, SimWall, SimZone, SimPortal } from "../../../shared/types";
import { analyseLine, speedColour, type LineAnalysis } from "../lib/analysis";

export interface ReplayStageProps {
  geometry: LevelGeometryPayload["geometry"];
  path: SimPoint[] | null;
  /** Index into the path to show live (null = full path). */
  markerIndex?: number | null;
  onPathAnalysis?: (a: LineAnalysis) => void;
  width?: number;
  height?: number;
}

const ZONE_COLOURS: Record<string, string> = {
  boost: "rgba(80, 220, 120, 0.22)",
  slow: "rgba(240, 130, 60, 0.22)",
  void: "rgba(0, 0, 0, 0.4)",
  death: "rgba(240, 40, 40, 0.3)",
};

function drawArrow(ctx: CanvasRenderingContext2D, p: SimPoint, scale: number) {
  const len = 10 * scale;
  const ang = p.rot ?? Math.atan2(
    Math.min(0, p.y),
    Math.min(1, p.x),
  );
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(len, 0);
  ctx.lineTo(-len * 0.5, len * 0.55);
  ctx.lineTo(-len * 0.5, -len * 0.55);
  ctx.closePath();
  ctx.fillStyle = "rgba(120, 220, 255, 0.95)";
  ctx.fill();
  ctx.restore();
}

export function ReplayStage({
  geometry,
  path,
  markerIndex,
  onPathAnalysis,
  width = 860,
  height = 620,
}: ReplayStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef({ geometry, path, markerIndex });
  propsRef.current = { geometry, path, markerIndex };

  useEffect(() => {
    const { geometry: g, path: p, markerIndex: mi } = propsRef.current;
    const walls = g.walls as SimWall[];
    const zones = g.zones as SimZone[];
    const portals = g.portals as SimPortal[];
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Fit the level bounds (or path bounds) into the canvas with padding.
    const all = [
      ...walls.flatMap((w) => [
        { x: w.ax, y: w.ay },
        { x: w.bx, y: w.by },
      ]),
      ...zones.flatMap((z) => z.points),
      ...portals.flatMap((po) => [
        { x: po.ax, y: po.ay },
        { x: po.bx, y: po.by },
      ]),
      ...(p ?? []),
    ];
    if (all.length === 0) return;
    const xs = all.map((pt) => pt.x);
    const ys = all.map((pt) => pt.y);
    let minX = Math.min(...xs);
    let minY = Math.min(...ys);
    let maxX = Math.max(...xs);
    let maxY = Math.max(...ys);
    const pad = 40;
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);

    const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
    const offsetX = (width - spanX * scale) / 2 - minX * scale;
    const offsetY = (height - spanY * scale) / 2 - minY * scale;
    const X = (x: number) => x * scale + offsetX;
    const Y = (y: number) => y * scale + offsetY;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0e1117";
    ctx.fillRect(0, 0, width, height);

    // Zones.
    for (const z of zones) {
      ctx.beginPath();
      z.points.forEach((pt, i) => {
        if (i === 0) ctx.moveTo(X(pt.x), Y(pt.y));
        else ctx.lineTo(X(pt.x), Y(pt.y));
      });
      ctx.closePath();
      ctx.fillStyle = ZONE_COLOURS[z.type] ?? "rgba(120,120,120,0.15)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Walls (with thickness strokes).
    for (const w of walls) {
      const thickness = w.thickness ?? 8;
      const angle = Math.atan2(w.by - w.ay, w.bx - w.ax);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const nx = -sin * thickness * 0.5;
      const ny = cos * thickness * 0.5;
      ctx.beginPath();
      ctx.moveTo(X(w.ax + nx), Y(w.ay + ny));
      ctx.lineTo(X(w.bx + nx), Y(w.by + ny));
      ctx.lineTo(X(w.bx - nx), Y(w.by - ny));
      ctx.lineTo(X(w.ax - nx), Y(w.ay - ny));
      ctx.closePath();
      ctx.fillStyle = w.type === "finish" ? "#2ecc71" : w.type === "hazard" ? "#e74c3c" : "#c8c8cc";
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 0.7;
      ctx.stroke();

      // Pivot marker for rotating walls.
      if (w.pivot) {
        ctx.beginPath();
        ctx.arc(X(w.pivot.x), Y(w.pivot.y), 3 * scale, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.fill();
      }
    }

    // Portals.
    for (const po of portals) {
      ctx.strokeStyle = "rgba(180, 90, 255, 0.9)";
      ctx.lineWidth = 3 * scale;
      ctx.beginPath();
      ctx.moveTo(X(po.ax), Y(po.ay));
      ctx.lineTo(X(po.bx), Y(po.by));
      ctx.stroke();
    }

    // Finish wall label.
    for (const w of walls) {
      if (w.type === "finish") {
        ctx.fillStyle = "rgba(46, 204, 113, 0.9)";
        ctx.font = `${11 * scale}px system-ui, sans-serif`;
        ctx.fillText("FINISH", (X(w.ax) + X(w.bx)) / 2 - 22 * scale, (Y(w.ay) + Y(w.by)) / 2 - 6 * scale);
      }
    }

    // Path (racing line): draw each segment coloured by speed.
    if (p && p.length >= 2) {
      const analysis = analyseLine(p);
      onPathAnalysis?.(analysis);
      const maxSpeed = analysis.maxSpeed;
      ctx.lineWidth = 2.6;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (let i = 0; i + 1 < p.length; i++) {
        const a = p[i];
        const b = p[i + 1];
        const speed = analysis.samples[i + 1]?.speed ?? 0;
        ctx.strokeStyle = speedColour(speed, maxSpeed);
        ctx.beginPath();
        ctx.moveTo(X(a.x), Y(a.y));
        ctx.lineTo(X(b.x), Y(b.y));
        ctx.stroke();
      }
    }

    // Arrow marker for live progress.
    if (p && mi != null && mi >= 0 && mi < p.length) {
      drawArrow(ctx, { x: p[mi].x, y: p[mi].y, rot: p[mi].rot ?? 0 }, scale);
    } else if (p && p.length > 0 && mi == null) {
      drawArrow(ctx, { x: p[p.length - 1].x, y: p[p.length - 1].y, rot: p[p.length - 1].rot ?? 0 }, scale);
    }
  }, [geometry, path, markerIndex, width, height, onPathAnalysis]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ width: "100%", height: "100%", display: "block", borderRadius: 8, border: "1px solid #23272f" }}
    />
  );
}