// ============================================================
// GeoWear — WearAnalysis Pipeline
// Orchestrates the full analysis pipeline
// ============================================================

import * as THREE from 'three';
import type {
  MeshData, SeparationResult, TrimResult, SphereFitResult,
  EllipsoidFitResult, Geodesic, AnalysisResults, AnomalyCluster,
  AnalysisParams, CommercialSphereInfo, WearClassification,
  ZoneSphereResult, RimPlaneResult, WearVolumeResult, WearPlaneResult,
  LinearWearFilter, AnalysisRunResult, DoubleSphereMetricsResult,
  DoubleSphereSweepCellResult
} from '../types';
import { COMMERCIAL_RADII } from '../types';
import { separateFaces, trimRim, computeRimAnchor } from './MeshProcessor';
import { smoothMesh, repairInnerFaceMesh } from './MeshSmoother';
import { computeTiltedRimNormal } from '../utils/geometry';
import { fitSphereRobust, fitSphereFixedRadius, fitSphereFixedRadiusRobust } from './SphereFitter';
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
  // Real rim geometry (from untrimmed inner surface boundary, computed during pole detection)
  realRimCentroid: THREE.Vector3 | null;
  realRimPlaneNormal: THREE.Vector3 | null;
  // Sphere BestFit mode state
  commercialSphere: CommercialSphereInfo | null;
  wearClassification: WearClassification | null;
  zoneSpheres: ZoneSphereResult | null;
  rimPlane: RimPlaneResult | null;
  wearVolume: WearVolumeResult | null;
  wearPlane: WearPlaneResult | null;
  // Pre-computed rim geometry for double-sphere mode (stored for live rim-trim slider)
  dsRimCentroid: THREE.Vector3 | null;
  dsRimNormal: THREE.Vector3 | null;
  dsDistToPole: number | null;
  dsRimVertices: number[] | null;
  // User-defined vertex exclusion mask (indices into separation.inner)
  excludedInnerMeshVertices: Set<number>;
  // User-defined rim plane normal (overrides cup axis when set)
  rimPlaneNormal?: [number, number, number];
  // Rim inclination angles (stored so the normal can be re-derived after
  // stepSeparateFaces uses the fresh cupAxis, avoiding stale-separation bugs)
  rimInclinationAngleDeg: number;
  rimInclinationAzimuthDeg: number;
  /**
   * Centroid of the manually-picked rim points (in mesh-local coordinates).
   * When set, the cut plane is anchored here (+ trim% shift along cup axis)
   * instead of the default mesh-centroid-based calculation.
   */
  manualRimBasePoint: [number, number, number] | null;
  // Cup axis refined during geodesic computation (rim-centroid → pole on trimmed mesh).
  // Kept separate from separation.cupAxis so that the original PCA axis is never
  // overwritten — updateRimPreview() reads separation.cupAxis and must see the same
  // value before and after analysis for identical inclination/azimuth parameters.
  geodesicCupAxis?: [number, number, number];
}

export class WearAnalysisPipeline {
  /** Populated after a 'compare-all-modes' run; holds each sub-pipeline's state
   *  so the caller can swap to any mode's 3D visualisation on demand. */
  public compareModePipelineStates: {
    pureGeodesic: PipelineState;
    sphereBestfit: PipelineState;
    doubleSphereMetrics: PipelineState;
  } | null = null;

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
    realRimCentroid: null,
    realRimPlaneNormal: null,
    commercialSphere: null,
    wearClassification: null,
    zoneSpheres: null,
    rimPlane: null,
    wearVolume: null,
    wearPlane: null,
    dsRimCentroid: null,
    dsRimNormal: null,
    dsDistToPole: null,
    dsRimVertices: null,
    excludedInnerMeshVertices: new Set<number>(),
    rimPlaneNormal: undefined,
    rimInclinationAngleDeg: 0,
    rimInclinationAzimuthDeg: 0,
    manualRimBasePoint: null,
    geodesicCupAxis: undefined,
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

  /** Set the vertex exclusion mask. Vertices in this set (indices into separation.inner)
   *  will be removed from trimRim output and from the double-sphere RANSAC point cloud. */
  public setExclusionMask(excluded: Set<number>): void {
    this.state.excludedInnerMeshVertices = excluded;
  }

  /** Override the rim cut-plane normal (e.g. from a user-adjusted inclination angle).
   *  When set, trimRim uses a fast plane-based approach instead of geodesic distance. */
  public setRimPlaneNormal(normal: [number, number, number] | undefined): void {
    this.state.rimPlaneNormal = normal;
  }

  /** Store rim inclination angles so stepTrimRim can compute the plane normal from the
   *  freshly computed cupAxis after separation, avoiding stale-pipeline bugs. */
  public setRimInclination(angleDeg: number, azimuthDeg: number): void {
    this.state.rimInclinationAngleDeg = angleDeg;
    this.state.rimInclinationAzimuthDeg = azimuthDeg;
  }

  /** Inject a pre-computed separation result so runFullAnalysis skips stepSeparateFaces.
   *  This ensures the cupAxis used for trim is identical to the one used in the preview. */
  public setSeparation(sep: SeparationResult): void {
    this.state.separation = sep;
  }

  /**
   * Set the centroid of the manually-picked rim points (mesh-local coordinates).
   * When set, the trim plane is anchored at this point (shifted by trim%) instead of
   * the default mesh-centroid position, so the cut matches the visual disc.
   */
  public setManualRimBasePoint(pt: [number, number, number] | null): void {
    this.state.manualRimBasePoint = pt;
  }

  /**
   * Run the complete analysis pipeline.
   * Branches after sphere fit based on analysisMode.
   */
  async runFullAnalysis(meshData: MeshData, params: AnalysisParams): Promise<AnalysisRunResult> {
    if (params.analysisMode === 'compare-all-modes') {
      return this.runAllModesIndependent(meshData, params);
    }

    const startTime = performance.now();

    // Step 1: Separate faces (skipped if a separation was pre-injected via setSeparation)
    this.progress('separating', 0, 'Detecting inner surface...');
    this.state.originalMesh = meshData;
    if (!this.state.separation) {
      this.stepSeparateFaces(meshData);
    }

    // Optional: repair inner face scan defects before trimming/analysis
    if (params.repairInnerFace) {
      this.progress('repair-inner', 0.06, 'Repairing inner face (smooth + hole fill)...');
      this.stepRepairInnerFace();
    }

    // Step 2: Trim rim
    this.progress('trimming', 0.1, `Trimming rim (${params.rimTrimPercent}%)...`);
    this.stepTrimRim(params.rimTrimPercent);

    // Step 2b: Smooth mesh for geodesic/sphere analysis
    this.progress('smoothing', 0.15, `Smoothing mesh (${params.smoothingIterations} iterations)...`);
    this.stepSmooth(params.smoothingIterations);

    if (params.analysisMode === 'double-sphere-metrics') {
      // Double-sphere does not need geodesics — fit sphere directly with all vertices
      this.progress('fitting', 0.8, 'Fitting reference sphere (all vertices)...');
      this.stepFitSphere();
    } else {
      // Step 3: Build graph and compute geodesics (before sphere fit)
      this.progress('geodesics', 0.2, `Computing ${params.geodesicCount} geodesics...`);
      await this.stepComputeGeodesicsAsync(params.geodesicCount);

      // Step 4: Fit sphere (using only regular geodesic vertices)
      this.progress('fitting', 0.8, 'Fitting reference sphere (regular geodesics only)...');
      this.stepFitSphere();
    }

    if (params.analysisMode === 'sphere-bestfit') {
      // --- Sphere BestFit pipeline ---
      this.progress('commercial', 0.83, 'Determining commercial radius...');
      this.stepDetermineCommercialRadius(params.commercialRadius);

      this.progress('rim-plane', 0.85, 'Computing rim plane...');
      this.stepComputeRimPlane(params.rimTrimPercent);

      this.progress('classifying', 0.86, 'Classifying wear zones...');
      this.stepClassifyWear(params.rimTrimPercent);

      this.progress('zone-spheres', 0.89, 'Fitting zone spheres...');
      this.stepFitZoneSpheres(params.linearWearFilter, params.minWornCoveragePct);

      this.progress('wear-volume', 0.93, 'Computing wear volume...');
      this.stepComputeWearVolumeBestFit();

      this.progress('wear-plane', 0.97, 'Computing wear plane...');
      this.stepComputeWearPlane();
    } else if (params.analysisMode === 'pure-geodesic') {
      // --- Pure Geodesic pipeline ---
      this.progress('fitting', 0.85, 'Fitting ellipsoid...');
      this.stepFitEllipsoid();

      this.progress('analyzing', 0.85, 'Analyzing deviations...');
      this.stepAnalyzeDeviations(params.thresholdMicrons);

      this.progress('volumes', 0.92, 'Computing defect volumes...');
      this.stepComputeVolumes(params.thresholdMicrons, params.density);
    } else {
      // --- Double Sphere Metrics pipeline ---
      this.progress('double-sphere', 0.85, 'Running double-sphere sweep...');
      await this.stepDoubleSphereMetrics(params);
    }

    const endTime = performance.now();
    this.state.results!.processingTimeMs = endTime - startTime;

    this.progress('complete', 1.0, 'Analysis complete!');
    return this.state.results!;
  }

  private async runAllModesIndependent(meshData: MeshData, params: AnalysisParams): Promise<AnalysisRunResult> {
    const startTime = performance.now();

    const buildModeParams = (mode: AnalysisParams['analysisMode']): AnalysisParams => ({
      ...params,
      analysisMode: mode,
    });

    const runOne = async (
      mode: 'pure-geodesic' | 'sphere-bestfit' | 'double-sphere-metrics',
      offset: number,
      label: string,
    ): Promise<{ result: AnalysisResults; pipeline: WearAnalysisPipeline }> => {
      const subPipeline = new WearAnalysisPipeline((stage, progress, message) => {
        const scaled = Math.min(0.999, offset + progress / 3);
        this.progress(stage, scaled, `[${label}] ${message}`);
      });
      // Propagate user-configured rim plane and exclusion mask to each sub-pipeline
      subPipeline.setRimPlaneNormal(this.state.rimPlaneNormal);
      subPipeline.setExclusionMask(this.state.excludedInnerMeshVertices);
      subPipeline.setRimInclination(this.state.rimInclinationAngleDeg, this.state.rimInclinationAzimuthDeg);
      subPipeline.setManualRimBasePoint(this.state.manualRimBasePoint);
      // Inject the pre-computed separation so all sub-pipelines use the same cupAxis
      if (this.state.separation) subPipeline.setSeparation(this.state.separation);
      const subResult = await subPipeline.runFullAnalysis(meshData, buildModeParams(mode));
      return { result: subResult as AnalysisResults, pipeline: subPipeline };
    };

    const pureRun = await runOne('pure-geodesic', 0, 'Pure Geodesic');
    const bestfitRun = await runOne('sphere-bestfit', 1 / 3, 'Sphere BestFit');
    const doubleRun = await runOne('double-sphere-metrics', 2 / 3, 'Double Sphere');
    const pure = pureRun.result;
    const bestfit = bestfitRun.result;
    const doubleMetrics = doubleRun.result;

    // Store all three sub-pipeline states so the caller can switch 3D visualisation.
    this.compareModePipelineStates = {
      pureGeodesic: pureRun.pipeline.state,
      sphereBestfit: bestfitRun.pipeline.state,
      doubleSphereMetrics: doubleRun.pipeline.state,
    };
    // Default 3D visualisation: sphere-bestfit (richest visual output).
    this.state = bestfitRun.pipeline.state;

    const processingTimeMs = performance.now() - startTime;
    this.progress('complete', 1.0, 'All analysis modes complete');

    return {
      analysisMode: 'compare-all-modes',
      pureGeodesic: pure,
      sphereBestfit: bestfit,
      doubleSphereMetrics: doubleMetrics,
      summary: {
        pureGeodesicWearVolumeMm3: pure.totalWearVolume,
        sphereBestfitWearVolumeMm3: bestfit.wearVolumeResult?.wearVolume ?? bestfit.totalWearVolume,
        doubleSphereLinearWearMm: doubleMetrics.doubleSphereMetrics?.bestCell?.centerDistanceMean ?? 0,
      },
      processingTimeMs,
    };
  }

  // ---- Individual steps ----

  stepSeparateFaces(meshData?: MeshData): SeparationResult {
    const data = meshData || this.state.originalMesh;
    if (!data) throw new Error('No mesh data loaded');

    this.state.separation = separateFaces(data);
    return this.state.separation;
  }

  stepRepairInnerFace(iterations: number = 2): void {
    if (!this.state.separation) throw new Error('Run face separation first');

    const repairedInner = repairInnerFaceMesh(this.state.separation.inner, iterations, 300);
    this.state.separation = {
      ...this.state.separation,
      inner: repairedInner,
    };
  }

  stepTrimRim(rimPercent: number = 5): TrimResult {
    if (!this.state.separation) throw new Error('Run face separation first');

    // Use the explicitly-provided rim plane normal when available (set by app.ts via
    // setRimPlaneNormal before each run). This already accounts for the confirmed manual
    // normal + any slider tilt, so no recomputation from angles is needed.
    // Fall back to angle-based recomputation only when no explicit normal was provided.
    let rimPlaneNormal = this.state.rimPlaneNormal;
    if (rimPlaneNormal === undefined) {
      if (this.state.rimInclinationAngleDeg !== 0 || this.state.rimInclinationAzimuthDeg !== 0) {
        const v = computeTiltedRimNormal(
          this.state.separation.cupAxis,
          this.state.rimInclinationAngleDeg,
          this.state.rimInclinationAzimuthDeg,
        );
        rimPlaneNormal = [v.x, v.y, v.z];
      } else {
        // inclination = 0 → use cup axis as plane normal (plane perpendicular to cup axis).
        const [ax, ay, az] = this.state.separation.cupAxis;
        rimPlaneNormal = [ax, ay, az];
      }
    }

    this.state.trimResult = trimRim(
      this.state.separation.inner,
      this.state.separation.cupAxis,
      rimPercent,
      this.state.excludedInnerMeshVertices.size > 0 ? this.state.excludedInnerMeshVertices : undefined,
      rimPlaneNormal,
      undefined,   // no pre-computed anchor here
      this._computeManualPlaneAnchor(rimPercent, rimPlaneNormal),
    );
    this.state.workingMesh = this.state.trimResult.mesh;
    this.state.smoothedMesh = null; // invalidate
    return this.state.trimResult;
  }

  /**
   * Compute the exact cut-plane anchor for the current manual rim base point + trim%.
   * Returns undefined when no manual rim point is stored (falls back to default logic).
   */
  private _computeManualPlaneAnchor(
    rimPercent: number,
    rimPlaneNormal: [number, number, number] | undefined,
  ): [number, number, number] | undefined {
    if (!this.state.manualRimBasePoint || !rimPlaneNormal || !this.state.separation) return undefined;
    const ca = this.state.separation.cupAxis;
    const anchor = computeRimAnchor(this.state.separation.inner, ca);
    const range = anchor.maxHA - anchor.minHA;
    // Shift along the plane normal (which points toward the pole) by trim%.
    // The normal is already oriented toward the interior — no sign flip needed.
    const shift = (rimPercent / 100) * range;
    const [nx, ny, nz] = rimPlaneNormal;
    const bp = this.state.manualRimBasePoint;
    return [bp[0] + nx * shift, bp[1] + ny * shift, bp[2] + nz * shift];
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

    // Store the real rim geometry for later use in rim plane computation
    this.state.realRimCentroid = new THREE.Vector3(rimCx, rimCy, rimCz);
    this.state.realRimPlaneNormal = new THREE.Vector3(planeN[0], planeN[1], planeN[2]);

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
    // Store the geodesic-derived axis in its own field so that separation.cupAxis
    // (the original PCA axis from separateFaces) is NEVER overwritten.
    // updateRimPreview() reads separation.cupAxis; keeping it unchanged guarantees
    // the rim-plane preview is identical before and after running analysis with the
    // same inclination/azimuth parameters.
    this.state.geodesicCupAxis = cupAxis;

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
      const cupAxisVec = new THREE.Vector3(...(this.state.geodesicCupAxis ?? this.state.separation.cupAxis));
      this.state.results.wearVector = computeWearVector(
        this.state.results.bumpClusters,
        this.state.polePosition,
        this.state.sphereFit.center,
        cupAxisVec
      );
    }
  }

  private async stepDoubleSphereMetrics(params: AnalysisParams): Promise<AnalysisResults> {
    if (!this.state.separation) throw new Error('Run face separation first');
    if (!this.state.sphereFit) throw new Error('Run sphere fit first');

    // ── Pre-RANSAC: cup rim geometry from the full untrimmed inner surface ──────
    // The rim plane is computed here so its direction is independent of RANSAC.
    // normalVec is oriented toward the inner mesh centroid (always INTO the cup).
    // distToPole is the true max extent, so 100% trim puts the plane at the pole.
    const innerMesh = this.state.separation.inner;

    // Boundary edges (shared by exactly 1 triangle) → build adjacency for loops
    const innerFcPre = innerMesh.indices.length / 3;
    const edgeMapPre = new Map<string, number>();
    for (let f = 0; f < innerFcPre; f++) {
      for (let e = 0; e < 3; e++) {
        const a = innerMesh.indices[f * 3 + e];
        const b = innerMesh.indices[f * 3 + ((e + 1) % 3)];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        edgeMapPre.set(key, (edgeMapPre.get(key) || 0) + 1);
      }
    }
    // Build adjacency among boundary vertices
    const boundaryAdjPre = new Map<number, Set<number>>();
    for (const [key, count] of edgeMapPre) {
      if (count === 1) {
        const parts = key.split('_');
        const va = Number(parts[0]), vb = Number(parts[1]);
        if (!boundaryAdjPre.has(va)) boundaryAdjPre.set(va, new Set());
        if (!boundaryAdjPre.has(vb)) boundaryAdjPre.set(vb, new Set());
        boundaryAdjPre.get(va)!.add(vb);
        boundaryAdjPre.get(vb)!.add(va);
      }
    }
    // Group into connected loops and take the LARGEST (= actual cup rim)
    const visitedPre = new Set<number>();
    const loopsPre: Set<number>[] = [];
    for (const startV of boundaryAdjPre.keys()) {
      if (visitedPre.has(startV)) continue;
      const loop = new Set<number>();
      const queue = [startV];
      visitedPre.add(startV);
      while (queue.length > 0) {
        const v = queue.pop()!;
        loop.add(v);
        for (const nb of boundaryAdjPre.get(v)!) {
          if (!visitedPre.has(nb)) { visitedPre.add(nb); queue.push(nb); }
        }
      }
      loopsPre.push(loop);
    }
    loopsPre.sort((a, b) => b.size - a.size);
    const rimVertsSetPre = loopsPre[0] ?? new Set<number>();
    const rimVertsPre = [...rimVertsSetPre];

    // Rim centroid
    let rimCxPre = 0, rimCyPre = 0, rimCzPre = 0;
    for (const v of rimVertsPre) {
      rimCxPre += innerMesh.positions[v * 3];
      rimCyPre += innerMesh.positions[v * 3 + 1];
      rimCzPre += innerMesh.positions[v * 3 + 2];
    }
    if (rimVertsPre.length > 0) {
      rimCxPre /= rimVertsPre.length;
      rimCyPre /= rimVertsPre.length;
      rimCzPre /= rimVertsPre.length;
    }

    // PCA on largest loop: smallest eigenvector = rim plane normal
    let cxxP = 0, cxyP = 0, cxzP = 0, cyyP = 0, cyzP = 0, czzP = 0;
    for (const v of rimVertsPre) {
      const dx = innerMesh.positions[v * 3]     - rimCxPre;
      const dy = innerMesh.positions[v * 3 + 1] - rimCyPre;
      const dz = innerMesh.positions[v * 3 + 2] - rimCzPre;
      cxxP += dx * dx; cxyP += dx * dy; cxzP += dx * dz;
      cyyP += dy * dy; cyzP += dy * dz; czzP += dz * dz;
    }
    const pnPre = smallestEigenvector3x3(cxxP, cxyP, cxzP, cyyP, cyzP, czzP);

    // Orient normal toward inner mesh centroid (always INTO the cup)
    let mCx = 0, mCy = 0, mCz = 0;
    for (let i = 0; i < innerMesh.vertexCount; i++) {
      mCx += innerMesh.positions[i * 3];
      mCy += innerMesh.positions[i * 3 + 1];
      mCz += innerMesh.positions[i * 3 + 2];
    }
    mCx /= innerMesh.vertexCount;
    mCy /= innerMesh.vertexCount;
    mCz /= innerMesh.vertexCount;

    const rimCentroidPre = new THREE.Vector3(rimCxPre, rimCyPre, rimCzPre);
    const meshCentroid = new THREE.Vector3(mCx, mCy, mCz);
    const normalVecPre = new THREE.Vector3(pnPre[0], pnPre[1], pnPre[2]);
    if (meshCentroid.clone().sub(rimCentroidPre).dot(normalVecPre) < 0) normalVecPre.negate();

    // distToPole = max projection of any inner vertex along normalVec from rim centroid
    const nx0 = normalVecPre.x, ny0 = normalVecPre.y, nz0 = normalVecPre.z;
    let maxProj = -Infinity;
    for (let i = 0; i < innerMesh.vertexCount; i++) {
      const proj = (innerMesh.positions[i * 3]     - rimCxPre) * nx0
                 + (innerMesh.positions[i * 3 + 1] - rimCyPre) * ny0
                 + (innerMesh.positions[i * 3 + 2] - rimCzPre) * nz0;
      if (proj > maxProj) maxProj = proj;
    }
    const distToPolePre = Math.max(maxProj, 1e-6);

    // Store for live slider updates (stepUpdateDoubleSphereRimPlane)
    this.state.dsRimCentroid = rimCentroidPre.clone();
    this.state.dsRimNormal = normalVecPre.clone();
    this.state.dsDistToPole = distToPolePre;
    this.state.dsRimVertices = rimVertsPre;

    // ── RANSAC points: innerMesh vertices on the pole side of the rim plane ──
    // The rim plane sits at rimTrimPercent% of the rim→pole distance.
    // normalVec points INTO the cup (toward the pole), so h = dot(p-planePoint, n)
    //   h >= 0  → vertex is between rim plane and pole  (keep)
    //   h <  0  → vertex is between rim plane and outside rim (discard)
    // At 0 % the plane is at the rim centroid, so virtually all inner-surface
    // vertices pass (no trimming). At 50 % only the deeper half is used, etc.
    // We always start from the full innerMesh so the point cloud never becomes
    // empty even at very high percentages — at worst a thin polar cap remains.
    const planeOffset = (params.rimTrimPercent / 100) * distToPolePre;
    const planePoint0 = rimCentroidPre.clone().add(normalVecPre.clone().multiplyScalar(planeOffset));
    const p0x = planePoint0.x, p0y = planePoint0.y, p0z = planePoint0.z;

    const points: [number, number, number][] = [];
    for (let i = 0; i < innerMesh.vertexCount; i++) {
      const h = (innerMesh.positions[i * 3]     - p0x) * nx0
              + (innerMesh.positions[i * 3 + 1] - p0y) * ny0
              + (innerMesh.positions[i * 3 + 2] - p0z) * nz0;
      if (h >= 0 && !this.state.excludedInnerMeshVertices.has(i)) {
        points.push([
          innerMesh.positions[i * 3],
          innerMesh.positions[i * 3 + 1],
          innerMesh.positions[i * 3 + 2],
        ]);
      }
    }
    console.log(`[DS RANSAC] rimTrim=${params.rimTrimPercent}%, points used for fitting: ${points.length} / ${innerMesh.vertexCount}`);
    if (points.length < 20) {
      throw new Error(`Not enough vertices above rim plane for sphere fitting (${points.length}). Lower the Rim Trim % value.`);
    }

    // Spatial downsampling: sphere fitting only needs ~15 k well-distributed points
    // (4 unknowns → system is massively overdetermined beyond that).
    // A uniform stride keeps the spatial coverage equivalent to the full cloud.
    const DS_MAX_FIT_POINTS = 15000;
    if (points.length > DS_MAX_FIT_POINTS) {
      const stride = Math.ceil(points.length / DS_MAX_FIT_POINTS);
      const sampled: [number, number, number][] = [];
      for (let i = 0; i < points.length; i += stride) sampled.push(points[i]);
      points.length = 0;
      for (const p of sampled) points.push(p);
      console.log(`[DS RANSAC] downsampled to ${points.length} points (stride=${stride})`);
    }

    const makeRange = (min: number, max: number, step: number): number[] => {
      const out: number[] = [];
      const safeStep = Math.max(1e-4, step);
      let v = min;
      while (v <= max + 1e-9) {
        out.push(Number(v.toFixed(6)));
        v += safeStep;
      }
      return out;
    };
    const mean = (arr: number[]): number => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
    const std = (arr: number[]): number => {
      if (arr.length <= 1) return 0;
      const m = mean(arr);
      return Math.sqrt(arr.reduce((acc, v) => acc + (v - m) * (v - m), 0) / arr.length);
    };
    const meanVec = (arr: [number, number, number][]): [number, number, number] => {
      if (arr.length === 0) return [0, 0, 0];
      let x = 0, y = 0, z = 0;
      for (const p of arr) {
        x += p[0];
        y += p[1];
        z += p[2];
      }
      return [x / arr.length, y / arr.length, z / arr.length];
    };

    const toFloatArray = (pts: [number, number, number][]): Float32Array => {
      const arr = new Float32Array(pts.length * 3);
      for (let i = 0; i < pts.length; i++) {
        arr[i * 3] = pts[i][0];
        arr[i * 3 + 1] = pts[i][1];
        arr[i * 3 + 2] = pts[i][2];
      }
      return arr;
    };

    const bootstrap = (pts: [number, number, number][], fraction = 0.85): [number, number, number][] => {
      const n = Math.max(20, Math.floor(pts.length * fraction));
      const out: [number, number, number][] = [];
      for (let i = 0; i < n; i++) {
        out.push(pts[Math.floor(Math.random() * pts.length)]);
      }
      return out;
    };

    const fitWithThreshold = (pts: [number, number, number][], thresh: number): SphereFitResult => {
      const base = fitSphereRobust(toFloatArray(pts), pts.length);
      const inliers: [number, number, number][] = [];
      const residualLimit = Math.max(1e-4, thresh);
      for (let i = 0; i < pts.length; i++) {
        if (Math.abs(base.residuals[i]) <= residualLimit) {
          inliers.push(pts[i]);
        }
      }
      if (inliers.length >= 20) {
        return fitSphereRobust(toFloatArray(inliers), inliers.length);
      }
      return base;
    };

    const thresh1Values = makeRange(params.doubleSphereThresh1Min, params.doubleSphereThresh1Max, params.doubleSphereSweepStep);
    const thresh2Values = makeRange(params.doubleSphereThresh2Min, params.doubleSphereThresh2Max, params.doubleSphereSweepStep);

    // Yields control to the browser event loop so the UI stays responsive.
    const yieldToUI = (): Promise<void> => new Promise<void>(r => setTimeout(r, 0));

    const cells: DoubleSphereSweepCellResult[] = [];
    let _debugLogged = false;
    for (let t1i = 0; t1i < thresh1Values.length; t1i++) {
      const thresh1 = thresh1Values[t1i];
      for (const thresh2 of thresh2Values) {
        const radii1: number[] = [];
        const radii2: number[] = [];
        const center1: [number, number, number][] = [];
        const center2: [number, number, number][] = [];
        const centerDistances: number[] = [];

        for (let iter = 0; iter < Math.max(1, params.doubleSphereIterations); iter++) {
          const sample1 = bootstrap(points);
          const sphere1 = fitWithThreshold(sample1, thresh1);

          // Adaptive factor: start at params.doubleSphereFactor and back down to
          // 1.001 so we always find a worn region even with minimal wear.
          const factorCandidates = [params.doubleSphereFactor, 1.01, 1.005, 1.001];
          let filtered: [number, number, number][] = [];
          for (const fc of factorCandidates) {
            filtered = points.filter((p) => {
              const dx = p[0] - sphere1.center.x;
              const dy = p[1] - sphere1.center.y;
              const dz = p[2] - sphere1.center.z;
              return Math.sqrt(dx * dx + dy * dy + dz * dz) > sphere1.radius * fc;
            });
            if (filtered.length >= 20) break;
          }

          // Diagnostic log on very first iteration to aid debugging
          if (!_debugLogged) {
            _debugLogged = true;
            const aboveR = points.filter((p) => {
              const dx = p[0] - sphere1.center.x;
              const dy = p[1] - sphere1.center.y;
              const dz = p[2] - sphere1.center.z;
              return Math.sqrt(dx * dx + dy * dy + dz * dz) > sphere1.radius;
            }).length;
            console.log(
              `[DS debug] sphere1 R=${sphere1.radius.toFixed(3)}mm ` +
              `center=(${sphere1.center.x.toFixed(2)},${sphere1.center.y.toFixed(2)},${sphere1.center.z.toFixed(2)}) ` +
              `points>${sphere1.radius.toFixed(2)}mm: ${aboveR} ` +
              `points>*${params.doubleSphereFactor}: ${filtered.length}`
            );
          }

          if (filtered.length < 20) continue;

          const sphere2 = fitWithThreshold(bootstrap(filtered), thresh2);
          const distance = sphere1.center.distanceTo(sphere2.center);

          radii1.push(sphere1.radius);
          radii2.push(sphere2.radius);
          center1.push([sphere1.center.x, sphere1.center.y, sphere1.center.z]);
          center2.push([sphere2.center.x, sphere2.center.y, sphere2.center.z]);
          centerDistances.push(distance);
        }

        if (centerDistances.length === 0) continue;

        cells.push({
          thresh1,
          thresh2,
          runs: centerDistances.length,
          radius1Mean: mean(radii1),
          radius1Std: std(radii1),
          radius2Mean: mean(radii2),
          radius2Std: std(radii2),
          center1Mean: meanVec(center1),
          center2Mean: meanVec(center2),
          centerDistanceMean: mean(centerDistances),
          centerDistanceStd: std(centerDistances),
        });
      }
      // Yield to UI after each thresh1 row and report real progress
      const sweepPct = 0.85 + 0.13 * ((t1i + 1) / thresh1Values.length);
      this.progress('double-sphere', sweepPct,
        `Double-sphere sweep: ${t1i + 1} / ${thresh1Values.length} rows done...`);
      await yieldToUI();
    }

    let bestCell: DoubleSphereSweepCellResult | null = null;
    for (const cell of cells) {
      if (!bestCell) {
        bestCell = cell;
        continue;
      }
      if (cell.centerDistanceStd < bestCell.centerDistanceStd - 1e-12) {
        bestCell = cell;
      } else if (
        Math.abs(cell.centerDistanceStd - bestCell.centerDistanceStd) <= 1e-12 &&
        cell.centerDistanceMean < bestCell.centerDistanceMean
      ) {
        bestCell = cell;
      }
    }

    const doubleSphereMetrics: DoubleSphereMetricsResult = {
      factor: params.doubleSphereFactor,
      iterations: params.doubleSphereIterations,
      thresh1Values,
      thresh2Values,
      cells,
      bestCell,
    };

    if (bestCell) {
      this.state.zoneSpheres = {
        wornSphere: {
          center: new THREE.Vector3(bestCell.center2Mean[0], bestCell.center2Mean[1], bestCell.center2Mean[2]),
          radius: bestCell.radius2Mean,
          rmsError: bestCell.radius2Std,
        },
        unwornSphere: {
          center: new THREE.Vector3(bestCell.center1Mean[0], bestCell.center1Mean[1], bestCell.center1Mean[2]),
          radius: bestCell.radius1Mean,
          rmsError: bestCell.radius1Std,
        },
      };
    }

    // --- Rim plane + volumetric wear (uses pre-computed rim geometry) ---
    // rimCentroidPre / normalVecPre / distToPolePre already computed above,
    // consistent with the RANSAC point filtering.
    let dsRimPlane: RimPlaneResult | undefined;
    let dsWearVolumeResult: WearVolumeResult | undefined;

    if (bestCell) {
      const planeOffset = (params.rimTrimPercent / 100) * distToPolePre;
      const planePoint = rimCentroidPre.clone().add(normalVecPre.clone().multiplyScalar(planeOffset));

      dsRimPlane = { point: planePoint, normal: normalVecPre.clone(), rimVertices: rimVertsPre };
      this.state.rimPlane = dsRimPlane;

      const sphere1Center = new THREE.Vector3(
        bestCell.center1Mean[0], bestCell.center1Mean[1], bestCell.center1Mean[2]);
      const meshEnclosedVolume = computeMeshEnclosedVolume(innerMesh, planePoint, normalVecPre);
      const sphereCapVolume = computeSphereCap(sphere1Center, bestCell.radius1Mean, planePoint, normalVecPre);
      const wearVolume = Math.max(0, meshEnclosedVolume - sphereCapVolume);

      dsWearVolumeResult = { meshEnclosedVolume, sphereCapVolume, wearVolume };
      this.state.wearVolume = dsWearVolumeResult;

      console.log(`[DS Volume] mesh=${meshEnclosedVolume.toFixed(4)}mm³, cap=${sphereCapVolume.toFixed(4)}mm³, wear=${wearVolume.toFixed(4)}mm³`);
    }

    this.state.results = {
      analysisMode: 'double-sphere-metrics',
      sphereFit: this.state.sphereFit,
      ellipsoidFit: null,
      geodesics: this.state.geodesics,
      geodesicCount: this.state.geodesics.length,
      totalAnomalyPoints: 0,
      bumpClusters: [],
      dipClusters: [],
      primaryWearZone: null,
      totalBumpVolume: 0,
      totalDipVolume: 0,
      totalWearVolume: dsWearVolumeResult?.wearVolume ?? bestCell?.centerDistanceMean ?? 0,
      wearVector: null,
      zoneSpheres: this.state.zoneSpheres ?? undefined,
      rimPlane: dsRimPlane,
      wearVolumeResult: dsWearVolumeResult,
      doubleSphereMetrics,
      processingTimeMs: 0,
      vertexCount: innerMesh.vertexCount,
      faceCount: innerMesh.faceCount,
    };

    return this.state.results;
  }

  /**
   * Re-compute only the rim plane position and volumetric wear for
   * double-sphere-metrics mode, using the pre-computed rim geometry stored
   * during the initial analysis. No RANSAC needed — fast for live slider updates.
   */
  stepUpdateDoubleSphereRimPlane(rimTrimPercent: number): void {
    const results = this.state.results;
    if (!results || results.analysisMode !== 'double-sphere-metrics') return;
    if (!this.state.separation) return;
    if (!this.state.dsRimCentroid || !this.state.dsRimNormal || this.state.dsDistToPole == null) return;

    const bestCell = results.doubleSphereMetrics?.bestCell;
    if (!bestCell) return;

    // Reuse pre-computed rim geometry (stored in stepDoubleSphereMetrics)
    const rimCentroid = this.state.dsRimCentroid;
    const normalVec = this.state.dsRimNormal;
    const distToPole = this.state.dsDistToPole;
    const rimVerts = this.state.dsRimVertices ?? [];

    const planeOffset = (rimTrimPercent / 100) * distToPole;
    const planePoint = rimCentroid.clone().add(normalVec.clone().multiplyScalar(planeOffset));

    const innerMesh = this.state.separation.inner;
    const dsRimPlane: RimPlaneResult = { point: planePoint, normal: normalVec.clone(), rimVertices: rimVerts };
    this.state.rimPlane = dsRimPlane;

    const sphere1Center = new THREE.Vector3(
      bestCell.center1Mean[0], bestCell.center1Mean[1], bestCell.center1Mean[2]);
    const meshEnclosedVolume = computeMeshEnclosedVolume(innerMesh, planePoint, normalVec);
    const sphereCapVolume = computeSphereCap(sphere1Center, bestCell.radius1Mean, planePoint, normalVec);
    const wearVolume = Math.max(0, meshEnclosedVolume - sphereCapVolume);
    const dsWearVolumeResult: WearVolumeResult = { meshEnclosedVolume, sphereCapVolume, wearVolume };
    this.state.wearVolume = dsWearVolumeResult;

    results.rimPlane = dsRimPlane;
    results.wearVolumeResult = dsWearVolumeResult;
    results.totalWearVolume = wearVolume;

    console.log(`[DS RimPlane Live] rimTrim=${rimTrimPercent}%, mesh=${meshEnclosedVolume.toFixed(4)}, cap=${sphereCapVolume.toFixed(4)}, wear=${wearVolume.toFixed(4)}mm³`);
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
  stepClassifyWear(rimTrimPercent: number = 6): WearClassification {
    if (!this.state.workingMesh) throw new Error('No working mesh available');
    if (!this.state.commercialSphere) throw new Error('Run commercial radius determination first');

    // Ensure classification uses the same unified rim plane used for enclosed-volume logic.
    if (!this.state.rimPlane) {
      this.stepComputeRimPlane(rimTrimPercent);
    }

    const mesh = this.state.workingMesh;
    const center = this.state.commercialSphere.center;
    const R = this.state.commercialSphere.commercialRadius;
    const threshold = R * 1.02;
    const rimPlane = this.state.rimPlane;

    const n = mesh.vertexCount;
    const isWorn = new Uint8Array(n);
    const distances = new Float32Array(n);
    const deviations = new Float32Array(n);
    let wornCount = 0;
    let activeCount = 0;

    for (let i = 0; i < n; i++) {
      const px = mesh.positions[i * 3];
      const py = mesh.positions[i * 3 + 1];
      const pz = mesh.positions[i * 3 + 2];

      const rimDist = rimPlane
        ? (px - rimPlane.point.x) * rimPlane.normal.x +
          (py - rimPlane.point.y) * rimPlane.normal.y +
          (pz - rimPlane.point.z) * rimPlane.normal.z
        : 1;

      // Outside rim plane: exclude from worn/unworn fitting and keep neutral heatmap value.
      if (rimDist < 0) {
        isWorn[i] = 0;
        distances[i] = R;
        deviations[i] = 0;
        continue;
      }

      activeCount++;

      const dx = px - center.x;
      const dy = py - center.y;
      const dz = pz - center.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      distances[i] = dist;
      deviations[i] = (dist - R) * 1000; // mm → μm

      if (dist > threshold) {
        isWorn[i] = 1;
        wornCount++;
      }
    }

    const denom = Math.max(1, activeCount);
    const unwornCount = Math.max(0, activeCount - wornCount);

    this.state.wearClassification = {
      isWorn,
      distances,
      wornCount,
      unwornCount,
      wornPercent: (wornCount / denom) * 100,
      threshold,
    };

    // Store deviations from commercial radius in μm for heatmap
    this.state.vertexDeviations = deviations;

    console.log(`[Wear Classification] active=${activeCount}, worn=${wornCount} (${this.state.wearClassification.wornPercent.toFixed(1)}%), unworn=${unwornCount}, threshold=${threshold.toFixed(3)}mm`);
    return this.state.wearClassification;
  }

  /**
   * Fit spheres with the commercial radius to worn and unworn vertex subsets.
   * Uses iterative center-only optimization (radius is fixed).
   * 
   * @param filter Filtering strategy to reduce noise in worn sphere fitting:
   *   - 'none': no filtering (original behavior)
   *   - 'robust-irls': Tukey bisquare IRLS reweighting of outlier vertices
   *   - 'dbscan-spatial': discard spatially isolated worn vertex clusters
   *   - 'combined': apply DBSCAN spatial filtering + IRLS robust fitting
   * @param minWornCoveragePct minimum % of active vertices that must be worn
   *   for linear wear to be considered reliable (default 1%)
   */
  stepFitZoneSpheres(
    filter: LinearWearFilter = 'combined',
    minWornCoveragePct: number = 1.0
  ): ZoneSphereResult {
    if (!this.state.workingMesh) throw new Error('No working mesh available');
    if (!this.state.wearClassification) throw new Error('Run wear classification first');
    if (!this.state.commercialSphere) throw new Error('Run commercial radius determination first');
    if (!this.state.rimPlane) throw new Error('Run rim plane computation first');

    const mesh = this.state.workingMesh;
    const { isWorn } = this.state.wearClassification;
    const R = this.state.commercialSphere.commercialRadius;
    const rim = this.state.rimPlane;

    // Collect worn and unworn vertex positions (inside rim plane only)
    const wornPositions: number[] = [];
    const unwornPositions: number[] = [];
    const wornVertexIndices: number[] = [];

    for (let i = 0; i < mesh.vertexCount; i++) {
      const px = mesh.positions[i * 3];
      const py = mesh.positions[i * 3 + 1];
      const pz = mesh.positions[i * 3 + 2];
      const rimDist = (px - rim.point.x) * rim.normal.x +
                      (py - rim.point.y) * rim.normal.y +
                      (pz - rim.point.z) * rim.normal.z;
      if (rimDist < 0) continue;

      if (isWorn[i]) {
        wornPositions.push(px, py, pz);
        wornVertexIndices.push(i);
      } else {
        unwornPositions.push(px, py, pz);
      }
    }

    const rawWornVertexCount = wornPositions.length / 3;
    let filteredWornPositions = wornPositions;
    let discardedClusters = 0;

    // --- Strategy: DBSCAN spatial pre-filter ---
    const useDbscan = filter === 'dbscan-spatial' || filter === 'combined';
    if (useDbscan && rawWornVertexCount >= 6) {
      const spatialResult = this.filterWornVerticesDbscan(
        wornPositions, wornVertexIndices, mesh
      );
      filteredWornPositions = spatialResult.filteredPositions;
      discardedClusters = spatialResult.discardedClusters;
      console.log(`[Zone Spheres] DBSCAN: ${rawWornVertexCount} → ${filteredWornPositions.length / 3} vertices (discarded ${discardedClusters} isolated clusters)`);
    }

    const filteredWornCount = filteredWornPositions.length / 3;

    // --- Strategy: minimum coverage guard ---
    const activeCount = rawWornVertexCount + unwornPositions.length / 3;
    const wornPercent = (filteredWornCount / Math.max(1, activeCount)) * 100;
    const isBelowMinCoverage = wornPercent < minWornCoveragePct;
    let linearWearUnreliable = false;
    let unreliableReason = '';

    if (filteredWornCount < 9) {
      linearWearUnreliable = true;
      unreliableReason = `Too few worn vertices after filtering (${filteredWornCount})`;
    } else if (isBelowMinCoverage) {
      linearWearUnreliable = true;
      unreliableReason = `Worn coverage ${wornPercent.toFixed(2)}% below minimum ${minWornCoveragePct}%`;
    }

    // --- Fit spheres ---
    const useRobust = filter === 'robust-irls' || filter === 'combined';

    const wornArr = new Float32Array(filteredWornPositions);
    const unwornArr = new Float32Array(unwornPositions);

    let wornFit: { center: THREE.Vector3; radius: number; rmsError: number };
    if (filteredWornPositions.length >= 9) {
      wornFit = useRobust
        ? fitSphereFixedRadiusRobust(wornArr, filteredWornPositions.length / 3, R)
        : fitSphereFixedRadius(wornArr, filteredWornPositions.length / 3, R);
    } else {
      wornFit = { center: this.state.commercialSphere.center.clone(), radius: R, rmsError: 0 };
    }

    const unwornFit = unwornPositions.length >= 9
      ? fitSphereFixedRadius(unwornArr, unwornPositions.length / 3, R)
      : { center: this.state.commercialSphere.center.clone(), radius: R, rmsError: 0 };

    this.state.zoneSpheres = {
      wornSphere: { center: wornFit.center, radius: R, rmsError: wornFit.rmsError },
      unwornSphere: { center: unwornFit.center, radius: R, rmsError: unwornFit.rmsError },
      filterUsed: filter,
      rawWornVertexCount: rawWornVertexCount,
      filteredWornVertexCount: filteredWornCount,
      discardedClusters,
      linearWearUnreliable,
      unreliableReason,
    };

    const linearMm = wornFit.center.distanceTo(unwornFit.center);
    console.log(`[Zone Spheres] filter=${filter}, worn RMS=${wornFit.rmsError.toFixed(4)}mm, unworn RMS=${unwornFit.rmsError.toFixed(4)}mm, linear=${(linearMm * 1000).toFixed(1)}μm` +
      (linearWearUnreliable ? ` ⚠ UNRELIABLE: ${unreliableReason}` : ''));

    return this.state.zoneSpheres;
  }

  /**
   * DBSCAN spatial filtering of worn vertices.
   * Clusters worn vertices and discards clusters that are too small
   * (likely noise/scan artifacts rather than real wear).
   */
  private filterWornVerticesDbscan(
    wornPositions: number[],
    _wornVertexIndices: number[],
    _mesh: MeshData
  ): { filteredPositions: number[]; discardedClusters: number } {
    const n = wornPositions.length / 3;
    if (n < 3) return { filteredPositions: wornPositions, discardedClusters: 0 };

    // DBSCAN parameters—use a larger eps than AnomalyRegistry since we're
    // working with contiguous mesh vertices, not geodesic sample points.
    const eps = 0.8; // mm
    const minClusterPoints = 5;
    // Minimum fraction of total worn vertices a cluster must have to be kept.
    const minClusterFraction = 0.05; // 5% of worn vertices

    // Simple grid-based DBSCAN
    const cellSize = eps;
    const inv = 1 / cellSize;
    const cells = new Map<string, number[]>();

    for (let i = 0; i < n; i++) {
      const cx = (wornPositions[i * 3] * inv) | 0;
      const cy = (wornPositions[i * 3 + 1] * inv) | 0;
      const cz = (wornPositions[i * 3 + 2] * inv) | 0;
      const key = `${cx}_${cy}_${cz}`;
      const arr = cells.get(key);
      if (arr) arr.push(i);
      else cells.set(key, [i]);
    }

    const queryBall = (idx: number): number[] => {
      const px = wornPositions[idx * 3];
      const py = wornPositions[idx * 3 + 1];
      const pz = wornPositions[idx * 3 + 2];
      const cx0 = (px * inv) | 0;
      const cy0 = (py * inv) | 0;
      const cz0 = (pz * inv) | 0;
      const eps2 = eps * eps;
      const result: number[] = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const key = `${cx0 + dx}_${cy0 + dy}_${cz0 + dz}`;
            const cell = cells.get(key);
            if (!cell) continue;
            for (const j of cell) {
              const ddx = wornPositions[j * 3] - px;
              const ddy = wornPositions[j * 3 + 1] - py;
              const ddz = wornPositions[j * 3 + 2] - pz;
              if (ddx * ddx + ddy * ddy + ddz * ddz <= eps2) {
                result.push(j);
              }
            }
          }
        }
      }
      return result;
    };

    // DBSCAN
    const labels = new Int32Array(n).fill(-1);
    let clusterId = 0;

    for (let i = 0; i < n; i++) {
      if (labels[i] !== -1) continue;
      const neighbors = queryBall(i);
      if (neighbors.length < minClusterPoints) {
        labels[i] = -2; // noise
        continue;
      }
      labels[i] = clusterId;
      const seedSet = new Set(neighbors);
      const seedArr = [...seedSet];
      while (seedArr.length > 0) {
        const j = seedArr.pop()!;
        if (labels[j] === -2) { labels[j] = clusterId; }
        if (labels[j] !== -1) continue;
        labels[j] = clusterId;
        const jNeighbors = queryBall(j);
        if (jNeighbors.length >= minClusterPoints) {
          for (const k of jNeighbors) {
            if (!seedSet.has(k)) {
              seedSet.add(k);
              seedArr.push(k);
            }
          }
        }
      }
      clusterId++;
    }

    // Count cluster sizes
    const clusterSizes = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      if (labels[i] >= 0) {
        clusterSizes.set(labels[i], (clusterSizes.get(labels[i]) || 0) + 1);
      }
    }

    // Keep clusters with enough points
    const minSize = Math.max(minClusterPoints, Math.floor(n * minClusterFraction));
    const keepClusters = new Set<number>();
    let discarded = 0;
    for (const [id, size] of clusterSizes) {
      if (size >= minSize) {
        keepClusters.add(id);
      } else {
        discarded++;
      }
    }

    // If all clusters are discarded, keep the largest one
    if (keepClusters.size === 0 && clusterSizes.size > 0) {
      let maxSize = 0, maxId = 0;
      for (const [id, size] of clusterSizes) {
        if (size > maxSize) { maxSize = size; maxId = id; }
      }
      keepClusters.add(maxId);
      discarded--;
    }

    // Collect filtered positions
    const filtered: number[] = [];
    for (let i = 0; i < n; i++) {
      if (keepClusters.has(labels[i])) {
        filtered.push(wornPositions[i * 3], wornPositions[i * 3 + 1], wornPositions[i * 3 + 2]);
      }
    }

    return { filteredPositions: filtered, discardedClusters: discarded };
  }

  /**
   * Compute the rim plane from the real cup border (untrimmed inner surface).
   * The plane is parallel to the border plane and translated toward the pole
   * by rimTrimPercent% of the border-centroid-to-pole distance.
   * This same plane is used for both mesh enclosed volume and sphere cap volume.
   */
  stepComputeRimPlane(rimTrimPercent: number = 6): RimPlaneResult {
    if (!this.state.realRimCentroid) throw new Error('Run geodesics first (real rim data needed)');
    if (!this.state.realRimPlaneNormal) throw new Error('Run geodesics first (real rim data needed)');
    if (!this.state.polePosition) throw new Error('No pole position available');

    // Use the same normal selection logic as stepTrimRim so the volume cut plane
    // is always consistent with the actual trim used for the working mesh:
    //   1. Explicit manual rim plane normal (set via setRimPlaneNormal)
    //   2. Auto mode with inclination/azimuth: compute tilted normal from angles
    //   3. Auto mode, no tilt: PCA-fitted normal from the physical boundary
    let normalSrc: THREE.Vector3;
    if (this.state.rimPlaneNormal) {
      normalSrc = new THREE.Vector3(...this.state.rimPlaneNormal);
    } else if (
      (this.state.rimInclinationAngleDeg !== 0 || this.state.rimInclinationAzimuthDeg !== 0) &&
      this.state.separation
    ) {
      // Mirror stepTrimRim: compute the tilted normal from user inclination/azimuth
      const v = computeTiltedRimNormal(
        this.state.separation.cupAxis,
        this.state.rimInclinationAngleDeg,
        this.state.rimInclinationAzimuthDeg,
      );
      normalSrc = new THREE.Vector3(v.x, v.y, v.z);
    } else {
      normalSrc = this.state.realRimPlaneNormal.clone();
    }
    const normal = normalSrc.normalize();

    // Orient normal toward the pole so h>0 always means "toward the interior".
    const toPole = this.state.polePosition.clone().sub(this.state.realRimCentroid.clone());
    if (toPole.dot(normal) < 0) {
      normal.negate();
    }

    // Compute the plane anchor using EXACTLY the same arithmetic as stepTrimRim/trimRim
    // so the volume cut plane is at the same position as the visual trim and preview disc.
    //
    //   Auto   mode: trimRim uses meshCentroid + cupAxis × threshA
    //                threshA = maxHA ∓ (pct/100) × (maxHA − minHA)
    //   Manual mode: trimRim uses manualRimBasePoint + normal × (pct/100) × (maxHA − minHA)
    //
    // Previously this function used (polePosition − rimCentroid)·normal as the scale,
    // which is ~14 mm for a 16 mm cup vs the ~9 mm span used by trimRim — a systematic
    // ~0.7–1 mm plane offset that made the numerical wear volume inconsistent with the
    // visual trim.
    if (!this.state.separation) throw new Error('Run face separation first');
    const ca = this.state.separation.cupAxis;
    const rimAnchor = computeRimAnchor(this.state.separation.inner, ca);
    const range = rimAnchor.maxHA - rimAnchor.minHA;
    let planePoint: THREE.Vector3;
    if (this.state.manualRimBasePoint) {
      // Manual mode — mirror _computeManualPlaneAnchor exactly
      const shift = (rimTrimPercent / 100) * range;
      planePoint = new THREE.Vector3(...this.state.manualRimBasePoint)
        .addScaledVector(normal, shift);
    } else {
      // Auto mode — mirror trimRim's inner anchor computation exactly
      const [ax, ay, az] = ca;
      const threshA = rimAnchor.rimAtHighEnd
        ? rimAnchor.maxHA - (rimTrimPercent / 100) * range
        : rimAnchor.minHA + (rimTrimPercent / 100) * range;
      planePoint = new THREE.Vector3(
        rimAnchor.cx + ax * threshA,
        rimAnchor.cy + ay * threshA,
        rimAnchor.cz + az * threshA,
      );
    }

    this.state.rimPlane = {
      point: planePoint,
      normal: normal,
      rimVertices: [],
    };

    const src = this.state.rimPlaneNormal ? 'manual' : 'auto-PCA';
    console.log(`[Rim Plane] source=${src}, center=(${planePoint.x.toFixed(3)}, ${planePoint.y.toFixed(3)}, ${planePoint.z.toFixed(3)}), normal=(${normal.x.toFixed(4)}, ${normal.y.toFixed(4)}, ${normal.z.toFixed(4)}), range=${range.toFixed(4)}mm, pct=${rimTrimPercent}%`);
    return this.state.rimPlane;
  }

  /**
   * Compute wear volume for the Sphere BestFit pipeline.
   * Wear = (mesh enclosed volume cut by rim plane) - (unworn sphere cap volume cut by same plane)
   */
  stepComputeWearVolumeBestFit(): WearVolumeResult {
    if (!this.state.separation) throw new Error('Run face separation first');
    if (!this.state.rimPlane) throw new Error('Run rim plane computation first');
    if (!this.state.commercialSphere) throw new Error('Run commercial radius determination first');
    if (!this.state.sphereFit) throw new Error('Run sphere fit first');

    const { point: planePoint, normal: planeNormal } = this.state.rimPlane;
    // Use the commercial sphere for the cap: its center comes from the general
    // sphere fit (all vertices) so it's geometrically consistent with the rim plane.
    // The unworn sphere center is fitted only to trimmed-mesh non-worn vertices,
    // which pushes it too deep inside the cup relative to the full rim opening.
    const capCenter = this.state.commercialSphere.center;
    const capRadius = this.state.commercialSphere.commercialRadius;

    // Volume enclosed between the untrimmed inner face and the rim plane
    const innerMesh = this.state.separation!.inner;
    const meshEnclosedVolume = computeMeshEnclosedVolume(
      innerMesh,
      planePoint,
      planeNormal
    );

    // Volume of the commercial sphere cap on the interior side of the rim plane
    const sphereCapVolume = computeSphereCap(
      capCenter,
      capRadius,
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
      vertexCount: innerMesh.vertexCount,
      faceCount: innerMesh.faceCount,
    };

    console.log(`[Wear Volume] mesh=${meshEnclosedVolume.toFixed(4)}mm³, sphereCap=${sphereCapVolume.toFixed(4)}mm³, wear=${wearVolume.toFixed(4)}mm³`);
    // Debug: log sphere-to-plane signed distance for verification
    const pn = planeNormal.clone().normalize();
    const dCenter = (capCenter.x - planePoint.x) * pn.x +
                    (capCenter.y - planePoint.y) * pn.y +
                    (capCenter.z - planePoint.z) * pn.z;
    console.log(`[Wear Volume Debug] capR=${capRadius.toFixed(4)}, d(center→plane)=${dCenter.toFixed(4)}, h=${(capRadius + dCenter).toFixed(4)}`);
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
