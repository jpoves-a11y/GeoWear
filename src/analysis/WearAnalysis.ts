// ============================================================
// GeoWear — WearAnalysis Pipeline
// Orchestrates the full analysis pipeline
// ============================================================

import * as THREE from 'three';
import type {
  MeshData, SeparationResult, TrimResult, SphereFitResult,
  EllipsoidFitResult, Geodesic, AnalysisResults, AnomalyCluster,
  AnalysisParams, CommercialSphereInfo, WearClassification,
  ZoneSphereResult, RimPlaneResult, WearVolumeResult, WearPlaneResult
} from '../types';
import { COMMERCIAL_RADII } from '../types';
import { separateFaces, trimRim } from './MeshProcessor';
import { smoothMesh } from './MeshSmoother';
import { fitSphereRobust, fitSphereFixedRadius } from './SphereFitter';
import { fitEllipsoid } from './EllipsoidFitter';
import { MeshGraph } from '../math/MeshGraph';
import { computeGeodesics } from './GeodesicSolver';
import { analyzeDeviations, computeVertexDeviations } from './DeviationAnalyzer';
import { clusterAnomalies, findPrimaryWearZone } from './AnomalyRegistry';
import { computeDefectVolumes, computeWearVector, computeMeshEnclosedVolume, computeSphereCap } from './VolumeComputer';

/**
 * Compute the eigenvector corresponding to the smallest eigenvalue
 * of a 3×3 symmetric matrix [[cxx,cxy,cxz],[cxy,cyy,cyz],[cxz,cyz,czz]].
 * Uses power iteration on the two largest eigenvectors, then cross product.
 */
function smallestEigenvector3x3(
  cxx: number, cxy: number, cxz: number,
  cyy: number, cyz: number, czz: number
): [number, number, number] {
  // Power iteration → largest eigenvector
  let v1x = 1, v1y = 0, v1z = 0;
  for (let iter = 0; iter < 80; iter++) {
    const nx = cxx * v1x + cxy * v1y + cxz * v1z;
    const ny = cxy * v1x + cyy * v1y + cyz * v1z;
    const nz = cxz * v1x + cyz * v1y + czz * v1z;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-15) break;
    v1x = nx / len; v1y = ny / len; v1z = nz / len;
  }
  const ev1 = cxx * v1x * v1x + 2 * cxy * v1x * v1y + 2 * cxz * v1x * v1z
            + cyy * v1y * v1y + 2 * cyz * v1y * v1z + czz * v1z * v1z;

  // Deflate → second largest eigenvector
  const d_cxx = cxx - ev1 * v1x * v1x;
  const d_cxy = cxy - ev1 * v1x * v1y;
  const d_cxz = cxz - ev1 * v1x * v1z;
  const d_cyy = cyy - ev1 * v1y * v1y;
  const d_cyz = cyz - ev1 * v1y * v1z;
  const d_czz = czz - ev1 * v1z * v1z;

  let v2x = 0, v2y = 1, v2z = 0;
  // Pick initial vector not collinear with v1
  const dot01 = Math.abs(v1y);
  if (dot01 > 0.9) { v2x = 0; v2y = 0; v2z = 1; }
  for (let iter = 0; iter < 80; iter++) {
    const nx = d_cxx * v2x + d_cxy * v2y + d_cxz * v2z;
    const ny = d_cxy * v2x + d_cyy * v2y + d_cyz * v2z;
    const nz = d_cxz * v2x + d_cyz * v2y + d_czz * v2z;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-15) break;
    v2x = nx / len; v2y = ny / len; v2z = nz / len;
  }

  // Smallest eigenvector = cross(v1, v2)
  let sx = v1y * v2z - v1z * v2y;
  let sy = v1z * v2x - v1x * v2z;
  let sz = v1x * v2y - v1y * v2x;
  const sLen = Math.sqrt(sx * sx + sy * sy + sz * sz);
  if (sLen > 1e-12) { sx /= sLen; sy /= sLen; sz /= sLen; }
  else { sx = 0; sy = 1; sz = 0; }
  return [sx, sy, sz];
}

export interface PipelineState {
  originalMesh: MeshData | null;
  separation: SeparationResult | null;
  trimResult: TrimResult | null;
  workingMesh: MeshData | null;
  smoothedMesh: MeshData | null;   // smoothed version for geodesics/sphere
  graph: MeshGraph | null;
  referenceCenter: [number, number, number] | null; // centroid used before sphere fit
  sphereFit: SphereFitResult | null;
  ellipsoidFit: EllipsoidFitResult | null;
  poleVertex: number;
  polePosition: THREE.Vector3 | null;
  geodesics: Geodesic[];
  curvatureThreshold: number;
  vertexDeviations: Float32Array | null;
  results: AnalysisResults | null;
  // Sphere BestFit mode state
  commercialSphere: CommercialSphereInfo | null;
  wearClassification: WearClassification | null;
  zoneSpheres: ZoneSphereResult | null;
  rimPlane: RimPlaneResult | null;
  wearVolume: WearVolumeResult | null;
  wearPlane: WearPlaneResult | null;
}

export class WearAnalysisPipeline {
  public state: PipelineState = {
    originalMesh: null,
    separation: null,
    trimResult: null,
    workingMesh: null,
    smoothedMesh: null,
    graph: null,
    referenceCenter: null,
    sphereFit: null,
    ellipsoidFit: null,
    poleVertex: 0,
    polePosition: null,
    geodesics: [],
    curvatureThreshold: 0,
    vertexDeviations: null,
    results: null,
    commercialSphere: null,
    wearClassification: null,
    zoneSpheres: null,
    rimPlane: null,
    wearVolume: null,
    wearPlane: null,
  };

  private onProgress?: (stage: string, progress: number, message: string) => void;

  constructor(onProgress?: (stage: string, progress: number, message: string) => void) {
    this.onProgress = onProgress;
  }

  private progress(stage: string, progress: number, message: string): void {
    if (this.onProgress) {
      this.onProgress(stage, progress, message);
    }
  }

  /**
   * Run the complete analysis pipeline.
   * Branches after sphere fit based on analysisMode.
   */
  async runFullAnalysis(meshData: MeshData, params: AnalysisParams): Promise<AnalysisResults> {
    const startTime = performance.now();

    // Step 1: Separate faces
    this.progress('separating', 0, 'Detecting inner surface...');
    this.state.originalMesh = meshData;
    this.stepSeparateFaces(meshData);

    // Step 2: Trim rim
    this.progress('trimming', 0.1, `Trimming rim (${params.rimTrimPercent}%)...`);
    this.stepTrimRim(params.rimTrimPercent);

    // Step 2b: Smooth mesh for geodesic/sphere analysis
    this.progress('smoothing', 0.15, `Smoothing mesh (${params.smoothingIterations} iterations)...`);
    this.stepSmooth(params.smoothingIterations);

    // Step 3: Build graph and compute geodesics (before sphere fit)
    this.progress('geodesics', 0.2, `Computing ${params.geodesicCount} geodesics...`);
    await this.stepComputeGeodesicsAsync(params.geodesicCount);

    // Step 4: Fit sphere (using only regular geodesic vertices)
    this.progress('fitting', 0.8, 'Fitting reference sphere (regular geodesics only)...');
    this.stepFitSphere();

    if (params.analysisMode === 'sphere-bestfit') {
      // --- Sphere BestFit pipeline ---
      this.progress('commercial', 0.83, 'Determining commercial radius...');
      this.stepDetermineCommercialRadius(params.commercialRadius);

      this.progress('classifying', 0.86, 'Classifying wear zones...');
      this.stepClassifyWear();

      this.progress('zone-spheres', 0.89, 'Fitting zone spheres...');
      this.stepFitZoneSpheres();

      this.progress('rim-plane', 0.92, 'Computing rim plane...');
      this.stepComputeRimPlane();

      this.progress('wear-volume', 0.93, 'Computing wear volume...');
      this.stepComputeWearVolumeBestFit();

      this.progress('wear-plane', 0.97, 'Computing wear plane...');
      this.stepComputeWearPlane();
    } else {
      // --- Pure Geodesic pipeline ---
      this.progress('fitting', 0.85, 'Fitting ellipsoid...');
      this.stepFitEllipsoid();

      this.progress('analyzing', 0.85, 'Analyzing deviations...');
      this.stepAnalyzeDeviations(params.thresholdMicrons);

      this.progress('volumes', 0.92, 'Computing defect volumes...');
      this.stepComputeVolumes(params.thresholdMicrons, params.density);
    }

    const endTime = performance.now();
    this.state.results!.processingTimeMs = endTime - startTime;

    this.progress('complete', 1.0, 'Analysis complete!');
    return this.state.results!;
  }

  // ---- Individual steps ----

  stepSeparateFaces(meshData?: MeshData): SeparationResult {
    const data = meshData || this.state.originalMesh;
    if (!data) throw new Error('No mesh data loaded');

    this.state.separation = separateFaces(data);
    return this.state.separation;
  }

  stepTrimRim(rimPercent: number = 5): TrimResult {
    if (!this.state.separation) throw new Error('Run face separation first');

    this.state.trimResult = trimRim(
      this.state.separation.inner,
      this.state.separation.cupAxis,
      rimPercent
    );
    this.state.workingMesh = this.state.trimResult.mesh;
    this.state.smoothedMesh = null; // invalidate
    return this.state.trimResult;
  }

  /**
   * Smooth the working mesh using Taubin (λ|μ) smoothing.
   * The smoothed mesh is used for geodesic computation and sphere fitting,
   * while the original (unsmoothed) working mesh is kept for display/heat map.
   */
  stepSmooth(iterations: number = 3): void {
    if (!this.state.workingMesh) throw new Error('No working mesh available');
    this.state.smoothedMesh = smoothMesh(this.state.workingMesh, iterations);
  }

  stepFitSphere(): SphereFitResult {
    if (!this.state.workingMesh) throw new Error('No working mesh available');

    // Use smoothed mesh for sphere fitting (same mesh used for geodesics)
    const mesh = this.state.smoothedMesh || this.state.workingMesh;

    // If geodesics are available, fit using only regular geodesic point positions.
    // Note: mesh-plane intersection points have vertexIndex = -1, so we use
    // the GeodesicPoint.position directly instead of indexing into mesh.positions.
    if (this.state.geodesics.length > 0) {
      const regularPoints: Array<[number, number, number]> = [];
      for (const geo of this.state.geodesics) {
        if (geo.isRegular) {
          for (const p of geo.points) {
            regularPoints.push(p.position);
          }
        }
      }

      // If we have enough regular points, fit with those only
      if (regularPoints.length >= 20) {
        const regularPositions = new Float32Array(regularPoints.length * 3);
        for (let i = 0; i < regularPoints.length; i++) {
          regularPositions[i * 3]     = regularPoints[i][0];
          regularPositions[i * 3 + 1] = regularPoints[i][1];
          regularPositions[i * 3 + 2] = regularPoints[i][2];
        }
        console.log(`Sphere fit: using ${regularPoints.length} regular geodesic points (${this.state.geodesics.filter(g => g.isRegular).length} regular geodesics)`);
        this.state.sphereFit = fitSphereRobust(regularPositions, regularPoints.length);
        return this.state.sphereFit;
      }
    }

    // Fallback: fit with all vertices
    console.warn('Sphere fit: not enough regular geodesic points, using all mesh vertices');
    this.state.sphereFit = fitSphereRobust(
      mesh.positions,
      mesh.vertexCount
    );
    return this.state.sphereFit;
  }

  stepFitEllipsoid(): EllipsoidFitResult {
    if (!this.state.workingMesh) throw new Error('No working mesh available');

    this.state.ellipsoidFit = fitEllipsoid(
      this.state.workingMesh.positions,
      this.state.workingMesh.vertexCount
    );
    return this.state.ellipsoidFit;
  }

  async stepComputeGeodesicsAsync(geodesicCount: number = 360): Promise<Geodesic[]> {
    if (!this.state.workingMesh) throw new Error('No working mesh available');
    if (!this.state.separation) throw new Error('Run separation first');

    // Use smoothed mesh for geodesic computation if available
    const mesh = this.state.smoothedMesh || this.state.workingMesh;

    // Build mesh graph
    this.progress('geodesics', 0.25, 'Building mesh adjacency graph...');
    this.state.graph = MeshGraph.build(mesh.positions, mesh.indices, mesh.vertexCount);

    // --- Robust pole detection via distance from real rim plane ---
    this.progress('geodesics', 0.3, 'Detecting pole vertex...');

    // Use separation.inner (untrimmed inner face) to find the real cup rim boundary
    const innerMesh = this.state.separation!.inner;

    // 1. Find boundary edges → rim vertices (from the real inner face, not the trimmed mesh)
    const innerFc = innerMesh.indices.length / 3;
    const edgeFaceMap = new Map<string, number>();
    for (let f = 0; f < innerFc; f++) {
      for (let e = 0; e < 3; e++) {
        const a = innerMesh.indices[f * 3 + e];
        const b = innerMesh.indices[f * 3 + ((e + 1) % 3)];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        edgeFaceMap.set(key, (edgeFaceMap.get(key) || 0) + 1);
      }
    }
    const rimVerts = new Set<number>();
    for (const [key, count] of edgeFaceMap) {
      if (count === 1) {
        const parts = key.split('_');
        rimVerts.add(Number(parts[0]));
        rimVerts.add(Number(parts[1]));
      }
    }

    // 2. Compute rim centroid (from the real inner face positions)
    let rimCx = 0, rimCy = 0, rimCz = 0;
    for (const v of rimVerts) {
      rimCx += innerMesh.positions[v * 3];
      rimCy += innerMesh.positions[v * 3 + 1];
      rimCz += innerMesh.positions[v * 3 + 2];
    }
    if (rimVerts.size > 0) {
      rimCx /= rimVerts.size;
      rimCy /= rimVerts.size;
      rimCz /= rimVerts.size;
    }

    // 3. Fit a plane to real rim vertices using PCA (normal = smallest eigenvector)
    //    The rim plane passes through rimCentroid with normal = planeN.
    //    Covariance matrix of rim positions relative to centroid:
    let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
    for (const v of rimVerts) {
      const dx = innerMesh.positions[v * 3]     - rimCx;
      const dy = innerMesh.positions[v * 3 + 1] - rimCy;
      const dz = innerMesh.positions[v * 3 + 2] - rimCz;
      cxx += dx * dx; cxy += dx * dy; cxz += dx * dz;
      cyy += dy * dy; cyz += dy * dz; czz += dz * dz;
    }
    const planeN = smallestEigenvector3x3(cxx, cxy, cxz, cyy, cyz, czz);

    // 4. Pole = vertex with maximum perpendicular distance from rim plane
    //    distance = dot(pos - rimCentroid, planeN), take absolute value
    //    (the deepest point is the one farthest from the plane, on the interior side)
    let maxPlaneDist = 0;
    let poleSide = 1; // track which side the majority of mesh is on
    this.state.poleVertex = 0;

    // First pass: determine which side of the plane the interior is on
    let sumSignedDist = 0;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const dx = mesh.positions[i * 3]     - rimCx;
      const dy = mesh.positions[i * 3 + 1] - rimCy;
      const dz = mesh.positions[i * 3 + 2] - rimCz;
      sumSignedDist += dx * planeN[0] + dy * planeN[1] + dz * planeN[2];
    }
    poleSide = sumSignedDist >= 0 ? 1 : -1;

    // Second pass: find vertex with maximum signed distance on the interior side
    for (let i = 0; i < mesh.vertexCount; i++) {
      const dx = mesh.positions[i * 3]     - rimCx;
      const dy = mesh.positions[i * 3 + 1] - rimCy;
      const dz = mesh.positions[i * 3 + 2] - rimCz;
      const signedDist = (dx * planeN[0] + dy * planeN[1] + dz * planeN[2]) * poleSide;
      if (signedDist > maxPlaneDist) {
        maxPlaneDist = signedDist;
        this.state.poleVertex = i;
      }
    }

    this.state.polePosition = new THREE.Vector3(
      mesh.positions[this.state.poleVertex * 3],
      mesh.positions[this.state.poleVertex * 3 + 1],
      mesh.positions[this.state.poleVertex * 3 + 2],
    );

    // 5. Cup axis = normalized direction from rim centroid → pole
    let axX = mesh.positions[this.state.poleVertex * 3] - rimCx;
    let axY = mesh.positions[this.state.poleVertex * 3 + 1] - rimCy;
    let axZ = mesh.positions[this.state.poleVertex * 3 + 2] - rimCz;
    const axLen = Math.sqrt(axX * axX + axY * axY + axZ * axZ);
    if (axLen > 1e-12) { axX /= axLen; axY /= axLen; axZ /= axLen; }
    else { axX = 0; axY = 1; axZ = 0; }

    const cupAxis: [number, number, number] = [axX, axY, axZ];
    this.state.separation!.cupAxis = cupAxis;

    // Reference center = rim centroid (≈ sphere center for hemispherical cup)
    const referenceCenter: [number, number, number] = [rimCx, rimCy, rimCz];
    this.state.referenceCenter = referenceCenter;

    console.log(`[Pole] vertex=${this.state.poleVertex}, maxPlaneDist=${maxPlaneDist.toFixed(4)}, ` +
      `rimVerts=${rimVerts.size}, planeN=[${planeN.map((v: number) => v.toFixed(4)).join(', ')}], ` +
      `axis=[${cupAxis.map(v => v.toFixed(4)).join(', ')}]`);

    // Compute geodesics (with yield for UI updates)
    this.state.geodesics = await new Promise<Geodesic[]>((resolve) => {
      setTimeout(() => {
        const result = computeGeodesics(
          mesh.positions,
          mesh.vertexCount,
          this.state.graph!,
          this.state.poleVertex,
          referenceCenter,
          cupAxis,
          geodesicCount,
          (progress: number) => {
            this.progress('geodesics', 0.35 + progress * 0.4, `Computing geodesic ${Math.round(progress * geodesicCount)}/${geodesicCount}`);
          },
          mesh.indices
        );
        resolve(result);
      }, 0);
    });

    // --- Classify geodesics as regular/irregular using 2nd derivative (curvature) ---
    // Compute RMS of second derivative for each geodesic
    const rmsValues: number[] = [];
    for (const geo of this.state.geodesics) {
      let sumSq = 0;
      let count = 0;
      for (const p of geo.points) {
        sumSq += p.secondDerivative * p.secondDerivative;
        count++;
      }
      rmsValues.push(count > 0 ? Math.sqrt(sumSq / count) : 0);
    }

    // Threshold = 2× median RMS (adaptive to the mesh)
    const sortedRms = [...rmsValues].sort((a, b) => a - b);
    const medianRms = sortedRms[Math.floor(sortedRms.length / 2)] || 0;
    const curvatureThreshold = medianRms * 2;

    let regularCount = 0;
    for (let i = 0; i < this.state.geodesics.length; i++) {
      this.state.geodesics[i].isRegular = rmsValues[i] <= curvatureThreshold;
      if (this.state.geodesics[i].isRegular) regularCount++;
    }

    this.state.curvatureThreshold = curvatureThreshold;

    console.log(`[Geodesics] curvatureThreshold=${curvatureThreshold.toFixed(6)}, ` +
      `medianRms=${medianRms.toFixed(6)}, regular=${regularCount}, irregular=${this.state.geodesics.length - regularCount}`);

    // Update pole position to the common average pole (set by computeGeodesics)
    if (this.state.geodesics.length > 0 && this.state.geodesics[0].points.length > 0) {
      const avgPole = this.state.geodesics[0].points[0].position;
      this.state.polePosition = new THREE.Vector3(avgPole[0], avgPole[1], avgPole[2]);
    }

    this.progress('geodesics', 0.8, `Classified: ${regularCount} regular, ${this.state.geodesics.length - regularCount} irregular geodesics`);

    return this.state.geodesics;
  }

  stepAnalyzeDeviations(thresholdMicrons: number = 1.0): void {
    if (!this.state.workingMesh) throw new Error('No working mesh available');
    if (!this.state.sphereFit) throw new Error('Run sphere fit first');

    // Compute vertex deviations for the entire mesh (for heat map)
    this.state.vertexDeviations = computeVertexDeviations(
      this.state.workingMesh.positions,
      this.state.workingMesh.vertexCount,
      this.state.sphereFit.center,
      this.state.sphereFit.radius
    );

    // Analyze along geodesics
    const devResult = analyzeDeviations(
      this.state.workingMesh.positions,
      this.state.workingMesh.vertexCount,
      this.state.geodesics,
      this.state.sphereFit,
      thresholdMicrons
    );

    // Cluster anomalies
    const allClusters = clusterAnomalies(devResult.anomalyPoints);
    const bumpClusters = allClusters.filter(c => c.type === 'bump');
    const dipClusters = allClusters.filter(c => c.type === 'dip');
    const primaryWearZone = findPrimaryWearZone(allClusters);

    // Initialize results (volumes computed in next step)
    this.state.results = {
      analysisMode: 'pure-geodesic',
      sphereFit: this.state.sphereFit,
      ellipsoidFit: this.state.ellipsoidFit ?? null,
      geodesics: this.state.geodesics,
      geodesicCount: this.state.geodesics.length,
      totalAnomalyPoints: devResult.anomalyPoints.length,
      bumpClusters,
      dipClusters,
      primaryWearZone,
      totalBumpVolume: 0,
      totalDipVolume: 0,
      totalWearVolume: 0,
      wearVector: null,
      processingTimeMs: 0,
      vertexCount: this.state.workingMesh.vertexCount,
      faceCount: this.state.workingMesh.faceCount,
    };
  }

  stepComputeVolumes(thresholdMicrons: number = 1.0, density: number = 0.935): void {
    if (!this.state.results) throw new Error('Run deviation analysis first');
    if (!this.state.workingMesh || !this.state.sphereFit || !this.state.vertexDeviations) {
      throw new Error('Missing data');
    }

    const allClusters = [...this.state.results.bumpClusters, ...this.state.results.dipClusters];

    const volumeResult = computeDefectVolumes(
      this.state.workingMesh,
      this.state.sphereFit,
      this.state.vertexDeviations,
      allClusters,
      thresholdMicrons,
      density
    );

    this.state.results.totalBumpVolume = volumeResult.totalBumpVolume;
    this.state.results.totalDipVolume = volumeResult.totalDipVolume;
    this.state.results.totalWearVolume = volumeResult.totalWearVolume;

    // Compute wear vector from bump clusters (positive deviation = outside sphere = wear)
    if (this.state.results.bumpClusters.length > 0 && this.state.polePosition && this.state.separation) {
      const cupAxisVec = new THREE.Vector3(...this.state.separation.cupAxis);
      this.state.results.wearVector = computeWearVector(
        this.state.results.bumpClusters,
        this.state.polePosition,
        this.state.sphereFit.center,
        cupAxisVec
      );
    }
  }

  // ======== Sphere BestFit pipeline steps ========

  /**
   * Determine the commercial sphere radius.
   * Uses the geodesic sphere fit center; snaps radius DOWN to nearest
   * commercial value in [14, 16, 18, 20] mm, or uses the manual value.
   */
  stepDetermineCommercialRadius(manualRadius: number = 0): CommercialSphereInfo {
    if (!this.state.sphereFit) throw new Error('Run sphere fit first');

    const geodesicRadius = this.state.sphereFit.radius;
    let commercialRadius: number;
    let autoDetected: boolean;

    if (manualRadius > 0 && COMMERCIAL_RADII.includes(manualRadius)) {
      commercialRadius = manualRadius;
      autoDetected = false;
    } else {
      // Round DOWN to nearest commercial radius, but snap UP if within 0.2mm of the next one
      const sorted = [...COMMERCIAL_RADII].sort((a, b) => a - b); // ascending
      commercialRadius = sorted[0]; // smallest as default
      for (let i = 0; i < sorted.length; i++) {
        if (geodesicRadius >= sorted[i]) {
          commercialRadius = sorted[i];
        } else if (sorted[i] - geodesicRadius <= 0.2) {
          // Within 0.2mm of the next commercial radius → snap up
          commercialRadius = sorted[i];
          break;
        } else {
          break;
        }
      }
      autoDetected = true;
    }

    this.state.commercialSphere = {
      geodesicRadius,
      commercialRadius,
      center: this.state.sphereFit.center.clone(),
      autoDetected,
    };

    console.log(`[Commercial Sphere] geodesic R=${geodesicRadius.toFixed(3)}mm → commercial R=${commercialRadius}mm (${autoDetected ? 'auto' : 'manual'})`);
    return this.state.commercialSphere;
  }

  /**
   * Classify each vertex as worn or unworn.
   * A vertex is worn if its distance to the commercial sphere center
   * exceeds 102% of the commercial radius.
   */
  stepClassifyWear(): WearClassification {
    if (!this.state.workingMesh) throw new Error('No working mesh available');
    if (!this.state.commercialSphere) throw new Error('Run commercial radius determination first');

    const mesh = this.state.workingMesh;
    const center = this.state.commercialSphere.center;
    const R = this.state.commercialSphere.commercialRadius;
    const threshold = R * 1.02;

    const n = mesh.vertexCount;
    const isWorn = new Uint8Array(n);
    const distances = new Float32Array(n);
    let wornCount = 0;

    for (let i = 0; i < n; i++) {
      const dx = mesh.positions[i * 3] - center.x;
      const dy = mesh.positions[i * 3 + 1] - center.y;
      const dz = mesh.positions[i * 3 + 2] - center.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      distances[i] = dist;
      if (dist > threshold) {
        isWorn[i] = 1;
        wornCount++;
      }
    }

    const unwornCount = n - wornCount;

    this.state.wearClassification = {
      isWorn,
      distances,
      wornCount,
      unwornCount,
      wornPercent: (wornCount / n) * 100,
      threshold,
    };

    // Store deviations from commercial radius in μm for heatmap
    const deviations = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      deviations[i] = (distances[i] - R) * 1000; // mm → μm
    }
    this.state.vertexDeviations = deviations;

    console.log(`[Wear Classification] worn=${wornCount} (${this.state.wearClassification.wornPercent.toFixed(1)}%), unworn=${unwornCount}, threshold=${threshold.toFixed(3)}mm`);
    return this.state.wearClassification;
  }

  /**
   * Fit spheres with the commercial radius to worn and unworn vertex subsets.
   * Uses iterative center-only optimization (radius is fixed).
   */
  stepFitZoneSpheres(): ZoneSphereResult {
    if (!this.state.workingMesh) throw new Error('No working mesh available');
    if (!this.state.wearClassification) throw new Error('Run wear classification first');
    if (!this.state.commercialSphere) throw new Error('Run commercial radius determination first');

    const mesh = this.state.workingMesh;
    const { isWorn } = this.state.wearClassification;
    const R = this.state.commercialSphere.commercialRadius;

    // Separate vertex positions
    const wornPositions: number[] = [];
    const unwornPositions: number[] = [];

    for (let i = 0; i < mesh.vertexCount; i++) {
      const px = mesh.positions[i * 3];
      const py = mesh.positions[i * 3 + 1];
      const pz = mesh.positions[i * 3 + 2];
      if (isWorn[i]) {
        wornPositions.push(px, py, pz);
      } else {
        unwornPositions.push(px, py, pz);
      }
    }

    const wornArr = new Float32Array(wornPositions);
    const unwornArr = new Float32Array(unwornPositions);

    const wornFit = wornPositions.length >= 9
      ? fitSphereFixedRadius(wornArr, wornPositions.length / 3, R)
      : { center: this.state.commercialSphere.center.clone(), radius: R, rmsError: 0 };

    const unwornFit = unwornPositions.length >= 9
      ? fitSphereFixedRadius(unwornArr, unwornPositions.length / 3, R)
      : { center: this.state.commercialSphere.center.clone(), radius: R, rmsError: 0 };

    this.state.zoneSpheres = {
      wornSphere: { center: wornFit.center, radius: R, rmsError: wornFit.rmsError },
      unwornSphere: { center: unwornFit.center, radius: R, rmsError: unwornFit.rmsError },
    };

    console.log(`[Zone Spheres] worn RMS=${wornFit.rmsError.toFixed(4)}mm, unworn RMS=${unwornFit.rmsError.toFixed(4)}mm`);
    return this.state.zoneSpheres;
  }

  /**
   * Compute the rim plane from the boundary edges of the working mesh.
   * The plane is fitted to the last vertices of the rim (the "mouth" of the cup).
   */
  stepComputeRimPlane(): RimPlaneResult {
    if (!this.state.workingMesh) throw new Error('No working mesh available');

    const mesh = this.state.workingMesh;
    const fc = mesh.indices.length / 3;

    // Find boundary edges
    const edgeFaceMap = new Map<string, number>();
    for (let f = 0; f < fc; f++) {
      for (let e = 0; e < 3; e++) {
        const a = mesh.indices[f * 3 + e];
        const b = mesh.indices[f * 3 + ((e + 1) % 3)];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        edgeFaceMap.set(key, (edgeFaceMap.get(key) || 0) + 1);
      }
    }

    const rimVerticesSet = new Set<number>();
    for (const [key, count] of edgeFaceMap) {
      if (count === 1) {
        const parts = key.split('_');
        rimVerticesSet.add(Number(parts[0]));
        rimVerticesSet.add(Number(parts[1]));
      }
    }

    const rimVertices = Array.from(rimVerticesSet);

    // Compute rim centroid
    let cx = 0, cy = 0, cz = 0;
    for (const v of rimVertices) {
      cx += mesh.positions[v * 3];
      cy += mesh.positions[v * 3 + 1];
      cz += mesh.positions[v * 3 + 2];
    }
    cx /= rimVertices.length;
    cy /= rimVertices.length;
    cz /= rimVertices.length;

    // PCA for plane normal
    let covxx = 0, covxy = 0, covxz = 0, covyy = 0, covyz = 0, covzz = 0;
    for (const v of rimVertices) {
      const dx = mesh.positions[v * 3] - cx;
      const dy = mesh.positions[v * 3 + 1] - cy;
      const dz = mesh.positions[v * 3 + 2] - cz;
      covxx += dx * dx; covxy += dx * dy; covxz += dx * dz;
      covyy += dy * dy; covyz += dy * dz; covzz += dz * dz;
    }
    const normal = smallestEigenvector3x3(covxx, covxy, covxz, covyy, covyz, covzz);

    // Orient normal toward the interior (same side as pole)
    if (this.state.polePosition) {
      const toPole = new THREE.Vector3(
        this.state.polePosition.x - cx,
        this.state.polePosition.y - cy,
        this.state.polePosition.z - cz
      );
      const normalVec = new THREE.Vector3(normal[0], normal[1], normal[2]);
      if (toPole.dot(normalVec) < 0) {
        normal[0] = -normal[0];
        normal[1] = -normal[1];
        normal[2] = -normal[2];
      }
    }

    this.state.rimPlane = {
      point: new THREE.Vector3(cx, cy, cz),
      normal: new THREE.Vector3(normal[0], normal[1], normal[2]),
      rimVertices,
    };

    console.log(`[Rim Plane] center=(${cx.toFixed(3)}, ${cy.toFixed(3)}, ${cz.toFixed(3)}), normal=(${normal[0].toFixed(4)}, ${normal[1].toFixed(4)}, ${normal[2].toFixed(4)}), ${rimVertices.length} rim vertices`);
    return this.state.rimPlane;
  }

  /**
   * Compute wear volume for the Sphere BestFit pipeline.
   * Wear = (mesh enclosed volume cut by rim plane) - (unworn sphere cap volume cut by same plane)
   */
  stepComputeWearVolumeBestFit(): WearVolumeResult {
    if (!this.state.workingMesh) throw new Error('No working mesh available');
    if (!this.state.rimPlane) throw new Error('Run rim plane computation first');
    if (!this.state.zoneSpheres) throw new Error('Run zone sphere fitting first');
    if (!this.state.sphereFit) throw new Error('Run sphere fit first');

    const { point: planePoint, normal: planeNormal } = this.state.rimPlane;
    const { unwornSphere } = this.state.zoneSpheres;

    // Volume enclosed between mesh and rim plane
    const meshEnclosedVolume = computeMeshEnclosedVolume(
      this.state.workingMesh,
      planePoint,
      planeNormal
    );

    // Volume of the unworn sphere cap on the interior side of the rim plane
    const sphereCapVolume = computeSphereCap(
      unwornSphere.center,
      unwornSphere.radius,
      planePoint,
      planeNormal
    );

    const wearVolume = Math.max(0, meshEnclosedVolume - sphereCapVolume);

    this.state.wearVolume = {
      meshEnclosedVolume,
      sphereCapVolume,
      wearVolume,
    };

    // Initialize results for bestfit mode
    this.state.results = {
      analysisMode: 'sphere-bestfit',
      sphereFit: this.state.sphereFit,
      ellipsoidFit: null,
      geodesics: this.state.geodesics,
      geodesicCount: this.state.geodesics.length,
      totalAnomalyPoints: this.state.wearClassification?.wornCount ?? 0,
      bumpClusters: [],
      dipClusters: [],
      primaryWearZone: null,
      totalBumpVolume: 0,
      totalDipVolume: 0,
      totalWearVolume: wearVolume,
      wearVector: null,
      commercialSphere: this.state.commercialSphere ?? undefined,
      wearClassification: this.state.wearClassification ?? undefined,
      zoneSpheres: this.state.zoneSpheres ?? undefined,
      rimPlane: this.state.rimPlane ?? undefined,
      wearVolumeResult: this.state.wearVolume,
      processingTimeMs: 0,
      vertexCount: this.state.workingMesh.vertexCount,
      faceCount: this.state.workingMesh.faceCount,
    };

    console.log(`[Wear Volume] mesh=${meshEnclosedVolume.toFixed(4)}mm³, sphereCap=${sphereCapVolume.toFixed(4)}mm³, wear=${wearVolume.toFixed(4)}mm³`);
    return this.state.wearVolume;
  }

  /**
   * Find the point of maximum wear and compute a wear plane through it and the pole,
   * perpendicular to the rim plane.
   *
   * Wear depth per vertex = how far the vertex is outside the commercial sphere
   *   depth_i = dist(vertex_i, commercialCenter) - R   (positive = worn)
   * This matches the heatmap coloring (vertexDeviations).
   */
  stepComputeWearPlane(): WearPlaneResult {
    if (!this.state.workingMesh) throw new Error('No working mesh available');
    if (!this.state.commercialSphere) throw new Error('Run commercial radius determination first');
    if (!this.state.rimPlane) throw new Error('Run rim plane computation first');
    if (!this.state.polePosition) throw new Error('No pole position available');

    const mesh = this.state.workingMesh;
    const center = this.state.commercialSphere.center;
    const R = this.state.commercialSphere.commercialRadius;
    const rimNormal = this.state.rimPlane.normal;
    const rimPoint = this.state.rimPlane.point;
    const pole = this.state.polePosition;

    // Find vertex with maximum wear depth (furthest outside commercial sphere),
    // only considering vertices on the interior side of the rim plane (toward the pole)
    let maxDepth = -Infinity;
    let maxIdx = 0;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const px = mesh.positions[i * 3];
      const py = mesh.positions[i * 3 + 1];
      const pz = mesh.positions[i * 3 + 2];

      // Signed distance to rim plane (positive = interior / pole side)
      const rimDist = (px - rimPoint.x) * rimNormal.x +
                      (py - rimPoint.y) * rimNormal.y +
                      (pz - rimPoint.z) * rimNormal.z;
      if (rimDist < 0) continue; // skip vertices outside the rim

      const dx = px - center.x;
      const dy = py - center.y;
      const dz = pz - center.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const depth = dist - R; // positive = outside commercial sphere = worn

      if (depth > maxDepth) {
        maxDepth = depth;
        maxIdx = i;
      }
    }

    const maxWearPoint = new THREE.Vector3(
      mesh.positions[maxIdx * 3],
      mesh.positions[maxIdx * 3 + 1],
      mesh.positions[maxIdx * 3 + 2]
    );

    // Wear plane: passes through pole and maxWearPoint, perpendicular to rim plane
    // Direction in the plane: pole → maxWearPoint
    const dir = maxWearPoint.clone().sub(pole).normalize();
    // Plane normal = dir × rimNormal (perpendicular to both)
    const planeNormal = new THREE.Vector3().crossVectors(dir, rimNormal).normalize();

    this.state.wearPlane = {
      maxWearPoint,
      maxWearDepth: maxDepth * 1000, // convert to μm
      planePoint: pole.clone(),
      planeNormal,
    };

    // Also store in results if they exist
    if (this.state.results) {
      this.state.results.wearPlane = this.state.wearPlane;
    }

    console.log(`[Wear Plane] maxWear=${(maxDepth * 1000).toFixed(1)}μm at (${maxWearPoint.x.toFixed(2)}, ${maxWearPoint.y.toFixed(2)}, ${maxWearPoint.z.toFixed(2)})`);
    return this.state.wearPlane;
  }
}
