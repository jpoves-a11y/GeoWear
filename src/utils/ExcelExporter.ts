// ============================================================
// GeoWear — ExcelExporter
// Builds and mutates Excel (.xlsx) workbooks from analysis results.
// Uses SheetJS loaded from CDN (window.XLSX) — no npm install required.
// ============================================================

import type { AnalysisRunResult, AnalysisResults, AnalysisParams } from '../types';

// SheetJS is loaded as a global script from CDN in index.html.
// This declaration gives TypeScript the correct types without an npm dependency.
declare const XLSX: typeof import('xlsx');

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const HEADERS = [
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
] as const;

const MODE_LABELS: Record<string, string> = {
  'sphere-bestfit': 'Sphere BestFit',
  'double-sphere-metrics': 'Double Sphere Metrics',
  'manual-geodesic': 'Manual Geodesic',
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
}

function extractWearValues(result: AnalysisResults): WearValues {
  let linearWearUm = 0;
  let volumetricWearMm3 = 0;

  const mode = result.analysisMode;

  if (mode === 'sphere-bestfit' || mode === 'manual-geodesic') {
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

  return { linearWearUm, volumetricWearMm3 };
}

type RowArray = (string | number)[];

function buildRowArray(
  prosthesisName: string,
  modeLabel: string,
  wear: WearValues,
  params: AnalysisParams,
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
): RowArray[] {
  if (result.analysisMode === 'compare-all-modes') {
    const sbfWear = extractWearValues(result.sphereBestfit);
    const dsmWear = extractWearValues(result.doubleSphereMetrics);
    return [
      buildRowArray(prosthesisName, MODE_LABELS['sphere-bestfit'], sbfWear, params),
      buildRowArray('', MODE_LABELS['double-sphere-metrics'], dsmWear, params),
    ];
  }

  const wear = extractWearValues(result as AnalysisResults);
  const label = MODE_LABELS[result.analysisMode] ?? result.analysisMode;
  return [buildRowArray(prosthesisName, label, wear, params)];
}

/** Create a brand-new workbook with header row + the supplied data rows. */
export function createWorkbook(rows: RowArray[]): XLSX.WorkBook {
  const aoa: RowArray[] = [HEADERS as unknown as RowArray, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'GeoWear');
  return wb;
}

/** Parse an existing .xlsx file buffer into a SheetJS WorkBook. */
export function parseWorkbook(buffer: ArrayBuffer): XLSX.WorkBook {
  return XLSX.read(new Uint8Array(buffer), { type: 'array' });
}

/**
 * Check whether a prosthesis name already has a row block in the workbook.
 * Scans column A (index 0) of the first sheet.
 */
export function prosthesisExistsInWorkbook(wb: XLSX.WorkBook, prosthesisName: string): boolean {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<(string | number | undefined)[]>(ws, { header: 1 });
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
  wb: XLSX.WorkBook,
  prosthesisName: string,
  newRows: RowArray[],
): XLSX.WorkBook {
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json<(string | number | undefined)[]>(ws, { header: 1 });

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

  if (blockStart !== -1) {
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
export function downloadWorkbook(wb: XLSX.WorkBook, fileName: string): void {
  const name = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  XLSX.writeFile(wb, name);
}

/**
 * Write a workbook either to a FileSystemFileHandle (File System Access API,
 * Chrome/Edge — allows in-place overwrite) or fall back to a blob download.
 */
export async function writeWorkbook(
  wb: XLSX.WorkBook,
  fileName: string,
  fileHandle?: FileSystemFileHandle,
): Promise<void> {
  if (fileHandle) {
    const wbout: ArrayBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const writable = await fileHandle.createWritable();
    await writable.write(
      new Blob([wbout], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    );
    await writable.close();
  } else {
    downloadWorkbook(wb, fileName);
  }
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
