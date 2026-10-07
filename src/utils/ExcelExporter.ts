// ============================================================
// HipWear — ExcelExporter
// Builds and mutates Excel (.xlsx) workbooks from analysis results.
// Uses SheetJS loaded from CDN (window.XLSX) — no npm install required.
// ============================================================

import type { AnalysisRunResult, AnalysisResults, AnalysisParams } from '../types';
import { SCAN_TYPE_LABELS } from '../types';

// SheetJS is loaded as a global script from CDN in index.html.
// Typed as 'any' to avoid requiring the xlsx npm package at build time.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const XLSX: any;

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const HEADERS = [
  'Prosthesis name',
  'Analysis mode',
  'Linear wear (μm)',
  'Volumetric wear (mm³)',
  'Implantation time (years)',
  'Linear wear rate (mm/y)',
  'Volumetric wear rate (mm³/y)',
  'Rim trim (%)',
  'Rim inclination (º)',
  'Rim azimuth (º)',
  'Threshold rule',
  'Noise σ (μm)',
  'Threshold over R (μm)',
  'DSM seed',
  'Wear direction to the cup axis (º)',
  'Two-sphere model',
  'Linear uncertainty, SD (μm)',
  'Volumetric uncertainty, SD (mm³)',
  'Volumetric wear, measured radius (mm³)',
  'Measured cavity radius (mm)',
  'Volume with the opposite direction (mm³)',
  'Outer-shell concentricity',
  'Commercial radius used (mm)',
  'Scan type',
  'Paint thickness (μm)',
  'Other uncertainties (± μm)',
  'Acquisition uncertainty, linear (μm)',
  'Acquisition uncertainty, volumetric (mm³)',
  'Sphericity, P–V (μm)',
  'Detection limit (μm)',
  'Linear wear corrected for radius excess (μm)',
  'Corrected linear uncertainty, SD (μm)',
  'Measured-radius volume uncertainty, SD (mm³)',
  'Worn area (mm²)',
  'Worn area (%)',
  'Open holes: missing volume (mm³)',
  'Sphericity (%)',
  'Mesh reduced at load (no smoothing)',
] as const;

/** Spanish headers written by earlier versions (same columns, same order). Workbooks that still have
 *  them are recognised when appending, and their exported-column headers are switched to English. */
const HEADERS_ES = [
  'Nombre de prótesis',
  'Analysis mode',
  'Desgaste lineal (μm)',
  'Desgaste volumétrico (mm³)',
  'Tiempo de implantación',
  'Desgaste lineal (mm/y)',
  'Desgaste volumétrico (mm³/y)',
  'Rim trim (%)',
  'Rim inclination (º)',
  'Rim azimuth (º)',
  'Regla de umbral',
  'Ruido σ (μm)',
  'Umbral sobre R (μm)',
  'Semilla DSM',
  'Dirección del desgaste respecto al eje (º)',
  'Modelo de dos esferas',
  'Incertidumbre lineal, DE (μm)',
  'Incertidumbre volumétrica, DE (mm³)',
  'Desgaste volumétrico con radio medido (mm³)',
  'Radio medido de la cavidad (mm)',
  'Volumen con la dirección contraria (mm³)',
  'Concentricidad de la cara externa',
  'Radio comercial usado (mm)',
  'Tipo de escaneo',
  'Espesor de pintura (μm)',
  'Otras incertidumbres (± μm)',
  'Incertidumbre de adquisición, lineal (μm)',
  'Incertidumbre de adquisición, volumétrica (mm³)',
  'Esfericidad (μm)',
  'Límite de detección (μm)',
  'Desgaste lineal corregido por exceso de radio (μm)',
  'Incertidumbre lineal corregido, DE (μm)',
  'Incertidumbre volumen con radio medido, DE (mm³)',
  'Área desgastada (mm²)',
  'Área desgastada (%)',
  'Agujeros abiertos: volumen que falta (mm³)',
  'Esfericidad (%)',
  'Malla reducida al cargar (sin suavizar)',
] as const;

const MODE_LABELS: Record<string, string> = {
  'sphere-bestfit': 'Sphere BestFit (legacy)',
  'double-sphere-metrics': 'Double Sphere Metrics (legacy)',
  'manual-geodesic': 'Manual Geodesic',
  'two-sphere-auto': 'Two-Sphere Auto',
  'pure-geodesic': 'Pure Geodesic',
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function dist3(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function round2(v: number): number { return Math.round(v * 100) / 100; }
function round4(v: number): number { return Math.round(v * 10000) / 10000; }

interface WearValues {
  linearWearUm: number;
  volumetricWearMm3: number;
  /** Threshold rule, noise σ and applied threshold (SBF classification) — '' when not applicable */
  thresholdMode: string;
  noiseSigmaUm: number | '';
  thresholdOverRUm: number | '';
  /** Double-sphere bootstrap seed — '' when not applicable */
  seed: number | '';
  /** Two-sphere mode: penetration direction to the cup axis (º) and detection status — '' when not applicable */
  directionDeg: number | '';
  twoSphereStatus: string;
  linearSdUm: number | '';
  volumeSdMm3: number | '';
  volumeMeasuredRadius: number | '';
  measuredRadius: number | '';
  alternativeVolume: number | '';
  outerShell: string;
  radiusUsed: number | '';
  linearAcqUm: number | '';
  volumeAcqMm3: number | '';
  sphericityUm: number | '';
  sphericityPct: number | '';
  lodUm: number | '';
  linCorrUm: number | '';
  linCorrSdUm: number | '';
  volMeasSdMm3: number | '';
  wornAreaMm2: number | '';
  wornAreaPct: number | '';
  holesMissingMm3: number | '';
}

function extractWearValues(result: AnalysisResults): WearValues {
  let linearWearUm = 0;
  let volumetricWearMm3 = 0;

  const mode = result.analysisMode;

  if (mode === 'two-sphere-auto') {
    linearWearUm = (result.twoSphere?.linearWearMm ?? 0) * 1000;
    volumetricWearMm3 = result.wearVolumeResult?.wearVolume ?? 0;
  } else if (mode === 'sphere-bestfit' || mode === 'manual-geodesic') {
    if (result.zoneSpheres) {
      linearWearUm =
        dist3(result.zoneSpheres.wornSphere.center, result.zoneSpheres.unwornSphere.center) *
        1000;
    }
    volumetricWearMm3 = result.wearVolumeResult?.wearVolume ?? 0;
  } else if (mode === 'double-sphere-metrics') {
    if (result.doubleSphereMetrics?.bestCell) {
      linearWearUm = result.doubleSphereMetrics.bestCell.centerDistanceMean * 1000;
    }
    // Volumetric wear is not computed in double-sphere mode
    volumetricWearMm3 = 0;
  } else if (mode === 'pure-geodesic') {
    linearWearUm = result.wearVector?.maxDepth ?? 0;
    volumetricWearMm3 = result.totalBumpVolume ?? 0;
  }

  const wc = result.wearClassification;
  const ds = result.doubleSphereMetrics;
  const thresholdMode = wc?.thresholdMode ?? ds?.thresholdMode ?? '';
  const noiseSigmaUm = wc?.noiseSigmaUm != null ? round2(wc.noiseSigmaUm) : '';
  const thresholdOverRUm = wc?.depthThresholdUm != null ? round2(wc.depthThresholdUm) : '';
  const seed = ds?.seed ?? '';
  const ts = result.twoSphere;
  const directionDeg = ts?.directionAngleDeg != null ? round2(ts.directionAngleDeg) : '';
  const twoSphereStatus = !ts ? ''
    : !ts.detected ? (ts.detectionLimitUm != null
      ? `Not detected (< ${ts.detectionLimitUm.toFixed(0)} μm, detection limit)`
      : 'Not detected (below the detection limit or uniformly enlarged cavity)')
    : ts.nearPole ? 'Detected · penetration < 30º from the axis (reduced reliability)'
    : 'Detected';
  const twoSphereStatusFull = ts?.inverted ? `${twoSphereStatus} · direction inverted manually` : twoSphereStatus;

  const linearSdUm = ts?.linearWearSdMm != null ? round2(ts.linearWearSdMm * 1000) : '';
  const volumeSdMm3 = ts?.volumeSdMm3 != null ? round2(ts.volumeSdMm3) : '';
  const mr = result.wearVolumeResult?.measuredRadius;
  const volumeMeasuredRadius = mr ? round2(mr.wearVolume) : '';
  const measuredRadius = mr ? round4(mr.radius) : '';
  const alternativeVolume = ts?.alternativeVolumeMm3 != null ? round2(ts.alternativeVolumeMm3) : '';
  const outerShell = !ts?.outerShell ? ''
    : ts.outerShell.favours === 'current' ? 'Supports the chosen direction'
    : ts.outerShell.favours === 'alternative' ? 'Supports the opposite direction'
    : 'Undetermined';
  const radiusUsed = result.commercialSphere?.commercialRadius ?? '';
  const linearAcqUm = ts?.linearSdAcquisitionMm != null ? round2(ts.linearSdAcquisitionMm * 1000) : '';
  const volumeAcqMm3 = ts?.volumeSdAcquisitionMm3 != null ? round2(ts.volumeSdAcquisitionMm3) : '';
  const sphericityUm = result.sphericity ? round2(result.sphericity.sphericityUm) : '';
  const sphericityPct = result.sphericity ? round4(result.sphericity.sphericityPercent) : '';
  const lodUm: number | '' = ts?.detectionLimitUm != null ? round2(ts.detectionLimitUm) : '';
  const linCorrUm: number | '' = ts?.linearCorrectedMm != null ? round2(ts.linearCorrectedMm * 1000) : '';
  const linCorrSdUm: number | '' = ts?.linearCorrectedSdMm != null ? round2(ts.linearCorrectedSdMm * 1000) : '';
  const volMeasSdMm3: number | '' = mr?.wearVolumeSdMm3 != null ? round2(mr.wearVolumeSdMm3) : '';
  const wornAreaMm2: number | '' = ts?.wornAreaMm2 != null && ts.detected ? round2(ts.wornAreaMm2) : '';
  const wornAreaPct: number | '' = ts?.wornAreaPct != null && ts.detected ? round2(ts.wornAreaPct) : '';
  const holes = result.wearVolumeResult?.unfilledHoles;
  const holesMissingMm3: number | '' = holes ? round2(holes.missingVolumeMm3) : '';
  return { linearWearUm, volumetricWearMm3, thresholdMode, noiseSigmaUm, thresholdOverRUm, seed, directionDeg, twoSphereStatus: twoSphereStatusFull, linearSdUm, volumeSdMm3, volumeMeasuredRadius, measuredRadius, alternativeVolume, outerShell, radiusUsed, linearAcqUm, volumeAcqMm3, sphericityUm, sphericityPct, lodUm, linCorrUm, linCorrSdUm, volMeasSdMm3, wornAreaMm2, wornAreaPct, holesMissingMm3 };
}

type RowArray = (string | number)[];

function buildRowArray(
  prosthesisName: string,
  modeLabel: string,
  wear: WearValues,
  params: AnalysisParams,
  meshNote: string = '',
): RowArray {
  const years = params.yearsInVivo ?? 0;
  const { linearWearUm, volumetricWearMm3 } = wear;
  return [
    prosthesisName,
    modeLabel,
    round2(linearWearUm),
    round2(volumetricWearMm3),
    years,
    years > 0 ? round4(linearWearUm / 1000 / years) : 0,
    years > 0 ? round2(volumetricWearMm3 / years) : 0,
    params.rimTrimPercent,
    params.rimInclinationAngle,
    params.rimInclinationAzimuth,
    wear.thresholdMode,
    wear.noiseSigmaUm,
    wear.thresholdOverRUm,
    wear.seed,
    wear.directionDeg,
    wear.twoSphereStatus,
    wear.linearSdUm,
    wear.volumeSdMm3,
    wear.volumeMeasuredRadius,
    wear.measuredRadius,
    wear.alternativeVolume,
    wear.outerShell,
    wear.radiusUsed,
    SCAN_TYPE_LABELS[params.scanType ?? 'unspecified'],
    params.scanType !== 'unspecified' ? (params.scanPainted ? params.paintThicknessUm : 'Not painted') : '',
    params.scanType !== 'unspecified' ? params.otherUncertaintyUm : '',
    wear.linearAcqUm,
    wear.volumeAcqMm3,
    wear.sphericityUm,
    wear.lodUm,
    wear.linCorrUm,
    wear.linCorrSdUm,
    wear.volMeasSdMm3,
    wear.wornAreaMm2,
    wear.wornAreaPct,
    wear.holesMissingMm3,
    wear.sphericityPct,
    meshNote,
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract one or more data rows from an analysis result.
 * The first row carries the prosthesis name; subsequent rows have an empty name
 * (so Excel visually groups them under the same prosthesis).
 */
export function extractRows(
  prosthesisName: string,
  result: AnalysisRunResult,
  params: AnalysisParams,
  meshNote: string = '',
): RowArray[] {
  if (result.analysisMode === 'compare-all-modes') {
    // One sphericity per sample: first row only
    const sph: number | '' = result.sphericity ? round2(result.sphericity.sphericityUm) : '';
    const sphPct: number | '' = result.sphericity ? round4(result.sphericity.sphericityPercent) : '';
    const sbfWear = { ...extractWearValues(result.sphereBestfit), sphericityUm: sph, sphericityPct: sphPct };
    const dsmWear = { ...extractWearValues(result.doubleSphereMetrics), sphericityUm: '' as const, sphericityPct: '' as const };
    const rows = [
      buildRowArray(prosthesisName, MODE_LABELS['sphere-bestfit'], sbfWear, params, meshNote),
      buildRowArray('', MODE_LABELS['double-sphere-metrics'], dsmWear, params, meshNote),
    ];
    if (result.twoSphereAuto) {
      rows.push(buildRowArray('', MODE_LABELS['two-sphere-auto'], { ...extractWearValues(result.twoSphereAuto), sphericityUm: '', sphericityPct: '' }, params, meshNote));
    }
    return rows;
  }

  const wear = extractWearValues(result as AnalysisResults);
  const label = MODE_LABELS[result.analysisMode] ?? result.analysisMode;
  return [buildRowArray(prosthesisName, label, wear, params, meshNote)];
}

/** Create a brand-new workbook with header row + the supplied data rows. */
export function createWorkbook(rows: RowArray[]): any {
  const aoa: RowArray[] = [HEADERS as unknown as RowArray, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'HipWear');
  return wb;
}

/** Parse an existing .xlsx file buffer into a SheetJS WorkBook. */
export function parseWorkbook(buffer: ArrayBuffer): any {
  return XLSX.read(new Uint8Array(buffer), { type: 'array' });
}

/**
 * Check whether a prosthesis name already has a row block in the workbook.
 * Scans column A (index 0) of the first sheet.
 */
export function prosthesisExistsInWorkbook(wb: any, prosthesisName: string): boolean {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa: (string | number | undefined)[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
  for (let i = 1; i < aoa.length; i++) {
    if (aoa[i]?.[0] === prosthesisName) return true;
  }
  return false;
}

/**
 * Merge new rows into an existing workbook (first sheet).
 *
 * - If a block whose col-A equals `prosthesisName` is found it is fully
 *   replaced with `newRows` (other blocks are not touched).
 * - If no block is found `newRows` are appended at the end.
 */
export function mergeWorkbook(
  wb: any,
  prosthesisName: string,
  newRows: RowArray[],
): any {
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const aoa: (string | number | undefined)[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });

  // Locate the existing block for this prosthesis
  let blockStart = -1;
  let blockEnd = aoa.length; // exclusive

  for (let i = 1; i < aoa.length; i++) {
    const cellA = aoa[i]?.[0];
    if (cellA === prosthesisName) {
      blockStart = i;
      // Block ends at the next row that has a non-empty col-A (i.e. a different prosthesis)
      for (let j = i + 1; j < aoa.length; j++) {
        const next = aoa[j]?.[0];
        if (next !== undefined && next !== '') {
          blockEnd = j;
          break;
        }
      }
      break;
    }
  }

  // Workbooks created by older versions have fewer exported columns. If the header starts with the
  // exported columns of an older version (k of them) and the user added columns after them, insert the
  // new exported columns at position k in every row so the user's columns shift right instead of being
  // overwritten; then complete the header.
  const header = ((aoa[0] ?? []) as (string | number | undefined)[]);
  let k = 0;
  const isExported = (c: number) => header[c] === HEADERS[c] || header[c] === HEADERS_ES[c];
  while (k < HEADERS.length && k < header.length && isExported(k)) k++;
  for (let c = 0; c < k; c++) header[c] = HEADERS[c];   // older Spanish headers → English
  if (k >= 20 && k < HEADERS.length && header.length > k) {
    const add = HEADERS.length - k;
    for (let i = 0; i < aoa.length; i++) {
      const row = (aoa[i] ?? []) as (string | number | undefined)[];
      if (row.length > k) row.splice(k, 0, ...new Array(add).fill(''));
      aoa[i] = row;
    }
    for (let c = k; c < HEADERS.length; c++) header[c] = HEADERS[c];
  } else {
    for (let c = header.length; c < HEADERS.length; c++) header[c] = HEADERS[c];
  }
  aoa[0] = header;

  if (blockStart !== -1) {
    // Keep anything the user typed to the right of the exported columns (dates, operator, comments…)
    for (let k = 0; k < newRows.length && blockStart + k < blockEnd; k++) {
      const old = aoa[blockStart + k] ?? [];
      for (let c = HEADERS.length; c < old.length; c++) (newRows[k] as any[])[c] = old[c] ?? '';
    }
    aoa.splice(blockStart, blockEnd - blockStart, ...newRows);
  } else {
    aoa.push(...newRows);
  }

  wb.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(
    aoa as RowArray[],
  );
  return wb;
}

/**
 * Trigger a browser download of the workbook as an .xlsx file.
 * Used as the universal fallback when the File System Access API is unavailable.
 */
export function downloadWorkbook(wb: any, fileName: string): void {
  const name = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  XLSX.writeFile(wb, name);
}

/**
 * Write a workbook IN PLACE into the local file behind `handle` (File System Access API).
 * Asks for write permission when the handle was obtained read-only (showOpenFilePicker).
 * Never falls back to a download: it throws, so the caller can tell the user what happened
 * (typically the file is open in Excel, which locks it on Windows) and offer to retry.
 */
export async function writeWorkbookToHandle(wb: any, handle: FileSystemFileHandle): Promise<void> {
  const h: any = handle;
  if (typeof h.queryPermission === 'function') {
    let perm = await h.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted' && typeof h.requestPermission === 'function') {
      perm = await h.requestPermission({ mode: 'readwrite' });
    }
    if (perm !== 'granted') throw new Error('Write permission denied');
  }
  const wbout: ArrayBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const writable = await handle.createWritable();
  try {
    await writable.write(
      new Blob([wbout], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    );
    await writable.close();
  } catch (e) {
    try { await writable.abort(); } catch { /* already closed */ }
    throw e;
  }
}

/** True when this browser can modify local files in place (Chrome, Edge, Opera). */
export function canWriteLocalFiles(): boolean {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window && 'showSaveFilePicker' in window;
}

/**
 * Fallback export when SheetJS is unavailable: generates a UTF-8 CSV file
 * that Excel opens correctly. Triggers a browser download.
 */
export function downloadRowsAsCSV(rows: RowArray[], fileName: string): void {
  const escape = (v: string | number) => {
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const allRows: RowArray[] = [HEADERS as unknown as RowArray, ...rows];
  const csv = allRows.map((r) => r.map(escape).join(',')).join('\r\n');
  // UTF-8 BOM ensures Excel renders special characters (μ, º) correctly
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.endsWith('.csv') ? fileName : `${fileName}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
