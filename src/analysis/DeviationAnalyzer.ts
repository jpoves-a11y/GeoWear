// ============================================================
// GeoWear — DeviationAnalyzer
// Sphericity deviation analysis along geodesics
// ============================================================

import * as THREE from 'three';
import type { Geodesic, AnomalyPoint, AnomalyType, SphereFitResult } from '../types';

export interface DeviationResult {
  /** Per-vertex deviation from reference sphere (μm) */
  vertexDeviations: Float32Array;
  /** Anomaly points exceeding threshold */
  anomalyPoints: AnomalyPoint[];
  /** Statistics */
  maxBump: number;      // μm (positive)
  maxDip: number;       // μm (negative)
  meanDeviation: number;
  stdDeviation: number;
  /** Percentage of surface within tolerance */
  nominalPercent: number;
}

/**
 * Compute per-vertex deviations from the reference sphere.
 */
export function computeVertexDeviations(
  positions: Float32Array,
  vertexCount: number,
  sphereCenter: THREE.Vector3,
  sphereRadius: number
): Float32Array {
  const deviations = new Float32Array(vertexCount);

  for (let i = 0; i < vertexCount; i++) {
    const dx = positions[i * 3] - sphereCenter.x;
    const dy = positions[i * 3 + 1] - sphereCenter.y;
    const dz = positions[i * 3 + 2] - sphereCenter.z;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // Positive = wear (outside sphere, material worn away), Negative = dip (inside sphere)
    deviations[i] = (r - sphereRadius) * 1000; // mm to μm
  }

  return deviations;
}

/**
 * Analyze deviations and extract anomaly points.
 */
export function analyzeDeviations(
  positions: Float32Array,
  vertexCount: number,
  geodesics: Geodesic[],
  sphereFit: SphereFitResult,
  thresholdMicrons: number = 1.0
): DeviationResult {
  const deviations = computeVertexDeviations(
    positions, vertexCount, sphereFit.center, sphereFit.radius
  );

  // Statistics
  let maxBump = 0, maxDip = 0;
  let sumDev = 0, sumSqDev = 0;
  let nominalCount = 0;

  for (let i = 0; i < vertexCount; i++) {
    const d = deviations[i];
    sumDev += d;
    sumSqDev += d * d;
    if (d > maxBump) maxBump = d;
    if (d < maxDip) maxDip = d;
    if (Math.abs(d) <= thresholdMicrons) nominalCount++;
  }

  const meanDeviation = sumDev / vertexCount;
  const variance = sumSqDev / vertexCount - meanDeviation * meanDeviation;
  const stdDeviation = Math.sqrt(Math.max(0, variance));
  const nominalPercent = (nominalCount / vertexCount) * 100;

  // Extract anomaly points from geodesics
  const anomalyPoints: AnomalyPoint[] = [];
  // Spatial deduplication: geodesic points are mesh-plane intersections
  // (vertexIndex is always -1), so deduplicate by rounded position key
  const seenPositions = new Set<string>();

  for (const geodesic of geodesics) {
    for (const point of geodesic.points) {
      // Round to 4 decimal places (0.1 μm precision) for dedup key
      const key = `${point.position[0].toFixed(4)}_${point.position[1].toFixed(4)}_${point.position[2].toFixed(4)}`;
      if (seenPositions.has(key)) continue;

      const absDev = Math.abs(point.deviation);
      if (absDev > thresholdMicrons) {
        seenPositions.add(key);

        const type: AnomalyType = point.deviation > 0 ? 'bump' : 'dip';

        anomalyPoints.push({
          position: new THREE.Vector3(
            point.position[0],
            point.position[1],
            point.position[2]
          ),
          deviation: point.deviation,
          type,
          geodesicAngle: geodesic.angle,
          arcLength: point.arcLength,
          derivative: point.derivative,
          vertexIndex: point.vertexIndex,
        });
      }
    }
  }

  return {
    vertexDeviations: deviations,
    anomalyPoints,
    maxBump,
    maxDip,
    meanDeviation,
    stdDeviation,
    nominalPercent,
  };
}
