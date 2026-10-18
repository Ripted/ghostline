/**
 * Deterministic RNGs for reproducible searches.
 *
 * Uses splitmix32 for the xorshift-style streams — a modern, well-distributed
 * 32-bit PRNG. A fixed seed always produces the same sequence, so a search with
 * the same seed + level + parameters reproduces byte-identical results.
 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z = z ^ (z >>> 15);
    return z / 4294967296;
  };
}

/** Pick a random element from an array/fractional index access if passed a number. */
export function pick<T>(rnd: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}