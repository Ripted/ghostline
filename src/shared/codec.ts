/**
 * Codec for the game's replay input stream, ported from the Narrow Arrow
 * rankings site (`nar-s/src/lib/replay.ts`).
 *
 * A run's `inputs` field is a base64 string where each byte packs four 2-bit
 * symbols, most-significant pair first. The game samples input at 240Hz, so one
 * tick is 1000/240 ≈ 4.1667ms.
 *
 * Symbol alphabet (recovered by matching a live replay against level geometry):
 *   0 = neutral / coast (no input)
 *   1 = right steer held
 *   2 = left steer held
 *   3 = brake (both steer directions held — cancels steering and slows down)
 */

/** Milliseconds represented by a single input tick (240Hz). */
export const TICK_MS = 1000 / 240;

/** A single held-input segment in the run-length summary. */
export interface InputSegment {
  index: number;
  key: "neutral" | "right" | "left" | "brake";
  short: string;
  atMs: number;
  heldMs: number;
}

export interface InputSummary {
  inputs: InputSegment[];
  tickCount: number;
  durationMs: number;
  totals: Record<string, number>;
  segmentCount: number;
}

/** Node-compatible base64 decoder (works in browser and main process). */
function base64ToBinaryString(base64: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(base64, "base64").toString("binary");
  }
  return atob(base64);
}

/** Node-compatible base64 encoder. */
function binaryStringToBase64(binary: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(binary, "binary").toString("base64");
  }
  return btoa(binary);
}

/** Decode a base64 `inputs` string into its 2-bit symbols. */
export function decodeInputSymbols(base64: string, inputCount?: number): number[] {
  if (!base64) return [];
  let binary: string;
  try {
    binary = base64ToBinaryString(base64);
  } catch {
    return [];
  }
  const symbols: number[] = [];
  for (let i = 0; i < binary.length; i++) {
    const byte = binary.charCodeAt(i);
    symbols.push((byte >> 6) & 3, (byte >> 4) & 3, (byte >> 2) & 3, byte & 3);
  }
  const decoded =
    typeof inputCount === "number" && inputCount > 0 ? symbols.slice(0, inputCount) : symbols;
  return decoded;
}

/**
 * Inverse of {@link decodeInputSymbols}: pack 2-bit symbols back into the
 * base64 the game stores in a run's `inputs` field, most-significant pair
 * first and the final byte zero-padded.
 */
export function encodeInputSymbols(symbols: number[]): string {
  if (symbols.length === 0) return "";
  const bytes: number[] = [];
  for (let i = 0; i < symbols.length; i += 4) {
    const a = symbols[i] & 3;
    const b = (symbols[i + 1] ?? 0) & 3;
    const c = (symbols[i + 2] ?? 0) & 3;
    const d = (symbols[i + 3] ?? 0) & 3;
    bytes.push((a << 6) | (b << 4) | (c << 2) | d);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return binaryStringToBase64(binary);
}

const SYMBOL_BY_NAME: Record<string, number> = {
  n: 0, neutral: 0, coast: 0, none: 0,
  r: 1, right: 1,
  l: 2, left: 2,
  b: 3, brake: 3, both: 3,
};

/** Map a loose arrow label to a canonical name (substring match). */
export function normaliseArrowName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const n = value.toLowerCase();
  if (n.includes("speedy")) return "Speedy Arrow";
  if (n.includes("energy")) return "Energy Arrow";
  if (n.includes("narrow")) return "Narrow Arrow";
  return undefined;
}

export interface ParsedTasFile {
  symbols: number[];
  arrowName?: string;
  levelId?: string;
  mapName?: string;
  finishTick?: number;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Decode a symbol list: plain 0-3 values, names ("right"), or run-length rows. */
function symbolsFromList(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: number[] = [];
  for (const item of value) {
    if (typeof item === "number") {
      if (item < 0 || item > 3 || !Number.isInteger(item)) return null;
      out.push(item);
      continue;
    }
    if (typeof item === "string") {
      const sym = SYMBOL_BY_NAME[item.trim().toLowerCase()];
      if (sym === undefined) return null;
      out.push(sym);
      continue;
    }
    if (item && typeof item === "object") {
      const row = item as Record<string, unknown>;
      const name = asString(row.key) ?? asString(row.short) ?? asString(row.input);
      const sym =
        typeof row.symbol === "number"
          ? row.symbol & 3
          : name
            ? SYMBOL_BY_NAME[name.toLowerCase()]
            : undefined;
      if (sym === undefined) return null;
      const length = Number(row.length ?? row.count ?? row.ticks ?? row.hold ?? 1);
      const n = Number.isFinite(length) && length > 0 ? Math.floor(length) : 1;
      for (let i = 0; i < n; i++) out.push(sym);
      continue;
    }
    return null;
  }
  return out.length ? out : null;
}

/**
 * Parse a TAS file (JSON, whatever shape) into the raw symbol stream. Accepts
 * the editor's export (`{inputs, input_count}`), the offline optimizer's
 * output (`{syms, arrow}`), a bare array, or a run-length list.
 */
export function parseTasFile(text: string): ParsedTasFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const levelObj = (
    obj.level && typeof obj.level === "object" ? obj.level : {}
  ) as Record<string, unknown>;
  const meta = {
    arrowName: normaliseArrowName(
      asString(obj.arrow_name) ??
        asString(obj.arrowName) ??
        asString(obj.arrow) ??
        asString(levelObj.arrow),
    ),
    levelId:
      asString(obj.level_id) ??
      asString(obj.levelId) ??
      asString(levelObj.levelId) ??
      asString(levelObj.level_id) ??
      asString(levelObj.id),
    mapName:
      asString(obj.map_name) ??
      asString(obj.mapName) ??
      asString(levelObj.name) ??
      asString(levelObj.map_name) ??
      asString(levelObj.mapName),
    finishTick: asNumber(obj.f) ?? asNumber(obj.finish_tick) ?? asNumber(obj.finishTick),
  };

  const inputs = asString(obj.inputs);
  if (inputs) {
    const count = asNumber(obj.input_count) ?? asNumber(obj.inputCount);
    const symbols = decodeInputSymbols(inputs, count);
    if (!symbols.length) throw new Error("The file's `inputs` field decoded to nothing.");
    return { symbols, ...meta };
  }

  const symbols =
    symbolsFromList(
      obj.syms ??
        obj.symbols ??
        obj.segments ??
        obj.input_list ??
        obj.inputs_list ??
        obj.sequence ??
        (Array.isArray(obj.inputs) ? obj.inputs : undefined),
    ) ?? symbolsFromList(raw);
  if (symbols) return { symbols, ...meta };

  throw new Error("Unrecognised TAS file — expected `inputs` (base64) or a symbol list.");
}

/** Collapse a symbol stream into held-input segments, e.g. "right 72ms". */
export function summariseSymbols(symbols: number[]): InputSummary {
  const LABELS = ["neutral", "right", "left", "brake"] as const;
  const SHORT = ["n", "r", "l", "b"] as const;
  const empty: InputSummary = {
    inputs: [],
    tickCount: 0,
    durationMs: 0,
    totals: { neutral: 0, right: 0, left: 0, brake: 0 },
    segmentCount: 0,
  };
  if (symbols.length === 0) return empty;

  const segments: InputSegment[] = [];
  const totals: Record<string, number> = { neutral: 0, right: 0, left: 0, brake: 0 };

  let start = 0;
  let current = symbols[0];
  for (let i = 1; i <= symbols.length; i++) {
    if (i === symbols.length || symbols[i] !== current) {
      const key = LABELS[current] ?? "neutral";
      const heldMs = (i - start) * TICK_MS;
      segments.push({
        index: segments.length,
        key,
        short: SHORT[current] ?? "n",
        atMs: start * TICK_MS,
        heldMs,
      });
      totals[key] += heldMs;
      if (i < symbols.length) {
        start = i;
        current = symbols[i];
      }
    }
  }

  return {
    inputs: segments,
    tickCount: symbols.length,
    durationMs: symbols.length * TICK_MS,
    totals,
    segmentCount: segments.length,
  };
}

/** Decode a base64 replay into a run-length produced summary (site-compatible). */
export function summariseReplay(base64: string, inputCount?: number): InputSummary {
  return summariseSymbols(decodeInputSymbols(base64, inputCount));
}

/** Compact label for a held input, e.g. "r72" (right held for 72ms). */
export function formatInputLabel(segment: InputSegment): string {
  return `${segment.short}${Math.round(segment.heldMs)}`;
}