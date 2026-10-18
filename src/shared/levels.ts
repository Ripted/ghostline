import type { LevelInfo, LevelPack } from "./types";

export const LEVEL_PACKS: LevelPack[] = [
  { id: "official-pack", name: "Official Pack" },
  { id: "ice-pack", name: "Ice Pack" },
  { id: "spinner-pack", name: "Spinner Pack" },
  { id: "highspeed-pack", name: "Highspeed Pack" },
  { id: "precision-pack", name: "Precision Pack" },
  { id: "deadzone-pack", name: "Deadzone Pack" },
  { id: "symmetry-pack", name: "Symmetry Pack" },
  { id: "bounce-pack", name: "Bounce Pack" },
  { id: "shape-pack", name: "Shape Pack" },
];

/** Official level catalog (id + name + pack), copied from `nar-s/src/constants.ts`. */
export const LEVELS: LevelInfo[] = [
  { id: "1777118905185", name: "Highway Jet", gameOrder: 0, packId: "official-pack" },
  { id: "801170F9", name: "Diamond Rally", gameOrder: 1, packId: "official-pack" },
  { id: "B05C7EDE", name: "Blue Slides", gameOrder: 2, packId: "official-pack" },
  { id: "9892299A", name: "Green Cross", gameOrder: 3, packId: "official-pack" },
  { id: "BBB1AF96", name: "Attractive Curves", gameOrder: 4, packId: "official-pack" },
  { id: "86155A34", name: "Dodgy Place", gameOrder: 5, packId: "official-pack" },
  { id: "1B901DFE", name: "Square Rally", gameOrder: 6, packId: "official-pack" },
  { id: "B91CA820", name: "Polar Drift", gameOrder: 7, packId: "official-pack" },
  { id: "D4111EF0", name: "Level Icy", gameOrder: 0, packId: "ice-pack" },
  { id: "1778427891183", name: "Peril Drift", gameOrder: 1, packId: "ice-pack" },
  { id: "1776365701718", name: "Icy Passage", gameOrder: 2, packId: "ice-pack" },
  { id: "1776607121274", name: "Friction", gameOrder: 3, packId: "ice-pack" },
  { id: "3FC555C7", name: "Iced Turns", gameOrder: 4, packId: "ice-pack" },
  { id: "1F9537A9", name: "Arctic Dash", gameOrder: 5, packId: "ice-pack" },
  { id: "1776585530826", name: "Slippy Navo", gameOrder: 6, packId: "ice-pack" },
  { id: "F3D36D72", name: "Frozen Snail", gameOrder: 7, packId: "ice-pack" },
  { id: "8440FB48", name: "Arrow Factory", gameOrder: 0, packId: "spinner-pack" },
  { id: "AAA35C8F", name: "Colossal R", gameOrder: 1, packId: "spinner-pack" },
  { id: "EE4C77BD", name: "Windmill Land", gameOrder: 2, packId: "spinner-pack" },
  { id: "0928C4FA", name: "Spinning Square", gameOrder: 3, packId: "spinner-pack" },
  { id: "DDD467F7", name: "Chain Reaction", gameOrder: 4, packId: "spinner-pack" },
  { id: "5B719122", name: "Arrow Vortex", gameOrder: 5, packId: "spinner-pack" },
  { id: "7913D7AD", name: "Fast Spinners", gameOrder: 6, packId: "spinner-pack" },
  { id: "ADEEF62A", name: "Turnpike Drift", gameOrder: 7, packId: "spinner-pack" },
  { id: "A4AC1F94", name: "Highspeed Madness", gameOrder: 0, packId: "highspeed-pack" },
  { id: "1201C184", name: "Flash Weave", gameOrder: 1, packId: "highspeed-pack" },
  { id: "DBAAF90F", name: "Speedrun Highway", gameOrder: 2, packId: "highspeed-pack" },
  { id: "6989E25C", name: "Turboplex", gameOrder: 3, packId: "highspeed-pack" },
  { id: "FE762722", name: "Blasture", gameOrder: 4, packId: "highspeed-pack" },
  { id: "1776363269324", name: "Energex", gameOrder: 5, packId: "highspeed-pack" },
  { id: "4C16A756", name: "SlipStream Rush", gameOrder: 6, packId: "highspeed-pack" },
  { id: "1778700802817", name: "Rhomb Rush", gameOrder: 7, packId: "highspeed-pack" },
  { id: "6D8E28FA", name: "Level 1", gameOrder: 0, packId: "precision-pack" },
  { id: "6A1DE122", name: "Fast and Slow", gameOrder: 1, packId: "precision-pack" },
  { id: "41CB6306", name: "Maze Rally", gameOrder: 2, packId: "precision-pack" },
  { id: "1777481332692", name: "Maze Rally 2.0", gameOrder: 3, packId: "precision-pack" },
  { id: "723F4248", name: "Final Drift", gameOrder: 4, packId: "precision-pack" },
  { id: "1777481344370", name: "Slippery Slope", gameOrder: 5, packId: "precision-pack" },
  { id: "1777481354584", name: "Gatekeeper", gameOrder: 6, packId: "precision-pack" },
  { id: "0CFAEE35", name: "Moon Rock Rally", gameOrder: 7, packId: "precision-pack" },
  { id: "D70A5531", name: "Ilectric Boogaloo", gameOrder: 0, packId: "deadzone-pack" },
  { id: "E4C0F31A", name: "Xarcade", gameOrder: 1, packId: "deadzone-pack" },
  { id: "7C61D654", name: "Deadly Divide", gameOrder: 2, packId: "deadzone-pack" },
  { id: "5F5D71A8", name: "Jasmine", gameOrder: 3, packId: "deadzone-pack" },
  { id: "1776585813204", name: "Deathmatch", gameOrder: 4, packId: "deadzone-pack" },
  { id: "111145BE", name: "Danger Drive", gameOrder: 5, packId: "deadzone-pack" },
  { id: "1776585800884", name: "Murder Valley", gameOrder: 6, packId: "deadzone-pack" },
  { id: "1776585820251", name: "Lava Rush", gameOrder: 7, packId: "deadzone-pack" },
  { id: "E2965202", name: "Symmetry", gameOrder: 0, packId: "symmetry-pack" },
  { id: "C5E8ED04", name: "Perfect Mirror", gameOrder: 1, packId: "symmetry-pack" },
  { id: "58FD77AE", name: "First Frost", gameOrder: 2, packId: "symmetry-pack" },
  { id: "6C81846A", name: "Balance", gameOrder: 3, packId: "symmetry-pack" },
  { id: "1776585247853", name: "Zigzag", gameOrder: 4, packId: "symmetry-pack" },
  { id: "1776586015136", name: "Opposites", gameOrder: 5, packId: "symmetry-pack" },
  { id: "1776586062365", name: "Centrifugal", gameOrder: 6, packId: "symmetry-pack" },
  { id: "1776585300270", name: "Corridor", gameOrder: 7, packId: "symmetry-pack" },
  { id: "A21D0A29", name: "Duck Season", gameOrder: 0, packId: "bounce-pack" },
  { id: "037C53A7", name: "Bounce House", gameOrder: 1, packId: "bounce-pack" },
  { id: "C36BA54B", name: "Rat Race", gameOrder: 2, packId: "bounce-pack" },
  { id: "5B7153D4", name: "Bouncer", gameOrder: 3, packId: "bounce-pack" },
  { id: "1776585575288", name: "Blobtastic", gameOrder: 4, packId: "bounce-pack" },
  { id: "1776585586074", name: "Boing", gameOrder: 5, packId: "bounce-pack" },
  { id: "1776585596138", name: "Big Bounce", gameOrder: 6, packId: "bounce-pack" },
  { id: "ACA26B98", name: "Bouncy Land", gameOrder: 7, packId: "bounce-pack" },
  { id: "1777118898584", name: "Ka Zing", gameOrder: 0, packId: "shape-pack" },
  { id: "D92F5158", name: "Fruit Loops", gameOrder: 1, packId: "shape-pack" },
  { id: "1777119138710", name: "Totality", gameOrder: 2, packId: "shape-pack" },
  { id: "1777118949036", name: "Archipelago", gameOrder: 3, packId: "shape-pack" },
  { id: "1777118959366", name: "Gangplank", gameOrder: 4, packId: "shape-pack" },
  { id: "1777118972779", name: "Shortcut", gameOrder: 5, packId: "shape-pack" },
  { id: "1777118986276", name: "Blossom", gameOrder: 6, packId: "shape-pack" },
  { id: "1777119000203", name: "Roam", gameOrder: 7, packId: "shape-pack" },
];

export const ARROW_NAMES = ["Narrow Arrow", "Speedy Arrow", "Energy Arrow"] as const;

/** Look up a level's display name by id (falls back to the id itself). */
export function levelName(id: string): string {
  return LEVELS.find((l) => l.id === id)?.name ?? id;
}

/** Resolve a run's `arrow_name` to its physics constants key (default: narrow). */
export function arrowKind(arrowName: string | null | undefined): "narrow" | "speedy" | "energy" {
  const name = (arrowName ?? "").toLowerCase();
  if (name.includes("speedy")) return "speedy";
  if (name.includes("energy")) return "energy";
  return "narrow";
}