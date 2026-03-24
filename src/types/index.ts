// ============================================================
// GeoWear — Shared Type Definitions
// ============================================================

import * as THREE from 'three';

/** Known commercial femoral head radii (mm) */
export const COMMERCIAL_RADII: number[] = [14, 16, 18, 20];

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
  isRegular: boolean;      // true if curvature is consistent with regular sphere
}

/** Double geodesic: two opposing geodesics combined edge-to-edge through the pole */
export interface DoubleGeodesic {
  angleA: number;          // first geodesic angle (e.g., 0°)
  angleB: number;          // opposite geodesic angle (e.g., 180°)
  points: GeodesicPoint[]; // combined points: rimA → pole → rimB
  totalLength: number;     // total arc length edge-to-edge
  poleIndex: number;       // index of pole point in combined array
  geodesicA: Geodesic;     // reference to original geodesic A
  geodesicB: Geodesic;     // reference to original geodesic B
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

/** Commercial sphere info after radius snapping */
export interface CommercialSphereInfo {
  geodesicRadius: number;       // original sphere fit radius (mm)
  commercialRadius: number;     // snapped commercial radius (mm)
  center: THREE.Vector3;        // same center as geodesic sphere
  autoDetected: boolean;        // true if auto, false if manual
}

/** Per-vertex wear classification */
export interface WearClassification {
  isWorn: Uint8Array;           // per-vertex: 0=unworn, 1=worn
  distances: Float32Array;      // per-vertex absolute distance to center (mm)
  wornCount: number;
  unwornCount: number;
  wornPercent: number;
  threshold: number;            // 1.02 * commercialRadius
}

/** Sphere fit with fixed radius for worn/unworn zones */
export interface ZoneSphereResult {
  wornSphere: { center: THREE.Vector3; radius: number; rmsError: number };
  unwornSphere: { center: THREE.Vector3; radius: number; rmsError: number };
}

/** Rim plane for volume computation */
export interface RimPlaneResult {
  point: THREE.Vector3;         // point on the plane (rim centroid)
  normal: THREE.Vector3;        // plane normal (pointing inward)
  rimVertices: number[];        // indices of rim boundary vertices
}

/** Wear volume result */
export interface WearVolumeResult {
  meshEnclosedVolume: number;   // mm³ — volume between rim plane and inner mesh
  sphereCapVolume: number;      // mm³ — volume of unworn sphere cut by rim plane
  wearVolume: number;           // mm³ — difference = wear
}

/** Wear plane through pole and max-wear point, perpendicular to rim plane */
export interface WearPlaneResult {
  maxWearPoint: THREE.Vector3;    // vertex with maximum wear depth
  maxWearDepth: number;           // μm — deviation at that vertex
  planePoint: THREE.Vector3;      // point on the wear plane (pole)
  planeNormal: THREE.Vector3;     // normal of the wear plane
}

/** Complete analysis results */
export interface AnalysisResults {
  // Analysis mode
  analysisMode: 'pure-geodesic' | 'sphere-bestfit';

  // Geometry
  sphereFit: SphereFitResult;
  ellipsoidFit: EllipsoidFitResult | null;
  
  // Geodesics
  geodesics: Geodesic[];
  geodesicCount: number;
  
  // --- Pure Geodesic mode fields ---
  totalAnomalyPoints: number;
  bumpClusters: AnomalyCluster[];
  dipClusters: AnomalyCluster[];
  primaryWearZone: AnomalyCluster | null;
  totalBumpVolume: number;  // mm³
  totalDipVolume: number;   // mm³
  totalWearVolume: number;  // mm³ (absolute)
  wearVector: {
    deepestPoint: THREE.Vector3;
    polePoint: THREE.Vector3;
    direction: THREE.Vector3;
    angle: number;           // degrees from pole axis
    distance: number;        // mm
    maxDepth: number;        // μm
  } | null;

  // --- Sphere BestFit mode fields ---
  commercialSphere?: CommercialSphereInfo;
  wearClassification?: WearClassification;
  zoneSpheres?: ZoneSphereResult;
  rimPlane?: RimPlaneResult;
  wearVolumeResult?: WearVolumeResult;
  wearPlane?: WearPlaneResult;
  
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
  rimTrimPercent: number;      // default 6
  repairInnerFace: boolean;    // optional inner-face cleanup before trimming/analysis
  smoothingIterations: number; // Taubin smoothing iterations, default 3
  thresholdMicrons: number;    // default 1.0
  colorMapName: string;        // 'rainbow' | 'cooltowarm'
  colorRangeMin: number;       // μm
  colorRangeMax: number;       // μm
  showWireframe: boolean;
  geodesicDisplayMode: string;   // 'all' | 'regular' | 'irregular' | 'none'
  showHeatmap: boolean;
  showAnnotations: boolean;
  showReferenceShape: boolean;
  contextOpaque: boolean;       // false = translucent (default), true = opaque
  density: number;             // UHMWPE density g/cm³, default 0.935
  analysisMode: 'pure-geodesic' | 'sphere-bestfit'; // wear calculation model
  commercialRadius: number;    // 0 = auto-detect, or 14|16|18|20 mm
  showCommercialSphere: boolean;
  showWornSphere: boolean;
  showUnwornSphere: boolean;
  showRimPlane: boolean;
  showWearPlane: boolean;
  showMeshVolume: boolean;
  showSphereCapVolume: boolean;
  showWearVolume: boolean;
  showOriginalMesh: boolean;
}

export const DEFAULT_PARAMS: AnalysisParams = {
  geodesicCount: 360,
  rimTrimPercent: 6,
  repairInnerFace: false,
  smoothingIterations: 3,
  thresholdMicrons: 1.0,
  colorMapName: 'rainbow',
  colorRangeMin: 0,
  colorRangeMax: 50,
  showWireframe: false,
  geodesicDisplayMode: 'all',
  showHeatmap: true,
  showAnnotations: false,
  showReferenceShape: false,
  contextOpaque: false,
  density: 0.935,
  analysisMode: 'sphere-bestfit',
  commercialRadius: 0,
  showCommercialSphere: false,
  showWornSphere: true,
  showUnwornSphere: true,
  showRimPlane: false,
  showWearPlane: false,
  showMeshVolume: false,
  showSphereCapVolume: false,
  showWearVolume: false,
  showOriginalMesh: false,
};
