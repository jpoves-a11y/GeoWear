// ============================================================
// GeoWear — AnomalyRegistry
// Clustering and classification of anomaly regions
// ============================================================

import * as THREE from 'three';
import type { AnomalyPoint, AnomalyCluster, AnomalyType } from '../types';

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
 * DBSCAN clustering algorithm for anomaly points.
 */
function dbscan(
  points: AnomalyPoint[],
  eps: number,
  minPoints: number,
  type: AnomalyType
): AnomalyCluster[] {
  const n = points.length;
  if (n === 0) return [];

  const labels = new Int32Array(n).fill(-1); // -1 = unvisited
  const clusters: AnomalyCluster[] = [];
  let clusterId = 0;

  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1) continue;

    // Find neighbors
    const neighborIndices = regionQuery(points, i, eps);

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

      const jNeighbors = regionQuery(points, j, eps);
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
 * Find all points within eps distance of point at index.
 */
function regionQuery(points: AnomalyPoint[], index: number, eps: number): number[] {
  const result: number[] = [];
  const p = points[index].position;

  for (let i = 0; i < points.length; i++) {
    const d = p.distanceTo(points[i].position);
    if (d <= eps) {
      result.push(i);
    }
  }

  return result;
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
 * Find the primary wear zone (largest dip cluster by absolute deviation magnitude).
 */
export function findPrimaryWearZone(clusters: AnomalyCluster[]): AnomalyCluster | null {
  const dipClusters = clusters.filter(c => c.type === 'dip');
  if (dipClusters.length === 0) return null;

  // Sort by: largest absolute minDeviation (deepest dip)
  dipClusters.sort((a, b) => a.minDeviation - b.minDeviation);
  return dipClusters[0];
}
