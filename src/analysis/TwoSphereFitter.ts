// ============================================================
// GeoWear — Two-sphere union fit (automatic reference detection)
// ============================================================
//
// Wear model: a rigid femoral head of radius R (the commercial radius) penetrates the
// liner by a vector d. The worn inner surface is then the UNION of the original cavity
// sphere A (centre cA) and the displaced head sphere B (centre cB = cA + d): every vertex
// lies ON one of the two spheres and OUTSIDE the other, i.e.
//
//        min(|p − cA|, |p − cB|) = R   (± scanner noise)
//
// Both spheres satisfy "no vertex inside", so a single fixed-radius fit to all vertices
// lands on whichever part is larger (usually the worn one) and the wear is absorbed.
// Here both centres are fitted jointly with the SAME fixed radius:
//
//   1. σ (scanner noise) from 1-ring roughness along the radial direction — insensitive
//      to wear, which is smooth at the scale of one mesh edge.
//   2. Multi-start alternating fit on a subsample: assign each vertex to the sphere it is
//      closer to, re-fit each centre by fixed-R Gauss–Newton (leaving out a ±2σ band
//      around the A/B intersection crease), then refine on all vertices.
//   3. Model selection: the two-sphere model is accepted only if (a) it reduces the mean
//      squared residual of the single fixed-R sphere by more than 0.1·σ², (b) the centres
//      are separated by more than 2σ, and (c) it explains the data at least as well as a
//      single FREE-radius sphere (within 5 %) — a uniformly enlarged cavity (machining
//      tolerance, paint layer, creep) is otherwise mistaken for two offset spheres.
//   4. Identification: the head penetrates INTO the cup, so the original sphere is the
//      one whose centre is closer to the opening (smaller projection on the pole-ward
//      normal of the cut plane).
//
// Outputs: cA (reference for volume and heat map), cB, linear wear |cB − cA|, the angle
// of d to the cup axis, and the reference vertices (on A, clearly outside B).

import * as THREE from 'three';
import { gaussNewtonFixedRadius, fitSphere } from './SphereFitter';
import type { MeshData, TwoSphereResult } from '../types';

function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

export interface TwoSphereFitOptions {
  /** Half-width of the noise band, in σ, used to select reference vertices (default 2.5) */
  k?: number;
  /** Initial centre (e.g. the general sphere fit) */
  init?: [number, number, number];
  /** Minimum centre separation, in σ (default 2) */
  minSepSigma?: number;
  /** Minimum reduction of the mean squared residual, in σ² (default 0.1) */
  gain?: number;
  /** Maximum number of vertices used in the multi-start search (default 5000) */
  searchPoints?: number;
}

export interface TwoSphereFitOutput extends TwoSphereResult {
  /** Reference (non-worn) vertex positions, flat xyz */
  referencePositions: Float32Array;
}

/**
 * Fit the two-sphere union model to the vertices of `mesh` on the pole side of the cut plane.
 * @param R           fixed radius (commercial head radius, mm)
 * @param planePoint  point on the cut plane
 * @param planeNormal unit normal of the cut plane, pointing toward the pole (into the cup)
 */
export function fitTwoSphereUnion(
  mesh: MeshData,
  R: number,
  planePoint: THREE.Vector3,
  planeNormal: THREE.Vector3,
  opts: TwoSphereFitOptions = {},
): TwoSphereFitOutput {
  const k = opts.k ?? 2.5;
  const P = mesh.positions, N = mesh.vertexCount;
  const nrm = [planeNormal.x, planeNormal.y, planeNormal.z];

  // --- active vertices (pole side of the cut plane)
  const act: number[] = [];
  for (let i = 0; i < N; i++) {
    const h = (P[i * 3] - planePoint.x) * nrm[0] + (P[i * 3 + 1] - planePoint.y) * nrm[1] + (P[i * 3 + 2] - planePoint.z) * nrm[2];
    if (h >= 0) act.push(i);
  }
  const n = act.length;
  const A = new Float32Array(n * 3);
  for (let j = 0; j < n; j++) { const v = act[j]; A[j * 3] = P[v * 3]; A[j * 3 + 1] = P[v * 3 + 1]; A[j * 3 + 2] = P[v * 3 + 2]; }
  const dist = (c: number[], j: number) => Math.hypot(A[j * 3] - c[0], A[j * 3 + 1] - c[1], A[j * 3 + 2] - c[2]);

  // --- single fixed-R sphere (starting point and null model)
  let c0: number[];
  if (opts.init) c0 = [...opts.init];
  else {
    let x = 0, y = 0, z = 0;
    for (let j = 0; j < n; j++) { x += A[j * 3]; y += A[j * 3 + 1]; z += A[j * 3 + 2]; }
    c0 = [x / n - nrm[0] * R * 0.5, y / n - nrm[1] * R * 0.5, z / n - nrm[2] * R * 0.5];
  }
  c0 = gaussNewtonFixedRadius(A, n, R, c0[0], c0[1], c0[2], null, 100);

  // --- 1. scanner noise from 1-ring roughness (radial component)
  // 1-ring neighbourhoods, built only for the sampled vertices (≤ 20 000) to keep memory low
  const rStride = Math.max(1, Math.floor(n / 20000));
  const nb = new Map<number, Set<number>>();
  for (let j = 0; j < n; j += rStride) nb.set(act[j], new Set<number>());
  const I = mesh.indices;
  for (let f = 0; f < I.length; f += 3) {
    const a = I[f], b = I[f + 1], c = I[f + 2];
    const sa = nb.get(a), sb = nb.get(b), sc = nb.get(c);
    if (sa) sa.add(b).add(c);
    if (sb) sb.add(a).add(c);
    if (sc) sc.add(a).add(b);
  }
  const rough: number[] = [];
  for (let j = 0; j < n; j += rStride) {
    const v = act[j]; const s = nb.get(v)!; if (s.size < 4) continue;
    let mx = 0, my = 0, mz = 0;
    for (const u of s) { mx += P[u * 3]; my += P[u * 3 + 1]; mz += P[u * 3 + 2]; }
    mx /= s.size; my /= s.size; mz /= s.size;
    const dx = P[v * 3] - c0[0], dy = P[v * 3 + 1] - c0[1], dz = P[v * 3 + 2] - c0[2];
    const L = Math.hypot(dx, dy, dz) || 1;
    const e = ((P[v * 3] - mx) * dx + (P[v * 3 + 1] - my) * dy + (P[v * 3 + 2] - mz) * dz) / L;
    rough.push(Math.abs(e) / Math.sqrt(1 + 1 / s.size));
  }
  const sigma = Math.max(1.4826 * median(rough), 0.002);

  // --- 2. alternating union fit
  const unionFit = (idxs: Int32Array, cP0: number[], cQ0: number[], maxIt: number) => {
    const m = idxs.length; const B = new Float32Array(m * 3);
    for (let t = 0; t < m; t++) { const j = idxs[t]; B[t * 3] = A[j * 3]; B[t * 3 + 1] = A[j * 3 + 1]; B[t * 3 + 2] = A[j * 3 + 2]; }
    const u1 = new Float64Array(m), u2 = new Float64Array(m);
    let cP = cP0, cQ = cQ0, it = 0, cost = Infinity, n1 = 0, n2 = 0;
    for (; it < maxIt; it++) {
      n1 = 0; n2 = 0; cost = 0;
      const mg = it >= 5 ? 2 * sigma : 0; // exclude the ambiguous band around the crease
      for (let t = 0; t < m; t++) {
        const a = Math.hypot(B[t * 3] - cP[0], B[t * 3 + 1] - cP[1], B[t * 3 + 2] - cP[2]);
        const b = Math.hypot(B[t * 3] - cQ[0], B[t * 3 + 1] - cQ[1], B[t * 3 + 2] - cQ[2]);
        if (a <= b) { u1[t] = b - a >= mg ? 1 : 0; u2[t] = 0; n1++; cost += (a - R) ** 2; }
        else { u1[t] = 0; u2[t] = a - b >= mg ? 1 : 0; n2++; cost += (b - R) ** 2; }
      }
      if (n1 < 30 || n2 < 30) break;
      const p2 = gaussNewtonFixedRadius(B, m, R, cP[0], cP[1], cP[2], u1, 30);
      const q2 = gaussNewtonFixedRadius(B, m, R, cQ[0], cQ[1], cQ[2], u2, 30);
      const mv = Math.hypot(p2[0] - cP[0], p2[1] - cP[1], p2[2] - cP[2]) + Math.hypot(q2[0] - cQ[0], q2[1] - cQ[1], q2[2] - cQ[2]);
      cP = p2; cQ = q2;
      if (mv < 1e-7) break;
    }
    return { cP, cQ, cost: cost / m, it, n1, n2 };
  };

  const allIdx = Int32Array.from({ length: n }, (_, j) => j);
  const stride = Math.max(1, Math.floor(n / (opts.searchPoints ?? 5000)));
  const subIdx = Int32Array.from({ length: Math.ceil(n / stride) }, (_, t) => Math.min(n - 1, t * stride));
  let cost1 = 0;
  for (let j = 0; j < n; j++) cost1 += (dist(c0, j) - R) ** 2;
  cost1 /= n;

  const dirs: number[][] = [];
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
    if (!x && !y && !z) continue;
    const L = Math.hypot(x, y, z); dirs.push([x / L, y / L, z / L]);
  }
  let best: ReturnType<typeof unionFit> | null = null;
  for (const e of dirs) for (const mag of [0.05, 0.2, 0.6, 1.5, 3.0]) {
    const r = unionFit(subIdx, c0, [c0[0] + e[0] * mag, c0[1] + e[1] * mag, c0[2] + e[2] * mag], 40);
    if (r.n1 < 30 || r.n2 < 30) continue;
    if (!best || r.cost < best.cost) best = r;
  }
  let cP = c0, cQ = c0, iters = 0, cost2 = cost1, found = false;
  if (best) {
    const r = unionFit(allIdx, best.cP, best.cQ, 60);
    if (r.n1 >= 30 && r.n2 >= 30) { cP = r.cP; cQ = r.cQ; iters = r.it; cost2 = r.cost; found = cost2 < cost1; }
  }

  // --- 3. competing explanation: one sphere with free radius (uniform enlargement)
  const free = fitSphere(A, n);
  let costFree = 0;
  for (let j = 0; j < n; j++) {
    costFree += (Math.hypot(A[j * 3] - free.center.x, A[j * 3 + 1] - free.center.y, A[j * 3 + 2] - free.center.z) - free.radius) ** 2;
  }
  costFree /= n;

  // --- 4. identify the original sphere (closer to the opening)
  const proj = (c: number[]) => c[0] * nrm[0] + c[1] * nrm[1] + c[2] * nrm[2];
  let cA = cP, cB = cQ;
  if (proj(cQ) < proj(cP)) { cA = cQ; cB = cP; }
  const sep = Math.hypot(cB[0] - cA[0], cB[1] - cA[1], cB[2] - cA[2]);
  const detected = found
    && sep > (opts.minSepSigma ?? 2) * sigma
    && cost1 - cost2 > (opts.gain ?? 0.1) * sigma * sigma
    && cost2 <= 1.05 * costFree;
  if (!detected) { cA = c0; cB = c0; }

  // --- reference vertices: on A within the noise band and (if detected) clearly outside B
  const sel: number[] = []; let nA = 0;
  for (let j = 0; j < n; j++) {
    const a = dist(cA, j), b = dist(cB, j);
    if (a <= b) nA++;
    if (Math.abs(a - R) < k * sigma && (!detected || b - R > k * sigma)) sel.push(A[j * 3], A[j * 3 + 1], A[j * 3 + 2]);
  }

  const linearMm = detected ? sep : 0;
  let angleDeg: number | null = null;
  if (detected && sep > 0) {
    const cosang = ((cB[0] - cA[0]) * nrm[0] + (cB[1] - cA[1]) * nrm[1] + (cB[2] - cA[2]) * nrm[2]) / sep;
    angleDeg = Math.acos(Math.max(-1, Math.min(1, cosang))) * 180 / Math.PI;
  }
  const ref = new Float32Array(sel);
  return {
    detected,
    radius: R,
    originalCenter: new THREE.Vector3(cA[0], cA[1], cA[2]),
    displacedCenter: new THREE.Vector3(cB[0], cB[1], cB[2]),
    linearWearMm: linearMm,
    directionAngleDeg: angleDeg,
    nearPole: angleDeg !== null && angleDeg < 30,
    noiseSigmaUm: sigma * 1000,
    unwornFraction: detected ? nA / n : 1,
    referenceVertexCount: ref.length / 3,
    activeVertexCount: n,
    msOneSphereUm2: cost1 * 1e6,
    msTwoSpheresUm2: cost2 * 1e6,
    msFreeSphereUm2: costFree * 1e6,
    freeSphereRadius: free.radius,
    iterations: iters,
    referencePositions: ref,
  };
}
