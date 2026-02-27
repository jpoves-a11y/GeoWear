// ============================================================
// GeoWear — ExportManager
// Export to PNG, CSV, colored STL, and PDF report
// ============================================================

import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import type { AnalysisResults, Geodesic, MeshData } from '../types';
import { SceneManager } from '../viewer/SceneManager';

export class ExportManager {
  private sceneManager: SceneManager;

  constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;
  }

  // ---- PNG Screenshot ----

  exportPNG(fileName: string = 'geowear-screenshot'): void {
    const dataUrl = this.sceneManager.screenshot();
    this.downloadDataUrl(dataUrl, `${fileName}.png`);
  }

  // ---- CSV Export ----

  exportCSV(results: AnalysisResults, fileName: string = 'geowear-data'): void {
    const lines: string[] = [];

    // Summary header
    lines.push('# GeoWear Analysis Results');
    lines.push(`# Date: ${new Date().toISOString()}`);
    lines.push('');

    // Summary metrics
    lines.push('# Summary');
    lines.push(`Sphere Radius (mm),${results.sphereFit.radius.toFixed(6)}`);
    lines.push(`Sphere Center X (mm),${results.sphereFit.center.x.toFixed(6)}`);
    lines.push(`Sphere Center Y (mm),${results.sphereFit.center.y.toFixed(6)}`);
    lines.push(`Sphere Center Z (mm),${results.sphereFit.center.z.toFixed(6)}`);
    lines.push(`RMS Error (μm),${(results.sphereFit.rmsError * 1000).toFixed(4)}`);
    lines.push(`Sphericity (%),${results.ellipsoidFit.sphericityPercent.toFixed(4)}`);
    lines.push(`Shape Class,${results.ellipsoidFit.shapeClass}`);
    lines.push(`Semi-axis A (mm),${results.ellipsoidFit.semiAxes[0].toFixed(6)}`);
    lines.push(`Semi-axis B (mm),${results.ellipsoidFit.semiAxes[1].toFixed(6)}`);
    lines.push(`Semi-axis C (mm),${results.ellipsoidFit.semiAxes[2].toFixed(6)}`);
    lines.push(`Bump Volume (mm³),${results.totalBumpVolume.toFixed(6)}`);
    lines.push(`Dip Volume (mm³),${results.totalDipVolume.toFixed(6)}`);
    lines.push(`Total Defect Volume (mm³),${(results.totalBumpVolume + results.totalDipVolume).toFixed(6)}`);
    lines.push(`Bump Mass (mg),${(results.totalBumpVolume * 0.935).toFixed(6)}`);
    lines.push(`Dip Mass (mg),${(results.totalDipVolume * 0.935).toFixed(6)}`);
    lines.push(`Bump Clusters,${results.bumpClusters.length}`);
    lines.push(`Dip Clusters,${results.dipClusters.length}`);
    lines.push(`Total Anomaly Points,${results.totalAnomalyPoints}`);
    lines.push('');

    // Wear vector
    if (results.wearVector) {
      lines.push('# Wear Vector');
      lines.push(`Max Depth (μm),${results.wearVector.maxDepth.toFixed(4)}`);
      lines.push(`Angle from Axis (°),${results.wearVector.angle.toFixed(2)}`);
      lines.push(`Distance to Pole (mm),${results.wearVector.distance.toFixed(4)}`);
      lines.push(`Deepest X (mm),${results.wearVector.deepestPoint.x.toFixed(6)}`);
      lines.push(`Deepest Y (mm),${results.wearVector.deepestPoint.y.toFixed(6)}`);
      lines.push(`Deepest Z (mm),${results.wearVector.deepestPoint.z.toFixed(6)}`);
      lines.push('');
    }

    // Geodesic data
    lines.push('# Geodesic Data');
    lines.push('Angle (°),Total Length (mm),Max Deviation (μm),Min Deviation (μm),Anomaly Count');
    for (const geo of results.geodesics) {
      lines.push(`${geo.angle.toFixed(1)},${geo.totalLength.toFixed(4)},${geo.maxDeviation.toFixed(4)},${geo.minDeviation.toFixed(4)},${geo.anomalyCount}`);
    }
    lines.push('');

    // Detailed geodesic points (for the first few geodesics with anomalies)
    const anomalousGeodesics = results.geodesics.filter(g => g.anomalyCount > 0);
    if (anomalousGeodesics.length > 0) {
      lines.push('# Detailed Geodesic Points (anomalous geodesics)');
      lines.push('Geodesic Angle (°),Arc Length (mm),Deviation (μm),Derivative,2nd Derivative,X (mm),Y (mm),Z (mm)');

      for (const geo of anomalousGeodesics.slice(0, 20)) { // limit detail to 20 geodesics
        for (const pt of geo.points) {
          if (Math.abs(pt.deviation) > 0.5) { // only log significant points
            lines.push(`${geo.angle.toFixed(1)},${pt.arcLength.toFixed(4)},${pt.deviation.toFixed(4)},${pt.derivative.toFixed(6)},${pt.secondDerivative.toFixed(6)},${pt.position[0].toFixed(6)},${pt.position[1].toFixed(6)},${pt.position[2].toFixed(6)}`);
          }
        }
      }
      lines.push('');
    }

    // Anomaly clusters
    lines.push('# Anomaly Clusters');
    lines.push('ID,Type,Points,Avg Deviation (μm),Max Deviation (μm), Min Deviation (μm),Area (mm²),Volume (mm³),Centroid X (mm),Centroid Y (mm),Centroid Z (mm)');
    for (const cluster of [...results.bumpClusters, ...results.dipClusters]) {
      lines.push(`${cluster.id},${cluster.type},${cluster.points.length},${cluster.avgDeviation.toFixed(4)},${cluster.maxDeviation.toFixed(4)},${cluster.minDeviation.toFixed(4)},${cluster.area.toFixed(4)},${cluster.volume.toFixed(6)},${cluster.centroid.x.toFixed(6)},${cluster.centroid.y.toFixed(6)},${cluster.centroid.z.toFixed(6)}`);
    }

    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    this.downloadBlob(blob, `${fileName}.csv`);
  }

  // ---- Colored STL Export ----

  exportColoredSTL(
    meshData: MeshData,
    vertexDeviations: Float32Array,
    fileName: string = 'geowear-colored'
  ): void {
    // Write binary STL with Magics color extension
    const faceCount = meshData.faceCount;
    const headerSize = 80;
    const faceDataSize = (4 * 3 + 4 * 3 * 3 + 2) * faceCount; // normal + 3 vertices + attribute
    const bufferSize = headerSize + 4 + faceDataSize;
    const buffer = new ArrayBuffer(bufferSize);
    const view = new DataView(buffer);

    // Header (80 bytes)
    const header = 'GeoWear Colored STL Export - UHMWPE Wear Analysis';
    for (let i = 0; i < Math.min(header.length, 80); i++) {
      view.setUint8(i, header.charCodeAt(i));
    }

    // Face count
    view.setUint32(80, faceCount, true);

    // Write faces
    let offset = 84;
    const { positions, normals, indices } = meshData;

    for (let f = 0; f < faceCount; f++) {
      const i0 = indices[f * 3];
      const i1 = indices[f * 3 + 1];
      const i2 = indices[f * 3 + 2];

      // Compute face normal
      const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
      const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
      const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];

      const abx = bx - ax, aby = by - ay, abz = bz - az;
      const acx = cx - ax, acy = cy - ay, acz = cz - az;
      let nx = aby * acz - abz * acy;
      let ny = abz * acx - abx * acz;
      let nz = abx * acy - aby * acx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 1e-12) { nx /= len; ny /= len; nz /= len; }

      // Normal
      view.setFloat32(offset, nx, true); offset += 4;
      view.setFloat32(offset, ny, true); offset += 4;
      view.setFloat32(offset, nz, true); offset += 4;

      // Vertices
      view.setFloat32(offset, ax, true); offset += 4;
      view.setFloat32(offset, ay, true); offset += 4;
      view.setFloat32(offset, az, true); offset += 4;

      view.setFloat32(offset, bx, true); offset += 4;
      view.setFloat32(offset, by, true); offset += 4;
      view.setFloat32(offset, bz, true); offset += 4;

      view.setFloat32(offset, cx, true); offset += 4;
      view.setFloat32(offset, cy, true); offset += 4;
      view.setFloat32(offset, cz, true); offset += 4;

      // Attribute byte count — encode color in Magics format (RGB555 + valid bit)
      const avgDev = (vertexDeviations[i0] + vertexDeviations[i1] + vertexDeviations[i2]) / 3;
      const rgb = deviationToRGB555(avgDev);
      view.setUint16(offset, rgb, true); offset += 2;
    }

    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    this.downloadBlob(blob, `${fileName}.stl`);
  }

  // ---- PDF Report ----

  async exportPDF(
    results: AnalysisResults,
    fileName: string = 'geowear-report'
  ): Promise<void> {
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageWidth = pdf.internal.pageSize.getWidth();
    const margin = 15;
    let y = margin;

    // Title
    pdf.setFontSize(20);
    pdf.setTextColor(0, 100, 180);
    pdf.text('GeoWear Analysis Report', margin, y);
    y += 10;

    pdf.setFontSize(10);
    pdf.setTextColor(100, 100, 100);
    pdf.text(`Generated: ${new Date().toISOString()}`, margin, y);
    y += 5;
    pdf.text('UHMWPE Acetabular Cup Wear Analysis', margin, y);
    y += 10;

    // 3D Screenshot
    try {
      const screenshot = this.sceneManager.screenshot();
      const imgWidth = pageWidth - 2 * margin;
      const imgHeight = imgWidth * 0.6;
      pdf.addImage(screenshot, 'PNG', margin, y, imgWidth, imgHeight);
      y += imgHeight + 10;
    } catch (e) {
      console.warn('Could not capture screenshot for PDF:', e);
    }

    // Summary table
    pdf.setFontSize(14);
    pdf.setTextColor(0, 0, 0);
    pdf.text('Sphere Fit', margin, y);
    y += 7;

    pdf.setFontSize(10);
    pdf.setTextColor(60, 60, 60);
    const summaryData = [
      ['Sphere Radius', `${results.sphereFit.radius.toFixed(4)} mm`],
      ['RMS Error', `${(results.sphereFit.rmsError * 1000).toFixed(2)} μm`],
      ['Max Error', `${(results.sphereFit.maxError * 1000).toFixed(2)} μm`],
      ['Sphericity', `${results.ellipsoidFit.sphericityPercent.toFixed(2)}%`],
      ['Shape', results.ellipsoidFit.shapeClass],
    ];

    for (const [label, value] of summaryData) {
      pdf.text(`${label}: ${value}`, margin + 5, y);
      y += 5;
    }
    y += 5;

    // Volume data
    pdf.setFontSize(14);
    pdf.setTextColor(0, 0, 0);
    pdf.text('Volume Analysis', margin, y);
    y += 7;

    pdf.setFontSize(10);
    pdf.setTextColor(60, 60, 60);
    const volumeData = [
      ['Bump Volume (excess)', `${results.totalBumpVolume.toFixed(4)} mm³`],
      ['Dip Volume (missing)', `${results.totalDipVolume.toFixed(4)} mm³`],
      ['Total Defect Volume', `${(results.totalBumpVolume + results.totalDipVolume).toFixed(4)} mm³`],
      ['Bump Mass', `${(results.totalBumpVolume * 0.935).toFixed(4)} mg`],
      ['Dip Mass (wear)', `${(results.totalDipVolume * 0.935).toFixed(4)} mg`],
    ];

    for (const [label, value] of volumeData) {
      pdf.text(`${label}: ${value}`, margin + 5, y);
      y += 5;
    }
    y += 5;

    // Wear Vector
    if (results.wearVector) {
      pdf.setFontSize(14);
      pdf.setTextColor(0, 0, 0);
      pdf.text('Wear Vector', margin, y);
      y += 7;

      pdf.setFontSize(10);
      pdf.setTextColor(60, 60, 60);
      pdf.text(`Max Depth: ${results.wearVector.maxDepth.toFixed(2)} μm`, margin + 5, y); y += 5;
      pdf.text(`Angle from Axis: ${results.wearVector.angle.toFixed(1)}°`, margin + 5, y); y += 5;
      pdf.text(`Distance to Pole: ${results.wearVector.distance.toFixed(3)} mm`, margin + 5, y); y += 5;
    }

    // Check if we need a new page
    if (y > 260) {
      pdf.addPage();
      y = margin;
    }

    // Anomaly summary
    y += 5;
    pdf.setFontSize(14);
    pdf.setTextColor(0, 0, 0);
    pdf.text('Anomaly Clusters', margin, y);
    y += 7;

    pdf.setFontSize(9);
    pdf.setTextColor(60, 60, 60);
    const allClusters = [...results.bumpClusters, ...results.dipClusters];
    for (const cluster of allClusters.slice(0, 10)) {
      const typeStr = cluster.type === 'bump' ? 'BUMP' : 'DIP';
      pdf.text(
        `${typeStr} #${cluster.id + 1}: ${cluster.points.length} pts, ` +
        `avg ${cluster.avgDeviation.toFixed(1)} μm, ` +
        `max ${cluster.maxDeviation.toFixed(1)} μm, ` +
        `vol ${cluster.volume.toFixed(4)} mm³`,
        margin + 5, y
      );
      y += 4.5;
      if (y > 280) { pdf.addPage(); y = margin; }
    }

    // Footer
    pdf.setFontSize(8);
    pdf.setTextColor(150, 150, 150);
    pdf.text('GeoWear v1.0 — UHMWPE Acetabular Cup Wear Analyzer', margin, 290);

    pdf.save(`${fileName}.pdf`);
  }

  // ---- Utilities ----

  private downloadDataUrl(dataUrl: string, fileName: string): void {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = fileName;
    a.click();
  }

  private downloadBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }
}

/**
 * Convert deviation (μm) to RGB555 format for Magics STL color.
 */
function deviationToRGB555(deviation: number): number {
  let r: number, g: number, b: number;

  if (deviation < -1) {
    // Dip → blue/purple
    const t = Math.min(1, Math.abs(deviation) / 50);
    r = Math.round(5 * (1 - t));
    g = Math.round(2 * (1 - t));
    b = Math.round(15 + 16 * t);
  } else if (deviation > 1) {
    // Bump → red
    const t = Math.min(1, deviation / 50);
    r = Math.round(20 + 11 * t);
    g = Math.round(10 * (1 - t));
    b = Math.round(3 * (1 - t));
  } else {
    // Nominal → green
    r = 8; g = 20; b = 8;
  }

  r = Math.max(0, Math.min(31, r));
  g = Math.max(0, Math.min(31, g));
  b = Math.max(0, Math.min(31, b));

  // RGB555: bit 15 = valid, bits 14-10 = R, 9-5 = G, 4-0 = B
  return 0x8000 | (r << 10) | (g << 5) | b;
}
