/**
 * Seeded randomness. The tuner must give the same answer for the same data,
 * so nothing in this module uses Math.random.
 */

/** FNV-1a 32-bit hash of a string. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A number in [0, 1) fixed by the text. Every version sees the same draw for the same coin. */
export function unitHash(text: string): number {
  return hashString(text) / 0x1_0000_0000;
}

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** standard normal */
  normal(): number;
  pick<T>(items: readonly T[]): T;
}

/** mulberry32 */
export function createRng(seed: number | string): Rng {
  let a = typeof seed === "string" ? hashString(seed) : seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
  return {
    next,
    normal() {
      const u = Math.max(next(), 1e-12);
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    pick(items) {
      if (items.length === 0) throw new Error("pick from an empty list");
      return items[Math.floor(next() * items.length)]!;
    },
  };
}
