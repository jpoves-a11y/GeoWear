// Synthetic acetabular-liner phantoms with known wear, used by the regression tests (tests/phantom.test.ts).
// Synthetic acetabular liner with known ground truth.
// Inner cavity: sphere radius R centred at c0 (pole toward -z, rim opening at z=0 plane, facing +z).
// Wear: femoral head penetration by vector d (|d| = delta, tilted alpha deg from the cup axis).
// Worn inner surface along ray u from c0:  r(u) = max(R, t(u)),  t = u.d + sqrt(R^2 - |d|^2 + (u.d)^2)
// (= union of original sphere and sphere shifted by d).
import type { MeshData } from '../src/types';

export interface SynthOpts {
  R?: number; Rout?: number; delta?: number; alphaDeg?: number; noiseUm?: number;
  nTheta?: number; nPhi?: number; offset?: [number, number, number]; seed?: number; thetaMaxDeg?: number;
  dR?: number; lfUm?: number; // dR: actual cavity radius − nominal (machining/paint); lfUm: amplitude of smooth low-frequency deviation (uneven paint)
}

function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

export function wornRadius(ux: number, uy: number, uz: number, R: number, d: [number, number, number]) {
  const ud = ux * d[0] + uy * d[1] + uz * d[2];
  const dd = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
  const t = ud + Math.sqrt(Math.max(0, R * R - dd + ud * ud));
  return Math.max(R, t);
}

export function makeLiner(o: SynthOpts = {}): { mesh: MeshData; d: [number, number, number]; c0: [number, number, number]; nInner: number } {
  const R = (o.R ?? 14) + (o.dR ?? 0), Rout = o.Rout ?? 20, delta = o.delta ?? 0, a = (o.alphaDeg ?? 30) * Math.PI / 180;
  const nT = o.nTheta ?? 90, nP = o.nPhi ?? 360, off = o.offset ?? [0, 0, 0], thMax = (o.thetaMaxDeg ?? 90) * Math.PI / 180;
  const sigma = (o.noiseUm ?? 0) / 1000; const rand = rng(o.seed ?? 1);
  const gauss = () => { const u1 = Math.max(rand(), 1e-12), u2 = rand(); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); };
  const d: [number, number, number] = [delta * Math.sin(a), 0, -delta * Math.cos(a)];
  const lfA = (o.lfUm ?? 0) / 1000; const lfW: [number, number, number, number, number][] = [];
  for (let q = 0; q < 4; q++) { const z0 = 2 * rand() - 1, ph0 = 2 * Math.PI * rand(), s0 = Math.sqrt(1 - z0 * z0); lfW.push([s0 * Math.cos(ph0), s0 * Math.sin(ph0), z0, 3 + 4 * rand(), 2 * Math.PI * rand()]); }
  const lf = (u: [number, number, number]) => { if (!lfA) return 0; let v = 0; for (const [x, y, z, w, p] of lfW) v += Math.cos(w * (u[0] * x + u[1] * y + u[2] * z) + p); return lfA * v / 2; }; // toward pole (-z), tilted to +x
  const P: number[] = []; const F: number[] = [];
  const dir = (th: number, ph: number): [number, number, number] => [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), -Math.cos(th)];
  const addV = (x: number, y: number, z: number) => { P.push(x + off[0], y + off[1], z + off[2]); return P.length / 3 - 1; };
  // --- surfaces: latitude rings with ~isotropic spacing (vertex count ∝ sinθ), no slivers at the pole ---
  const dTh = thMax / nT;
  const surface = (radiusFn: (u: [number, number, number]) => number, noise: boolean) => {
    const pole = (() => { const u = dir(0, 0); const r = radiusFn(u) + (noise ? sigma * gauss() : 0); return addV(u[0] * r, u[1] * r, u[2] * r); })();
    const rings: number[][] = [];
    for (let i = 1; i <= nT; i++) {
      const th = dTh * i; const m = i === nT ? nP : Math.max(6, Math.round(2 * Math.PI * Math.sin(th) / dTh));
      const ring: number[] = []; const ph0 = (i % 2) * Math.PI / m;
      for (let j = 0; j < m; j++) { const u = dir(th, ph0 + 2 * Math.PI * j / m); const r = radiusFn(u) + (noise ? sigma * gauss() : 0); ring.push(addV(u[0] * r, u[1] * r, u[2] * r)); }
      rings.push(ring);
    }
    return { pole, rings };
  };
  const angleOf = (v: number) => { let a = Math.atan2(P[v * 3 + 1] - off[1], P[v * 3] - off[0]); if (a < 0) a += 2 * Math.PI; return a; };
  // Triangulate the strip between two closed rings by advancing along angle
  const strip = (A: number[], B: number[], want: 'in' | 'out' | 'up') => {
    const rot = (R: number[]) => { let k = 0; for (let i = 1; i < R.length; i++) if (angleOf(R[i]) < angleOf(R[k])) k = i; return [...R.slice(k), ...R.slice(0, k)]; };
    const a = rot(A), b = rot(B); const na = a.length, nb = b.length;
    const ang = (R: number[], i: number) => angleOf(R[i % R.length]) + (i >= R.length ? 2 * Math.PI : 0);
    let i = 0, j = 0;
    while (i < na || j < nb) {
      const advA = j >= nb || (i < na && ang(a, i + 1) <= ang(b, j + 1));
      if (advA) { tri(a[i % na], a[(i + 1) % na], b[j % nb], want); i++; }
      else { tri(a[i % na], b[(j + 1) % nb], b[j % nb], want); j++; }
    }
  };
  const I = surface(u => wornRadius(u[0], u[1], u[2], R, d) + lf(u), true);
  const nInner = P.length / 3;
  const O = surface(() => Rout, false);
  const tri = (a: number, b: number, c: number, want: 'in' | 'out' | 'up') => {
    const A = [P[a * 3] - off[0], P[a * 3 + 1] - off[1], P[a * 3 + 2] - off[2]], B = [P[b * 3] - off[0], P[b * 3 + 1] - off[1], P[b * 3 + 2] - off[2]], C = [P[c * 3] - off[0], P[c * 3 + 1] - off[1], P[c * 3 + 2] - off[2]];
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const g = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, (A[2] + B[2] + C[2]) / 3];
    const s = want === 'up' ? n[2] : (n[0] * g[0] + n[1] * g[1] + n[2] * g[2]) * (want === 'in' ? -1 : 1);
    if (s >= 0) F.push(a, b, c); else F.push(a, c, b);
  };
  for (const [S, w] of [[I, 'in'], [O, 'out']] as const) {
    const r0 = S.rings[0]; for (let j = 0; j < r0.length; j++) tri(S.pole, r0[j], r0[(j + 1) % r0.length], w);
    for (let i = 0; i + 1 < S.rings.length; i++) strip(S.rings[i], S.rings[i + 1], w);
  }
  strip(I.rings[nT - 1], O.rings[nT - 1], 'up');
  const positions = new Float32Array(P); const indices = new Uint32Array(F);
  // vertex normals (area weighted)
  const normals = new Float32Array(positions.length);
  for (let f = 0; f < indices.length; f += 3) {
    const [a, b, c] = [indices[f], indices[f + 1], indices[f + 2]];
    const e1 = [0, 1, 2].map(k => positions[b * 3 + k] - positions[a * 3 + k]), e2 = [0, 1, 2].map(k => positions[c * 3 + k] - positions[a * 3 + k]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) normals[v * 3 + k] += n[k];
  }
  for (let v = 0; v < normals.length / 3; v++) { const l = Math.hypot(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]) || 1; for (let k = 0; k < 3; k++) normals[v * 3 + k] /= l; }
  return { mesh: { positions, normals, indices, vertexCount: positions.length / 3, faceCount: indices.length / 3 }, d, c0: off, nInner };
}

/** Ground-truth wear volume above a plane (point p, unit normal n pointing to the pole side):
 *  volume of {c0 + s u : R < s < r(u)} ∩ {(x - p)·n > 0}, by quadrature over directions. */
export function trueWearVolumeAbovePlane(R: number, d: [number, number, number], c0: [number, number, number],
  p: { x: number; y: number; z: number }, n: { x: number; y: number; z: number }, nT = 1500, nP = 3000): number {
  const h0 = (p.x - c0[0]) * n.x + (p.y - c0[1]) * n.y + (p.z - c0[2]) * n.z; // plane offset from c0 along n
  let V = 0; const dT = Math.PI / nT, dP = 2 * Math.PI / nP;
  for (let i = 0; i < nT; i++) {
    const th = (i + 0.5) * dT; const st = Math.sin(th), ct = Math.cos(th);
    for (let j = 0; j < nP; j++) {
      const ph = (j + 0.5) * dP; const u = [st * Math.cos(ph), st * Math.sin(ph), -ct];
      const r = wornRadius(u[0], u[1], u[2], R, d); if (r <= R) continue;
      const un = u[0] * n.x + u[1] * n.y + u[2] * n.z;
      let lo = R, hi = r;
      if (un > 1e-12) lo = Math.max(lo, h0 / un); else if (un < -1e-12) hi = Math.min(hi, h0 / un); else if (h0 > 0) continue;
      if (hi > lo) V += (hi ** 3 - lo ** 3) / 3 * st * dT * dP;
    }
  }
  return V;
}
