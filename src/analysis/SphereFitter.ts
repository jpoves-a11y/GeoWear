// ============================================================
// GeoWear — SphereFitter
// Least-squares sphere fitting using algebraic method
// ============================================================

import { Matrix, solve, pseudoInverse } from 'ml-matrix';
import type { SphereFitResult } from '../types';
import * as THREE from 'three';

/**
 * Fit a sphere to a set of 3D points using the algebraic (linearized) method.
 *
 * The equation (x - x0)² + (y - y0)² + (z - z0)² = r² is rewritten as:
 *   x² + y² + z² = 2*x0*x + 2*y0*y + 2*z0*z + (r² - x0² - y0² - z0²)
 *
 * Let a = 2*x0, b = 2*y0, c = 2*z0, d = r² - x0² - y0² - z0²
 * Then: x² + y² + z² = a*x + b*y + c*z + d
 *
 * This is a linear system A * [a,b,c,d]^T = B
 * Where A[i] = [xi, yi, zi, 1] and B[i] = xi² + yi² + zi²
 */
export function fitSphere(positions: Float32Array, vertexCount: number): SphereFitResult {
  // Build the linear system
  const n = vertexCount;
  const A = new Matrix(n, 4);
  const B = new Matrix(n, 1);

  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    A.set(i, 0, x);
    A.set(i, 1, y);
    A.set(i, 2, z);
    A.set(i, 3, 1);
    B.set(i, 0, x * x + y * y + z * z);
  }

  // Solve the normal equations: (A^T A) x = A^T B
  const At = A.transpose();
  const AtA = At.mmul(A);
  const AtB = At.mmul(B);

  let solution: Matrix;
  try {
    solution = solve(AtA, AtB);
  } catch {
    // Fallback: use pseudo-inverse
    const pseudoInv = pseudoInverse(A);
    solution = pseudoInv.mmul(B);
  }

  const a = solution.get(0, 0);
  const b = solution.get(1, 0);
  const c = solution.get(2, 0);
  const d = solution.get(3, 0);

  const x0 = a / 2;
  const y0 = b / 2;
  const z0 = c / 2;
  const radius = Math.sqrt(d + x0 * x0 + y0 * y0 + z0 * z0);

  // Compute residuals
  const residuals = new Float32Array(n);
  let sumSq = 0;
  let maxErr = 0;

  for (let i = 0; i < n; i++) {
    const dx = positions[i * 3] - x0;
    const dy = positions[i * 3 + 1] - y0;
    const dz = positions[i * 3 + 2] - z0;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const residual = r - radius;
    residuals[i] = residual;
    sumSq += residual * residual;
    if (Math.abs(residual) > maxErr) maxErr = Math.abs(residual);
  }

  const rmsError = Math.sqrt(sumSq / n);

  return {
    center: new THREE.Vector3(x0, y0, z0),
    radius,
    rmsError,
    maxError: maxErr,
    residuals,
  };
}

/**
 * Robust sphere fit using iterative reweighted least squares (IRLS).
 * Downweights outliers (anomalous regions) to get a better estimate
 * of the nominal sphere shape.
 */
export function fitSphereRobust(
  positions: Float32Array,
  vertexCount: number,
  iterations: number = 5,
  outlierThreshold: number = 0.05 // mm
): SphereFitResult {
  // Initial fit
  let result = fitSphere(positions, vertexCount);

  for (let iter = 0; iter < iterations; iter++) {
    // Compute weights: downweight vertices with large residuals
    const weights = new Float64Array(vertexCount);
    const sigma = Math.max(result.rmsError, 1e-6);

    for (let i = 0; i < vertexCount; i++) {
      const absResidual = Math.abs(result.residuals[i]);
      // Tukey bisquare weight function
      if (absResidual < 3 * sigma) {
        const u = absResidual / (3 * sigma);
        const w = (1 - u * u);
        weights[i] = w * w;
      } else {
        weights[i] = 0;
      }
    }

    // Weighted least squares
    const n = vertexCount;
    const A = new Matrix(n, 4);
    const B = new Matrix(n, 1);

    for (let i = 0; i < n; i++) {
      const w = Math.sqrt(weights[i]);
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      A.set(i, 0, x * w);
      A.set(i, 1, y * w);
      A.set(i, 2, z * w);
      A.set(i, 3, w);
      B.set(i, 0, (x * x + y * y + z * z) * w);
    }

    const At = A.transpose();
    const AtA = At.mmul(A);
    const AtB = At.mmul(B);

    let solution: Matrix;
    try {
      solution = solve(AtA, AtB);
    } catch {
      break; // Keep previous result
    }

    const a = solution.get(0, 0);
    const b = solution.get(1, 0);
    const c = solution.get(2, 0);
    const d = solution.get(3, 0);

    const x0 = a / 2;
    const y0 = b / 2;
    const z0 = c / 2;
    const radius = Math.sqrt(Math.max(0, d + x0 * x0 + y0 * y0 + z0 * z0));

    // Recompute residuals
    const residuals = new Float32Array(n);
    let sumSq = 0;
    let maxErr = 0;
    let weightedCount = 0;

    for (let i = 0; i < n; i++) {
      const dx = positions[i * 3] - x0;
      const dy = positions[i * 3 + 1] - y0;
      const dz = positions[i * 3 + 2] - z0;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const residual = r - radius;
      residuals[i] = residual;
      if (weights[i] > 0.01) {
        sumSq += residual * residual;
        weightedCount++;
      }
      if (Math.abs(residual) > maxErr) maxErr = Math.abs(residual);
    }

    const rmsError = Math.sqrt(sumSq / Math.max(1, weightedCount));

    result = {
      center: new THREE.Vector3(x0, y0, z0),
      radius,
      rmsError,
      maxError: maxErr,
      residuals,
    };
  }

  return result;
}

/**
 * Fit a sphere with a FIXED radius to a set of 3D points.
 * Only the center is optimized (radius is constrained).
 * Uses iterative projection: c_new = mean of (p_i - R * (p_i - c) / ||p_i - c||)
 * which is equivalent to minimising sum of (||p_i - c|| - R)^2 w.r.t. c.
 */
export function fitSphereFixedRadius(
  positions: Float32Array,
  vertexCount: number,
  fixedRadius: number,
  iterations: number = 30
): { center: THREE.Vector3; radius: number; rmsError: number } {
  const n = vertexCount;
  if (n === 0) {
    return { center: new THREE.Vector3(), radius: fixedRadius, rmsError: 0 };
  }

  // Initial center = centroid of points
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    cx += positions[i * 3];
    cy += positions[i * 3 + 1];
    cz += positions[i * 3 + 2];
  }
  cx /= n; cy /= n; cz /= n;

  for (let iter = 0; iter < iterations; iter++) {
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < n; i++) {
      const px = positions[i * 3];
      const py = positions[i * 3 + 1];
      const pz = positions[i * 3 + 2];
      const dx = px - cx, dy = py - cy, dz = pz - cz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 1e-12) continue;
      // Projected center contribution: p_i - R * (p_i - c)/||p_i - c||
      const s = fixedRadius / dist;
      nx += px - dx * s;
      ny += py - dy * s;
      nz += pz - dz * s;
    }
    cx = nx / n;
    cy = ny / n;
    cz = nz / n;
  }

  // Enforce inscribed constraint: sphere must never protrude beyond
  // the concave inner face. All vertices must satisfy dist(v, center) >= R.
  for (let attempt = 0; attempt < 100; attempt++) {
    let dispX = 0, dispY = 0, dispZ = 0;
    let violationCount = 0;

    for (let i = 0; i < n; i++) {
      const dx = positions[i * 3] - cx;
      const dy = positions[i * 3 + 1] - cy;
      const dz = positions[i * 3 + 2] - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < fixedRadius) {
        // Vertex is inside the sphere → sphere protrudes beyond inner face
        const deficit = fixedRadius - d;
        const invD = 1 / Math.max(d, 1e-12);
        // Push center away from this vertex
        dispX -= (dx * invD) * deficit;
        dispY -= (dy * invD) * deficit;
        dispZ -= (dz * invD) * deficit;
        violationCount++;
      }
    }

    if (violationCount === 0) break;

    cx += dispX / violationCount;
    cy += dispY / violationCount;
    cz += dispZ / violationCount;
  }

  // Compute RMS error
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const dx = positions[i * 3] - cx;
    const dy = positions[i * 3 + 1] - cy;
    const dz = positions[i * 3 + 2] - cz;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const residual = r - fixedRadius;
    sumSq += residual * residual;
  }

  return {
    center: new THREE.Vector3(cx, cy, cz),
    radius: fixedRadius,
    rmsError: Math.sqrt(sumSq / n),
  };
}
