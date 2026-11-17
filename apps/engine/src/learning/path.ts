/**
 * A coin's recorded prices, packed into one flat number array:
 * [t0, price0, liq0, t1, price1, liq1, …], t in ms since the verdict and a
 * liquidity of -1 meaning "not known". One array of doubles instead of one
 * small array per sample keeps two weeks of recordings in a few hundred MB.
 */
export type PackedPath = number[];

const STRIDE = 3;

export const sampleCount = (p: PackedPath): number => Math.floor(p.length / STRIDE);
export const tAt = (p: PackedPath, i: number): number => p[i * STRIDE]!;
export const priceAt = (p: PackedPath, i: number): number => p[i * STRIDE + 1]!;
export function liqAt(p: PackedPath, i: number): number | null {
  const l = p[i * STRIDE + 2]!;
  return l >= 0 ? l : null;
}

/** Appends one sample, rounded to what is worth storing. */
export function pushSample(p: PackedPath, t: number, price: number, liquidity: number | null): void {
  p.push(Math.round(t), Number(price.toPrecision(8)), liquidity === null || !(liquidity >= 0) ? -1 : Math.round(liquidity));
}

export function packSamples(samples: ReadonlyArray<readonly [number, number, number | null]>): PackedPath {
  const p: PackedPath = [];
  for (const [t, price, liq] of samples) pushSample(p, t, price, liq);
  return p;
}
