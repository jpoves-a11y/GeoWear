// ============================================================
// GeoWear — SphereFitter
// Least-squares sphere fitting using algebraic method
// ============================================================

import { Matrix, solve } from 'ml-matrix';
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
  // Accumulate normal equations A^T A (4×4) and A^T B (4×1) directly.
  // Row of A: [x, y, z, 1], B[i] = x²+y²+z².
  // This avoids allocating a Matrix(n,4) which is extremely expensive for large n.
  const n = vertexCount;

  // AᵀA symmetric 4×4 stored row-major (16 elements, but only 10 unique)
  let s_xx = 0, s_xy = 0, s_xz = 0, s_x = 0;
  let s_yy = 0, s_yz = 0, s_y = 0;
  let s_zz = 0, s_z = 0;
  let s_1 = 0;
  // AᵀB 4×1
  let sb_x = 0, sb_y = 0, sb_z = 0, sb_1 = 0;

  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const b = x * x + y * y + z * z;
    s_xx += x * x; s_xy += x * y; s_xz += x * z; s_x += x;
    s_yy += y * y; s_yz += y * z; s_y += y;
    s_zz += z * z; s_z += z;
    s_1 += 1;
    sb_x += x * b; sb_y += y * b; sb_z += z * b; sb_1 += b;
  }

  // Build 4×4 symmetric AtA and 4×1 AtB as ml-matrix objects (tiny)
  const AtA = new Matrix([
    [s_xx, s_xy, s_xz, s_x],
    [s_xy, s_yy, s_yz, s_y],
    [s_xz, s_yz, s_zz, s_z],
    [s_x,  s_y,  s_z,  s_1],
  ]);
  const AtB = new Matrix([[sb_x], [sb_y], [sb_z], [sb_1]]);

  let solution: Matrix;
  try {
    solution = solve(AtA, AtB);
  } catch {
    // Fallback: Cramer / manual pseudo-inverse on 4×4 — use perturbed solve
    try {
      const reg = AtA.clone();
      for (let k = 0; k < 4; k++) reg.set(k, k, reg.get(k, k) + 1e-8);
      solution = solve(reg, AtB);
    } catch {
      // Degenerate case: return centroid with radius 0
      return {
        center: new THREE.Vector3(0, 0, 0),
        radius: 0,
        rmsError: Infinity,
        maxError: Infinity,
        residuals: new Float32Array(n),
      };
    }
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

    // Weighted least squares: accumulate normal equations directly (no Matrix(n,4))
    const n = vertexCount;
    let ws_xx = 0, ws_xy = 0, ws_xz = 0, ws_x = 0;
    let ws_yy = 0, ws_yz = 0, ws_y = 0;
    let ws_zz = 0, ws_z = 0;
    let ws_1 = 0;
    let wsb_x = 0, wsb_y = 0, wsb_z = 0, wsb_1 = 0;

    for (let i = 0; i < n; i++) {
      const wi = weights[i]; // already the squared Tukey weight
      if (wi < 1e-12) continue;
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      const b = x * x + y * y + z * z;
      ws_xx += wi * x * x; ws_xy += wi * x * y; ws_xz += wi * x * z; ws_x += wi * x;
      ws_yy += wi * y * y; ws_yz += wi * y * z; ws_y += wi * y;
      ws_zz += wi * z * z; ws_z += wi * z;
      ws_1 += wi;
      wsb_x += wi * x * b; wsb_y += wi * y * b; wsb_z += wi * z * b; wsb_1 += wi * b;
    }

    const AtA = new Matrix([
      [ws_xx, ws_xy, ws_xz, ws_x],
      [ws_xy, ws_yy, ws_yz, ws_y],
      [ws_xz, ws_yz, ws_zz, ws_z],
      [ws_x,  ws_y,  ws_z,  ws_1],
    ]);
    const AtB = new Matrix([[wsb_x], [wsb_y], [wsb_z], [wsb_1]]);

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

/**
 * Robust version of fitSphereFixedRadius using iterative reweighted least-squares (IRLS).
 * Downweights outlier vertices using Tukey bisquare weights, so that spatially
 * scattered noise points don't drag the center away from the true worn zone.
 */
export function fitSphereFixedRadiusRobust(
  positions: Float32Array,
  vertexCount: number,
  fixedRadius: number,
  irlsIterations: number = 5,
  centerIterations: number = 30
): { center: THREE.Vector3; radius: number; rmsError: number } {
  const n = vertexCount;
  if (n === 0) {
    return { center: new THREE.Vector3(), radius: fixedRadius, rmsError: 0 };
  }

  // Initial fit (unweighted) to get a starting center
  let { center } = fitSphereFixedRadius(positions, n, fixedRadius, centerIterations);
  let cx = center.x, cy = center.y, cz = center.z;

  for (let irlsIter = 0; irlsIter < irlsIterations; irlsIter++) {
    // Compute residuals and sigma
    const residuals = new Float64Array(n);
    let sumSq = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const dx = positions[i * 3] - cx;
      const dy = positions[i * 3 + 1] - cy;
      const dz = positions[i * 3 + 2] - cz;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      residuals[i] = r - fixedRadius;
      sumSq += residuals[i] * residuals[i];
      count++;
    }
    const sigma = Math.max(Math.sqrt(sumSq / Math.max(1, count)), 1e-6);

    // Compute Tukey bisquare weights
    const weights = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const absR = Math.abs(residuals[i]);
      if (absR < 3 * sigma) {
        const u = absR / (3 * sigma);
        const w = (1 - u * u);
        weights[i] = w * w;
      } else {
        weights[i] = 0;
      }
    }

    // Weighted center-only optimization
    for (let iter = 0; iter < centerIterations; iter++) {
      let nx = 0, ny = 0, nz = 0, wSum = 0;
      for (let i = 0; i < n; i++) {
        if (weights[i] < 1e-8) continue;
        const px = positions[i * 3];
        const py = positions[i * 3 + 1];
        const pz = positions[i * 3 + 2];
        const dx = px - cx, dy = py - cy, dz = pz - cz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < 1e-12) continue;
        const s = fixedRadius / dist;
        const w = weights[i];
        nx += w * (px - dx * s);
        ny += w * (py - dy * s);
        nz += w * (pz - dz * s);
        wSum += w;
      }
      if (wSum > 1e-12) {
        cx = nx / wSum;
        cy = ny / wSum;
        cz = nz / wSum;
      }
    }
  }

  // Enforce inscribed constraint
  for (let attempt = 0; attempt < 100; attempt++) {
    let dispX = 0, dispY = 0, dispZ = 0;
    let violationCount = 0;

    for (let i = 0; i < n; i++) {
      const dx = positions[i * 3] - cx;
      const dy = positions[i * 3 + 1] - cy;
      const dz = positions[i * 3 + 2] - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < fixedRadius) {
        const deficit = fixedRadius - d;
        const invD = 1 / Math.max(d, 1e-12);
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
