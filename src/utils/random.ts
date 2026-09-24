// ============================================================
// GeoWear — Reproducible randomness and robust statistics
// ============================================================

/**
 * Mulberry32: small, fast 32-bit seeded PRNG (period 2^32).
 * Returns a function producing uniform floats in [0, 1).
 * Statistical quality is ample for bootstrap resampling and, unlike
 * Math.random(), the sequence is identical for the same seed on every
 * browser and platform.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic 32-bit seed derived from mesh geometry (FNV-1a over the raw
 * Float32 bits of the vertex positions). The same STL always yields the same
 * seed, so an analysis is reproducible without the user choosing a seed.
 * Never returns 0 (0 is reserved for "derive automatically").
 */
export function seedFromPositions(positions: Float32Array): number {
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  let h = 0x811c9dc5;
  for (let i = 0; i < bits.length; i++) {
    let w = bits[i];
    for (let b = 0; b < 4; b++) {
      h ^= w & 0xff;
      h = Math.imul(h, 0x01000193);
      w >>>= 8;
    }
  }
  h >>>= 0;
  return h === 0 ? 1 : h;
}

/** Median of a numeric array (does not modify the input). */
export function median(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) return 0;
  const a = Float64Array.from(values as ArrayLike<number>).sort();
  const m = n >> 1;
  return n % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

/**
 * Robust noise scale: σ ≈ 1.4826 · MAD (median absolute deviation).
 * Consistent with the standard deviation for Gaussian noise and insensitive
 * to up to 50 % of outliers (e.g. worn vertices mixed into the sample).
 */
export function robustSigma(values: ArrayLike<number>): { median: number; sigma: number } {
  const med = median(values);
  const dev = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) dev[i] = Math.abs(values[i] - med);
  return { median: med, sigma: 1.4826 * median(dev) };
}
