// ============================================================
// GeoWear — Shared Type Definitions
// ============================================================

import * as THREE from 'three';

/** Generate the list of commercial femoral head radii (even mm values) up to a given maximum */
export function commercialRadiiUpTo(maxR: number): number[] {
  const list: number[] = [];
  for (let r = 10; r <= maxR; r += 2) list.push(r);
  return list;
}
/** Known commercial femoral head radii (mm) — kept for backward compatibility */
export const COMMERCIAL_RADII: number[] = commercialRadiiUpTo(40);

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
  planeCenter?: [number, number, number]; // world-space anchor used for the cut plane
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
  threshold: number;            // distance-to-centre threshold (mm) actually applied
  /** Threshold rule used ('relative-2pct' = legacy 1.02·R, 'noise-adaptive' = baseline + k·σ) */
  thresholdMode?: WearThresholdMode;
  /** Robust noise estimate of the reference surface, σ = 1.4826·MAD (μm) */
  noiseSigmaUm?: number;
  /** Median offset of the reference surface from the commercial sphere (μm) */
  baselineUm?: number;
  /** Applied threshold as an offset over the commercial radius, threshold − R (μm) */
  depthThresholdUm?: number;
  /** k·σ exceeded the legacy 2 % threshold: the reference surface is not spherical within noise */
  noiseAboveLegacy?: boolean;
}

/** Double-sphere cell selection: legacy minimum-dispersion cell, or the median cell of the most stable quarter */
export type DoubleSphereEstimator = 'min-std-cell' | 'stable-quartile';

/** Two-sphere mode: which fitted sphere is the original cavity.
 *  'auto' = the head penetrates INTO the cup (original = sphere closer to the opening);
 *  'inverted' = the opposite (e.g. rim wear after subluxation or dislocation). */
export type TwoSphereDirection = 'auto' | 'inverted';

/** Rule for deciding which vertices are worn */
export type WearThresholdMode = 'relative-2pct' | 'noise-adaptive';

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

/** Alternative volume using the ACTUAL radius of the unworn cavity (free-radius fit to the
 *  non-worn reference) instead of the nominal commercial radius. Excludes uniform enlargement
 *  (design clearance, machining tolerance, creep) — and any uniformly distributed wear. */
export interface MeasuredRadiusVolume {
  radius: number;               // mm — fitted radius of the unworn reference
  center: THREE.Vector3;
  wearVolume: number;           // mm³ — mesh volume − cap of the measured sphere
  supportVertexCount: number;
  /** Reference large enough and radius within ±0.5 mm of the nominal one */
  reliable: boolean;
}

/** Wear volume result */
export interface WearVolumeResult {
  meshEnclosedVolume: number;   // mm³ — volume between rim plane and inner mesh
  sphereCapVolume: number;      // mm³ — volume of unworn sphere cut by rim plane
  wearVolume: number;           // mm³ — difference = wear
  /** Same volume with the measured radius of the unworn cavity (Manual Geodesic / Two-Sphere Auto) */
  measuredRadius?: MeasuredRadiusVolume;
}

/** Wear plane through pole and max-wear point, perpendicular to rim plane */
export interface WearPlaneResult {
  maxWearPoint: THREE.Vector3;    // vertex with maximum wear depth
  maxWearDepth: number;           // μm — deviation at that vertex
  planePoint: THREE.Vector3;      // point on the wear plane (pole)
  planeNormal: THREE.Vector3;     // normal of the wear plane
}

/** Automatic two-sphere union fit (mode 'two-sphere-auto'): original cavity sphere and
 *  displaced head sphere, both with the commercial radius. */
export interface TwoSphereResult {
  /** A directional wear pattern was detected (two-sphere model accepted) */
  detected: boolean;
  /** Fixed radius used for both spheres (commercial radius, mm) */
  radius: number;
  /** Centre of the original (unworn) cavity sphere */
  originalCenter: THREE.Vector3;
  /** Centre of the displaced (head) sphere; equals originalCenter if not detected */
  displacedCenter: THREE.Vector3;
  /** Linear wear = |displaced − original| (mm); 0 if not detected */
  linearWearMm: number;
  /** Angle between the penetration vector and the cup axis (0° = toward the pole), null if not detected */
  directionAngleDeg: number | null;
  /** Penetration within 30° of the cup axis: the unworn reference is small and accuracy is reduced */
  nearPole: boolean;
  /** The user inverted the automatic choice (head displaced toward the rim instead of into the cup) */
  inverted: boolean;
  /** Standard uncertainty of the linear wear (mm): √(block-bootstrap² + cut-plane² + systematic²); null if not detected */
  linearWearSdMm?: number | null;
  /** Standard uncertainty of the volumetric wear (mm³); null if not detected */
  volumeSdMm3?: number | null;
  /** Components: spatial block bootstrap, cut-plane sensitivity (±1 % of the cup depth) */
  linearSdBootstrapMm?: number | null;
  linearSdPlaneMm?: number | null;
  volumeSdBootstrapMm3?: number | null;
  volumeSdPlaneMm3?: number | null;
  /** Systematic component from low-frequency non-sphericity (uneven paint / form error) */
  linearSdSystematicMm?: number | null;
  volumeSdSystematicMm3?: number | null;
  /** RMS of the block-mean residuals of each sphere's support (μm) */
  lowFreqRmsUm?: number | null;
  /** Volume that the OTHER direction choice would give (spheres swapped), mm³; null if not detected */
  alternativeVolumeMm3?: number | null;
  /** Concentricity of the liner's outer (back) surface with each sphere — a hint for the direction
   *  choice, since the back surface is usually concentric with the original cavity. */
  outerShell?: {
    radius: number; rmsUm: number;
    distToOriginalMm: number; distToDisplacedMm: number;
    /** 'current' = supports the chosen original sphere; 'alternative' = supports the swap; 'undetermined' */
    favours: 'current' | 'alternative' | 'undetermined';
  } | null;
  /** Automatic radius selection: candidates evaluated with the two-sphere model (auto radius only) */
  radiusSelection?: { snapped: number; chosen: number; candidates: { radius: number; rmsUm: number }[] } | null;
  /** Scanner noise estimated from local roughness (μm) */
  noiseSigmaUm: number;
  /** Fraction of analysed vertices lying on the original sphere */
  unwornFraction: number;
  /** Vertices used as non-worn reference */
  referenceVertexCount: number;
  /** Vertices analysed (pole side of the cut plane) */
  activeVertexCount: number;
  /** Mean squared residuals (μm²): single fixed-R sphere, two-sphere union, single free-radius sphere */
  msOneSphereUm2: number;
  msTwoSpheresUm2: number;
  msFreeSphereUm2: number;
  /** Radius of the free-radius single sphere (mm) */
  freeSphereRadius: number;
  iterations: number;
}

/** Complete analysis results */
export type AnalysisMode =
  | 'pure-geodesic'
  | 'sphere-bestfit'
  | 'double-sphere-metrics'
  | 'manual-geodesic'
  | 'two-sphere-auto'
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
  /** PRNG seed actually used for the bootstrap (reproducible runs) */
  seed?: number;
  /** Threshold rule used to select sphere-2 points */
  thresholdMode?: WearThresholdMode;
  /** Cell-selection rule used for bestCell */
  estimator?: DoubleSphereEstimator;
  /** Median and interquartile range of centerDistanceMean across all sweep cells (mm) */
  cellDistanceMedian?: number;
  cellDistanceIQR?: [number, number];
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

  // --- Automatic two-sphere mode fields ---
  twoSphere?: TwoSphereResult;
  
  // Processing info
  processingTimeMs: number;
  vertexCount: number;
  faceCount: number;
}

export interface MultiModeComparisonResults {
  analysisMode: 'compare-all-modes';
  sphereBestfit: AnalysisResults;
  doubleSphereMetrics: AnalysisResults;
  twoSphereAuto?: AnalysisResults;
  summary: {
    sphereBestfitWearVolumeMm3: number;
    doubleSphereLinearWearMm: number;
    twoSphereLinearWearMm?: number;
    twoSphereWearVolumeMm3?: number;
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
  rimTrimPercent: number;      // default 16
  repairInnerFace: boolean;    // optional inner-face cleanup before trimming/analysis
  holeRepairMaxLoopSize: number; // max boundary loop size (vertices) to fill; larger = repairs bigger holes
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
  doubleSphereSeed: number;            // bootstrap PRNG seed; 0 = derive from mesh geometry
  doubleSphereEstimator: DoubleSphereEstimator; // how the reported sweep cell is chosen
  wearThresholdMode: WearThresholdMode; // worn-vertex rule (SBF classification + DSM sphere-2 selection)
  wearThresholdK: number;              // noise-adaptive: threshold = max(k·σ, min)
  wearThresholdMinUm: number;          // noise-adaptive: floor of the threshold (μm)
  twoSphereDirection: TwoSphereDirection; // two-sphere mode: automatic (into the cup) or inverted
  showCommercialSphere: boolean;
  showWornSphere: boolean;
  showUnwornSphere: boolean;
  showRimPlane: boolean;
  showWearPlane: boolean;
  showMeshVolume: boolean;
  showSphereCapVolume: boolean;
  showWearVolume: boolean;
  showLinearWearVector: boolean;
  showOriginalMesh: boolean;
  yearsInVivo: number;         // 0 = unknown; if >0, wear rates (mm/year, mm³/year) are shown
  showExcludedVertices: boolean; // highlight excluded vertices in the viewer
  rimInclinationAngle: number;  // degrees: tilt the rim cut-plane away from the cup axis (0 = auto)
  rimInclinationAzimuth: number; // degrees: direction of tilt in the plane perpendicular to cup axis
}

export const DEFAULT_PARAMS: AnalysisParams = {
  geodesicCount: 360,
  rimTrimPercent: 16,
  repairInnerFace: false,
  holeRepairMaxLoopSize: 1000,
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
  analysisMode: 'two-sphere-auto',
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
  doubleSphereSeed: 0,
  doubleSphereEstimator: 'stable-quartile',
  wearThresholdMode: 'noise-adaptive',
  wearThresholdK: 3,
  wearThresholdMinUm: 10,
  twoSphereDirection: 'auto',
  showCommercialSphere: false,
  showWornSphere: true,
  showUnwornSphere: true,
  showRimPlane: true,
  showWearPlane: false,
  showMeshVolume: false,
  showSphereCapVolume: false,
  showWearVolume: false,
  showLinearWearVector: false,
  showOriginalMesh: true,
  yearsInVivo: 0,
  showExcludedVertices: true,
  rimInclinationAngle: 0,
  rimInclinationAzimuth: 0,
};
