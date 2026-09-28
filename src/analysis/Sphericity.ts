// ============================================================
// GeoWear — Sphericity (form deviation) of the articulating surface
// ------------------------------------------------------------
// Sphericity is reported as the radial peak-to-valley deviation from the least-squares
// sphere (free radius, ISO "LS" reference) of the trimmed inner surface — i.e. how far the
// retrieved bearing surface is from a perfect sphere once wear, creep and form errors are
// included. It is a property of the surface, so it is the same whatever analysis mode is used.
//
// Scanner noise would dominate a raw max−min (a 15 µm noise gives ≈ ±60 µm extremes), so the
// deviations are first averaged over ≈ 1 mm × 1 mm cells of the sphere (the size of the
// smallest wear features of interest) and the peak-to-valley is taken between the 0.5th and
// 99.5th percentiles of the cell means, which also discards isolated scan artefacts. A band of
// `edgeBandMm` along every mesh border (the trim cut near the rim entrance/chamfer and the
// edges of scan holes) is left out, as in bearing metrology where the edges are excluded from
// the evaluated surface. The raw point-wise figures are reported alongside for transparency.
// ============================================================

import type { MeshData, SphericityResult } from '../types';
import { fitSphere } from './SphereFitter';

/** Solve a 4×4 linear system (Gaussian elimination with partial pivoting). */
function solve4(A: number[][], b: number[]): number[] | null {
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < 4; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 5; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = [0, 0, 0, 0];
  for (let r = 3; r >= 0; r--) {
    let s = M[r][4];
    for (let k = r + 1; k < 4; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Vertices farther than `band` (mm) from every border vertex of the mesh (trim cut, hole edges). */
function interiorPositions(mesh: MeshData, nAll: number, band: number): Float32Array {
  const { positions: P, indices: I, faceCount } = mesh;
  const V = mesh.vertexCount;
  const edgeCount = new Map<number, number>();
  const key = (a: number, b: number) => (a < b ? a * V + b : b * V + a); // < 2^53 for V < 9.4·10^7
  for (let f = 0; f < faceCount; f++) {
    for (let e = 0; e < 3; e++) {
      const k = key(I[f * 3 + e], I[f * 3 + ((e + 1) % 3)]);
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
    }
  }
  const border = new Set<number>();
  for (const [k, c] of edgeCount) {
    if (c !== 1) continue;
    border.add(Math.floor(k / V)); border.add(k % V);
  }
  if (border.size === 0 || band <= 0) return P.slice(0, nAll * 3);
  // uniform grid hash of the border vertices (cell = band)
  const grid = new Map<string, number[]>();
  const cell = (v: number) => Math.floor(v / band);
  for (const v of border) {
    const k = `${cell(P[v * 3])},${cell(P[v * 3 + 1])},${cell(P[v * 3 + 2])}`;
    const g = grid.get(k); if (g) g.push(v); else grid.set(k, [v]);
  }
  const out: number[] = [];
  const b2 = band * band;
  for (let i = 0; i < nAll; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const gx = cell(x), gy = cell(y), gz = cell(z);
    let near = false;
    for (let a = -1; a <= 1 && !near; a++) for (let b = -1; b <= 1 && !near; b++) for (let c = -1; c <= 1 && !near; c++) {
      const g = grid.get(`${gx + a},${gy + b},${gz + c}`);
      if (!g) continue;
      for (const v of g) {
        const dx = P[v * 3] - x, dy = P[v * 3 + 1] - y, dz = P[v * 3 + 2] - z;
        if (dx * dx + dy * dy + dz * dz < b2) { near = true; break; }
      }
    }
    if (!near) out.push(x, y, z);
  }
  return new Float32Array(out);
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * @param mesh       trimmed inner (bearing) surface — the same working mesh the wear models use
 * @param vertexLimit only the first `vertexLimit` vertices are used (excludes hole-fill centre vertices)
 * @param cellSizeMm  averaging cell size on the sphere (mm)
 */
export function computeSphericity(mesh: MeshData, vertexLimit?: number, cellSizeMm = 1, edgeBandMm = 1.5): SphericityResult | null {
  const nAll = Math.min(mesh.vertexCount, vertexLimit ?? mesh.vertexCount);
  if (nAll < 100) return null;
  const P = interiorPositions(mesh, nAll, edgeBandMm);
  const n = P.length / 3;
  if (n < 100) return null;

  // --- Least-squares sphere (geometric, free radius): algebraic start + Gauss–Newton
  const init = fitSphere(P, n);
  let cx = init.center.x, cy = init.center.y, cz = init.center.z, R = init.radius;
  for (let it = 0; it < 10; it++) {
    const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const g = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const dx = P[i * 3] - cx, dy = P[i * 3 + 1] - cy, dz = P[i * 3 + 2] - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-12;
      const r = d - R;
      const J = [-dx / d, -dy / d, -dz / d, -1];
      for (let a = 0; a < 4; a++) {
        g[a] += J[a] * r;
        for (let b = a; b < 4; b++) A[a][b] += J[a] * J[b];
      }
    }
    for (let a = 0; a < 4; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
    const step = solve4(A, g.map(v => -v));
    if (!step) break;
    cx += step[0]; cy += step[1]; cz += step[2]; R += step[3];
    if (Math.hypot(step[0], step[1], step[2], step[3]) < 1e-9) break;
  }

  // --- Radial deviations and a pole-centred frame (w points from the centre to the surface centroid)
  const dev = new Float64Array(n);
  let mx = 0, my = 0, mz = 0, sumSq = 0, dMin = Infinity, dMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = P[i * 3] - cx, dy = P[i * 3 + 1] - cy, dz = P[i * 3 + 2] - cz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    dev[i] = d - R;
    sumSq += dev[i] * dev[i];
    if (dev[i] < dMin) dMin = dev[i];
    if (dev[i] > dMax) dMax = dev[i];
    mx += dx / d; my += dy / d; mz += dz / d;
  }
  let wl = Math.hypot(mx, my, mz) || 1;
  const w = [mx / wl, my / wl, mz / wl];
  const ref = Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let e1 = [ref[1] * w[2] - ref[2] * w[1], ref[2] * w[0] - ref[0] * w[2], ref[0] * w[1] - ref[1] * w[0]];
  wl = Math.hypot(e1[0], e1[1], e1[2]); e1 = e1.map(v => v / wl);
  const e2 = [w[1] * e1[2] - w[2] * e1[1], w[2] * e1[0] - w[0] * e1[2], w[0] * e1[1] - w[1] * e1[0]];

  // --- Average the deviations over ≈ cellSize × cellSize patches (equal-area latitude rings)
  const dTh = cellSizeMm / R;
  const sums = new Map<number, { s: number; c: number }>();
  for (let i = 0; i < n; i++) {
    const dx = P[i * 3] - cx, dy = P[i * 3 + 1] - cy, dz = P[i * 3 + 2] - cz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-12;
    const uw = (dx * w[0] + dy * w[1] + dz * w[2]) / d;
    const th = Math.acos(Math.max(-1, Math.min(1, uw)));
    let ph = Math.atan2((dx * e2[0] + dy * e2[1] + dz * e2[2]), (dx * e1[0] + dy * e1[1] + dz * e1[2]));
    if (ph < 0) ph += 2 * Math.PI;
    const ring = Math.floor(th / dTh);
    const nPh = Math.max(1, Math.round(2 * Math.PI * R * Math.sin((ring + 0.5) * dTh) / cellSizeMm));
    const key = ring * 100000 + Math.min(nPh - 1, Math.floor(ph / (2 * Math.PI) * nPh));
    const e = sums.get(key);
    if (e) { e.s += dev[i]; e.c++; } else sums.set(key, { s: dev[i], c: 1 });
  }
  const means: number[] = [];
  for (const { s, c } of sums.values()) if (c >= 3) means.push(s / c);
  if (means.length < 20) return null;
  means.sort((a, b) => a - b);
  const cellRms = Math.sqrt(means.reduce((a, v) => a + v * v, 0) / means.length);

  return {
    sphericityUm: (percentile(means, 0.995) - percentile(means, 0.005)) * 1000,
    formRmsUm: cellRms * 1000,
    rawPeakToValleyUm: (dMax - dMin) * 1000,
    pointRmsUm: Math.sqrt(sumSq / n) * 1000,
    radiusMm: R,
    center: [cx, cy, cz],
    cellSizeMm,
    edgeBandMm,
    cellCount: means.length,
    pointCount: n,
  };
}
