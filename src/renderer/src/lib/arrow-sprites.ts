/**
 * Arrow sprite rendering, ported from the rankings site (`arrow-sprites.ts`).
 * Each sprite is a 64x64 viewBox with the nose pointing up (-y). The path data
 * is copied verbatim from the game's own SVGs, so the shape is exact; we tint
 * tail/body the way the game tints skins.
 */
import arrowNarrow from "../assets/arrow-narrow.png";
import arrowSpeedy from "../assets/arrow-speedy.png";
import arrowEnergy from "../assets/arrow-energy.png";

export type ArrowKind = "narrow" | "speedy" | "energy";

interface Sprite {
  tail: string;
  body: string;
}

const SPRITES: Record<ArrowKind, Sprite> = {
  narrow: {
    tail: "M32 40 20 44 16 60 32 52 48 60 44 44Z",
    body: "M8 48 32 4 56 48 32 40Z",
  },
  speedy: {
    tail: "M32 39l-8 3-12 17 20-8 20 8-12-17Z",
    body: "M8 47l14-16 10-28 10 28 14 16-24-8Z",
  },
  energy: {
    tail: "M32 40l-12 4 2 16 10-4 10 4 2-16Z",
    body: "M8 56V42L32 4 56 42V56L32 40Z",
  },
};

/** PNG sprite maps — the game's actual arrow art (nose up, 128x128). */
export const ARROW_IMAGES: Record<ArrowKind, string> = {
  narrow: arrowNarrow,
  speedy: arrowSpeedy,
  energy: arrowEnergy,
};

const SPRITE_SIZE = 64;
const SPRITE_TIP_Y = 4;

/** Resolve a run's `arrow_name` to the sprite kind it flies. */
export function arrowKind(arrowName: string | null | undefined): ArrowKind {
  const name = (arrowName ?? "").toLowerCase();
  if (name.includes("speedy")) return "speedy";
  if (name.includes("energy")) return "energy";
  return "narrow";
}

const cache = new Map<string, { tail: Path2D; body: Path2D }>();

function pathsFor(kind: ArrowKind) {
  const cached = cache.get(kind);
  if (cached) return cached;
  const sprite = SPRITES[kind];
  const paths = { tail: new Path2D(sprite.tail), body: new Path2D(sprite.body) };
  cache.set(kind, paths);
  return paths;
}

/**
 * Draw the run's arrow sprite at `(x, y)`, facing `heading`, scaled to a
 * world radius (`worldRadius`) and mapped to canvas px via `scale`, tinted
 * with skin body/tail colours.
 */
export function drawArrowSprite(
  ctx: CanvasRenderingContext2D,
  kind: ArrowKind,
  x: number,
  y: number,
  heading: number,
  scale: number,
  worldRadius: number,
  bodyColor: string,
  tailColor: string,
) {
  const { tail, body } = pathsFor(kind);
  const size = worldRadius * scale * 2;
  ctx.save();
  ctx.translate(x, y);
  // The sprite points up; the engine's heading is a canvas angle, so add 90°.
  ctx.rotate(heading + Math.PI / 2);
  ctx.scale(size / SPRITE_SIZE, size / SPRITE_SIZE);
  ctx.translate(-SPRITE_SIZE / 2, -SPRITE_TIP_Y);
  ctx.shadowColor = bodyColor;
  ctx.shadowBlur = 6;
  ctx.fillStyle = tailColor;
  ctx.strokeStyle = tailColor;
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.fill(tail);
  ctx.stroke(tail);
  ctx.fillStyle = bodyColor;
  ctx.strokeStyle = bodyColor;
  ctx.fill(body);
  ctx.stroke(body);
  ctx.restore();
}