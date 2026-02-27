// ============================================================
// GeoWear — ResultsPanel
// Analysis results display and interactive table
// ============================================================

import type { AnalysisResults, AnomalyCluster, Geodesic } from '../types';

export class ResultsPanel {
  private container: HTMLElement;
  private sidebar: HTMLElement;
  private closeBtn: HTMLElement;
  private onGeodesicSelect?: (angle: number) => void;

  constructor() {
    this.container = document.getElementById('results-container')!;
    this.sidebar = document.getElementById('sidebar-right')!;
    this.closeBtn = document.getElementById('btn-close-results')!;

    this.closeBtn.addEventListener('click', () => this.hide());
  }

  /**
   * Set callback for geodesic selection in the table.
   */
  setGeodesicSelectHandler(handler: (angle: number) => void): void {
    this.onGeodesicSelect = handler;
  }

  /**
   * Show results panel with full analysis data.
   */
  show(results: AnalysisResults): void {
    this.sidebar.classList.remove('hidden');
    this.container.innerHTML = '';

    // Summary section
    this.addSummarySection(results);

    // Sphere fit section
    this.addSphereFitSection(results);

    // Shape classification section
    this.addShapeSection(results);

    // Wear analysis section
    this.addWearSection(results);

    // Volume section
    this.addVolumeSection(results);

    // Wear vector section
    if (results.wearVector) {
      this.addWearVectorSection(results);
    }

    // Geodesic table section
    this.addGeodesicTable(results.geodesics);

    // Trigger layout resize
    window.dispatchEvent(new Event('resize'));
  }

  hide(): void {
    this.sidebar.classList.add('hidden');
    window.dispatchEvent(new Event('resize'));
  }

  private addSummarySection(results: AnalysisResults): void {
    const section = this.createSection('Summary');

    this.addMetric(section, 'Vertices', results.vertexCount.toLocaleString());
    this.addMetric(section, 'Faces', results.sphereFit.residuals.length > 0
      ? `${(results.vertexCount).toLocaleString()}` : '—');
    this.addMetric(section, 'Geodesics', results.geodesicCount.toString());
    this.addMetric(section, 'Anomaly Points', results.totalAnomalyPoints.toLocaleString(), 
      results.totalAnomalyPoints > 0 ? 'warning' : 'success');
    this.addMetric(section, 'Bump Clusters', results.bumpClusters.length.toString());
    this.addMetric(section, 'Dip Clusters', results.dipClusters.length.toString(),
      results.dipClusters.length > 0 ? 'danger' : 'success');
    this.addMetric(section, 'Processing Time',
      `${(results.processingTimeMs / 1000).toFixed(1)}`, 's');

    this.container.appendChild(section);
  }

  private addSphereFitSection(results: AnalysisResults): void {
    const section = this.createSection('Sphere Fit');
    const sf = results.sphereFit;

    this.addMetric(section, 'Radius', sf.radius.toFixed(4), 'mm');
    this.addMetric(section, 'Center X', sf.center.x.toFixed(4), 'mm');
    this.addMetric(section, 'Center Y', sf.center.y.toFixed(4), 'mm');
    this.addMetric(section, 'Center Z', sf.center.z.toFixed(4), 'mm');
    this.addMetric(section, 'RMS Error', (sf.rmsError * 1000).toFixed(2), 'μm');
    this.addMetric(section, 'Max Error', (sf.maxError * 1000).toFixed(2), 'μm');

    this.container.appendChild(section);
  }

  private addShapeSection(results: AnalysisResults): void {
    const section = this.createSection('Shape Classification');
    const ef = results.ellipsoidFit;

    this.addMetric(section, 'Sphericity', `${ef.sphericityPercent.toFixed(2)}`, '%',
      ef.sphericityPercent >= 98 ? 'success' : ef.sphericityPercent >= 90 ? 'warning' : 'danger');
    this.addMetric(section, 'Classification', ef.shapeClass.replace(/-/g, ' '));
    this.addMetric(section, 'Semi-axis A', ef.semiAxes[0].toFixed(4), 'mm');
    this.addMetric(section, 'Semi-axis B', ef.semiAxes[1].toFixed(4), 'mm');
    this.addMetric(section, 'Semi-axis C', ef.semiAxes[2].toFixed(4), 'mm');
    this.addMetric(section, 'Axis ratio (B/A)', (ef.semiAxes[1] / ef.semiAxes[0]).toFixed(4));
    this.addMetric(section, 'Axis ratio (C/A)', (ef.semiAxes[2] / ef.semiAxes[0]).toFixed(4));

    this.container.appendChild(section);
  }

  private addWearSection(results: AnalysisResults): void {
    const section = this.createSection('Wear Analysis');

    // Find max bump and max dip across all clusters
    let maxBump = 0, maxDip = 0;
    for (const c of results.bumpClusters) {
      if (c.maxDeviation > maxBump) maxBump = c.maxDeviation;
    }
    for (const c of results.dipClusters) {
      if (c.minDeviation < maxDip) maxDip = c.minDeviation;
    }

    this.addMetric(section, 'Max Bump', `+${maxBump.toFixed(2)}`, 'μm',
      maxBump > 10 ? 'danger' : maxBump > 5 ? 'warning' : 'success');
    this.addMetric(section, 'Max Dip', `${maxDip.toFixed(2)}`, 'μm',
      Math.abs(maxDip) > 10 ? 'danger' : Math.abs(maxDip) > 5 ? 'warning' : 'success');

    if (results.primaryWearZone) {
      const pwz = results.primaryWearZone;
      this.addMetric(section, 'Primary Wear Depth', `${pwz.minDeviation.toFixed(2)}`, 'μm', 'danger');
      this.addMetric(section, 'Primary Wear Area', pwz.area.toFixed(2), 'mm²');
    }

    this.container.appendChild(section);
  }

  private addVolumeSection(results: AnalysisResults): void {
    const section = this.createSection('Volume Analysis');

    this.addMetric(section, 'Bump Volume (excess)',
      results.totalBumpVolume.toFixed(4), 'mm³',
      results.totalBumpVolume > 0.1 ? 'warning' : 'success');
    this.addMetric(section, 'Dip Volume (missing)',
      results.totalDipVolume.toFixed(4), 'mm³',
      results.totalDipVolume > 0.1 ? 'danger' : 'success');
    this.addMetric(section, 'Total Defect Volume',
      (results.totalBumpVolume + results.totalDipVolume).toFixed(4), 'mm³');

    // Mass estimates
    const density = 0.935; // g/cm³ = mg/mm³
    this.addMetric(section, 'Bump Mass',
      (results.totalBumpVolume * density).toFixed(4), 'mg');
    this.addMetric(section, 'Dip Mass (wear)',
      (results.totalDipVolume * density).toFixed(4), 'mg', 'danger');

    this.container.appendChild(section);
  }

  private addWearVectorSection(results: AnalysisResults): void {
    const section = this.createSection('Wear Vector');
    const wv = results.wearVector!;

    this.addMetric(section, 'Max Depth', wv.maxDepth.toFixed(2), 'μm', 'danger');
    this.addMetric(section, 'Distance to Pole', wv.distance.toFixed(3), 'mm');
    this.addMetric(section, 'Angle from Axis', wv.angle.toFixed(1), '°');
    this.addMetric(section, 'Deepest Pt X', wv.deepestPoint.x.toFixed(3), 'mm');
    this.addMetric(section, 'Deepest Pt Y', wv.deepestPoint.y.toFixed(3), 'mm');
    this.addMetric(section, 'Deepest Pt Z', wv.deepestPoint.z.toFixed(3), 'mm');

    this.container.appendChild(section);
  }

  private addGeodesicTable(geodesics: Geodesic[]): void {
    const section = this.createSection('Geodesic Details');

    const tableWrapper = document.createElement('div');
    tableWrapper.style.maxHeight = '300px';
    tableWrapper.style.overflowY = 'auto';

    const table = document.createElement('table');
    table.className = 'geodesic-table';

    // Header
    const thead = document.createElement('thead');
    thead.innerHTML = `
      <tr>
        <th>Angle</th>
        <th>Max</th>
        <th>Min</th>
        <th>Anom.</th>
      </tr>`;
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    for (const geo of geodesics) {
      const tr = document.createElement('tr');
      if (geo.anomalyCount > 0) tr.className = 'anomaly';

      tr.innerHTML = `
        <td>${geo.angle.toFixed(0)}°</td>
        <td style="color: ${geo.maxDeviation > 1 ? '#f85149' : 'inherit'}">${geo.maxDeviation.toFixed(1)}</td>
        <td style="color: ${geo.minDeviation < -1 ? '#6644ff' : 'inherit'}">${geo.minDeviation.toFixed(1)}</td>
        <td>${geo.anomalyCount}</td>
      `;

      tr.addEventListener('click', () => {
        if (this.onGeodesicSelect) {
          this.onGeodesicSelect(geo.angle);
        }
      });

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableWrapper.appendChild(table);
    section.appendChild(tableWrapper);

    this.container.appendChild(section);
  }

  private createSection(title: string): HTMLElement {
    const section = document.createElement('div');
    section.className = 'results-section fade-in';

    const h3 = document.createElement('h3');
    h3.textContent = title;
    section.appendChild(h3);

    return section;
  }

  private addMetric(
    section: HTMLElement,
    label: string,
    value: string,
    unit?: string,
    colorClass?: string
  ): void {
    const row = document.createElement('div');
    row.className = 'metric-row';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'metric-label';
    labelSpan.textContent = label;

    const valueSpan = document.createElement('span');
    valueSpan.className = `metric-value ${colorClass || ''}`;
    valueSpan.textContent = value;
    if (unit) {
      const unitSpan = document.createElement('span');
      unitSpan.className = 'metric-unit';
      unitSpan.textContent = unit;
      valueSpan.appendChild(unitSpan);
    }

    row.appendChild(labelSpan);
    row.appendChild(valueSpan);
    section.appendChild(row);
  }
}
