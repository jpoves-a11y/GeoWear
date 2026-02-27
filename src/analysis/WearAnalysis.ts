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
  graph: MeshGraph | null;
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
    graph: null,
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

    // Step 3: Fit sphere
    this.progress('fitting', 0.2, 'Fitting reference sphere...');
    this.stepFitSphere();

    // Step 4: Fit ellipsoid
    this.progress('fitting', 0.25, 'Fitting ellipsoid...');
    this.stepFitEllipsoid();

    // Step 5: Build graph and compute geodesics
    this.progress('geodesics', 0.3, `Computing ${params.geodesicCount} geodesics...`);
    await this.stepComputeGeodesicsAsync(params.geodesicCount);

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
    return this.state.trimResult;
  }

  stepFitSphere(): SphereFitResult {
    if (!this.state.workingMesh) throw new Error('No working mesh available');

    this.state.sphereFit = fitSphereRobust(
      this.state.workingMesh.positions,
      this.state.workingMesh.vertexCount
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
    if (!this.state.sphereFit) throw new Error('Run sphere fit first');
    if (!this.state.separation) throw new Error('Run separation first');

    const mesh = this.state.workingMesh;
    const sphereCenter: [number, number, number] = [
      this.state.sphereFit.center.x,
      this.state.sphereFit.center.y,
      this.state.sphereFit.center.z,
    ];
    const cupAxis = this.state.separation.cupAxis;

    // Build mesh graph
    this.progress('geodesics', 0.3, 'Building mesh adjacency graph...');
    this.state.graph = MeshGraph.build(mesh.positions, mesh.indices, mesh.vertexCount);

    // Find pole
    this.state.poleVertex = findPoleVertex(
      mesh.positions, mesh.vertexCount, sphereCenter, cupAxis
    );
    this.state.polePosition = new THREE.Vector3(
      mesh.positions[this.state.poleVertex * 3],
      mesh.positions[this.state.poleVertex * 3 + 1],
      mesh.positions[this.state.poleVertex * 3 + 2],
    );

    // Compute geodesics (with yield for UI updates)
    this.state.geodesics = await new Promise<Geodesic[]>((resolve) => {
      // Use setTimeout to allow UI to update between batches
      setTimeout(() => {
        const result = computeGeodesics(
          mesh.positions,
          mesh.vertexCount,
          this.state.graph!,
          this.state.poleVertex,
          sphereCenter,
          cupAxis,
          geodesicCount,
          (progress: number) => {
            this.progress('geodesics', 0.3 + progress * 0.55, `Computing geodesic ${Math.round(progress * geodesicCount)}/${geodesicCount}`);
          }
        );
        resolve(result);
      }, 0);
    });

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
