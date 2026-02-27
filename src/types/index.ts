// ============================================================
// GeoWear — Shared Type Definitions
// ============================================================

import * as THREE from 'three';

/** Raw vertex data transferred between main thread and workers */
export interface MeshData {
  positions: Float32Array; // xyz interleaved
  normals: Float32Array;   // xyz interleaved
  indices: Uint32Array;    // triangle indices
  vertexCount: number;
  faceCount: number;
}

/** Result of inner/outer face separation */
export interface SeparationResult {
  inner: MeshData;
  outer: MeshData;
  centroid: [number, number, number];
  cupAxis: [number, number, number]; // axis from rim to pole
}

/** Trimmed mesh result after rim removal */
export interface TrimResult {
  mesh: MeshData;                 // trimmed inner surface
  rimMesh: MeshData;              // removed rim part (transparent reference)
  rimPercentRemoved: number;
  heightRange: [number, number];
}

/** Sphere fit result */
export interface SphereFitResult {
  center: THREE.Vector3;
  radius: number;
  rmsError: number;       // root mean square residual
  maxError: number;        // max absolute residual
  residuals: Float32Array; // per-vertex residual (deviation from sphere)
}

/** Ellipsoid fit result */
export interface EllipsoidFitResult {
  center: THREE.Vector3;
  semiAxes: [number, number, number];  // sorted ascending
  rotationMatrix: THREE.Matrix3;       // axes orientation
  sphericityPercent: number;           // 100 = perfect sphere
  shapeClass: 'sphere' | 'slight-ellipsoid' | 'significant-ellipsoid';
  rmsError: number;
}

/** Single point on a geodesic path */
export interface GeodesicPoint {
  vertexIndex: number;
  position: [number, number, number];
  arcLength: number;       // cumulative arc length from pole
  deviation: number;       // radial deviation from reference sphere (μm)
  derivative: number;      // first derivative of deviation along arc
  secondDerivative: number;
}

/** Complete geodesic (meridian) */
export interface Geodesic {
  angle: number;           // degrees [0, 360)
  points: GeodesicPoint[];
  totalLength: number;
  maxDeviation: number;
  minDeviation: number;
  anomalyCount: number;
}

/** Anomaly classification */
export type AnomalyType = 'bump' | 'dip';

/** Individual anomaly point */
export interface AnomalyPoint {
  position: THREE.Vector3;
  deviation: number;        // μm
  type: AnomalyType;
  geodesicAngle: number;    // degrees
  arcLength: number;        // mm
  derivative: number;
  vertexIndex: number;
}

/** Clustered anomaly region */
export interface AnomalyCluster {
  id: number;
  type: AnomalyType;
  points: AnomalyPoint[];
  centroid: THREE.Vector3;
  area: number;             // mm²
  volume: number;           // mm³
  avgDeviation: number;     // μm
  maxDeviation: number;     // μm (absolute)
  minDeviation: number;     // μm
  maxDeviationPoint: THREE.Vector3;
}

/** Complete analysis results */
export interface AnalysisResults {
  // Geometry
  sphereFit: SphereFitResult;
  ellipsoidFit: EllipsoidFitResult;
  
  // Geodesics
  geodesics: Geodesic[];
  geodesicCount: number;
  
  // Anomalies
  totalAnomalyPoints: number;
  bumpClusters: AnomalyCluster[];
  dipClusters: AnomalyCluster[];
  primaryWearZone: AnomalyCluster | null;
  
  // Volumes
  totalBumpVolume: number;  // mm³
  totalDipVolume: number;   // mm³
  totalWearVolume: number;  // mm³ (absolute)
  
  // Wear vector
  wearVector: {
    deepestPoint: THREE.Vector3;
    polePoint: THREE.Vector3;
    direction: THREE.Vector3;
    angle: number;           // degrees from pole axis
    distance: number;        // mm
    maxDepth: number;        // μm
  } | null;
  
  // Processing info
  processingTimeMs: number;
  vertexCount: number;
  faceCount: number;
}

/** Worker message types */
export type WorkerMessageType =
  | 'parse-stl'
  | 'separate-faces'
  | 'trim-rim'
  | 'build-graph'
  | 'compute-geodesics'
  | 'analyze-deviations'
  | 'compute-volumes'
  | 'progress'
  | 'error'
  | 'result';

export interface WorkerMessage {
  type: WorkerMessageType;
  payload: unknown;
  id?: string;
}

export interface ProgressMessage {
  type: 'progress';
  payload: {
    stage: string;
    progress: number;    // 0-1
    message: string;
  };
}

/** Pipeline stages */
export type PipelineStage =
  | 'idle'
  | 'loading'
  | 'separating'
  | 'trimming'
  | 'fitting-sphere'
  | 'fitting-ellipsoid'
  | 'computing-geodesics'
  | 'analyzing-deviations'
  | 'computing-volumes'
  | 'rendering-heatmap'
  | 'complete'
  | 'error';

/** Application state */
export interface AppState {
  stage: PipelineStage;
  fileName: string | null;
  originalMesh: MeshData | null;
  innerMesh: MeshData | null;
  trimmedMesh: MeshData | null;
  results: AnalysisResults | null;
  params: AnalysisParams;
}

/** User-configurable parameters */
export interface AnalysisParams {
  geodesicCount: number;       // default 360
  rimTrimPercent: number;      // default 7
  thresholdMicrons: number;    // default 1.0
  colorMapName: string;        // 'rainbow' | 'cooltowarm'
  colorRangeMin: number;       // μm
  colorRangeMax: number;       // μm
  showWireframe: boolean;
  showGeodesics: boolean;
  showHeatmap: boolean;
  showAnnotations: boolean;
  showReferenceShape: boolean;
  density: number;             // UHMWPE density g/cm³, default 0.935
}

export const DEFAULT_PARAMS: AnalysisParams = {
  geodesicCount: 360,
  rimTrimPercent: 7,
  thresholdMicrons: 1.0,
  colorMapName: 'rainbow',
  colorRangeMin: -50,
  colorRangeMax: 50,
  showWireframe: false,
  showGeodesics: true,
  showHeatmap: true,
  showAnnotations: true,
  showReferenceShape: false,
  density: 0.935,
};
