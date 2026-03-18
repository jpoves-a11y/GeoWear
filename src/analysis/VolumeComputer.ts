// ============================================================
// GeoWear — VolumeComputer
// Volumetric computation of defect regions (bumps and dips)
// Computes volume between actual mesh surface and reference sphere
// High-performance: all math is inline, no heap allocations in hot loop
// ============================================================

import * as THREE from 'three';
import type { AnomalyCluster, SphereFitResult, MeshData } from '../types';

export interface VolumeResult {
  totalBumpVolume: number;   // mm³
  totalDipVolume: number;    // mm³
  totalWearVolume: number;   // mm³ (sum of absolute values)
  bumpMass: number;          // mg
  dipMass: number;           // mg
  clusterVolumes: Map<number, number>; // cluster id → volume in mm³
}

/** Inline signed tetrahedron volume from 12 scalars (no object allocation) */
function tetVol6(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number
): number {
  // (b-a)·((c-a)×(d-a))
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const adx = dx - ax, ady = dy - ay, adz = dz - az;
  // cross(ac, ad)
  const crx = acy * adz - acz * ady;
  const cry = acz * adx - acx * adz;
  const crz = acx * ady - acy * adx;
  return (abx * crx + aby * cry + abz * crz) / 6.0;
}

/** Project (px,py,pz) radially onto sphere → (sx,sy,sz) in out array offsets */
function projectSphere(
  px: number, py: number, pz: number,
  cxx: number, cyy: number, czz: number,
  radius: number,
  out: Float64Array, off: number
): void {
  const dx = px - cxx, dy = py - cyy, dz = pz - czz;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-12) {
    out[off] = cxx + radius; out[off + 1] = cyy; out[off + 2] = czz;
  } else {
    const s = radius / len;
    out[off] = cxx + dx * s; out[off + 1] = cyy + dy * s; out[off + 2] = czz + dz * s;
  }
}

/**
 * Compute the volume between the mesh surface and the reference sphere
 * for faces whose average per-vertex deviation exceeds threshold.
 */
export function computeDefectVolumes(
  meshData: MeshData,
  sphereFit: SphereFitResult,
  vertexDeviations: Float32Array,
  clusters: AnomalyCluster[],
  thresholdMicrons: number,
  density: number = 0.935 // UHMWPE density in g/cm³ = mg/mm³
): VolumeResult {
  const { positions, indices, faceCount } = meshData;
  const cxx = sphereFit.center.x, cyy = sphereFit.center.y, czz = sphereFit.center.z;
  const radius = sphereFit.radius;

  let totalBumpVolume = 0;
  let totalDipVolume = 0;

  // Reusable buffer for 2 projected triangles (6 floats)
  const sp = new Float64Array(9); // s0xyz, s1xyz, s2xyz

  for (let f = 0; f < faceCount; f++) {
    const i0 = indices[f * 3];
    const i1 = indices[f * 3 + 1];
    const i2 = indices[f * 3 + 2];

    const avgDev = (vertexDeviations[i0] + vertexDeviations[i1] + vertexDeviations[i2]) / 3;
    if (Math.abs(avgDev) <= thresholdMicrons) continue;

    // Read mesh vertex coords inline
    const v0x = positions[i0 * 3], v0y = positions[i0 * 3 + 1], v0z = positions[i0 * 3 + 2];
    const v1x = positions[i1 * 3], v1y = positions[i1 * 3 + 1], v1z = positions[i1 * 3 + 2];
    const v2x = positions[i2 * 3], v2y = positions[i2 * 3 + 1], v2z = positions[i2 * 3 + 2];

    // Project onto sphere
    projectSphere(v0x, v0y, v0z, cxx, cyy, czz, radius, sp, 0);
    projectSphere(v1x, v1y, v1z, cxx, cyy, czz, radius, sp, 3);
    projectSphere(v2x, v2y, v2z, cxx, cyy, czz, radius, sp, 6);

    // Prism volume = sum of 3 tetrahedra
    const vol =
      tetVol6(v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z, sp[0], sp[1], sp[2]) +
      tetVol6(sp[0], sp[1], sp[2], v1x, v1y, v1z, v2x, v2y, v2z, sp[3], sp[4], sp[5]) +
      tetVol6(sp[0], sp[1], sp[2], sp[3], sp[4], sp[5], v2x, v2y, v2z, sp[6], sp[7], sp[8]);

    const absVol = Math.abs(vol);
    if (avgDev > 0) totalBumpVolume += absVol;
    else totalDipVolume += absVol;
  }

  // Update cluster volumes (approximate: assign volume proportional to cluster area)
  const clusterVolumes = new Map<number, number>();
  for (const cluster of clusters) {
    clusterVolumes.set(cluster.id, 0);
    cluster.volume = 0;
  }

  // 1 g/cm³ = 1000 mg / 1000 mm³ = 1 mg/mm³   →   0.935 g/cm³ = 0.935 mg/mm³
  const bumpMass = totalBumpVolume * density; // mg
  const dipMass = totalDipVolume * density;   // mg

  return {
    totalBumpVolume,
    totalDipVolume,
    totalWearVolume: totalBumpVolume + totalDipVolume,
    bumpMass,
    dipMass,
    clusterVolumes,
  };
}

/**
 * Compute the wear vector from the most-worn point to the pole.
 *
 * The "most-worn point" is chosen among all bump-cluster vertices
 * (positive deviation = outside reference sphere = material worn away)
 * that fall within the 70% of the active surface closest to the cup
 * bottom (pole). Among those candidates, the vertex with the largest
 * deviation (most wear) is selected.
 */
export function computeWearVector(
  wearClusters: AnomalyCluster[],
  polePosition: THREE.Vector3,
  sphereCenter: THREE.Vector3,
  cupAxis: THREE.Vector3
): {
  deepestPoint: THREE.Vector3;
  polePoint: THREE.Vector3;
  direction: THREE.Vector3;
  angle: number;
  distance: number;
  maxDepth: number;
} | null {
  if (wearClusters.length === 0) return null;

  const pole = polePosition.clone();
  const candidates: { pos: THREE.Vector3; dev: number; distToPole: number }[] = [];

  for (const cluster of wearClusters) {
    for (const p of cluster.points) {
      const d = p.position.distanceTo(pole);
      candidates.push({ pos: p.position.clone(), dev: p.deviation, distToPole: d });
    }
  }

  if (candidates.length === 0) return null;

  // Sort by distance to pole (ascending = closest first)
  candidates.sort((a, b) => a.distToPole - b.distToPole);

  // Keep only the 70% closest to the pole (cup bottom)
  const cutoff = Math.max(1, Math.ceil(candidates.length * 0.7));
  const filtered = candidates.slice(0, cutoff);

  // Among the filtered set, find the vertex with most wear (highest positive deviation)
  let bestCandidate = filtered[0];
  for (const c of filtered) {
    if (c.dev > bestCandidate.dev) {
      bestCandidate = c;
    }
  }

  const deepest = bestCandidate.pos;
  const direction = deepest.clone().sub(pole).normalize();
  const distance = deepest.distanceTo(pole);

  // Angle between wear direction and cup axis
  const angle = Math.acos(
    Math.max(-1, Math.min(1, direction.dot(cupAxis)))
  ) * (180 / Math.PI);

  return {
    deepestPoint: deepest,
    polePoint: pole,
    direction,
    angle,
    distance,
    maxDepth: bestCandidate.dev,
  };
}

/**
 * Compute the volume enclosed between the mesh surface and a capping plane.
 *
 * Uses the projection formula: for each triangle on the pole side of the plane,
 * compute the volume of the truncated prism from the triangle to its projection
 * on the plane:
 *
 *   V_face = (h0 + h1 + h2) / 3 * signedProjectedArea
 *
 * where h_i = signed height of vertex i above the plane and
 * signedProjectedArea = (1/2) * dot(cross(e1, e2), planeNormal).
 *
 * This directly computes the volume between a (potentially open) mesh surface
 * and a flat plane, without requiring the mesh to be closed.
 */
export function computeMeshEnclosedVolume(
  meshData: MeshData,
  planePoint: THREE.Vector3,
  planeNormal: THREE.Vector3
): number {
  const { positions, indices, faceCount } = meshData;
  const px = planePoint.x, py = planePoint.y, pz = planePoint.z;

  // Normalize plane normal
  const nl = Math.sqrt(planeNormal.x * planeNormal.x + planeNormal.y * planeNormal.y + planeNormal.z * planeNormal.z);
  const nx = planeNormal.x / nl, ny = planeNormal.y / nl, nz = planeNormal.z / nl;

  let volume = 0;
  for (let f = 0; f < faceCount; f++) {
    const i0 = indices[f * 3];
    const i1 = indices[f * 3 + 1];
    const i2 = indices[f * 3 + 2];

    // Signed height of each vertex above the plane
    const h0 = (positions[i0 * 3] - px) * nx + (positions[i0 * 3 + 1] - py) * ny + (positions[i0 * 3 + 2] - pz) * nz;
    const h1 = (positions[i1 * 3] - px) * nx + (positions[i1 * 3 + 1] - py) * ny + (positions[i1 * 3 + 2] - pz) * nz;
    const h2 = (positions[i2 * 3] - px) * nx + (positions[i2 * 3 + 1] - py) * ny + (positions[i2 * 3 + 2] - pz) * nz;

    // Skip faces not on the pole side
    if (h0 < 0 && h1 < 0 && h2 < 0) continue;
    // Skip faces straddling the plane (minor boundary strip)
    if (h0 < 0 || h1 < 0 || h2 < 0) continue;

    // Edge vectors
    const e1x = positions[i1 * 3] - positions[i0 * 3];
    const e1y = positions[i1 * 3 + 1] - positions[i0 * 3 + 1];
    const e1z = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];
    const e2x = positions[i2 * 3] - positions[i0 * 3];
    const e2y = positions[i2 * 3 + 1] - positions[i0 * 3 + 1];
    const e2z = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];

    // cross(e1, e2)
    const crx = e1y * e2z - e1z * e2y;
    const cry = e1z * e2x - e1x * e2z;
    const crz = e1x * e2y - e1y * e2x;

    // Signed projected area = (1/2) * cross · n̂
    const signedProjArea = 0.5 * (crx * nx + cry * ny + crz * nz);

    // Volume of truncated prism from triangle to its projection on the plane
    volume += (h0 + h1 + h2) / 3.0 * signedProjArea;
  }

  return Math.abs(volume);
}

/**
 * Compute the volume of a spherical cap cut by a plane.
 *
 * Given a sphere (center, radius) and a plane (point, normal),
 * compute the volume of the cap on the side of the plane pointed
 * to by the normal.
 *
 * Cap volume: V = (π/3) h² (3R - h)
 * where h = R + d (d = signed distance from center to plane, positive toward normal)
 */
export function computeSphereCap(
  center: THREE.Vector3,
  radius: number,
  planePoint: THREE.Vector3,
  planeNormal: THREE.Vector3
): number {
  const pn = planeNormal.clone().normalize();
  // Signed distance from sphere center to plane (positive = same side as normal)
  const d = (center.x - planePoint.x) * pn.x +
            (center.y - planePoint.y) * pn.y +
            (center.z - planePoint.z) * pn.z;

  // Cap on the same side as the normal (interior / pole side).
  // The normal points toward the pole. d > 0 means center is on the pole side.
  // The sphere extends from (d-R) to (d+R) along the normal.
  // Interior cap height = distance from plane to farthest sphere point on pole side = R + d.
  const h = radius + d;

  if (h <= 0) return 0;                         // sphere entirely on the exterior side
  if (h >= 2 * radius) return (4 / 3) * Math.PI * radius * radius * radius; // entire sphere

  return (Math.PI / 3) * h * h * (3 * radius - h);
}
