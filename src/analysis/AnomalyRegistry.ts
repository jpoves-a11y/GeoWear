// ============================================================
// GeoWear — AnomalyRegistry
// Clustering and classification of anomaly regions
// ============================================================

import * as THREE from 'three';
import type { AnomalyPoint, AnomalyCluster, AnomalyType } from '../types';

// ----- Grid-based spatial index for fast neighbor queries -----

class SpatialGrid {
  private cellSize: number;
  private inv: number;
  private cells = new Map<string, number[]>();

  constructor(cellSize: number) {
    this.cellSize = cellSize;
    this.inv = 1 / cellSize;
  }

  private key(x: number, y: number, z: number): string {
    return `${(x * this.inv) | 0}_${(y * this.inv) | 0}_${(z * this.inv) | 0}`;
  }

  insert(index: number, pos: THREE.Vector3): void {
    const k = this.key(pos.x, pos.y, pos.z);
    const arr = this.cells.get(k);
    if (arr) arr.push(index);
    else this.cells.set(k, [index]);
  }

  /** Return indices of all points within eps of query point */
  queryBall(pos: THREE.Vector3, eps: number, points: AnomalyPoint[]): number[] {
    const eps2 = eps * eps;
    const result: number[] = [];
    const cx = (pos.x * this.inv) | 0;
    const cy = (pos.y * this.inv) | 0;
    const cz = (pos.z * this.inv) | 0;
    // Check 3×3×3 neighboring cells
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const k = `${cx + dx}_${cy + dy}_${cz + dz}`;
          const cell = this.cells.get(k);
          if (!cell) continue;
          for (const idx of cell) {
            const p = points[idx].position;
            const ddx = p.x - pos.x, ddy = p.y - pos.y, ddz = p.z - pos.z;
            if (ddx * ddx + ddy * ddy + ddz * ddz <= eps2) {
              result.push(idx);
            }
          }
        }
      }
    }
    return result;
  }
}

/**
 * Cluster anomaly points into contiguous regions using DBSCAN-like spatial clustering.
 *
 * @param points Array of anomaly points
 * @param eps Maximum distance between points in the same cluster (mm)
 * @param minPoints Minimum number of points to form a cluster
 */
export function clusterAnomalies(
  points: AnomalyPoint[],
  eps: number = 0.5,
  minPoints: number = 3
): AnomalyCluster[] {
  if (points.length === 0) return [];

  // Separate bumps and dips
  const bumps = points.filter(p => p.type === 'bump');
  const dips = points.filter(p => p.type === 'dip');

  const bumpClusters = dbscan(bumps, eps, minPoints, 'bump');
  const dipClusters = dbscan(dips, eps, minPoints, 'dip');

  // Assign IDs
  let id = 0;
  for (const c of bumpClusters) c.id = id++;
  for (const c of dipClusters) c.id = id++;

  return [...bumpClusters, ...dipClusters];
}

/**
 * DBSCAN clustering algorithm with grid-accelerated neighbor queries.
 */
function dbscan(
  points: AnomalyPoint[],
  eps: number,
  minPoints: number,
  type: AnomalyType
): AnomalyCluster[] {
  const n = points.length;
  if (n === 0) return [];

  // Build spatial index
  const grid = new SpatialGrid(eps);
  for (let i = 0; i < n; i++) grid.insert(i, points[i].position);

  const labels = new Int32Array(n).fill(-1); // -1 = unvisited
  const clusters: AnomalyCluster[] = [];
  let clusterId = 0;

  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1) continue;

    // Find neighbors via grid
    const neighborIndices = grid.queryBall(points[i].position, eps, points);

    if (neighborIndices.length < minPoints) {
      labels[i] = -2; // noise
      continue;
    }

    // Expand cluster
    const clusterPoints: AnomalyPoint[] = [];
    const seed = new Set(neighborIndices);
    labels[i] = clusterId;
    clusterPoints.push(points[i]);

    const seedArray = [...seed];
    while (seedArray.length > 0) {
      const j = seedArray.pop()!;
      if (labels[j] === -2) {
        labels[j] = clusterId;
        clusterPoints.push(points[j]);
      }
      if (labels[j] !== -1) continue;

      labels[j] = clusterId;
      clusterPoints.push(points[j]);

      const jNeighbors = grid.queryBall(points[j].position, eps, points);
      if (jNeighbors.length >= minPoints) {
        for (const k of jNeighbors) {
          if (labels[k] === -1 || labels[k] === -2) {
            if (!seed.has(k)) {
              seed.add(k);
              seedArray.push(k);
            }
          }
        }
      }
    }

    // Build cluster summary
    clusters.push(buildCluster(clusterId, type, clusterPoints));
    clusterId++;
  }

  // Add noise points as individual clusters if they exceed threshold significantly
  // (isolated but significant anomalies)
  for (let i = 0; i < n; i++) {
    if (labels[i] === -2 && Math.abs(points[i].deviation) > 5) {
      // Significant isolated point
      clusters.push(buildCluster(clusterId++, type, [points[i]]));
    }
  }

  return clusters;
}

/**
 * Build cluster summary from a set of anomaly points.
 */
function buildCluster(id: number, type: AnomalyType, points: AnomalyPoint[]): AnomalyCluster {
  // Centroid
  const centroid = new THREE.Vector3();
  for (const p of points) {
    centroid.add(p.position);
  }
  centroid.divideScalar(points.length);

  // Deviation statistics
  let maxAbs = 0;
  let maxDevPoint = points[0].position.clone();
  let minDev = Infinity, maxDev = -Infinity;
  let sumDev = 0;

  for (const p of points) {
    const absDev = Math.abs(p.deviation);
    if (absDev > maxAbs) {
      maxAbs = absDev;
      maxDevPoint = p.position.clone();
    }
    if (p.deviation < minDev) minDev = p.deviation;
    if (p.deviation > maxDev) maxDev = p.deviation;
    sumDev += p.deviation;
  }

  const avgDeviation = sumDev / points.length;

  // Estimate area: convex hull projected area or simply count * average triangle area
  // Rough estimate: number of points * average Voronoi cell area
  // For now, use a simple bounding sphere area estimate
  let maxRadius = 0;
  for (const p of points) {
    const d = p.position.distanceTo(centroid);
    if (d > maxRadius) maxRadius = d;
  }
  const area = Math.PI * maxRadius * maxRadius; // approximate circular area

  return {
    id,
    type,
    points,
    centroid,
    area,
    volume: 0, // computed by VolumeComputer
    avgDeviation,
    maxDeviation: maxDev,
    minDeviation: minDev,
    maxDeviationPoint: maxDevPoint,
  };
}

/**
 * Find the primary wear zone (largest bump cluster by max deviation magnitude).
 * Positive deviation = outside reference sphere = material worn away.
 */
export function findPrimaryWearZone(clusters: AnomalyCluster[]): AnomalyCluster | null {
  const bumpClusters = clusters.filter(c => c.type === 'bump');
  if (bumpClusters.length === 0) return null;

  // Sort by: largest maxDeviation (most wear)
  bumpClusters.sort((a, b) => b.maxDeviation - a.maxDeviation);
  return bumpClusters[0];
}
