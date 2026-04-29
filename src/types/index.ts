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
  rimAtHighEnd: boolean;          // true = rim at maxH end (normal points toward rim)
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

/** Linear wear filtering strategies */
export type LinearWearFilter = 'none' | 'robust-irls' | 'dbscan-spatial' | 'combined';

/** Sphere fit with fixed radius for worn/unworn zones */
export interface ZoneSphereResult {
  wornSphere: { center: THREE.Vector3; radius: number; rmsError: number };
  unwornSphere: { center: THREE.Vector3; radius: number; rmsError: number };
  /** Applied filtering strategy */
  filterUsed?: LinearWearFilter;
  /** Original (unfiltered) worn vertex count before spatial filtering */
  rawWornVertexCount?: number;
  /** Worn vertex count after spatial filtering */
  filteredWornVertexCount?: number;
  /** How many isolated worn clusters were discarded */
  discardedClusters?: number;
  /** Linear wear is unreliable (too few worn vertices after filtering) */
  linearWearUnreliable?: boolean;
  /** Reason for unreliability */
  unreliableReason?: string;
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
export type AnalysisMode =
  | 'pure-geodesic'
  | 'sphere-bestfit'
  | 'double-sphere-metrics'
  | 'compare-all-modes';

export interface DoubleSphereSweepCellResult {
  thresh1: number;
  thresh2: number;
  runs: number;
  radius1Mean: number;
  radius1Std: number;
  radius2Mean: number;
  radius2Std: number;
  center1Mean: [number, number, number];
  center2Mean: [number, number, number];
  centerDistanceMean: number;
  centerDistanceStd: number;
}

export interface DoubleSphereMetricsResult {
  factor: number;
  iterations: number;
  thresh1Values: number[];
  thresh2Values: number[];
  cells: DoubleSphereSweepCellResult[];
  bestCell: DoubleSphereSweepCellResult | null;
}

export interface AnalysisResults {
  // Analysis mode
  analysisMode: Exclude<AnalysisMode, 'compare-all-modes'>;

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
  doubleSphereMetrics?: DoubleSphereMetricsResult;
  
  // Processing info
  processingTimeMs: number;
  vertexCount: number;
  faceCount: number;
}

export interface MultiModeComparisonResults {
  analysisMode: 'compare-all-modes';
  pureGeodesic: AnalysisResults;
  sphereBestfit: AnalysisResults;
  doubleSphereMetrics: AnalysisResults;
  summary: {
    pureGeodesicWearVolumeMm3: number;
    sphereBestfitWearVolumeMm3: number;
    doubleSphereLinearWearMm: number;
  };
  processingTimeMs: number;
}

export type AnalysisRunResult = AnalysisResults | MultiModeComparisonResults;

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
  results: AnalysisRunResult | null;
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
  analysisMode: AnalysisMode; // wear calculation model
  commercialRadius: number;    // 0 = auto-detect, or 14|16|18|20 mm
  linearWearFilter: LinearWearFilter; // filtering strategy for linear wear
  minWornCoveragePct: number;          // minimum % of worn vertices to consider linear wear reliable
  doubleSphereFactor: number;          // factor to filter non-worn points after sphere1 fit
  doubleSphereIterations: number;      // runs per (thresh1, thresh2) cell
  doubleSphereThresh1Min: number;
  doubleSphereThresh1Max: number;
  doubleSphereThresh2Min: number;
  doubleSphereThresh2Max: number;
  doubleSphereSweepStep: number;
  showCommercialSphere: boolean;
  showWornSphere: boolean;
  showUnwornSphere: boolean;
  showRimPlane: boolean;
  showWearPlane: boolean;
  showMeshVolume: boolean;
  showSphereCapVolume: boolean;
  showWearVolume: boolean;
  showOriginalMesh: boolean;
  yearsInVivo: number;         // 0 = unknown; if >0, wear rates (mm/year, mm³/year) are shown
  showExcludedVertices: boolean; // highlight excluded vertices in the viewer
  rimInclinationAngle: number;  // degrees: tilt the rim cut-plane away from the cup axis (0 = auto)
  rimInclinationAzimuth: number; // degrees: direction of tilt in the plane perpendicular to cup axis
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
  linearWearFilter: 'combined',
  minWornCoveragePct: 1.0,
  doubleSphereFactor: 1.02,
  doubleSphereIterations: 6,
  doubleSphereThresh1Min: 0.08,
  doubleSphereThresh1Max: 0.2,
  doubleSphereThresh2Min: 0.08,
  doubleSphereThresh2Max: 0.2,
  doubleSphereSweepStep: 0.02,
  showCommercialSphere: false,
  showWornSphere: true,
  showUnwornSphere: true,
  showRimPlane: true,
  showWearPlane: false,
  showMeshVolume: false,
  showSphereCapVolume: false,
  showWearVolume: false,
  showOriginalMesh: true,
  yearsInVivo: 0,
  showExcludedVertices: true,
  rimInclinationAngle: 0,
  rimInclinationAzimuth: 0,
};
