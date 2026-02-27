// ============================================================
// GeoWear — VolumeComputer
// Volumetric computation of defect regions (bumps and dips)
// Computes volume between actual mesh surface and reference sphere
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

/**
 * Compute the volume between the mesh surface and the reference sphere
 * for anomaly regions (bumps and dips).
 *
 * For each triangle in the mesh, if its vertices are in an anomaly region:
 * 1. Project each vertex radially onto the reference sphere
 * 2. Form a prism between the mesh triangle and the projected triangle
 * 3. Sum signed volumes using tetrahedra decomposition
 */
export function computeDefectVolumes(
  meshData: MeshData,
  sphereFit: SphereFitResult,
  vertexDeviations: Float32Array,
  clusters: AnomalyCluster[],
  thresholdMicrons: number,
  density: number = 0.935 // UHMWPE density in g/cm³
): VolumeResult {
  const { positions, indices, faceCount } = meshData;
  const { center, radius } = sphereFit;

  // Build a set of anomalous vertex indices for quick lookup
  const anomalousVertices = new Set<number>();
  const vertexClusterMap = new Map<number, number>();

  for (const cluster of clusters) {
    for (const point of cluster.points) {
      anomalousVertices.add(point.vertexIndex);
      vertexClusterMap.set(point.vertexIndex, cluster.id);
    }
  }

  // For each face, check if any vertex is anomalous
  let totalBumpVolume = 0;
  let totalDipVolume = 0;
  const clusterVolumes = new Map<number, number>();

  for (const cluster of clusters) {
    clusterVolumes.set(cluster.id, 0);
  }

  for (let f = 0; f < faceCount; f++) {
    const i0 = indices[f * 3];
    const i1 = indices[f * 3 + 1];
    const i2 = indices[f * 3 + 2];

    // Check if the face has any vertex exceeding threshold
    const d0 = vertexDeviations[i0]; // μm
    const d1 = vertexDeviations[i1];
    const d2 = vertexDeviations[i2];

    const avgDev = (d0 + d1 + d2) / 3;
    if (Math.abs(avgDev) <= thresholdMicrons) continue;

    // Mesh triangle vertices
    const v0 = new THREE.Vector3(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
    const v1 = new THREE.Vector3(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
    const v2 = new THREE.Vector3(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);

    // Project vertices onto reference sphere
    const s0 = projectOntoSphere(v0, center, radius);
    const s1 = projectOntoSphere(v1, center, radius);
    const s2 = projectOntoSphere(v2, center, radius);

    // Volume of the prism between mesh triangle and sphere triangle
    // Decompose into 3 tetrahedra:
    // Tet 1: v0, v1, v2, s0
    // Tet 2: s0, v1, v2, s1
    // Tet 3: s0, s1, v2, s2
    // (This is a standard prism decomposition)
    const vol =
      signedTetraVolume(v0, v1, v2, s0) +
      signedTetraVolume(s0, v1, v2, s1) +
      signedTetraVolume(s0, s1, v2, s2);

    // Sign convention: positive = mesh is outside sphere (bump), negative = inside (dip)
    if (avgDev > 0) {
      totalBumpVolume += Math.abs(vol);
    } else {
      totalDipVolume += Math.abs(vol);
    }

    // Assign to cluster
    const clusterId = vertexClusterMap.get(i0) ??
                      vertexClusterMap.get(i1) ??
                      vertexClusterMap.get(i2);
    if (clusterId !== undefined) {
      const prev = clusterVolumes.get(clusterId) || 0;
      clusterVolumes.set(clusterId, prev + Math.abs(vol));
    }
  }

  // Update cluster volumes
  for (const cluster of clusters) {
    cluster.volume = clusterVolumes.get(cluster.id) || 0;
  }

  // Convert volumes to mass (mm³ to mg)
  // density is in g/cm³ = g/1000mm³ = 0.001 mg/mm³ * 1000 = mg/mm³ * density
  // Actually: 1 cm³ = 1000 mm³, so density g/cm³ = density/1000 g/mm³
  // mass_grams = volume_mm3 * density / 1000
  // mass_mg = volume_mm3 * density
  const bumpMass = totalBumpVolume * density; // mm³ * g/cm³ → need correction
  // 1 cm³ = 1000 mm³, so g/cm³ = g/(1000 mm³) = 0.001 g/mm³ = 1 mg/mm³ * density * 0.001
  // No: 1 g/cm³ = 0.001 g/mm³ = 1 mg/mm³ * 0.001... Let me be precise.
  // density = 0.935 g/cm³ = 0.935 g / 1000 mm³ = 0.000935 g/mm³ = 0.935 mg/mm³
  // So mass_mg = volume_mm³ * density_g_per_cm3
  // Since our volume is already in mm³ and density is in g/cm³:
  // mass_mg = volume_mm3 * density * 1.0 (because g/cm³ = mg/mm³ × 1e-3 × 1e3 = same)
  // Wait: 1 g/cm³ = 1 g / (10mm)³ = 1g/1000mm³ = 0.001g/mm³ = 1mg/mm³ * 0.001... 
  // No. 1g = 1000mg. 1 g/cm³ = 1000mg / 1000mm³ = 1 mg/mm³. 
  // So 0.935 g/cm³ = 0.935 mg/mm³.
  // mass_mg = volume_mm3 * 0.935

  const actualBumpMass = totalBumpVolume * density; // mg
  const actualDipMass = totalDipVolume * density;   // mg

  return {
    totalBumpVolume,
    totalDipVolume,
    totalWearVolume: totalBumpVolume + totalDipVolume,
    bumpMass: actualBumpMass,
    dipMass: actualDipMass,
    clusterVolumes,
  };
}

/**
 * Project a point onto a sphere surface.
 */
function projectOntoSphere(
  point: THREE.Vector3,
  center: THREE.Vector3,
  radius: number
): THREE.Vector3 {
  const dir = point.clone().sub(center);
  const len = dir.length();
  if (len < 1e-12) return center.clone().add(new THREE.Vector3(radius, 0, 0));
  return center.clone().add(dir.multiplyScalar(radius / len));
}

/**
 * Signed volume of a tetrahedron formed by 4 points.
 * V = (1/6) * |(b-a) · ((c-a) × (d-a))|
 */
function signedTetraVolume(
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3
): number {
  const ab = b.clone().sub(a);
  const ac = c.clone().sub(a);
  const ad = d.clone().sub(a);
  return ab.dot(ac.cross(ad)) / 6.0;
}

/**
 * Compute the wear vector from the deepest point to the pole.
 */
export function computeWearVector(
  primaryWearZone: AnomalyCluster | null,
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
  if (!primaryWearZone) return null;

  const deepest = primaryWearZone.maxDeviationPoint.clone();
  const pole = polePosition.clone();

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
    maxDepth: Math.abs(primaryWearZone.minDeviation),
  };
}
