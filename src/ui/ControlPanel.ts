// ============================================================
// GeoWear — ControlPanel
// lil-gui based parameter controls
// ============================================================

import GUI from 'lil-gui';
import type { AnalysisParams } from '../types';
import { DEFAULT_PARAMS } from '../types';

export interface ControlCallbacks {
  onLoadSTL: () => void;
  onRunAnalysis: () => void;
  onStepSeparate: () => void;
  onStepTrim: () => void;
  onStepFitSphere: () => void;
  onStepGeodesics: () => void;
  onStepAnalyze: () => void;
  onToggleWireframe: (v: boolean) => void;
  onToggleGeodesics: (v: boolean) => void;
  onToggleHeatmap: (v: boolean) => void;
  onToggleAnnotations: (v: boolean) => void;
  onToggleRefSphere: (v: boolean) => void;
  onExportPNG: () => void;
  onExportCSV: () => void;
  onExportSTL: () => void;
  onExportPDF: () => void;
  onShowResults: () => void;
  onParamsChange: (params: AnalysisParams) => void;
}

export class ControlPanel {
  private gui: GUI;
  public params: AnalysisParams;
  private callbacks: ControlCallbacks;
  private processingFolder!: GUI;
  private analysisButtons: Record<string, any> = {};

  constructor(callbacks: ControlCallbacks) {
    this.callbacks = callbacks;
    this.params = { ...DEFAULT_PARAMS };

    const container = document.getElementById('gui-container')!;
    this.gui = new GUI({ container, autoPlace: false, title: 'GeoWear Controls' });
    this.gui.domElement.style.width = '100%';

    this.buildImportSection();
    this.buildProcessingSection();
    this.buildParametersSection();
    this.buildVisualizationSection();
    this.buildExportSection();
  }

  private buildImportSection(): void {
    const folder = this.gui.addFolder('📂 Import');

    const importBtn = { 'Load STL File': () => this.callbacks.onLoadSTL() };
    folder.add(importBtn, 'Load STL File');

    folder.open();
  }

  private buildProcessingSection(): void {
    this.processingFolder = this.gui.addFolder('⚙ Processing');

    const runAll = { 'Run Full Analysis': () => this.callbacks.onRunAnalysis() };
    this.processingFolder.add(runAll, 'Run Full Analysis');

    // Step-by-step controls
    const steps = this.processingFolder.addFolder('Step by Step');
    this.analysisButtons['separate'] = { '1. Detect Inner Face': () => this.callbacks.onStepSeparate() };
    steps.add(this.analysisButtons['separate'], '1. Detect Inner Face');

    this.analysisButtons['trim'] = { '2. Trim Rim (5%)': () => this.callbacks.onStepTrim() };
    steps.add(this.analysisButtons['trim'], '2. Trim Rim (5%)');

    this.analysisButtons['fit'] = { '3. Fit Sphere': () => this.callbacks.onStepFitSphere() };
    steps.add(this.analysisButtons['fit'], '3. Fit Sphere');

    this.analysisButtons['geodesics'] = { '4. Compute Geodesics': () => this.callbacks.onStepGeodesics() };
    steps.add(this.analysisButtons['geodesics'], '4. Compute Geodesics');

    this.analysisButtons['analyze'] = { '5. Analyze & Quantify': () => this.callbacks.onStepAnalyze() };
    steps.add(this.analysisButtons['analyze'], '5. Analyze & Quantify');

    steps.close();
    this.processingFolder.open();
  }

  private buildParametersSection(): void {
    const folder = this.gui.addFolder('🔧 Parameters');

    folder.add(this.params, 'geodesicCount', 36, 720, 1)
      .name('Geodesics')
      .onChange(() => this.callbacks.onParamsChange(this.params));

    folder.add(this.params, 'rimTrimPercent', 0, 20, 0.5)
      .name('Rim Trim %')
      .onChange(() => this.callbacks.onParamsChange(this.params));

    folder.add(this.params, 'thresholdMicrons', 0.1, 10, 0.1)
      .name('Threshold (μm)')
      .onChange(() => this.callbacks.onParamsChange(this.params));

    folder.add(this.params, 'density', 0.8, 1.1, 0.001)
      .name('Density (g/cm³)')
      .onChange(() => this.callbacks.onParamsChange(this.params));

    folder.add(this.params, 'colorMapName', ['rainbow', 'cooltowarm', 'blackbody'])
      .name('Color Map')
      .onChange(() => this.callbacks.onParamsChange(this.params));

    folder.add(this.params, 'colorRangeMin', -200, 0, 1)
      .name('Color Min (μm)')
      .onChange(() => this.callbacks.onParamsChange(this.params));

    folder.add(this.params, 'colorRangeMax', 0, 200, 1)
      .name('Color Max (μm)')
      .onChange(() => this.callbacks.onParamsChange(this.params));

    folder.close();
  }

  private buildVisualizationSection(): void {
    const folder = this.gui.addFolder('👁 Visualization');

    folder.add(this.params, 'showWireframe')
      .name('Wireframe')
      .onChange((v: boolean) => this.callbacks.onToggleWireframe(v));

    folder.add(this.params, 'showGeodesics')
      .name('Geodesics')
      .onChange((v: boolean) => this.callbacks.onToggleGeodesics(v));

    folder.add(this.params, 'showHeatmap')
      .name('Heat Map')
      .onChange((v: boolean) => this.callbacks.onToggleHeatmap(v));

    folder.add(this.params, 'showAnnotations')
      .name('Annotations')
      .onChange((v: boolean) => this.callbacks.onToggleAnnotations(v));

    folder.add(this.params, 'showReferenceShape')
      .name('Reference Sphere')
      .onChange((v: boolean) => this.callbacks.onToggleRefSphere(v));

    const resultsBtn = { 'Show Results Panel': () => this.callbacks.onShowResults() };
    folder.add(resultsBtn, 'Show Results Panel');

    folder.open();
  }

  private buildExportSection(): void {
    const folder = this.gui.addFolder('💾 Export');

    const exports = {
      'Screenshot (PNG)': () => this.callbacks.onExportPNG(),
      'Data (CSV)': () => this.callbacks.onExportCSV(),
      'Colored Mesh (STL)': () => this.callbacks.onExportSTL(),
      'Report (PDF)': () => this.callbacks.onExportPDF(),
    };

    folder.add(exports, 'Screenshot (PNG)');
    folder.add(exports, 'Data (CSV)');
    folder.add(exports, 'Colored Mesh (STL)');
    folder.add(exports, 'Report (PDF)');

    folder.close();
  }

  dispose(): void {
    this.gui.destroy();
  }
}
