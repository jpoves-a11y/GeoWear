// ============================================================
// HipWear — export for HipCreep ("hipcreep-input", version 1)
// ------------------------------------------------------------
// HipCreep (https://github.com/EloyChueca/HipCreep) estimates the creep of the liner
// and splits the penetration measured here into remaining creep and wear. It needs:
//   • the original (unworn) sphere: centre, commercial radius, measured cavity radius;
//   • the penetration: linear value, uncertainty, direction (displaced centre);
//   • the cup axis, the wall thickness and the trimmed inner surface (for the
//     sphere → plane maps and the elevation analysis);
//   • case data entered at export time: days between explantation and scanning,
//     polyethylene grade.
// Specification: HipCreep repository, docs/HIPWEAR_EXPORT.md.
// Only type imports: the module also runs in the Node regression tests.
// ============================================================

import type { AnalysisResults, MeshData, SeparationResult } from '../types';

export type HipCreepMaterial = 'virgin' | 'conventional' | 'hxlpe' | 'vite-hxlpe';

export const HIPCREEP_MATERIALS: { value: HipCreepMaterial; label: string }[] = [
  { value: 'conventional', label: 'Conventional UHMWPE, γ-sterilised (25–40 kGy)' },
  { value: 'hxlpe', label: 'Highly cross-linked (remelted / annealed)' },
  { value: 'vite-hxlpe', label: 'Vitamin-E highly cross-linked' },
  { value: 'virgin', label: 'Unirradiated (virgin) UHMWPE' },
];

type V3 = { x: number; y: number; z: number };
type Arr3 = [number, number, number];

export interface HipCreepExportOptions {
  /** Case / prosthesis name */
  caseId: string;
  /** STL file name */
  sourceFile: string;
  programVersion: string;
  /** Results of the analysed run (in compare mode: the Two-Sphere Auto run) */
  res: AnalysisResults;
  /** Trimmed inner bearing surface used by that run */
  workingMesh: MeshData;
  /** Inner / outer surface separation (for the wall thickness) */
  separation: SeparationResult | null;
  /** Years in vivo (0 = unknown) */
  yearsInVivo: number;
  /** Days between explantation and scanning (null = unknown) */
  daysExVivo: number | null;
  material: HipCreepMaterial | null;
}

export interface HipCreepExportResult {
  data: Record<string, unknown>;
  warnings: string[];
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const arr = (v: V3, round = r6): Arr3 => [round(v.x), round(v.y), round(v.z)];
const sub = (a: Arr3, b: Arr3): Arr3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Arr3, b: Arr3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Arr3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Arr3): Arr3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const num = (x: number | null | undefined) => (x != null && Number.isFinite(x) ? x : null);

/** Median of an array (NaN if empty) */
function median(a: number[]): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Wall thickness from the outer (back) surface: for every outer vertex in the bearing region
 * (≤ maxPoleDeg from the pole) the distance to the centre of the original cavity minus the
 * cavity radius. "atPenetration" (median) and "sdAtPenetration" use the outer vertices within
 * coneDeg of the penetration direction (the pole if none was detected): that local dispersion is
 * the uncertainty of the wall under the load, whereas "sd" also contains the shape of the back
 * (flats, steps, non-concentric outer surfaces). Rim faces are excluded by the pole-angle limit.
 */
export function wallThickness(
  outer: MeshData, center: Arr3, radius: number, pole: Arr3, load: Arr3 | null, maxPoleDeg = 75, coneDeg = 10,
): { mean: number; sd: number; atPenetration: number; sdAtPenetration: number; n: number } | null {
  const P = outer.positions;
  const cosMax = Math.cos(maxPoleDeg * Math.PI / 180);
  const cosCone = Math.cos(coneDeg * Math.PI / 180);
  const dir = load ?? pole;
  const all: number[] = [], cone: number[] = [];
  for (let i = 0; i < outer.vertexCount; i++) {
    const d: Arr3 = [P[i * 3] - center[0], P[i * 3 + 1] - center[1], P[i * 3 + 2] - center[2]];
    const r = len(d);
    if (!(r > radius + 0.3)) continue;            // not a back-surface point
    const u: Arr3 = [d[0] / r, d[1] / r, d[2] / r];
    if (dot(u, pole) < cosMax) continue;          // rim / opening region
    const t = r - radius;
    all.push(t);
    if (dot(u, dir) >= cosCone) cone.push(t);
  }
  if (all.length < 20) return null;
  const sdOf = (a: number[]) => { const m = a.reduce((s, x) => s + x, 0) / a.length; return { m, sd: Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)) }; };
  const g = sdOf(all);
  const local = cone.length >= 5 ? cone : all;
  return { mean: g.m, sd: g.sd, atPenetration: median(local), sdAtPenetration: sdOf(local).sd, n: all.length };
}

export function buildHipCreepInput(o: HipCreepExportOptions): HipCreepExportResult {
  const { res, workingMesh: mesh } = o;
  const warnings: string[] = [];
  const ts = res.twoSphere;

  // ---- Original (unworn) sphere and penetration ----
  let center: Arr3, radius: number, model: string;
  let displaced: Arr3 | null = null;
  let linearUm: number | null = null, linearSdUm: number | null = null;
  if (ts) {
    model = 'two-sphere-auto';
    center = arr(ts.originalCenter);
    radius = ts.radius;
    if (ts.detected) {
      displaced = arr(ts.displacedCenter);
      linearUm = ts.linearWearMm * 1000;
    } else {
      linearUm = 0;
      warnings.push('No directional penetration detected: exported as 0 µm with the detection limit.');
    }
    linearSdUm = ts.linearWearSdMm != null ? ts.linearWearSdMm * 1000 : null;
  } else if (res.zoneSpheres) {
    model = res.analysisMode;
    center = arr(res.zoneSpheres.unwornSphere.center);
    radius = res.zoneSpheres.unwornSphere.radius;
    displaced = arr(res.zoneSpheres.wornSphere.center);
    linearUm = len(sub(displaced, center)) * 1000;
    warnings.push(`Analysis mode "${res.analysisMode}": HipCreep is designed for Two-Sphere Auto (no uncertainty of the penetration).`);
  } else if (res.commercialSphere) {
    model = res.analysisMode;
    center = arr(res.commercialSphere.center);
    radius = res.commercialSphere.commercialRadius;
    warnings.push(`Analysis mode "${res.analysisMode}": no penetration vector — run Two-Sphere Auto for HipCreep.`);
  } else {
    throw new Error('No reference sphere in the results — run a Two-Sphere Auto analysis first.');
  }

  // ---- Cup axis (rim plane → pole), checked against the mesh ----
  let pole: Arr3 | null = res.rimPlane ? unit(arr(res.rimPlane.normal)) : null;
  if (!pole && o.separation) pole = unit([...o.separation.cupAxis] as Arr3);
  if (!pole) throw new Error('No cup axis available.');
  {
    // the trimmed surface must lie on the pole side of the centre on average
    let s = 0;
    const P = mesh.positions;
    const step = Math.max(1, Math.floor(mesh.vertexCount / 2000));
    for (let i = 0; i < mesh.vertexCount; i += step) s += dot([P[i * 3] - center[0], P[i * 3 + 1] - center[1], P[i * 3 + 2] - center[2]], pole);
    if (s < 0) pole = [-pole[0], -pole[1], -pole[2]];
  }

  // ---- Measured cavity radius (free-radius fit of the unworn reference) ----
  const mr = res.wearVolumeResult?.measuredRadius ?? null;

  // ---- Wall thickness ----
  let wall: ReturnType<typeof wallThickness> = null;
  const load = displaced ? unit(sub(displaced, center)) : null;
  if (o.separation?.outer && o.separation.outer.vertexCount > 0) {
    wall = wallThickness(o.separation.outer, center, mr?.reliable ? mr.radius : radius, pole, load);
  }
  if (!wall) warnings.push('Wall thickness could not be measured from the outer surface: enter it in HipCreep.');

  if (o.daysExVivo == null) warnings.push('Days between explantation and scanning not given: HipCreep will use its default.');
  if (!(o.yearsInVivo > 0)) warnings.push('Time in vivo is 0 (unknown): set "Years in vivo" before exporting, or enter it in HipCreep.');

  // ---- Mesh (trimmed inner surface) ----
  const vertices = new Array<number>(mesh.vertexCount * 3);
  for (let i = 0; i < mesh.vertexCount * 3; i++) vertices[i] = r4(mesh.positions[i]);
  const faces = Array.from(mesh.indices);

  const data: Record<string, unknown> = {
    format: 'hipcreep-input',
    version: 1,
    source: {
      program: 'HipWear',
      programVersion: o.programVersion,
      file: o.sourceFile,
      exportedAt: new Date().toISOString(),
      analysisMode: model,
    },
    case: {
      id: o.caseId,
      yearsInVivo: o.yearsInVivo > 0 ? o.yearsInVivo : null,
      daysExVivo: o.daysExVivo,
    },
    implant: {
      headDiameterMm: r6(2 * radius),
      material: o.material,
    },
    geometry: {
      commercialRadiusMm: r6(radius),
      measuredRadiusMm: mr ? r6(mr.radius) : null,
      measuredRadiusReliable: mr ? mr.reliable : null,
      measuredCenter: mr ? arr(mr.center) : null,
      originalCenter: center,
      displacedCenter: displaced,
      poleAxis: pole.map(r6),
      rimPlane: res.rimPlane ? { point: arr(res.rimPlane.point), normal: arr(res.rimPlane.normal) } : null,
      wallThicknessMm: wall ? { mean: r4(wall.mean), sd: r4(wall.sd), atPenetration: r4(wall.atPenetration), sdAtPenetration: r4(wall.sdAtPenetration) } : null,
      outerShellRadiusMm: ts?.outerShell ? r6(ts.outerShell.radius) : null,
    },
    wear: {
      model,
      linearWearUm: linearUm != null ? r4(linearUm) : null,
      linearWearSdUm: linearSdUm != null ? r4(linearSdUm) : null,
      linearWearCorrectedUm: num(ts?.linearCorrectedMm) != null ? r4(ts!.linearCorrectedMm! * 1000) : null,
      linearWearCorrectedSdUm: num(ts?.linearCorrectedSdMm) != null ? r4(ts!.linearCorrectedSdMm! * 1000) : null,
      volumeMm3: num(res.wearVolumeResult?.wearVolume),
      volumeSdMm3: num(ts?.volumeSdMm3),
      directionAngleDeg: num(ts?.directionAngleDeg),
      detectionLimitUm: num(ts?.detectionLimitUm),
    },
    uncertainty: {
      noiseSigmaUm: num(ts?.noiseSigmaUm) ?? num(res.wearClassification?.noiseSigmaUm),
      surfaceUncertaintyUm: num(ts?.surfaceUncertaintyUm),
      formRmsUm: num(ts?.formRmsUm),
    },
    mesh: { vertices, faces },
  };
  return { data, warnings };
}
