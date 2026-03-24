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
  onToggleOriginalMesh: (v: boolean) => void;
  // Export
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
  private buttonControllers: Record<string, any> = {};
  private completedSteps = new Set<string>();
  // BestFit mode UI state
  private bestfitStepControllers: any[] = [];
  private pureGeodesicStepControllers: any[] = [];
  private bestfitVisControllers: any[] = [];
  // Commercial radius proxy for dropdown
  private commercialRadiusProxy = { value: 'Auto' };
  private colorRangeMaxController: any = null;
  // Analysis mode display name mapping
  private readonly modeLabelMap: Record<string, string> = {
    'Pure Geodesic': 'pure-geodesic',
    'Sphere BestFit': 'sphere-bestfit',
  };
  private readonly modeReverseMap: Record<string, string> = {
    'pure-geodesic': 'Pure Geodesic',
    'sphere-bestfit': 'Sphere BestFit',
  };
  private analysisModelProxy = { mode: 'Sphere BestFit' };

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

    // --- Wear Model sub-section ---
    const wearModel = folder.addFolder('Wear Model');
    wearModel.add(this.analysisModelProxy, 'mode', ['Pure Geodesic', 'Sphere BestFit'])
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
    wearModel.open();

    folder.add(this.params, 'geodesicCount', 36, 720, 1)
      .name('Geodesics')
      .onChange(() => this.callbacks.onParamsChange(this.params));

    folder.add(this.params, 'rimTrimPercent', 0, 50, 0.5)
      .name('Rim Trim %')
      .onChange(() => this.callbacks.onParamsChange(this.params));

    folder.add(this.params, 'smoothingIterations', 0, 10, 1)
      .name('Smoothing Iter.')
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

    this.colorRangeMaxController = folder.add(this.params, 'colorRangeMax', 0, 200, 1)
      .name('Color Max (μm)')
      .onChange(() => this.callbacks.onParamsChange(this.params));

    folder.close();
  }

  private buildVisualizationSection(): void {
    const folder = this.gui.addFolder('👁 Visualization');

    folder.add(this.params, 'showWireframe')
      .name('Wireframe')
      .onChange((v: boolean) => this.callbacks.onToggleWireframe(v));

    folder.add(this.params, 'geodesicDisplayMode', ['all', 'regular', 'irregular', 'none'])
      .name('Geodesics')
      .onChange((v: string) => this.callbacks.onGeodesicDisplayMode(v));

    folder.add(this.params, 'showHeatmap')
      .name('Heat Map')
      .onChange((v: boolean) => this.callbacks.onToggleHeatmap(v));

    folder.add(this.params, 'showAnnotations')
      .name('Annotations')
      .onChange((v: boolean) => this.callbacks.onToggleAnnotations(v));

    folder.add(this.params, 'showReferenceShape')
      .name('Reference Sphere')
      .onChange((v: boolean) => this.callbacks.onToggleRefSphere(v));

    folder.add(this.params, 'contextOpaque')
      .name('Opaque Context')
      .onChange((v: boolean) => this.callbacks.onToggleContext(v));

    // BestFit-specific toggles (bound directly to global params)
    const csc = folder.add(this.params, 'showCommercialSphere')
      .name('Commercial Sphere')
      .onChange((v: boolean) => this.callbacks.onToggleCommercialSphere(v));
    this.bestfitVisControllers.push(csc);

    const wsc = folder.add(this.params, 'showWornSphere')
      .name('Worn Sphere (Red)')
      .onChange((v: boolean) => this.callbacks.onToggleWornSphere(v));
    this.bestfitVisControllers.push(wsc);

    const usc = folder.add(this.params, 'showUnwornSphere')
      .name('Unworn Sphere (Green)')
      .onChange((v: boolean) => this.callbacks.onToggleUnwornSphere(v));
    this.bestfitVisControllers.push(usc);

    const rpc = folder.add(this.params, 'showRimPlane')
      .name('Rim Plane')
      .onChange((v: boolean) => this.callbacks.onToggleRimPlane(v));
    this.bestfitVisControllers.push(rpc);

    const wpc = folder.add(this.params, 'showWearPlane')
      .name('Wear Section Plane')
      .onChange((v: boolean) => this.callbacks.onToggleWearPlane(v));
    this.bestfitVisControllers.push(wpc);

    const mvc = folder.add(this.params, 'showMeshVolume')
      .name('Mesh Volume (Blue)')
      .onChange((v: boolean) => this.callbacks.onToggleMeshVolume(v));
    this.bestfitVisControllers.push(mvc);

    const scc = folder.add(this.params, 'showSphereCapVolume')
      .name('Sphere Cap (Green)')
      .onChange((v: boolean) => this.callbacks.onToggleSphereCapVolume(v));
    this.bestfitVisControllers.push(scc);

    const omc = folder.add(this.params, 'showOriginalMesh')
      .name('Full STL Sample')
      .onChange((v: boolean) => this.callbacks.onToggleOriginalMesh(v));
    this.bestfitVisControllers.push(omc);

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

    for (const ctrl of this.bestfitStepControllers) {
      isBestFit ? ctrl.show() : ctrl.hide();
    }
    for (const ctrl of this.pureGeodesicStepControllers) {
      isBestFit ? ctrl.hide() : ctrl.show();
    }
    for (const ctrl of this.bestfitVisControllers) {
      isBestFit ? ctrl.show() : ctrl.hide();
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
