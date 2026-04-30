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
  // Sphere BestFit mode steps
  onStepCommercialRadius: () => void;
  onStepClassifyWear: () => void;
  onStepWearVolume: () => void;
  // Visualization toggles
  onToggleWireframe: (v: boolean) => void;
  onGeodesicDisplayMode: (mode: string) => void;
  onToggleHeatmap: (v: boolean) => void;
  onToggleAnnotations: (v: boolean) => void;
  onToggleRefSphere: (v: boolean) => void;
  onToggleContext: (opaque: boolean) => void;
  onToggleCommercialSphere: (v: boolean) => void;
  onToggleWornSphere: (v: boolean) => void;
  onToggleUnwornSphere: (v: boolean) => void;
  onToggleRimPlane: (v: boolean) => void;
  onToggleWearPlane: (v: boolean) => void;
  onToggleMeshVolume: (v: boolean) => void;
  onToggleSphereCapVolume: (v: boolean) => void;
  onToggleWearVolume: (v: boolean) => void;
  onToggleOriginalMesh: (v: boolean) => void;
  // Export
  onExportPNG: () => void;
  onExportCSV: () => void;
  onExportSTL: () => void;
  onExportPDF: () => void;
  onShowResults: () => void;
  onParamsChange: (params: AnalysisParams) => void;
  // Exclusion zone
  onEnableLassoMode: () => void;
  onClearExclusions: () => void;
  onToggleExcludedHighlight: (v: boolean) => void;
}

export class ControlPanel {
  private gui: GUI;
  public params: AnalysisParams;
  private callbacks: ControlCallbacks;
  private processingFolder!: GUI;
  private analysisButtons: Record<string, any> = {};
  private buttonControllers: Record<string, any> = {};
  private completedSteps = new Set<string>();
  // BestFit mode UI state
  private bestfitStepControllers: any[] = [];
  private pureGeodesicStepControllers: any[] = [];
  private bestfitVisControllers: any[] = [];
  private doubleSphereControllers: any[] = [];
  // Controllers visible in BOTH sphere-bestfit AND double-sphere-metrics
  private dualModeVisControllers: any[] = [];
  // Commercial radius proxy for dropdown
  private commercialRadiusProxy = { value: 'Auto' };
  private colorRangeMaxController: any = null;
  private rimInclinationController: any = null;
  private rimAzimuthController: any = null;
  // Analysis mode display name mapping
  private readonly modeLabelMap: Record<string, string> = {
    'Pure Geodesic': 'pure-geodesic',
    'Sphere BestFit': 'sphere-bestfit',
    'Double Sphere Metrics': 'double-sphere-metrics',
    'Compare All Modes': 'compare-all-modes',
  };
  private readonly modeReverseMap: Record<string, string> = {
    'pure-geodesic': 'Pure Geodesic',
    'sphere-bestfit': 'Sphere BestFit',
    'double-sphere-metrics': 'Double Sphere Metrics',
    'compare-all-modes': 'Compare All Modes',
  };
  private analysisModelProxy = { mode: 'Compare All Modes' };

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
    this.buildExclusionSection();
    this.buildExportSection();
  }

  private buildImportSection(): void {
    const folder = this.gui.addFolder('📂 Import');
    folder.domElement.classList.add('section-import');

    const importBtn = { 'Load STL File': () => this.callbacks.onLoadSTL() };
    folder.add(importBtn, 'Load STL File');

    folder.open();
  }

  private buildProcessingSection(): void {
    this.processingFolder = this.gui.addFolder('⚙ Processing');
    this.processingFolder.domElement.classList.add('section-processing');

    const runAll = { 'Run Full Analysis': () => this.callbacks.onRunAnalysis() };
    const runAllCtrl = this.processingFolder.add(runAll, 'Run Full Analysis');
    const runBtn = runAllCtrl.domElement.querySelector('button');
    if (runBtn) runBtn.classList.add('btn-run-analysis');

    this.processingFolder.add(this.params, 'repairInnerFace')
      .name('Repair Inner Face')
      .onChange(() => this.callbacks.onParamsChange(this.params));

    // Step-by-step controls
    const steps = this.processingFolder.addFolder('Step by Step');

    // Shared steps (1-3)
    this.analysisButtons['separate'] = { '1. Detect Inner Face': () => this.callbacks.onStepSeparate() };
    this.buttonControllers['separate'] = steps.add(this.analysisButtons['separate'], '1. Detect Inner Face');

    this.analysisButtons['trim'] = { '2. Trim Rim': () => this.callbacks.onStepTrim() };
    this.buttonControllers['trim'] = steps.add(this.analysisButtons['trim'], '2. Trim Rim');

    this.analysisButtons['geodesics'] = { '3. Compute Geodesics': () => this.callbacks.onStepGeodesics() };
    this.buttonControllers['geodesics'] = steps.add(this.analysisButtons['geodesics'], '3. Compute Geodesics');

    this.analysisButtons['fit'] = { '4. Fit Sphere': () => this.callbacks.onStepFitSphere() };
    this.buttonControllers['fit'] = steps.add(this.analysisButtons['fit'], '4. Fit Sphere');

    // --- Sphere BestFit steps (5-7) ---
    this.analysisButtons['commercial'] = { '5. Commercial Radius': () => this.callbacks.onStepCommercialRadius() };
    this.buttonControllers['commercial'] = steps.add(this.analysisButtons['commercial'], '5. Commercial Radius');
    this.bestfitStepControllers.push(this.buttonControllers['commercial']);

    this.analysisButtons['classifywear'] = { '6. Classify Wear Zones': () => this.callbacks.onStepClassifyWear() };
    this.buttonControllers['classifywear'] = steps.add(this.analysisButtons['classifywear'], '6. Classify Wear Zones');
    this.bestfitStepControllers.push(this.buttonControllers['classifywear']);

    this.analysisButtons['wearvolume'] = { '7. Compute Wear Volume': () => this.callbacks.onStepWearVolume() };
    this.buttonControllers['wearvolume'] = steps.add(this.analysisButtons['wearvolume'], '7. Compute Wear Volume');
    this.bestfitStepControllers.push(this.buttonControllers['wearvolume']);

    // --- Pure Geodesic step (5) ---
    this.analysisButtons['analyze'] = { '5. Analyze & Quantify': () => this.callbacks.onStepAnalyze() };
    this.buttonControllers['analyze'] = steps.add(this.analysisButtons['analyze'], '5. Analyze & Quantify');
    this.pureGeodesicStepControllers.push(this.buttonControllers['analyze']);

    steps.close();
    this.processingFolder.open();

    // Apply initial mode visibility
    this.updateStepVisibility();
  }

  private buildParametersSection(): void {
    const folder = this.gui.addFolder('🔧 Parameters');
    folder.domElement.classList.add('section-parameters');

    // --- Wear Model sub-section ---
    const wearModel = folder.addFolder('Wear Model');
    wearModel.add(this.analysisModelProxy, 'mode', ['Pure Geodesic', 'Sphere BestFit', 'Double Sphere Metrics', 'Compare All Modes'])
      .name('Analysis Mode')
      .onChange((v: string) => {
        this.params.analysisMode = this.modeLabelMap[v] as AnalysisParams['analysisMode'];
        this.callbacks.onParamsChange(this.params);
        this.updateStepVisibility();
      });

    wearModel.add(this.commercialRadiusProxy, 'value', ['Auto', '14 mm', '16 mm', '18 mm', '20 mm'])
      .name('Commercial Radius')
      .onChange((v: string) => {
        if (v === 'Auto') {
          this.params.commercialRadius = 0;
        } else {
          this.params.commercialRadius = parseInt(v);
        }
        this.callbacks.onParamsChange(this.params);
      });

    const filterLabelMap: Record<string, string> = {
      'None': 'none',
      'Robust IRLS': 'robust-irls',
      'Spatial DBSCAN': 'dbscan-spatial',
      'Combined (recommended)': 'combined',
    };
    const filterProxy = { value: 'Combined (recommended)' };
    const filterCtrl = wearModel.add(filterProxy, 'value',
      ['None', 'Robust IRLS', 'Spatial DBSCAN', 'Combined (recommended)'])
      .name('Linear Wear Filter')
      .onChange((v: string) => {
        this.params.linearWearFilter = filterLabelMap[v] as any;
        this.callbacks.onParamsChange(this.params);
      });
    this.bestfitVisControllers.push(filterCtrl);

    const minCovCtrl = wearModel.add(this.params, 'minWornCoveragePct', 0, 10, 0.1)
      .name('Min Worn Coverage %')
      .onChange(() => this.callbacks.onParamsChange(this.params));
    this.bestfitVisControllers.push(minCovCtrl);

    const dsFolder = folder.addFolder('Double Sphere Sweep');
    const dsFactor = dsFolder.add(this.params, 'doubleSphereFactor', 0.9, 1.5, 0.005)
      .name('Factor')
      .onChange(() => this.callbacks.onParamsChange(this.params));
    this.doubleSphereControllers.push(dsFactor);

    const dsIter = dsFolder.add(this.params, 'doubleSphereIterations', 1, 30, 1)
      .name('Iterations')
      .onChange(() => this.callbacks.onParamsChange(this.params));
    this.doubleSphereControllers.push(dsIter);

    const dsT1Min = dsFolder.add(this.params, 'doubleSphereThresh1Min', 0.01, 1.0, 0.01)
      .name('Thresh1 Min')
      .onChange(() => this.callbacks.onParamsChange(this.params));
    this.doubleSphereControllers.push(dsT1Min);

    const dsT1Max = dsFolder.add(this.params, 'doubleSphereThresh1Max', 0.01, 1.5, 0.01)
      .name('Thresh1 Max')
      .onChange(() => this.callbacks.onParamsChange(this.params));
    this.doubleSphereControllers.push(dsT1Max);

    const dsT2Min = dsFolder.add(this.params, 'doubleSphereThresh2Min', 0.01, 1.0, 0.01)
      .name('Thresh2 Min')
      .onChange(() => this.callbacks.onParamsChange(this.params));
    this.doubleSphereControllers.push(dsT2Min);

    const dsT2Max = dsFolder.add(this.params, 'doubleSphereThresh2Max', 0.01, 1.5, 0.01)
      .name('Thresh2 Max')
      .onChange(() => this.callbacks.onParamsChange(this.params));
    this.doubleSphereControllers.push(dsT2Max);

    const dsStep = dsFolder.add(this.params, 'doubleSphereSweepStep', 0.005, 0.25, 0.005)
      .name('Sweep Step')
      .onChange(() => this.callbacks.onParamsChange(this.params));
    this.doubleSphereControllers.push(dsStep);

    wearModel.open();
    dsFolder.close();

    const yivCtrl = folder.add(this.params, 'yearsInVivo', 0, 40, 0.1)
      .name('⏱ Years In Vivo')
      .onChange(() => this.callbacks.onParamsChange(this.params));
    yivCtrl.domElement.parentElement!.style.cssText +=
      'background: rgba(56,154,237,0.12); border-left: 3px solid #389aed; border-radius: 3px; padding-left: 4px;';

    // --- Geometry sub-section ---
    const geoFolder = folder.addFolder('Geometry');
    geoFolder.add(this.params, 'geodesicCount', 36, 720, 1)
      .name('Geodesics')
      .onChange(() => this.callbacks.onParamsChange(this.params));
    geoFolder.add(this.params, 'rimTrimPercent', 0, 50, 0.5)
      .name('Rim Trim %')
      .onChange(() => this.callbacks.onParamsChange(this.params));
    this.rimInclinationController = geoFolder.add(this.params, 'rimInclinationAngle', -180, 180, 0.5)
      .name('Rim Inclination (°)')
      .onChange(() => this.callbacks.onParamsChange(this.params));
    this.rimAzimuthController = geoFolder.add(this.params, 'rimInclinationAzimuth', -180, 180, 1)
      .name('Rim Azimuth (°)')
      .onChange(() => this.callbacks.onParamsChange(this.params));
    geoFolder.add(this.params, 'smoothingIterations', 0, 10, 1)
      .name('Smoothing Iter.')
      .onChange(() => this.callbacks.onParamsChange(this.params));
    geoFolder.close();

    // --- Analysis & Display sub-section ---
    const dispFolder = folder.addFolder('Analysis & Display');
    dispFolder.add(this.params, 'thresholdMicrons', 0.1, 10, 0.1)
      .name('Threshold (μm)')
      .onChange(() => this.callbacks.onParamsChange(this.params));
    dispFolder.add(this.params, 'density', 0.8, 1.1, 0.001)
      .name('Density (g/cm³)')
      .onChange(() => this.callbacks.onParamsChange(this.params));
    dispFolder.add(this.params, 'colorMapName', ['rainbow', 'cooltowarm', 'blackbody'])
      .name('Color Map')
      .onChange(() => this.callbacks.onParamsChange(this.params));
    this.colorRangeMaxController = dispFolder.add(this.params, 'colorRangeMax', 0, 200, 1)
      .name('Color Max (μm)')
      .onChange(() => this.callbacks.onParamsChange(this.params));
    dispFolder.close();

    folder.close();
  }

  private buildVisualizationSection(): void {
    const folder = this.gui.addFolder('👁 Visualization');
    folder.domElement.classList.add('section-visualization');

    // Always-visible at root level
    folder.add(this.params, 'contextOpaque')
      .name('Opaque Context')
      .onChange((v: boolean) => this.callbacks.onToggleContext(v));

    const resultsBtn = { 'Show Results Panel': () => this.callbacks.onShowResults() };
    folder.add(resultsBtn, 'Show Results Panel');

    // --- Rendering sub-folder ---
    const renderFolder = folder.addFolder('Rendering');
    renderFolder.add(this.params, 'showWireframe')
      .name('Wireframe')
      .onChange((v: boolean) => this.callbacks.onToggleWireframe(v));
    renderFolder.add(this.params, 'geodesicDisplayMode', ['all', 'regular', 'irregular', 'none'])
      .name('Geodesics')
      .onChange((v: string) => this.callbacks.onGeodesicDisplayMode(v));
    renderFolder.add(this.params, 'showHeatmap')
      .name('Heat Map')
      .onChange((v: boolean) => this.callbacks.onToggleHeatmap(v));
    renderFolder.add(this.params, 'showAnnotations')
      .name('Annotations')
      .onChange((v: boolean) => this.callbacks.onToggleAnnotations(v));
    renderFolder.open();

    // --- Overlays sub-folder (spheres, planes, volumes) ---
    const overlayFolder = folder.addFolder('Overlays');
    overlayFolder.add(this.params, 'showReferenceShape')
      .name('Reference Sphere')
      .onChange((v: boolean) => this.callbacks.onToggleRefSphere(v));

    const csc = overlayFolder.add(this.params, 'showCommercialSphere')
      .name('Commercial Sphere')
      .onChange((v: boolean) => this.callbacks.onToggleCommercialSphere(v));
    this.bestfitVisControllers.push(csc);

    const wsc = overlayFolder.add(this.params, 'showWornSphere')
      .name('Worn Sphere (Red)')
      .onChange((v: boolean) => this.callbacks.onToggleWornSphere(v));
    this.dualModeVisControllers.push(wsc);

    const usc = overlayFolder.add(this.params, 'showUnwornSphere')
      .name('Unworn Sphere (Green)')
      .onChange((v: boolean) => this.callbacks.onToggleUnwornSphere(v));
    this.dualModeVisControllers.push(usc);

    const rpc = overlayFolder.add(this.params, 'showRimPlane')
      .name('Rim Plane')
      .onChange((v: boolean) => this.callbacks.onToggleRimPlane(v));
    this.dualModeVisControllers.push(rpc);

    const wpc = overlayFolder.add(this.params, 'showWearPlane')
      .name('Wear Section Plane')
      .onChange((v: boolean) => this.callbacks.onToggleWearPlane(v));
    this.bestfitVisControllers.push(wpc);

    const mvc = overlayFolder.add(this.params, 'showMeshVolume')
      .name('Mesh Volume (Blue)')
      .onChange((v: boolean) => this.callbacks.onToggleMeshVolume(v));
    this.dualModeVisControllers.push(mvc);

    const scc = overlayFolder.add(this.params, 'showSphereCapVolume')
      .name('Sphere Cap (Green)')
      .onChange((v: boolean) => this.callbacks.onToggleSphereCapVolume(v));
    this.dualModeVisControllers.push(scc);

    const wvc = overlayFolder.add(this.params, 'showWearVolume')
      .name('Wear Volume (Red)')
      .onChange((v: boolean) => this.callbacks.onToggleWearVolume(v));
    this.dualModeVisControllers.push(wvc);

    const omc = overlayFolder.add(this.params, 'showOriginalMesh')
      .name('Full STL Sample')
      .onChange((v: boolean) => this.callbacks.onToggleOriginalMesh(v));
    this.dualModeVisControllers.push(omc);

    overlayFolder.close();

    folder.open();
  }

  private buildExclusionSection(): void {
    const folder = this.gui.addFolder('✂ Exclusion Zone');
    folder.domElement.classList.add('section-exclusion');

    const actions = {
      'Draw Lasso': () => this.callbacks.onEnableLassoMode(),
      'Clear All': () => this.callbacks.onClearExclusions(),
    };
    folder.add(actions, 'Draw Lasso');
    folder.add(actions, 'Clear All');

    folder.add(this.params, 'showExcludedVertices')
      .name('Highlight Excluded')
      .onChange((v: boolean) => this.callbacks.onToggleExcludedHighlight(v));

    // Exclusion zone count label (updated externally via updateExclusionCount)
    this.exclusionCountProxy = { info: 'No vertices excluded' };
    this.exclusionCountController = folder.add(this.exclusionCountProxy, 'info').name('Status').disable();

    folder.close();
  }

  // Proxy objects for the exclusion folder
  private exclusionCountProxy: { info: string } = { info: 'No vertices excluded' };
  private exclusionCountController: any = null;

  /** Update the exclusion count label in the UI */
  public updateExclusionCount(count: number): void {
    this.exclusionCountProxy.info = count === 0 ? 'No vertices excluded' : `${count.toLocaleString()} vertices excluded`;
    if (this.exclusionCountController) this.exclusionCountController.updateDisplay();
  }

  /**
   * Refresh the Rim Inclination and Rim Azimuth slider display.
   * Call this after programmatically writing new values into params
   * (e.g. after the manual rim plane pick mode computes a new normal).
   */
  public refreshRimSliders(): void {
    this.rimInclinationController?.updateDisplay();
    this.rimAzimuthController?.updateDisplay();
  }

  private buildExportSection(): void {
    const folder = this.gui.addFolder('💾 Export');
    folder.domElement.classList.add('section-export');

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

  /**
   * Mark a step as completed by adding a checkmark to its button label.
   */
  public markStepCompleted(stepName: string): void {
    if (this.completedSteps.has(stepName)) return;
    this.completedSteps.add(stepName);

    const controller = this.buttonControllers[stepName];
    if (controller) {
      const button = controller.domElement.querySelector('button');
      if (button) {
        button.style.color = '#3fb950'; // green
        button.textContent = '✓ ' + button.textContent;
      }
    }
  }

  /**
   * Show/hide step buttons based on the current analysis mode.
   */
  private updateStepVisibility(): void {
    const isBestFit = this.params.analysisMode === 'sphere-bestfit';
    const isDoubleSphere = this.params.analysisMode === 'double-sphere-metrics';
    const isCompareMode = this.params.analysisMode === 'compare-all-modes';
    const isPureOnly = this.params.analysisMode === 'pure-geodesic';

    for (const ctrl of this.bestfitStepControllers) {
      isBestFit ? ctrl.show() : ctrl.hide();
    }
    for (const ctrl of this.pureGeodesicStepControllers) {
      isPureOnly ? ctrl.show() : ctrl.hide();
    }
    for (const ctrl of this.bestfitVisControllers) {
      isBestFit ? ctrl.show() : ctrl.hide();
    }
    for (const ctrl of this.dualModeVisControllers) {
      (isBestFit || isDoubleSphere || isCompareMode) ? ctrl.show() : ctrl.hide();
    }
    for (const ctrl of this.doubleSphereControllers) {
      (isDoubleSphere || isCompareMode) ? ctrl.show() : ctrl.hide();
    }
  }

  /**
   * Update the color range max value and slider bounds to fit the actual data.
   */
  public updateColorRangeMax(value: number, sliderMax: number): void {
    this.params.colorRangeMax = value;
    if (this.colorRangeMaxController) {
      this.colorRangeMaxController.max(sliderMax);
      this.colorRangeMaxController.updateDisplay();
    }
  }

  dispose(): void {
    this.gui.destroy();
  }
}
