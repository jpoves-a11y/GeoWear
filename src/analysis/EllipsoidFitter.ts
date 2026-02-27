// ============================================================
// GeoWear — EllipsoidFitter
// General ellipsoid fitting via SVD and eigenvalue decomposition
// ============================================================

import { Matrix, EigenvalueDecomposition, SVD, inverse, pseudoInverse } from 'ml-matrix';
import * as THREE from 'three';
import type { EllipsoidFitResult } from '../types';

/**
 * Fit a general ellipsoid to a set of 3D points.
 *
 * Ellipsoid equation in quadratic form:
 *   Ax² + By² + Cz² + 2Dxy + 2Exz + 2Fyz + 2Gx + 2Hy + 2Iz = 1
 *
 * This is solved as a least-squares problem: minimize ||M * p - 1||²
 * where p = [A, B, C, D, E, F, G, H, I]
 * and M[i] = [x², y², z², 2xy, 2xz, 2yz, 2x, 2y, 2z]
 */
export function fitEllipsoid(positions: Float32Array, vertexCount: number): EllipsoidFitResult {
  const n = vertexCount;

  // Build the design matrix
  const M = new Matrix(n, 9);
  const ones = new Matrix(n, 1);

  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];

    M.set(i, 0, x * x);
    M.set(i, 1, y * y);
    M.set(i, 2, z * z);
    M.set(i, 3, 2 * x * y);
    M.set(i, 4, 2 * x * z);
    M.set(i, 5, 2 * y * z);
    M.set(i, 6, 2 * x);
    M.set(i, 7, 2 * y);
    M.set(i, 8, 2 * z);
    ones.set(i, 0, 1);
  }

  // Solve via SVD pseudo-inverse
  const svd = new SVD(M);
  const svdSolution = svd.solve(ones);

  const A = svdSolution.get(0, 0);
  const B = svdSolution.get(1, 0);
  const C = svdSolution.get(2, 0);
  const D = svdSolution.get(3, 0);
  const E = svdSolution.get(4, 0);
  const F = svdSolution.get(5, 0);
  const G = svdSolution.get(6, 0);
  const H = svdSolution.get(7, 0);
  const I = svdSolution.get(8, 0);

  // Shape matrix (symmetric 3x3):
  // [A  D  E]
  // [D  B  F]
  // [E  F  C]
  const Q = new Matrix([
    [A, D, E],
    [D, B, F],
    [E, F, C],
  ]);

  // Translation vector
  const g = new Matrix([[G], [H], [I]]);

  // Center: c = -Q⁻¹ * g
  let Qinv: Matrix;
  try {
    Qinv = inverse(Q);
  } catch {
    // Singular matrix — fallback to pseudo-inverse
    Qinv = pseudoInverse(Q);
  }

  const center_mat = Qinv.mmul(g).mul(-1);
  const cx = center_mat.get(0, 0);
  const cy = center_mat.get(1, 0);
  const cz = center_mat.get(2, 0);

  // Scale factor: 1 + g^T * Q^-1 * g
  const gtQinvg = g.transpose().mmul(Qinv).mmul(g);
  const scale = 1 + gtQinvg.get(0, 0);

  // Normalized shape matrix: Q / scale
  const Qn = Q.div(scale);

  // Eigenvalue decomposition of normalized shape matrix
  const eig = new EigenvalueDecomposition(Qn);
  const eigenvalues = eig.realEigenvalues;
  const eigenvectors = eig.eigenvectorMatrix;

  // Semi-axes = 1/sqrt(eigenvalue) for each axis
  const semiAxes: [number, number, number] = [
    1 / Math.sqrt(Math.abs(eigenvalues[0])),
    1 / Math.sqrt(Math.abs(eigenvalues[1])),
    1 / Math.sqrt(Math.abs(eigenvalues[2])),
  ];

  // Sort semi-axes ascending
  semiAxes.sort((a, b) => a - b);

  // Sphericity: ratio of smallest to largest semi-axis (1.0 = perfect sphere)
  const sphericityPercent = (semiAxes[0] / semiAxes[2]) * 100;

  // Classification
  let shapeClass: 'sphere' | 'slight-ellipsoid' | 'significant-ellipsoid';
  if (sphericityPercent >= 98) {
    shapeClass = 'sphere';
  } else if (sphericityPercent >= 90) {
    shapeClass = 'slight-ellipsoid';
  } else {
    shapeClass = 'significant-ellipsoid';
  }

  // Build rotation matrix from eigenvectors
  const rotMat = new THREE.Matrix3();
  rotMat.set(
    eigenvectors.get(0, 0), eigenvectors.get(0, 1), eigenvectors.get(0, 2),
    eigenvectors.get(1, 0), eigenvectors.get(1, 1), eigenvectors.get(1, 2),
    eigenvectors.get(2, 0), eigenvectors.get(2, 1), eigenvectors.get(2, 2),
  );

  // Compute RMS error
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const val = A * x * x + B * y * y + C * z * z +
      2 * D * x * y + 2 * E * x * z + 2 * F * y * z +
      2 * G * x + 2 * H * y + 2 * I * z;
    const residual = val - 1;
    sumSq += residual * residual;
  }
  const rmsError = Math.sqrt(sumSq / n);

  return {
    center: new THREE.Vector3(cx, cy, cz),
    semiAxes,
    rotationMatrix: rotMat,
    sphericityPercent,
    shapeClass,
    rmsError,
  };
}
