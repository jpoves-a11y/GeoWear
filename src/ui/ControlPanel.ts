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
  // Manual rim plane pick
  onRimPickUndo: () => void;
  onRimPickFlipNormal: () => void;
  onRimPickClearPoints: () => void;
  onRimPickConfirm: () => void;
  onRimPickRevertAuto: () => void;
  onRimPickDefinePole: () => void;
  // Manual hole seed pick
  onEnableHoleSeedMode: () => void;
  onClearHoleSeeds: () => void;
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
  // Visualization sub-folders (hidden until analysis results are available)
  private visRenderFolder: GUI | null = null;
  private visOverlayFolder: GUI | null = null;
  private visRimPlaneCtrl: any = null;          // always visible (rim preview works pre-analysis)
  private visGeodesicsControllers: any[] = [];   // hidden for double-sphere
  private visAnnotationsControllers: any[] = []; // shown only for pure-geodesic
  private visCompareSelectorCtrl: any = null;    // inline compare sub-mode picker
  // Commercial radius proxy for dropdown
  private commercialRadiusProxy = { value: 'Auto' };
  private colorRangeMaxController: any = null;
  private rimInclinationController: any = null;
  private rimAzimuthController: any = null;
  // Rim plane pick mode controllers (enabled/disabled dynamically)
  private rimPickStatusController: any = null;
  private rimPickUndoController: any = null;
  private rimPickFlipController: any = null;
  private rimPickClearController: any = null;
  private rimPickConfirmController: any = null;
  private rimPickPoleController: any = null;
  // Hole seed pick mode controllers
  private holeSeedStatusProxy: { info: string } = { info: 'No seeds placed' };
  private holeSeedStatusController: any = null;
  private holeSeedClearController: any = null;
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

  // Compare-mode visualisation selector (inline inside Visualization folder)
  private compareVisModeProxy = { mode: 'Sphere BestFit' };
  private compareVisModeCallback: ((mode: 'pure-geodesic' | 'sphere-bestfit' | 'double-sphere-metrics') => void) | null = null;
  private readonly compareVisModeMap: Record<string, 'pure-geodesic' | 'sphere-bestfit' | 'double-sphere-metrics'> = {
    'Pure Geodesic': 'pure-geodesic',
    'Sphere BestFit': 'sphere-bestfit',
    'Double Sphere Metrics': 'double-sphere-metrics',
  };

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
    this.buildRimPlaneSection();
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

    const holeMaxCtrl = this.processingFolder.add(this.params, 'holeRepairMaxLoopSize', 3, 5000, 1)
      .name('Max Hole Size (verts)')
      .onChange(() => this.callbacks.onParamsChange(this.params));
    if (!this.params.repairInnerFace) holeMaxCtrl.hide();

    this.processingFolder.add(this.params, 'repairInnerFace')
      .name('Repair Inner Face')
      .onChange((v: boolean) => {
        if (v) holeMaxCtrl.show(); else holeMaxCtrl.hide();
        this.callbacks.onParamsChange(this.params);
      });

    // --- Manual hole seed mode ---
    const holeActions = {
      'Seed Holes Manually': () => this.callbacks.onEnableHoleSeedMode(),
      'Clear Seeds': () => this.callbacks.onClearHoleSeeds(),
    };
    this.processingFolder.add(holeActions, 'Seed Holes Manually')
      .name('🕳 Seed Holes Manually');
    this.holeSeedClearController = this.processingFolder.add(holeActions, 'Clear Seeds')
      .name('Clear Seeds');
    this.holeSeedStatusController = this.processingFolder
      .add(this.holeSeedStatusProxy, 'info')
      .name('Seeds')
      .disable();

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

    // Compare-mode sub-mode selector — shown only after compare-all-modes analysis
    this.visCompareSelectorCtrl = folder.add(
      this.compareVisModeProxy,
      'mode',
      ['Pure Geodesic', 'Sphere BestFit', 'Double Sphere Metrics'],
    )
      .name('🔍 View Mode')
      .onChange((v: string) => {
        const mode = this.compareVisModeMap[v];
        this.updateVisControlsForMode(mode);
        if (this.compareVisModeCallback) this.compareVisModeCallback(mode);
      });
    this.visCompareSelectorCtrl.hide();

    // Always-visible at root level
    folder.add(this.params, 'contextOpaque')
      .name('Opaque Context')
      .onChange((v: boolean) => this.callbacks.onToggleContext(v));

    const resultsBtn = { 'Show Results Panel': () => this.callbacks.onShowResults() };
    folder.add(resultsBtn, 'Show Results Panel');

    // Rim Plane toggle: always visible so the rim preview can be toggled
    // before analysis runs. Hidden post-analysis for pure-geodesic mode.
    this.visRimPlaneCtrl = folder.add(this.params, 'showRimPlane')
      .name('Rim Plane')
      .onChange((v: boolean) => this.callbacks.onToggleRimPlane(v));

    // --- Rendering sub-folder ---
    const renderFolder = folder.addFolder('Rendering');
    this.visRenderFolder = renderFolder;
    renderFolder.add(this.params, 'showWireframe')
      .name('Wireframe')
      .onChange((v: boolean) => this.callbacks.onToggleWireframe(v));

    // Geodesics: hidden for double-sphere (no geodesics computed)
    const geodesicCtrl = renderFolder.add(this.params, 'geodesicDisplayMode', ['all', 'regular', 'irregular', 'none'])
      .name('Geodesics')
      .onChange((v: string) => this.callbacks.onGeodesicDisplayMode(v));
    this.visGeodesicsControllers.push(geodesicCtrl);

    renderFolder.add(this.params, 'showHeatmap')
      .name('Heat Map')
      .onChange((v: boolean) => this.callbacks.onToggleHeatmap(v));

    // Annotations: only relevant for pure-geodesic (cluster-based)
    const annotationsCtrl = renderFolder.add(this.params, 'showAnnotations')
      .name('Annotations')
      .onChange((v: boolean) => this.callbacks.onToggleAnnotations(v));
    this.visAnnotationsControllers.push(annotationsCtrl);

    renderFolder.open();
    renderFolder.hide(); // hidden until analysis runs

    // --- Overlays sub-folder (spheres, planes, volumes) ---
    const overlayFolder = folder.addFolder('Overlays');
    this.visOverlayFolder = overlayFolder;
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

    // Rim Plane is at root level (see above) — not duplicated here

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

    // Full STL Sample: always visible regardless of mode
    overlayFolder.add(this.params, 'showOriginalMesh')
      .name('Full STL Sample')
      .onChange((v: boolean) => this.callbacks.onToggleOriginalMesh(v));

    overlayFolder.close();
    overlayFolder.hide(); // hidden until analysis runs

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

  private buildRimPlaneSection(): void {
    const folder = this.gui.addFolder('📐 Rim Plane');
    folder.domElement.classList.add('section-rimplane');

    // Status line shows how many points are picked
    const statusProxy = { info: 'Inactive — use toolbar button to start' };
    this.rimPickStatusController = folder.add(statusProxy, 'info')
      .name('Status')
      .disable();

    const actions = {
      'Undo Last Point': () => this.callbacks.onRimPickUndo(),
      'Flip Normal ↕': () => this.callbacks.onRimPickFlipNormal(),
      'Define Pole 📍': () => this.callbacks.onRimPickDefinePole(),
      'Clear All Points': () => this.callbacks.onRimPickClearPoints(),
      'Confirm Plane ✓': () => this.callbacks.onRimPickConfirm(),
      'Revert to Auto ↺': () => this.callbacks.onRimPickRevertAuto(),
    };
    this.rimPickUndoController    = folder.add(actions, 'Undo Last Point').disable();
    this.rimPickFlipController    = folder.add(actions, 'Flip Normal ↕').disable();
    this.rimPickPoleController    = folder.add(actions, 'Define Pole 📍').disable();
    this.rimPickClearController   = folder.add(actions, 'Clear All Points').disable();
    this.rimPickConfirmController = folder.add(actions, 'Confirm Plane ✓').disable();
    // Revert to Auto is always available (once mesh is loaded)
    folder.add(actions, 'Revert to Auto ↺');

    folder.close();
  }

  /**
   * Update the Rim Plane panel to reflect the current pick mode state.
   * @param inPickMode  Whether pick mode is currently active.
   * @param pointCount  Number of points currently accumulated.
   */
  /**
   * Update the Rim Plane panel to reflect the current pick mode state.
   * @param inPickMode     Whether pick mode is currently active.
   * @param pointCount     Number of points currently accumulated.
   * @param hasManualPlane True after a rim plane has been confirmed (normal exists).
   */
  public updateRimPickUI(inPickMode: boolean, pointCount: number, hasManualPlane = false): void {
    // Update status text
    let statusText: string;
    if (!inPickMode) {
      statusText = hasManualPlane
        ? `Manual plane confirmed — sliders fine-tune`
        : 'Inactive — use toolbar button to start';
    } else {
      statusText = pointCount < 3
        ? `Picking… ${pointCount}/3 pts (need ≥3)`
        : `${pointCount} pts — plane live-updated`;
    }
    if (this.rimPickStatusController) {
      this.rimPickStatusController.object.info = statusText;
      this.rimPickStatusController.updateDisplay();
    }

    // Enable/disable buttons
    const enable = (ctrl: any, on: boolean) => {
      if (!ctrl) return;
      if (on) ctrl.enable(); else ctrl.disable();
    };
    enable(this.rimPickUndoController,    inPickMode && pointCount > 0);
    enable(this.rimPickFlipController,    inPickMode && pointCount >= 3);
    enable(this.rimPickPoleController,   (inPickMode && pointCount >= 3) || (!inPickMode && hasManualPlane));
    enable(this.rimPickClearController,   inPickMode && pointCount > 0);
    enable(this.rimPickConfirmController, inPickMode && pointCount >= 3);
  }

  /** Enable or disable the Define Pole button independently (e.g. after confirmation). */
  public setPoleButtonEnabled(enabled: boolean): void {
    if (!this.rimPickPoleController) return;
    if (enabled) this.rimPickPoleController.enable();
    else this.rimPickPoleController.disable();
  }

  /**
   * Update the hole seed UI to reflect the current seed count and pick-mode state.
   * @param inSeedMode  Whether seed pick mode is currently active.
   * @param seedCount   Number of seeds currently placed.
   */
  public updateHoleSeedUI(inSeedMode: boolean, seedCount: number): void {
    let text: string;
    if (inSeedMode) {
      text = seedCount === 0
        ? 'Click inside a hole to seed it'
        : `${seedCount} seed(s) — right-click to undo`;
    } else {
      text = seedCount === 0 ? 'No seeds placed' : `${seedCount} seed(s) set`;
    }
    this.holeSeedStatusProxy.info = text;
    this.holeSeedStatusController?.updateDisplay();
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
   * Update overlay/rendering visibility controls to match the given rendered mode.
   * Called when analysis mode changes or when the compare sub-mode selector changes.
   */
  private updateVisControlsForMode(mode: 'pure-geodesic' | 'sphere-bestfit' | 'double-sphere-metrics'): void {
    const isPure = mode === 'pure-geodesic';
    const isBestFit = mode === 'sphere-bestfit';
    const isSphere = isBestFit || mode === 'double-sphere-metrics';

    // Rim Plane toggle (root-level, always visible) — hide only for pure-geodesic
    if (this.visRimPlaneCtrl) {
      isSphere ? this.visRimPlaneCtrl.show() : this.visRimPlaneCtrl.hide();
    }

    // Geodesics: pure-geodesic and sphere-bestfit compute geodesics; double-sphere does not
    for (const ctrl of this.visGeodesicsControllers) {
      (isPure || isBestFit) ? ctrl.show() : ctrl.hide();
    }
    // Annotations: only pure-geodesic produces anomaly clusters
    for (const ctrl of this.visAnnotationsControllers) {
      isPure ? ctrl.show() : ctrl.hide();
    }
    // bestfitVisControllers: commercial sphere, wear plane (+ filter/coverage params)
    for (const ctrl of this.bestfitVisControllers) {
      isBestFit ? ctrl.show() : ctrl.hide();
    }
    // dualModeVisControllers: worn/unworn spheres, volume overlays
    for (const ctrl of this.dualModeVisControllers) {
      isSphere ? ctrl.show() : ctrl.hide();
    }
  }

  /**
   * Show/hide step buttons and initialize visualization controls
   * based on the currently selected analysis mode.
   */
  private updateStepVisibility(): void {
    const isBestFit = this.params.analysisMode === 'sphere-bestfit';
    const isDoubleSphere = this.params.analysisMode === 'double-sphere-metrics';
    const isCompareMode = this.params.analysisMode === 'compare-all-modes';
    const isPureOnly = this.params.analysisMode === 'pure-geodesic';

    // Step buttons
    for (const ctrl of this.bestfitStepControllers) {
      isBestFit ? ctrl.show() : ctrl.hide();
    }
    for (const ctrl of this.pureGeodesicStepControllers) {
      isPureOnly ? ctrl.show() : ctrl.hide();
    }
    for (const ctrl of this.doubleSphereControllers) {
      (isDoubleSphere || isCompareMode) ? ctrl.show() : ctrl.hide();
    }

    // Compare sub-mode selector: only shown after analysis via showCompareSelector()
    if (this.visCompareSelectorCtrl) this.visCompareSelectorCtrl.hide();

    // Visualization overlays: preview controls for the expected rendered mode
    const renderedMode: 'pure-geodesic' | 'sphere-bestfit' | 'double-sphere-metrics' =
      isCompareMode ? 'sphere-bestfit'
      : isBestFit   ? 'sphere-bestfit'
      : isDoubleSphere ? 'double-sphere-metrics'
      : 'pure-geodesic';
    this.updateVisControlsForMode(renderedMode);
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

  /**
   * Show visualization controls appropriate for the given analysis mode.
   * Called by app.ts after analysis completes.
   */
  public showVisualizationControls(
    mode: 'pure-geodesic' | 'sphere-bestfit' | 'double-sphere-metrics',
  ): void {
    this.visRenderFolder?.show();
    this.visOverlayFolder?.show();
    this.updateVisControlsForMode(mode);
  }

  /**
   * Hide all analysis-result visualization controls.
   * Called when a new STL is loaded (before analysis runs).
   */
  public hideVisualizationControls(): void {
    this.visRenderFolder?.hide();
    this.visOverlayFolder?.hide();
    if (this.visCompareSelectorCtrl) this.visCompareSelectorCtrl.hide();
  }

  /**
   * Show the compare sub-mode selector inside the Visualization folder and
   * register the callback invoked when the user picks a mode to display.
   * Also updates the visualization controls to match the initial sphere-bestfit view.
   */
  public showCompareSelector(
    onChange: (mode: 'pure-geodesic' | 'sphere-bestfit' | 'double-sphere-metrics') => void,
  ): void {
    this.compareVisModeCallback = onChange;
    this.compareVisModeProxy.mode = 'Sphere BestFit';
    if (this.visCompareSelectorCtrl) {
      this.visCompareSelectorCtrl.updateDisplay();
      this.visCompareSelectorCtrl.show();
    }
    this.updateVisControlsForMode('sphere-bestfit');
  }

  /** Hide the compare sub-mode selector. */
  public hideCompareSelector(): void {
    if (this.visCompareSelectorCtrl) this.visCompareSelectorCtrl.hide();
  }

  dispose(): void {
    this.gui.destroy();
  }
}
