// ============================================================
// GeoWear — WearAnalysis Pipeline
// Orchestrates the full analysis pipeline
// ============================================================

import * as THREE from 'three';
import type {
  MeshData, SeparationResult, TrimResult, SphereFitResult,
  EllipsoidFitResult, Geodesic, AnalysisResults, AnomalyCluster,
  AnalysisParams
} from '../types';
import { separateFaces, trimRim } from './MeshProcessor';
import { smoothMesh } from './MeshSmoother';
import { fitSphereRobust } from './SphereFitter';
import { fitEllipsoid } from './EllipsoidFitter';
import { MeshGraph } from '../math/MeshGraph';
import { computeGeodesics, findPoleVertex } from './GeodesicSolver';
import { analyzeDeviations, computeVertexDeviations } from './DeviationAnalyzer';
import { clusterAnomalies, findPrimaryWearZone } from './AnomalyRegistry';
import { computeDefectVolumes, computeWearVector } from './VolumeComputer';

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
  vertexDeviations: Float32Array | null;
  results: AnalysisResults | null;
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
    vertexDeviations: null,
    results: null,
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

    // Step 5: Fit ellipsoid
    this.progress('fitting', 0.85, 'Fitting ellipsoid...');
    this.stepFitEllipsoid();

    // Step 6: Analyze deviations
    this.progress('analyzing', 0.85, 'Analyzing deviations...');
    this.stepAnalyzeDeviations(params.thresholdMicrons);

    // Step 7: Compute volumes
    this.progress('volumes', 0.92, 'Computing defect volumes...');
    this.stepComputeVolumes(params.thresholdMicrons, params.density);

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

    // If geodesics are available, fit using only regular geodesic vertices
    if (this.state.geodesics.length > 0) {
      const regularVertexSet = new Set<number>();
      for (const geo of this.state.geodesics) {
        if (geo.isRegular) {
          for (const p of geo.points) {
            regularVertexSet.add(p.vertexIndex);
          }
        }
      }

      // If we have enough regular vertices, fit with those only
      if (regularVertexSet.size >= 20) {
        const regularPositions = new Float32Array(regularVertexSet.size * 3);
        let idx = 0;
        for (const vi of regularVertexSet) {
          regularPositions[idx++] = mesh.positions[vi * 3];
          regularPositions[idx++] = mesh.positions[vi * 3 + 1];
          regularPositions[idx++] = mesh.positions[vi * 3 + 2];
        }
        this.state.sphereFit = fitSphereRobust(regularPositions, regularVertexSet.size);
        return this.state.sphereFit;
      }
    }

    // Fallback: fit with all vertices
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
    const cupAxis = this.state.separation.cupAxis;

    // Compute centroid as reference center (no sphere fit needed yet)
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      cx += mesh.positions[i];
      cy += mesh.positions[i + 1];
      cz += mesh.positions[i + 2];
    }
    cx /= mesh.vertexCount;
    cy /= mesh.vertexCount;
    cz /= mesh.vertexCount;
    const referenceCenter: [number, number, number] = [cx, cy, cz];
    this.state.referenceCenter = referenceCenter;

    // Build mesh graph
    this.progress('geodesics', 0.3, 'Building mesh adjacency graph...');
    this.state.graph = MeshGraph.build(mesh.positions, mesh.indices, mesh.vertexCount);

    // Find pole using centroid as reference
    this.state.poleVertex = findPoleVertex(
      mesh.positions, mesh.vertexCount, referenceCenter, cupAxis
    );
    this.state.polePosition = new THREE.Vector3(
      mesh.positions[this.state.poleVertex * 3],
      mesh.positions[this.state.poleVertex * 3 + 1],
      mesh.positions[this.state.poleVertex * 3 + 2],
    );

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
            this.progress('geodesics', 0.3 + progress * 0.45, `Computing geodesic ${Math.round(progress * geodesicCount)}/${geodesicCount}`);
          }
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
      sphereFit: this.state.sphereFit,
      ellipsoidFit: this.state.ellipsoidFit!,
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

    // Compute wear vector
    if (this.state.results.primaryWearZone && this.state.polePosition && this.state.separation) {
      const cupAxisVec = new THREE.Vector3(...this.state.separation.cupAxis);
      this.state.results.wearVector = computeWearVector(
        this.state.results.primaryWearZone,
        this.state.polePosition,
        this.state.sphereFit.center,
        cupAxisVec
      );
    }
  }
}
