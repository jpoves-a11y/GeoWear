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
