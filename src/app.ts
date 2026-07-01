// ============================================================
// GeoWear — App Orchestrator
// Wires together all modules: viewer, analysis, UI
// ============================================================

import * as THREE from 'three';
import type { MeshData, AnalysisParams, AnalysisResults, AnalysisRunResult, DoubleGeodesic } from './types';
import { DEFAULT_PARAMS } from './types';
import { SceneManager } from './viewer/SceneManager';
import { MeshViewer } from './viewer/MeshViewer';
import { HeatMapRenderer } from './viewer/HeatMapRenderer';
import { GeodesicRenderer } from './viewer/GeodesicRenderer';
import { GeodesicInteractionManager } from './viewer/GeodesicInteractionManager';
import { AnnotationManager } from './viewer/Annotations';
import { ControlPanel, type ControlCallbacks } from './ui/ControlPanel';
import { ResultsPanel } from './ui/ResultsPanel';
import { ExportManager } from './ui/ExportManager';
import { StatusBar } from './ui/StatusBar';
import { ProfileWindowManager } from './ui/ProfileWindowManager';
import { WearAnalysisPipeline } from './analysis/WearAnalysis';
import { LassoSelectionManager } from './viewer/LassoSelectionManager';
import { RimPlanePickManager } from './viewer/RimPlanePickManager';
import { HoleSeedPickManager } from './viewer/HoleSeedPickManager';
import { trimRim, computeRimAnchor, rimAnchorToPlanePoint, type RimAnchor } from './analysis/MeshProcessor';
import { computeTiltedRimNormal, fitPlaneFromPoints, decomposeNormalToInclination } from './utils/geometry';

export class App {
  // Core viewer
  private scene!: SceneManager;
  private meshViewer!: MeshViewer;
  private heatMap!: HeatMapRenderer;
  private geodesicRenderer!: GeodesicRenderer;
  private geodesicInteraction!: GeodesicInteractionManager;
  private annotations!: AnnotationManager;

  // UI
  private controls!: ControlPanel;
  private resultsPanel!: ResultsPanel;
  private exporter!: ExportManager;
  private status!: StatusBar;
  private profileWindows!: ProfileWindowManager;

  // Section mode UI
  private sectionModeBtn!: HTMLButtonElement;
  private sectionModeActive: boolean = false;

  // Manual rim plane pick mode
  private rimPickBtn!: HTMLButtonElement;
  private rimPickManager: RimPlanePickManager | null = null;
  private rimPickActive = false;

  // Manual hole seed pick mode
  private holeSeedManager: HoleSeedPickManager | null = null;
  private holeSeedActive = false;
  private manualHoleSeeds: THREE.Vector3[] = [];

  // State
  private pipeline: WearAnalysisPipeline | null = null;
  private currentMeshData: MeshData | null = null;
  private currentResults: AnalysisRunResult | null = null;
  /** Which sub-mode is currently rendered when analysisMode === 'compare-all-modes'. */
  private compareVisualizationMode: 'sphere-bestfit' | 'double-sphere-metrics' = 'sphere-bestfit';
  private fileName: string = '';
  private isRunning = false;
  private stlWorker: Worker | null = null;

  // Parameters (copy from defaults)
  private params: AnalysisParams = { ...DEFAULT_PARAMS };

  // Exclusion zone
  private excludedInnerMeshVertices: Set<number> = new Set();
  private lassoManager: LassoSelectionManager | null = null;

  // Manual non-worn zone (Manual Geodesic mode)
  // Positions are pre-extracted from the trimmed working mesh, stored as flat xyz Float32Array.
  private manualNonWornPositions: Float32Array | null = null;
  private manualNonWornCount: number = 0;
  private manualLassoManager: LassoSelectionManager | null = null;

  // Rim-plane preview performance: cache mesh geometry stats so the disc
  // can be updated instantly (O(1)) without re-running the O(F) edge map.
  private _rimAnchorCache: RimAnchor | null = null;
  private _rimMeshDebounce: ReturnType<typeof setTimeout> | null = null;

  init(): void {
    // SceneManager finds DOM elements by ID internally
    this.scene = new SceneManager();
    this.meshViewer = new MeshViewer(this.scene);
    this.heatMap = new HeatMapRenderer();
    this.geodesicRenderer = new GeodesicRenderer(this.scene);
    this.geodesicInteraction = new GeodesicInteractionManager(this.scene);
    this.annotations = new AnnotationManager(this.scene);

    // UI modules
    this.status = new StatusBar();
    this.resultsPanel = new ResultsPanel();
    this.profileWindows = new ProfileWindowManager();
    
    this.resultsPanel.setGeodesicSelectHandler((angle: number) => {
      this.geodesicRenderer.highlightGeodesic(angle);
    });

    // Setup geodesic interaction callbacks
    this.geodesicInteraction.setCallbacks({
      onHover: (dg: DoubleGeodesic | null) => {
        if (dg) {
          this.geodesicRenderer.highlightDoubleGeodesic(dg.angleA, dg.angleB);
        } else {
          this.geodesicRenderer.resetHighlight();
        }
      },
      onSelect: (dg: DoubleGeodesic) => {
        this.openGeodesicProfile(dg);
      },
    });

    // Setup section mode button
    this.sectionModeBtn = document.getElementById('btn-section-mode') as HTMLButtonElement;
    this.setupSectionModeButton();

    // Setup manual rim plane pick button
    this.rimPickBtn = document.getElementById('btn-rim-plane-pick') as HTMLButtonElement;
    this.setupRimPlanePickButton();

    // Setup recenter button
    const recenterBtn = document.getElementById('btn-recenter');
    if (recenterBtn) {
      recenterBtn.addEventListener('click', () => this.scene.resetView());
    }

    // Setup resizable right sidebar
    this.setupSidebarResize();

    const callbacks: ControlCallbacks = {
      onLoadSTL: () => this.openFileDialog(),
      onRunAnalysis: () => this.runAnalysis(),
      onStepSeparate: () => this.stepSeparate(),
      onStepTrim: () => this.stepTrim(),
      onStepFitSphere: () => this.stepFitSphere(),
      onStepGeodesics: () => this.stepGeodesics(),
      onStepAnalyze: () => this.stepAnalyze(),
      // --- Sphere BestFit mode steps ---
      onStepCommercialRadius: () => this.stepCommercialRadius(),
      onStepClassifyWear: () => this.stepClassifyWear(),
      onStepWearVolume: () => this.stepWearVolume(),
      // --- Visualization toggles ---
      onToggleWireframe: (v: boolean) => { this.meshViewer.setWireframe(v); this.scene.requestRender(); },
      onGeodesicDisplayMode: (mode: string) => { this.geodesicRenderer.setDisplayMode(mode); this.scene.requestRender(); },
      onToggleHeatmap: (v: boolean) => this.toggleHeatMap(v),
      onToggleAnnotations: (v: boolean) => { this.annotations.setVisible(v); this.scene.requestRender(); },
      onToggleRefSphere: (v: boolean) => this.toggleRefSphere(v),
      onToggleContext: (opaque: boolean) => { this.meshViewer.setContextOpaque(opaque); this.scene.requestRender(); },
      onToggleCommercialSphere: (v: boolean) => { this.meshViewer.setCommercialSphereVisible(v); this.scene.requestRender(); },
      onToggleWornSphere: (v: boolean) => { this.meshViewer.setWornSphereVisible(v); this.scene.requestRender(); },
      onToggleUnwornSphere: (v: boolean) => { this.meshViewer.setUnwornSphereVisible(v); this.scene.requestRender(); },
      onToggleRimPlane: (v: boolean) => { this.meshViewer.setRimPlaneVisible(v); this.scene.requestRender(); },
      onToggleWearPlane: (v: boolean) => { this.meshViewer.setWearPlaneVisible(v); this.scene.requestRender(); },
      onToggleLinearWearVector: (v: boolean) => {
        this.meshViewer.setLinearWearVectorVisible(v);
        this.annotations.setWearVectorVisible(v);
        this.scene.requestRender();
      },
      onFocusLinearWearVector: () => this.focusLinearWearVector(),
      onToggleMeshVolume: (v: boolean) => { this.meshViewer.setMeshVolumeVisible(v); this.scene.requestRender(); },
      onToggleSphereCapVolume: (v: boolean) => { this.meshViewer.setSphereCapVisible(v); this.scene.requestRender(); },
      onToggleWearVolume: (v: boolean) => { this.meshViewer.setWearVolumeVisible(v); this.scene.requestRender(); },
      onToggleOriginalMesh: (v: boolean) => { this.meshViewer.setOriginalVisible(v); this.scene.requestRender(); },
      // --- Export ---
      onExportPNG: () => this.exportPNG(),
      onExportCSV: () => this.exportCSV(),
      onExportSTL: () => this.exportSTL(),
      onExportPDF: () => this.exportPDF(),
      onShowResults: () => {
        if (this.currentResults) {
          this.resultsPanel.setYearsInVivo(this.params.yearsInVivo);
          this.resultsPanel.show(this.currentResults);
        }
      },
      onParamsChange: (p: AnalysisParams) => {
        const yearsChanged = p.yearsInVivo !== this.params.yearsInVivo;
        this.resultsPanel.setYearsInVivo(p.yearsInVivo);
        this.onParamsChange(p);
        // Refresh results panel when yearsInVivo changes (no re-analysis needed)
        if (yearsChanged && this.currentResults) {
          this.resultsPanel.show(this.currentResults);
        }
      },
      // --- Exclusion zone ---
      onEnableLassoMode: () => this.enableLassoMode(),
      onClearExclusions: () => this.clearExclusions(),
      onToggleExcludedHighlight: (v: boolean) => this.toggleExcludedHighlight(v),
      // --- Manual non-worn zone (Manual Geodesic mode) ---
      onEnableManualNonWornLassoMode: () => this.enableManualNonWornLassoMode(),
      onClearManualNonWornSelection: () => this.clearManualNonWornSelection(),
      // --- Manual rim plane ---
      onRimPickUndo: () => this.undoLastRimPoint(),
      onRimPickFlipNormal: () => this.flipRimNormal(),
      onRimPickClearPoints: () => this.clearRimPoints(),
      onRimPickConfirm: () => this.confirmRimPlane(),
      onRimPickRevertAuto: () => this.revertRimToAuto(),
      onRimPickDefinePole: () => this.definePole(),
      // --- Hole seed pick ---
      onEnableHoleSeedMode: () => this.enableHoleSeedMode(),
      onClearHoleSeeds: () => this.clearHoleSeeds(),
      onViewerControlsChange: (mode: 'basic' | 'alternative') => this.scene.setControlMode(mode),
    };
    this.controls = new ControlPanel(callbacks);

    this.exporter = new ExportManager(this.scene);

    // Drag & drop on viewport
    const viewport = document.getElementById('viewport');
    if (viewport) this.setupDragDrop(viewport);

    // Hide loading overlay
    this.hideLoading();

    this.status.setStatus('Ready. Load an STL file to begin.');
    console.log('GeoWear initialized');
  }

  // ---- File Loading ----

  private openFileDialog(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.stl';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.loadFile(file);
    };
    input.click();
  }

  private setupDragDrop(element: HTMLElement): void {
    element.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.add('drag-over');
    });
    element.addEventListener('dragleave', () => {
      element.classList.remove('drag-over');
    });
    element.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.remove('drag-over');
      const file = e.dataTransfer?.files[0];
      if (file && file.name.toLowerCase().endsWith('.stl')) {
        this.loadFile(file);
      } else {
        this.status.setStatus('Please drop an STL file.');
      }
    });
  }

  private async loadFile(file: File): Promise<void> {
    this.showLoading('Loading STL...');
    this.status.setStatus(`Loading ${file.name}...`);
    this.fileName = file.name.replace(/\.stl$/i, '');

    try {
      const buffer = await file.arrayBuffer();

      // Yield to allow the UI to update
      await new Promise(resolve => setTimeout(resolve, 0));

      // Parse and weld in a Web Worker to keep the UI responsive
      this.status.setStatus('Parsing STL geometry...');
      const workerResult = await this.parseSTLInWorker(buffer);

      const meshData: MeshData = {
        positions: workerResult.positions,
        normals: workerResult.normals,
        indices: workerResult.indices,
        vertexCount: workerResult.vertexCount,
        faceCount: workerResult.faceCount,
      };

      if (meshData.vertexCount === 0) {
        throw new Error('STL file contains no vertices after welding');
      }

      console.log(`Welded: ${workerResult.displayPositions.length / 3} → ${meshData.vertexCount} vertices, ${meshData.faceCount} faces`);

      if (workerResult.scaleFactor !== 1) {
        this.status.setStatus(`Auto-scaled from ${workerResult.scaleFactor === 0.001 ? 'μm' : 'm'} to mm`);
      }

      // Clear all per-sample state before loading the new mesh
      this.clearSampleState();
      this.currentMeshData = meshData;

      // Clear previous visualization
      this.clearVisualization();

      // Yield before display
      await new Promise(resolve => setTimeout(resolve, 0));

      // Create display geometry from raw (non-welded) data
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(workerResult.displayPositions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(workerResult.displayNormals, 3));
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();

      // Display original mesh
      this.meshViewer.displayOriginalMesh(geometry);

      // Mark scene as large for adaptive quality
      this.scene.setLargeScene(meshData.faceCount > 500_000);

      // Auto-separate to enable rim-plane live preview immediately
      try {
        const p = this.ensurePipeline();
        p.stepSeparateFaces(meshData);
        const sep = p.state.separation!;
        this.meshViewer.displayInnerMesh(sep.inner);
        this.meshViewer.displayOuterMesh(sep.outer);
        this.meshViewer.hideOriginal();
        this._rimAnchorCache = null; // new mesh — invalidate cache
        this.updateRimPreview();
      } catch (e) {
        console.warn('[auto-separate] failed:', (e as Error).message);
      }

      // Update status
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
      this.status.setFileInfo(`${file.name} (${sizeMB} MB)`);
      this.status.setMeshInfo(`${meshData.vertexCount.toLocaleString()} verts, ${meshData.faceCount.toLocaleString()} faces`);
      this.status.setStatus(`Loaded ${file.name} — ${meshData.vertexCount.toLocaleString()} vertices, ${meshData.faceCount.toLocaleString()} faces`);

      this.hideLoading();
    } catch (err) {
      console.error('Error loading STL:', err);
      this.status.setStatus(`Error loading file: ${(err as Error).message}`);
      this.hideLoading();
    }
  }

  /**
   * Parse an STL ArrayBuffer in a Web Worker.
   * Returns welded mesh data + raw display geometry arrays.
   */
  private parseSTLInWorker(buffer: ArrayBuffer): Promise<{
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    vertexCount: number;
    faceCount: number;
    scaleFactor: number;
    displayPositions: Float32Array;
    displayNormals: Float32Array;
  }> {
    return new Promise((resolve, reject) => {
      // Terminate previous worker if any
      if (this.stlWorker) {
        this.stlWorker.terminate();
      }

      const worker = new Worker(
        new URL('./workers/stl.worker.ts', import.meta.url),
        { type: 'module' }
      );
      this.stlWorker = worker;

      worker.onmessage = (e: MessageEvent) => {
        const { type } = e.data;
        if (type === 'progress') {
          this.status.setStatus(e.data.message);
        } else if (type === 'result') {
          const r = e.data.result;
          worker.terminate();
          this.stlWorker = null;
          resolve(r);
        } else if (type === 'error') {
          worker.terminate();
          this.stlWorker = null;
          reject(new Error(e.data.error));
        }
      };

      worker.onerror = (err) => {
        worker.terminate();
        this.stlWorker = null;
        reject(new Error(err.message || 'Worker error'));
      };

      // Transfer the buffer to the worker (zero-copy)
      worker.postMessage({ type: 'parse', buffer }, [buffer]);
    });
  }

  // ---- Full Analysis ----

  private async runAnalysis(): Promise<void> {
    if (this.isRunning) return;
    if (!this.currentMeshData) {
      this.status.setStatus('No mesh loaded. Please load an STL file first.');
      return;
    }

    // Always sync params from the GUI panel so nothing is stale (e.g. mode dropdown)
    this.params = { ...this.controls.params };

    this.isRunning = true;
    this.showLoading('Running analysis...');
    // Cancel any pending preview debounce — the analysis will provide the authoritative mesh.
    if (this._rimMeshDebounce !== null) {
      clearTimeout(this._rimMeshDebounce);
      this._rimMeshDebounce = null;
    }
    this.clearVisualization();

    // Capture separation from previous pipeline so the new one uses the same cupAxis.
    // This guarantees the trim plane is identical to what the preview showed.
    const existingSeparation = this.pipeline?.state.separation ?? null;

    this.pipeline = new WearAnalysisPipeline((stage, progress, message) => {
      this.status.setProgress(progress);
      this.status.setStatus(message);
    });

    try {
      this.pipeline.setExclusionMask(this.excludedInnerMeshVertices);
      this.pipeline.setRimInclination(this.params.rimInclinationAngle, this.params.rimInclinationAzimuth);
      // Manual Geodesic mode: require a manual non-worn selection before running
      if (this.params.analysisMode === 'manual-geodesic') {
        if (!this.manualNonWornPositions || this.manualNonWornCount < 100) {
          throw new Error(
            'Manual Geodesic mode requires a non-worn zone selection. ' +
            'Use "\u270e Non-Worn Zone \u2192 Select Zone (Lasso)" to draw the non-worn area first.'
          );
        }
        this.pipeline.setManualUnwornPositions(this.manualNonWornPositions, this.manualNonWornCount);
      }
      // Inject the pre-computed separation BEFORE setRimPlaneNormal so that
      // computeCurrentRimNormal() can access sep.cupAxis in auto mode.
      if (existingSeparation) this.pipeline.setSeparation(existingSeparation);
      // Always set the fully-resolved plane normal so WearAnalysis uses it directly
      // regardless of inclination angle values (critical when confirmed normal is active).
      this.pipeline.setRimPlaneNormal(this.computeCurrentRimNormal());
      // Propagate manual rim base point so the cut plane matches the live preview
      if (this._manualRimCenter) {
        this.pipeline.setManualRimBasePoint([this._manualRimCenter.x, this._manualRimCenter.y, this._manualRimCenter.z]);
      } else {
        this.pipeline.setManualRimBasePoint(null);
      }
      const results = await this.pipeline.runFullAnalysis(this.currentMeshData, this.params);
      // Init lasso manager so the user can draw exclusions after full analysis too
      this.ensureLassoManager();
      // Enable rim pick mode after analysis (inner mesh is available)
      this.rimPickBtn.disabled = false;
      this.currentResults = results;
      // Show/hide the compare-mode visualisation selector depending on the mode.
      if (results.analysisMode === 'compare-all-modes') {
        this.compareVisualizationMode = 'sphere-bestfit';
        this.controls.showVisualizationControls('sphere-bestfit');
        this.controls.showCompareSelector((mode) => this.setCompareVisualizationMode(mode));
      } else if (results.analysisMode === 'manual-geodesic') {
        this.controls.showVisualizationControls('manual-geodesic');
        this.controls.hideCompareSelector();
      } else {
        this.controls.showVisualizationControls(results.analysisMode);
        this.controls.hideCompareSelector();
      }
      this.applyVisualization();
      this.applyVisibilityFromParams();
      // Cancel any pending preview debounce so it doesn't overwrite the analysis result.
      // Then update ONLY the disc position — do NOT rebuild the trimmed mesh, because the
      // analysis result (with exclusion mask applied + heatmap) is already displayed.
      if (this._rimMeshDebounce !== null) {
        clearTimeout(this._rimMeshDebounce);
        this._rimMeshDebounce = null;
      }
      this._rimAnchorCache = null; // separation may have changed — invalidate cache
      this.updateRimDiscOnly();
      this.resultsPanel.setYearsInVivo(this.params.yearsInVivo);
      this.resultsPanel.show(results);
      this.status.setStatus(`Analysis complete in ${(results.processingTimeMs / 1000).toFixed(1)}s`);
    } catch (err) {
      console.error('Analysis error:', err);
      this.status.setStatus(`Analysis error: ${(err as Error).message}`);
    } finally {
      this.isRunning = false;
      this.hideLoading();
    }
  }

  // ---- Step-by-step execution ----

  private ensurePipeline(): WearAnalysisPipeline {
    if (!this.pipeline) {
      this.pipeline = new WearAnalysisPipeline((stage, progress, message) => {
        this.status.setProgress(progress);
        this.status.setStatus(message);
      });
    }
    return this.pipeline;
  }

  private async stepSeparate(): Promise<void> {
    if (!this.currentMeshData) { this.status.setStatus('Load a mesh first'); return; }
    const p = this.ensurePipeline();
    try {
      this.status.setStatus('Separating inner/outer faces...');
      p.stepSeparateFaces(this.currentMeshData);
      // Clear any overlay from a previous repair before displaying the new mesh
      this.meshViewer.removeRepairedHolesOverlay();
      if (this.params.repairInnerFace) {
        p.stepRepairInnerFace(2, this.params.holeRepairMaxLoopSize);
      }
      const sep = p.state.separation!;
      this.meshViewer.displayInnerMesh(sep.inner);
      this.meshViewer.displayOuterMesh(sep.outer);
      this.meshViewer.hideOriginal();
      this._rimAnchorCache = null; // new separation — invalidate cache
      // Show amber overlay for filled holes (if any)
      if (this.params.repairInnerFace && p.state.filledHolesFaceStart !== null) {
        this.meshViewer.displayRepairedHolesOverlay(sep.inner, p.state.filledHolesFaceStart);
        this.status.setStatus(
          `Separated: ${sep.inner.faceCount} inner / ${sep.outer.faceCount} outer faces` +
          ` (${p.state.filledHolesCount} hole(s) repaired — highlighted in orange)`
        );
      } else {
        this.status.setStatus(`Separated: ${sep.inner.faceCount} inner / ${sep.outer.faceCount} outer faces${this.params.repairInnerFace ? ' (no holes found)' : ''}`);
      }
      this.controls.markStepCompleted('separate');
      this.applyVisibilityFromParams();
      this.scene.requestRender();
      // Init lasso manager after we have a separation
      this.ensureLassoManager();
      // Enable rim pick mode now that inner mesh exists
      this.rimPickBtn.disabled = false;
    } catch (e) {
      this.status.setStatus(`Error: ${(e as Error).message}`);
    }
  }

  private async stepTrim(): Promise<void> {
    const p = this.ensurePipeline();
    try {
      this.status.setStatus('Trimming rim...');
      p.setExclusionMask(this.excludedInnerMeshVertices);
      p.setRimPlaneNormal(this.computeCurrentRimNormal());
      p.setRimInclination(this.params.rimInclinationAngle, this.params.rimInclinationAzimuth);
      if (this._manualRimCenter) {
        p.setManualRimBasePoint([this._manualRimCenter.x, this._manualRimCenter.y, this._manualRimCenter.z]);
      } else {
        p.setManualRimBasePoint(null);
      }
      const trim = p.stepTrimRim(this.params.rimTrimPercent);
      // Repair holes in the trimmed working mesh (post-trim repair is more accurate:
      // largest boundary loop = artificial trim boundary, not the real rim)
      this.meshViewer.removeRepairedHolesOverlay();
      if (this.params.repairInnerFace) {
        p.stepRepairWorkingMesh(2, this.params.holeRepairMaxLoopSize);
      }
      const displayMesh = p.state.workingMesh ?? trim.mesh;
      this.meshViewer.displayInnerMesh(displayMesh);
      this.meshViewer.displayGhostMesh(trim.rimMesh);
      this.meshViewer.hideOriginal();
      if (this.params.repairInnerFace && p.state.workingMeshFilledHolesFaceStart !== null) {
        this.meshViewer.displayRepairedHolesOverlay(displayMesh, p.state.workingMeshFilledHolesFaceStart);
        this.status.setStatus(
          `Trimmed: ${trim.rimPercentRemoved.toFixed(1)}% rim removed` +
          ` · ${p.state.workingMeshFilledHolesCount} hole(s) repaired (orange)`
        );
      } else {
        this.status.setStatus(`Trimmed: ${(trim.rimPercentRemoved).toFixed(1)}% rim removed`);
      }
      this.controls.markStepCompleted('trim');
      this.applyVisibilityFromParams();
      this.scene.requestRender();
    } catch (e) {
      this.status.setStatus(`Error: ${(e as Error).message}`);
    }
  }

  private async stepFitSphere(): Promise<void> {
    const p = this.ensurePipeline();
    try {
      this.status.setStatus('Fitting reference sphere (regular geodesics)...');
      const fit = p.stepFitSphere();
      // Also compute ellipsoid while we are at it
      p.stepFitEllipsoid();
      this.meshViewer.displayReferenceSphere(fit.center, fit.radius);
      this.status.setStatus(
        `Sphere: R=${fit.radius.toFixed(4)}mm, RMS=${(fit.rmsError * 1000).toFixed(2)}μm | ` +
        `Ellipsoid: ${p.state.ellipsoidFit!.shapeClass}, sphericity=${p.state.ellipsoidFit!.sphericityPercent.toFixed(1)}%`
      );
      this.controls.markStepCompleted('fit');
      this.applyVisibilityFromParams();
      this.scene.requestRender();
    } catch (e) {
      this.status.setStatus(`Error: ${(e as Error).message}`);
    }
  }

  // ---- Rim plane live preview ----

  /**
   * Compute the current tilted rim-plane normal from the cup axis + inclination params.
   * Returns undefined when inclination = 0 (falls back to geodesic-based trim in analysis).
   */
  private computeCurrentRimNormal(): [number, number, number] | undefined {
    const { rimInclinationAngle, rimInclinationAzimuth } = this.params;

    if (this._confirmedManualNormal) {
      // Confirmed manual normal: sliders define tilt RELATIVE to this normal.
      // This path does NOT need sep — safe to call even before separation has run.
      if (Math.abs(rimInclinationAngle) < 1e-6 && Math.abs(rimInclinationAzimuth) < 1e-6) {
        const n = this._confirmedManualNormal;
        return [n.x, n.y, n.z];
      }
      const n = this._confirmedManualNormal;
      const v = computeTiltedRimNormal([n.x, n.y, n.z], rimInclinationAngle, rimInclinationAzimuth);
      return [v.x, v.y, v.z];
    }

    // Auto mode: tilt relative to cup axis — requires separation.
    const sep = this.pipeline?.state.separation;
    if (!sep) return undefined;
    const v = computeTiltedRimNormal(sep.cupAxis, rimInclinationAngle, rimInclinationAzimuth);
    return [v.x, v.y, v.z];
  }

  /**
   * Recompute the rim trim preview using the current plane parameters and display the
   * ghost (rim) mesh + plane disc in the viewer. Called live as sliders change.
   *
   * Two-phase strategy for heavy meshes:
   *   1. INSTANT  – update the rim plane disc using a cached RimAnchor (pure arithmetic).
   *   2. DEBOUNCED – rebuild the trimmed inner/ghost mesh geometry after 300 ms of inactivity.
   */
  private updateRimPreview(): void {
    // During pick mode, only update the disc geometry — no mesh rebuild.
    // The disc is driven by the live-fitted normal, not by params.
    if (this.rimPickActive) {
      this.updateRimDiscOnly();
      return;
    }

    const sep = this.pipeline?.state.separation;
    if (!sep) return;
    const planeNormal = this.computeCurrentRimNormal();
    if (!planeNormal) return;

    // --- Phase 1: instant disc update using cached geometry stats ---
    if (!this._rimAnchorCache) {
      this._rimAnchorCache = computeRimAnchor(sep.inner, sep.cupAxis);
    }
    const anchor = this._rimAnchorCache;
    const range = anchor.maxHA - anchor.minHA;

    // Disc center: if manual rim confirmed, shift along the effective plane normal (toward pole).
    // The plane normal always points toward the pole, so positive shift = toward pole.
    let planePt: THREE.Vector3;
    if (this._manualRimCenter) {
      const shift = (this.params.rimTrimPercent / 100) * range;
      planePt = this._manualRimCenter.clone()
        .addScaledVector(new THREE.Vector3(...planeNormal), shift);
    } else {
      const pc = rimAnchorToPlanePoint(anchor, sep.cupAxis, this.params.rimTrimPercent);
      planePt = new THREE.Vector3(pc[0], pc[1], pc[2]);
    }

    const [nx, ny, nz] = planeNormal;
    this.meshViewer.displayRimPlane(planePt, new THREE.Vector3(nx, ny, nz), anchor.radius, this.params.showRimPlane, new THREE.Vector3(...sep.cupAxis));
    this.scene.requestRender();

    // --- Phase 2: debounced mesh rebuild (300 ms after last slider change) ---
    if (this._rimMeshDebounce !== null) clearTimeout(this._rimMeshDebounce);
    this._rimMeshDebounce = setTimeout(() => {
      this._rimMeshDebounce = null;
      const sep2 = this.pipeline?.state.separation;
      if (!sep2) return;
      const pn = this.computeCurrentRimNormal();
      if (!pn) return;

      // Compute the exact plane anchor when a manual rim center is available.
      // Shift along the effective plane normal (toward pole), not along the cup axis.
      let planeAnchorOverride: [number, number, number] | undefined;
      const mc = this._manualRimCenter;
      if (mc) {
        if (!this._rimAnchorCache) {
          this._rimAnchorCache = computeRimAnchor(sep2.inner, sep2.cupAxis);
        }
        const r2 = this._rimAnchorCache!.maxHA - this._rimAnchorCache!.minHA;
        const shift = (this.params.rimTrimPercent / 100) * r2;
        const [pnx, pny, pnz] = pn;
        planeAnchorOverride = [mc.x + pnx * shift, mc.y + pny * shift, mc.z + pnz * shift];
      }

      const trimResult = trimRim(
        sep2.inner,
        sep2.cupAxis,
        this.params.rimTrimPercent,
        // Apply the same exclusion mask as the analysis so the preview matches exactly.
        this.excludedInnerMeshVertices.size > 0 ? this.excludedInnerMeshVertices : undefined,
        pn,
        this._rimAnchorCache ?? undefined,
        planeAnchorOverride,
      );
      this.meshViewer.displayInnerMesh(trimResult.mesh);
      this.meshViewer.displayGhostMesh(trimResult.rimMesh);
      this.scene.requestRender();
    }, 300);
  }

  // ---- Exclusion zone methods ----

  /**
   * One-shot pole pick: next click on the inner mesh defines the approximate pole location.
   * The rim-plane normal is auto-flipped so its positive side (rim side) faces away from the pole.
   */
  private definePole(): void {
    const innerMesh = this.meshViewer.getInnerMesh();
    if (!innerMesh) {
      this.status.setStatus('No inner mesh — run face separation first.');
      return;
    }
    if (this._polePickActive) return; // debounce double-click
    this._polePickActive = true;

    // In rim pick mode orbit is already disabled; outside it we must disable it
    const orbitWasEnabled = this.scene.controls.enabled;
    this.scene.controls.enabled = false;

    const canvas = this.scene.renderer.domElement;
    this._onPoleClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      canvas.removeEventListener('click', this._onPoleClick!, true);
      this._onPoleClick = null;
      this._polePickActive = false;
      this.scene.controls.enabled = orbitWasEnabled && !this.rimPickActive;

      const rect = canvas.getBoundingClientRect();
      const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.scene.camera);
      const hits = raycaster.intersectObject(innerMesh, false);
      if (hits.length === 0) {
        this.status.setStatus('No surface hit — click directly on the inner cup surface.');
        return;
      }

      // Mesh-local coordinates
      const localPole = hits[0].point.clone().sub(this.meshViewer.getGroupOffset());
      this._polePoint = localPole;
      const markerR = (this._rimAnchorCache?.radius ?? 15) * 0.06;
      this.meshViewer.displayPoleMarker(localPole, markerR);

      // Auto-orient: rim normal positive side = rim/outside, so pole must be on negative side.
      // Compute current effective normal from either the manual normal or the params.
      const sep = this.pipeline?.state.separation;
      if (!sep) return;
      if (!this._rimAnchorCache) this._rimAnchorCache = computeRimAnchor(sep.inner, sep.cupAxis);
      const anchor = this._rimAnchorCache;

      let effNormal: THREE.Vector3;
      if (this._manualRimNormal) {
        // Still in pick mode — work with the stored raw normal + flip flag
        effNormal = this._normalFlipped
          ? this._manualRimNormal.clone().negate()
          : this._manualRimNormal.clone();
      } else {
        // Post-confirmation or no manual pick — derive from current params
        const pn = this.computeCurrentRimNormal();
        if (!pn) { this.status.setStatus('Pole defined. No rim plane to orient.'); return; }
        effNormal = new THREE.Vector3(...pn);
      }

      // Plane center in mesh-local coords: shift along effective normal (toward pole)
      const planePt = this._manualRimCenter
        ? (() => {
            const range = anchor.maxHA - anchor.minHA;
            const shift = (this.params.rimTrimPercent / 100) * range;
            return this._manualRimCenter!.clone().addScaledVector(effNormal, shift);
          })()
        : (() => {
            const pc = rimAnchorToPlanePoint(anchor, sep.cupAxis, this.params.rimTrimPercent);
            return new THREE.Vector3(pc[0], pc[1], pc[2]);
          })();

      const towardPole = localPole.clone().sub(planePt);
      if (towardPole.dot(effNormal) > 0) {
        // Pole is on positive (rim-opening) side of the normal — flip needed
        if (this._manualRimNormal) {
          // In pick-mode context: toggle flip flag and re-apply
          this._normalFlipped = !this._normalFlipped;
          this._applyManualNormal();
        } else if (this._confirmedManualNormal) {
          // Post-confirm with confirmed normal: negate the confirmed normal and reset sliders
          this._confirmedManualNormal.negate();
          this.params.rimInclinationAngle = 0;
          this.params.rimInclinationAzimuth = 0;
          this.controls.refreshRimSliders();
          this._rimAnchorCache = null;
          this.updateRimPreview();
        } else {
          // Auto mode: flip via params (inc → 180-inc, az → az+180)
          let newInc = 180 - this.params.rimInclinationAngle;
          let newAz  = this.params.rimInclinationAzimuth + 180;
          if (newAz > 180) newAz -= 360;
          this.params.rimInclinationAngle  = Math.round(newInc * 10) / 10;
          this.params.rimInclinationAzimuth = Math.round(newAz  * 10) / 10;
          this.controls.refreshRimSliders();
          this._rimAnchorCache = null;
          this.updateRimPreview();
        }
        this.status.setStatus('Pole defined — normal auto-flipped so rim side is correct.');
      } else {
        this.status.setStatus('Pole defined — normal orientation already correct.');
      }
    };
    canvas.addEventListener('click', this._onPoleClick, true);
    this.status.setStatus('Pole pick: click the deepest interior of the cup. Escape cancels.');
  }

  /** Create lassoManager if not yet created (works after both stepSeparate and runFullAnalysis). */
  private ensureLassoManager(): void {
    if (this.lassoManager) return;
    this.lassoManager = new LassoSelectionManager(this.scene.renderer.domElement);
    this.lassoManager.setCallbacks({
      onSelectionComplete: (newSet: Set<number>) => {
        for (const vi of newSet) this.excludedInnerMeshVertices.add(vi);
        this.scene.controls.enabled = true;
        const separation = this.pipeline?.state.separation;
        if (separation) this.meshViewer.setExcludedVerticesHighlight(this.excludedInnerMeshVertices, separation.inner);
        this.controls.updateExclusionCount(this.excludedInnerMeshVertices.size);
        this.status.setStatus(`Exclusion updated: ${this.excludedInnerMeshVertices.size.toLocaleString()} vertices excluded. Re-run analysis to apply.`);
        this.scene.requestRender();
      },
    });
  }

  private enableLassoMode(): void {
    const sep = this.pipeline?.state.separation;
    if (!sep) { this.status.setStatus('Run face separation first'); return; }
    this.ensureLassoManager();
    this.scene.controls.enabled = false;
    const offset = this.meshViewer.getGroupOffset();
    this.lassoManager!.enable(sep.inner, this.scene.camera, offset);
    this.status.setStatus('Lasso active — click to add points, click near start or Enter to close, Esc to cancel');
  }

  private clearExclusions(): void {
    this.excludedInnerMeshVertices.clear();
    this.meshViewer.setExcludedVerticesHighlight(null, null);
    this.controls.updateExclusionCount(0);
    this.scene.requestRender();
  }

  private ensureManualLassoManager(): void {
    if (this.manualLassoManager) return;
    this.manualLassoManager = new LassoSelectionManager(this.scene.renderer.domElement);
  }

  private enableManualNonWornLassoMode(): void {
    // Sync params from GUI so rim trim% is current
    const currentParams = { ...this.controls.params };
    const p = this.ensurePipeline();
    const sep = p.state.separation;
    if (!sep) { this.status.setStatus('Run face separation first before selecting the non-worn zone.'); return; }

    // Always (re)compute the trimmed working mesh from the current params so the
    // lasso operates on exactly the same geometry that is shown opaque in the viewport.
    try {
      p.setExclusionMask(this.excludedInnerMeshVertices);
      p.setRimPlaneNormal(this.computeCurrentRimNormal());
      p.setRimInclination(currentParams.rimInclinationAngle, currentParams.rimInclinationAzimuth);
      if (this._manualRimCenter) {
        p.setManualRimBasePoint([this._manualRimCenter.x, this._manualRimCenter.y, this._manualRimCenter.z]);
      } else {
        p.setManualRimBasePoint(null);
      }
      p.stepTrimRim(currentParams.rimTrimPercent);
      if (currentParams.repairInnerFace) {
        p.stepRepairWorkingMesh(2, currentParams.holeRepairMaxLoopSize);
      }
    } catch (e) {
      this.status.setStatus(`Could not compute trimmed mesh: ${(e as Error).message}`);
      return;
    }

    const workingMesh = p.state.workingMesh!;
    this.ensureManualLassoManager();

    // Re-register callback each time, capturing the current workingMesh in a closure
    // so positions are extracted from the exact mesh the user drew on.
    this.manualLassoManager!.setCallbacks({
      onSelectionComplete: (selected: Set<number>) => {
        this.scene.controls.enabled = true;
        if (selected.size === 0) return;

        // Extract 3D positions from the trimmed mesh (mesh-local coords)
        const newPts = new Float32Array(selected.size * 3);
        let i = 0;
        for (const vi of selected) {
          newPts[i++] = workingMesh.positions[vi * 3];
          newPts[i++] = workingMesh.positions[vi * 3 + 1];
          newPts[i++] = workingMesh.positions[vi * 3 + 2];
        }

        // Accumulate with any previous selection
        if (this.manualNonWornPositions && this.manualNonWornCount > 0) {
          const merged = new Float32Array(this.manualNonWornPositions.length + newPts.length);
          merged.set(this.manualNonWornPositions, 0);
          merged.set(newPts, this.manualNonWornPositions.length);
          this.manualNonWornPositions = merged;
        } else {
          this.manualNonWornPositions = newPts;
        }
        this.manualNonWornCount = this.manualNonWornPositions.length / 3;

        this.controls.updateManualSelectionCount(this.manualNonWornCount);
        this.meshViewer.setManualNonWornHighlight(this.manualNonWornPositions);
        this.scene.requestRender();
        this.status.setStatus(
          `Non-worn zone: ${this.manualNonWornCount.toLocaleString()} vertices total. Draw again to add more, or run analysis.`
        );
      },
    });

    this.scene.controls.enabled = false;
    const offset = this.meshViewer.getGroupOffset();
    this.manualLassoManager!.enable(workingMesh, this.scene.camera, offset);
    this.status.setStatus('Non-worn lasso active — click to add points, click near start or Enter to close, Esc to cancel');
  }

  private clearManualNonWornSelection(): void {
    this.manualNonWornPositions = null;
    this.manualNonWornCount = 0;
    this.meshViewer.setManualNonWornHighlight(null);
    this.controls.updateManualSelectionCount(0);
    this.scene.requestRender();
  }

  // ---- Manual Hole Seed Pick Mode ----

  private ensureHoleSeedManager(): void {
    if (this.holeSeedManager) return;
    this.holeSeedManager = new HoleSeedPickManager(
      this.scene.renderer.domElement,
      this.scene.scene,
    );
    this.holeSeedManager.setCallbacks({
      onSeedsChanged: (seeds: THREE.Vector3[]) => {
        this.manualHoleSeeds = seeds;
        this.controls.updateHoleSeedUI(true, seeds.length);
        // Propagate seeds to pipeline state immediately so they're used on next run
        if (this.pipeline) {
          this.pipeline.setManualHoleSeeds(
            seeds.map(s => [s.x, s.y, s.z] as [number, number, number]),
          );
        }
        this.scene.requestRender();
      },
      onCancel: () => {
        this.exitHoleSeedMode();
      },
    });
  }

  private enableHoleSeedMode(): void {
    // Toggle: if already active, exit instead
    if (this.holeSeedActive) {
      this.exitHoleSeedMode();
      return;
    }
    const innerMesh = this.meshViewer.getInnerMesh();
    if (!innerMesh) {
      this.status.setStatus('Run face separation first before seeding holes.');
      return;
    }
    this.ensureHoleSeedManager();
    this.holeSeedActive = true;
    // Disable orbit controls so clicks register as seeds, not camera pans
    this.scene.controls.enabled = false;
    const offset = this.meshViewer.getGroupOffset();
    this.holeSeedManager!.enable(innerMesh, this.scene.camera, offset);
    this.controls.updateHoleSeedUI(true, this.manualHoleSeeds.length);
    this.status.setStatus('Seed mode: click inside a hole to mark it for filling. Right-click to undo. Esc to exit.');
  }

  private exitHoleSeedMode(): void {
    if (!this.holeSeedActive) return;
    this.holeSeedActive = false;
    this.holeSeedManager?.disable();
    this.scene.controls.enabled = true;
    this.controls.updateHoleSeedUI(false, this.manualHoleSeeds.length);
    this.status.setStatus(
      this.manualHoleSeeds.length === 0
        ? 'Seed mode exited.'
        : `Seed mode exited — ${this.manualHoleSeeds.length} seed(s) active. Re-run analysis to apply.`,
    );
  }

  private clearHoleSeeds(): void {
    this.manualHoleSeeds = [];
    this.holeSeedManager?.clear();
    if (this.pipeline) this.pipeline.setManualHoleSeeds([]);
    this.controls.updateHoleSeedUI(false, 0);
    this.scene.requestRender();
    this.status.setStatus('Hole seeds cleared.');
  }

  private toggleExcludedHighlight(visible: boolean): void {
    const sep = this.pipeline?.state.separation;
    if (visible && sep) {
      this.meshViewer.setExcludedVerticesHighlight(this.excludedInnerMeshVertices, sep.inner);
    } else {
      this.meshViewer.setExcludedVerticesHighlight(null, null);
    }
    this.scene.requestRender();
  }

  private async stepGeodesics(): Promise<void> {
    const p = this.ensurePipeline();
    try {
      this.status.setStatus('Smoothing mesh...');
      this.showLoading('Smoothing + computing geodesics...');

      // Smooth before geodesics so tessellation noise is filtered out
      p.stepSmooth(this.params.smoothingIterations);

      this.status.setStatus('Computing geodesics...');
      await p.stepComputeGeodesicsAsync(this.params.geodesicCount);

      // Use the mesh group offset so geodesics align with the displayed mesh
      const offset = this.meshViewer.getGroupOffset();

      if (p.state.polePosition) {
        this.geodesicRenderer.renderPole(p.state.polePosition, offset);
      }
      // Render geodesics with per-point irregularity coloring
      this.geodesicRenderer.renderGeodesics(p.state.geodesics, offset, true, p.state.curvatureThreshold || 0);
      this.geodesicRenderer.setDisplayMode(this.params.geodesicDisplayMode);

      // Make inner face slightly transparent so geodesics show on top
      this.meshViewer.setInnerTransparency(0.55);

      const regularCount = p.state.geodesics.filter(g => g.isRegular).length;
      const irregularCount = p.state.geodesics.length - regularCount;
      this.status.setStatus(`Geodesics: ${regularCount} regular, ${irregularCount} irregular`);
      this.hideLoading();
      this.controls.markStepCompleted('geodesics');
      this.controls.showVisualizationControls('pure-geodesic');
      this.applyVisibilityFromParams();
      
      // Enable section profile mode
      this.enableSectionModeButton();
      this.scene.requestRender();
    } catch (e) {
      this.status.setStatus(`Error: ${(e as Error).message}`);
      this.hideLoading();
    }
  }

  /** Step: analyze deviations + volumes + annotations (all-in-one "analyze" step) */
  private async stepAnalyze(): Promise<void> {
    const p = this.ensurePipeline();
    try {
      this.showLoading('Analyzing deviations...');
      this.status.setStatus('Analyzing deviations...');

      // Yield so the loading overlay / spinner can paint
      await new Promise<void>(r => setTimeout(r, 30));

      // 1. Deviation analysis
      this.updateLoadingText('Computing vertex deviations...');
      await new Promise<void>(r => setTimeout(r, 0));

      p.stepAnalyzeDeviations(this.params.thresholdMicrons);
      this.autoScaleColorRange();

      // 2. Heat map
      this.updateLoadingText('Generating heat map...');
      await new Promise<void>(r => setTimeout(r, 0));

      const offset = this.meshViewer.getGroupOffset();

      if (p.state.vertexDeviations && p.state.workingMesh) {
        this.meshViewer.setInnerTransparency(1.0);
        const colors = this.heatMap.generateColors(
          p.state.vertexDeviations,
          this.params.colorRangeMin,
          this.params.colorRangeMax,
          this.params.colorMapName
        );
        this.meshViewer.applyVertexColors(colors);
        this.heatMap.updateLegend(this.params.colorRangeMin, this.params.colorRangeMax, this.params.colorMapName);
      }

      // 3. Geodesic rendering - async batched for UI responsiveness
      this.updateLoadingText('Rendering geodesics...');
      await new Promise<void>(r => setTimeout(r, 0));

      if (p.state.geodesics.length > 0) {
        await this.geodesicRenderer.renderGeodesicsAsync(
          p.state.geodesics, 
          offset, 
          true, 
          p.state.curvatureThreshold || 0
        );
        this.geodesicRenderer.setDisplayMode(this.params.geodesicDisplayMode);
      }
      if (p.state.polePosition) {
        this.geodesicRenderer.renderPole(p.state.polePosition, offset);
      }

      // 4. Volume computation
      this.updateLoadingText('Computing defect volumes...');
      this.status.setStatus('Computing defect volumes...');
      await new Promise<void>(r => setTimeout(r, 0));

      p.stepComputeVolumes(this.params.thresholdMicrons, this.params.density);

      // 5. Annotations & wear vector
      this.updateLoadingText('Building annotations...');
      await new Promise<void>(r => setTimeout(r, 0));

      if (p.state.results) {
        const allClusters = [...p.state.results.bumpClusters, ...p.state.results.dipClusters];
        this.annotations.addClusterAnnotations(
          allClusters, offset,
          p.state.workingMesh?.positions,
          p.state.vertexDeviations ?? undefined
        );

        if (p.state.results.wearVector && p.state.polePosition) {
          const wv = p.state.results.wearVector;
          this.annotations.renderWearVector(
            wv.deepestPoint, p.state.polePosition, offset,
            wv.maxDepth, wv.angle
          );
        }

        this.currentResults = p.state.results;
        this.resultsPanel.setYearsInVivo(this.params.yearsInVivo);
        this.resultsPanel.show(p.state.results);
      }

      this.status.setStatus(`Analysis complete: ${p.state.results?.totalAnomalyPoints || 0} anomaly points`);
      this.hideLoading();
      this.controls.markStepCompleted('analyze');
      this.controls.showVisualizationControls('pure-geodesic');
      this.applyVisibilityFromParams();
      this.scene.requestRender();
    } catch (e) {
      this.status.setStatus(`Error: ${(e as Error).message}`);
      this.hideLoading();
    }
  }

  // ---- Visualization ----

  /**
   * Switch which sub-mode is rendered in compare-all-modes.
   * Swaps pipeline.state to the selected mode's sub-pipeline state and re-renders.
   */
  public setCompareVisualizationMode(mode: 'sphere-bestfit' | 'double-sphere-metrics'): void {
    if (!this.pipeline || !this.pipeline.compareModePipelineStates) return;
    this.compareVisualizationMode = mode;
    const stateMap = {
      'sphere-bestfit': this.pipeline.compareModePipelineStates.sphereBestfit,
      'double-sphere-metrics': this.pipeline.compareModePipelineStates.doubleSphereMetrics,
    };
    this.pipeline.state = stateMap[mode];
    this.autoScaleColorRange();
    this.applyVisualization();
    this.updateRimDiscOnly();
  }

  private applyVisualization(): void {
    if (!this.pipeline || !this.pipeline.state.results) return;
    const p = this.pipeline;
    const offset = this.meshViewer.getGroupOffset();
    const results = p.state.results!;

    // Show inner mesh (trimmed, opaque)
    if (p.state.workingMesh) {
      this.meshViewer.displayInnerMesh(p.state.workingMesh);
    }

    // Repaired holes overlay on trimmed working mesh (post-trim repair)
    if (this.params.repairInnerFace && p.state.workingMeshFilledHolesFaceStart !== null && p.state.workingMesh) {
      this.meshViewer.displayRepairedHolesOverlay(p.state.workingMesh, p.state.workingMeshFilledHolesFaceStart);
    } else {
      this.meshViewer.removeRepairedHolesOverlay();
    }

    // Show transparent context meshes
    if (p.state.separation) {
      this.meshViewer.displayOuterMesh(p.state.separation.outer);
    }
    if (p.state.trimResult) {
      this.meshViewer.displayGhostMesh(p.state.trimResult.rimMesh);
    }

    // Heat map (both modes store μm deviations in vertexDeviations)
    if (this.params.showHeatmap && p.state.vertexDeviations) {
      this.autoScaleColorRange();
      const colors = this.heatMap.generateColors(
        p.state.vertexDeviations,
        this.params.colorRangeMin,
        this.params.colorRangeMax,
        this.params.colorMapName
      );
      this.meshViewer.applyVertexColors(colors);
      this.heatMap.updateLegend(this.params.colorRangeMin, this.params.colorRangeMax, this.params.colorMapName);
    } else {
      this.meshViewer.removeVertexColors();
      this.heatMap.hideLegend();
    }

    // Reference sphere (hidden by default)
    if (p.state.sphereFit) {
      this.meshViewer.displayReferenceSphere(p.state.sphereFit.center, p.state.sphereFit.radius, this.params.showReferenceShape);
    }

    // --- BestFit / Manual Geodesic mode visualization ---
    if (results.analysisMode === 'sphere-bestfit' || results.analysisMode === 'double-sphere-metrics' || results.analysisMode === 'manual-geodesic') {
      if (results.commercialSphere) {
        this.meshViewer.displayCommercialSphere(
          results.commercialSphere.center,
          results.commercialSphere.commercialRadius,
          this.params.showCommercialSphere
        );
      }
      // Show zone spheres for both sphere-bestfit and double-sphere-metrics
      const zs = results.zoneSpheres ?? p.state.zoneSpheres;
      if (zs) {
        this.meshViewer.displayWornSphere(
          zs.wornSphere.center,
          zs.wornSphere.radius,
          this.params.showWornSphere
        );
        this.meshViewer.displayUnwornSphere(
          zs.unwornSphere.center,
          zs.unwornSphere.radius,
          this.params.showUnwornSphere
        );
      }
      if (results.rimPlane && results.commercialSphere) {
        // Rim plane disc is shown via updateRimPreview() after applyVisualization,
        // so the user-configured inclination/azimuth is always respected.
        // We skip re-drawing it here to avoid overwriting with the algorithm plane.
      } else if (results.rimPlane && (results.analysisMode === 'double-sphere-metrics' || results.analysisMode === 'manual-geodesic') && zs) {
        // same: drawn by updateRimPreview
      }
      if (results.wearPlane && results.commercialSphere) {
        // Center the plane midway between pole and rim, projected onto the wear plane
        const midPoint = results.wearPlane.planePoint.clone()
          .add(results.rimPlane!.point).multiplyScalar(0.5);
        const off = midPoint.clone().sub(results.wearPlane.planePoint);
        midPoint.sub(results.wearPlane.planeNormal.clone().multiplyScalar(off.dot(results.wearPlane.planeNormal)));
        this.meshViewer.displayWearPlane(
          midPoint,
          results.wearPlane.planeNormal,
          results.commercialSphere.commercialRadius,
          this.params.showWearPlane
        );
      }
      // Volume preview (mesh volume vs sphere cap)
      if (results.rimPlane && results.commercialSphere && p.state.separation) {
        this.meshViewer.displayVolumePreview(
          p.state.separation.inner,
          results.commercialSphere.center,
          results.commercialSphere.commercialRadius,
          results.rimPlane.point,
          results.rimPlane.normal,
          this.params.showMeshVolume || this.params.showSphereCapVolume || this.params.showWearVolume,
          this.params.repairInnerFace
        );
      } else if (results.rimPlane && (results.analysisMode === 'double-sphere-metrics' || results.analysisMode === 'manual-geodesic') && zs && p.state.separation) {
        // Manual-geodesic / double-sphere: volume preview uses unworn sphere (sphere 1) as reference
        this.meshViewer.displayVolumePreview(
          p.state.separation.inner,
          zs.unwornSphere.center,
          zs.unwornSphere.radius,
          results.rimPlane.point,
          results.rimPlane.normal,
          this.params.showMeshVolume || this.params.showSphereCapVolume || this.params.showWearVolume,
          this.params.repairInnerFace
        );
      }
    }

    // Geodesics
    if (p.state.geodesics.length > 0) {
      this.geodesicRenderer.renderGeodesics(p.state.geodesics, offset, true, p.state.curvatureThreshold || 0);
      this.geodesicRenderer.setDisplayMode(this.params.geodesicDisplayMode);
      // Enable section profile mode
      this.enableSectionModeButton();
    }

    // Pole
    if (p.state.polePosition) {
      this.geodesicRenderer.renderPole(p.state.polePosition, offset);
    }

    // Clusters & annotations
    const allClusters = [
      ...results.bumpClusters,
      ...results.dipClusters,
    ];
    this.annotations.addClusterAnnotations(
      allClusters, offset,
      p.state.workingMesh?.positions,
      p.state.vertexDeviations ?? undefined
    );
    this.annotations.setVisible(this.params.showAnnotations);

    // Wear vector (pure-geodesic) — gated by showLinearWearVector
    if (results.wearVector && p.state.polePosition) {
      const wv = results.wearVector;
      this.annotations.renderWearVector(
        wv.deepestPoint, p.state.polePosition, offset,
        wv.maxDepth, wv.angle
      );
    }

    // Linear wear vector (sphere modes) — arrow from unworn sphere centre to worn sphere centre
    if (
      (results.analysisMode === 'sphere-bestfit' ||
       results.analysisMode === 'manual-geodesic' ||
       results.analysisMode === 'double-sphere-metrics') &&
      results.zoneSpheres
    ) {
      const zs = results.zoneSpheres;
      const magnitudeMm = zs.wornSphere.center.distanceTo(zs.unwornSphere.center);
      this.meshViewer.displayLinearWearVector(
        zs.unwornSphere.center,
        zs.wornSphere.center,
        magnitudeMm,
        this.params.showLinearWearVector,
      );
    }

    this.applyVisibilityFromParams();
    this.scene.requestRender();
  }
  // --- Sphere BestFit step methods ---
  private async stepCommercialRadius(): Promise<void> {
    const p = this.ensurePipeline();
    try {
      this.status.setStatus('Determining commercial radius...');
      p.stepDetermineCommercialRadius(this.params.commercialRadius);
      this.meshViewer.displayCommercialSphere(p.state.commercialSphere!.center, p.state.commercialSphere!.commercialRadius);
      this.status.setStatus(`Commercial radius: ${p.state.commercialSphere!.commercialRadius.toFixed(2)} mm`);
      this.controls.markStepCompleted('commercial');
      this.currentResults = p.state.results;
      this.resultsPanel.setYearsInVivo(this.params.yearsInVivo);
      this.resultsPanel.show(p.state.results!);
      this.controls.showVisualizationControls('sphere-bestfit');
      this.applyVisibilityFromParams();
      this.scene.requestRender();
    } catch (e) {
      this.status.setStatus(`Error: ${(e as Error).message}`);
    }
  }

  private async stepClassifyWear(): Promise<void> {
    const p = this.ensurePipeline();
    try {
      this.status.setStatus('Classifying worn/unworn zones...');
      p.stepClassifyWear(this.params.rimTrimPercent);
      this.autoScaleColorRange();
      this.status.setStatus(`Worn vertices: ${p.state.wearClassification!.wornCount}`);
      this.controls.markStepCompleted('classifywear');
      this.currentResults = p.state.results;
      this.resultsPanel.setYearsInVivo(this.params.yearsInVivo);
      this.resultsPanel.show(p.state.results!);
      this.scene.requestRender();
    } catch (e) {
      this.status.setStatus(`Error: ${(e as Error).message}`);
    }
  }

  private async stepWearVolume(): Promise<void> {
    const p = this.ensurePipeline();
    try {
      this.status.setStatus('Computing wear volume...');
      p.stepComputeRimPlane(this.params.rimTrimPercent);
      p.stepClassifyWear(this.params.rimTrimPercent);
      p.stepFitZoneSpheres(this.params.linearWearFilter, this.params.minWornCoveragePct);
      p.stepComputeWearVolumeBestFit();
      p.stepComputeWearPlane();
      this.meshViewer.displayWornSphere(
        p.state.zoneSpheres!.wornSphere.center,
        p.state.zoneSpheres!.wornSphere.radius,
        this.params.showWornSphere
      );
      this.meshViewer.displayUnwornSphere(
        p.state.zoneSpheres!.unwornSphere.center,
        p.state.zoneSpheres!.unwornSphere.radius,
        this.params.showUnwornSphere
      );
      if (p.state.rimPlane && p.state.commercialSphere) {
        this.meshViewer.displayRimPlane(
          p.state.rimPlane.point,
          p.state.rimPlane.normal,
          p.state.commercialSphere.commercialRadius,
          this.params.showRimPlane
        );
      }
      if (p.state.wearPlane && p.state.commercialSphere && p.state.rimPlane) {
        const midPoint = p.state.wearPlane.planePoint.clone()
          .add(p.state.rimPlane.point).multiplyScalar(0.5);
        const off = midPoint.clone().sub(p.state.wearPlane.planePoint);
        midPoint.sub(p.state.wearPlane.planeNormal.clone().multiplyScalar(off.dot(p.state.wearPlane.planeNormal)));
        this.meshViewer.displayWearPlane(
          midPoint,
          p.state.wearPlane.planeNormal,
          p.state.commercialSphere.commercialRadius,
          this.params.showWearPlane
        );
      }
      // Volume preview (mesh volume vs sphere cap)
      if (p.state.rimPlane && p.state.commercialSphere && p.state.separation) {
        this.meshViewer.displayVolumePreview(
          p.state.separation.inner,
          p.state.commercialSphere.center,
          p.state.commercialSphere.commercialRadius,
          p.state.rimPlane.point,
          p.state.rimPlane.normal,
          this.params.showMeshVolume || this.params.showSphereCapVolume || this.params.showWearVolume,
          this.params.repairInnerFace
        );
      }
      this.status.setStatus(`Wear volume: ${p.state.wearVolume!.wearVolume.toFixed(4)} mm³`);
      this.controls.markStepCompleted('wearvolume');
      this.currentResults = p.state.results;
      this.resultsPanel.setYearsInVivo(this.params.yearsInVivo);
      this.resultsPanel.show(p.state.results!);
      this.controls.showVisualizationControls('sphere-bestfit');
      this.applyVisibilityFromParams();
      this.scene.requestRender();
    } catch (e) {
      this.status.setStatus(`Error: ${(e as Error).message}`);
    }
  }

  private clearVisualization(): void {
    this.meshViewer.clearAll();
    this.geodesicRenderer.clear();
    this.annotations.clearAnnotations();
    this.annotations.clearWearVector();
    this.meshViewer.removeVertexColors();
    this.heatMap.hideLegend();
    this.resultsPanel.hide();
    this.profileWindows.closeAll();
    this.disableSectionModeButton();
    this.controls.hideVisualizationControls();
    this.scene.requestRender();
  }

  /**
   * Clear all per-sample analysis state before loading a new STL.
   * Ensures no rim plane, exclusion mask, or analysis data from the
   * previous sample bleeds into the new one.
   */
  private clearSampleState(): void {
    // ---- Cancel active pick modes ----
    if (this.rimPickActive) {
      this.rimPickManager?.disable();
      this.rimPickManager?.clear();
      this.rimPickActive = false;
      this.rimPickBtn?.classList.remove('active');
      this.scene.controls.enabled = true;
    }
    if (this.holeSeedActive) {
      this.holeSeedActive = false;
      this.holeSeedManager?.disable();
      this.scene.controls.enabled = true;
    }
    // Cancel pending pole click
    if (this._onPoleClick) {
      this.scene.renderer.domElement.removeEventListener('click', this._onPoleClick, true);
      this._onPoleClick = null;
      this._polePickActive = false;
    }

    // ---- Clear rim plane state ----
    this._manualRimNormal = null;
    this._manualRimCenter = null;
    this._confirmedManualNormal = null;
    this._normalFlipped = false;
    this._polePoint = null;
    this._rimAnchorCache = null;
    if (this._rimMeshDebounce !== null) {
      clearTimeout(this._rimMeshDebounce);
      this._rimMeshDebounce = null;
    }
    this.meshViewer.clearRimNormalArrow();
    this.meshViewer.clearPoleMarker();

    // ---- Reset all analysis params to defaults ----
    Object.assign(this.params, DEFAULT_PARAMS);
    this._prePickInclination = 0;
    this._prePickAzimuth = 0;

    // ---- Clear exclusion zone ----
    this.excludedInnerMeshVertices.clear();
    this.lassoManager = null;

    // ---- Clear manual non-worn selection ----
    this.manualNonWornPositions = null;
    this.manualNonWornCount = 0;
    this.manualLassoManager = null;
    this.meshViewer.setManualNonWornHighlight(null);

    // ---- Clear hole seeds ----
    this.manualHoleSeeds = [];
    this.holeSeedManager?.clear();

    // ---- Clear pipeline and results ----
    this.pipeline = null;
    this.currentResults = null;

    // ---- Update UI ----
    this.controls.resetParamsUI();
    this.controls.updateRimPickUI(false, 0, false);
    this.controls.updateExclusionCount(0);
    this.controls.updateHoleSeedUI(false, 0);
    this.controls.updateManualSelectionCount(0);
    this.resultsPanel.hide();
    this.rimPickBtn.disabled = true; // re-enabled after face separation
  }

  private toggleHeatMap(visible: boolean): void {
    if (!visible) {
      this.meshViewer.removeVertexColors();
      this.heatMap.hideLegend();
    } else if (this.pipeline?.state.vertexDeviations) {
      const colors = this.heatMap.generateColors(
        this.pipeline.state.vertexDeviations,
        this.params.colorRangeMin,
        this.params.colorRangeMax,
        this.params.colorMapName
      );
      this.meshViewer.applyVertexColors(colors);
      this.heatMap.updateLegend(this.params.colorRangeMin, this.params.colorRangeMax, this.params.colorMapName);
    }
    this.scene.requestRender();
  }

  private toggleRefSphere(visible: boolean): void {
    this.meshViewer.setReferenceSphereVisible(visible);
    this.scene.requestRender();
  }

  /**
   * Auto-scale colorRangeMax to the actual deviation range.
   */
  private autoScaleColorRange(): void {
    if (!this.pipeline?.state.vertexDeviations) return;
    const devs = this.pipeline.state.vertexDeviations;

    // Collect positive deviations and use the 99th percentile so that extreme
    // outliers near screw holes or rim edges don't collapse the colour scale.
    const positive: number[] = [];
    for (let i = 0; i < devs.length; i++) {
      if (devs[i] > 0) positive.push(devs[i]);
    }
    let maxDev = 0;
    if (positive.length > 0) {
      positive.sort((a, b) => a - b);
      const p99idx = Math.min(Math.floor(positive.length * 0.99), positive.length - 1);
      maxDev = positive[p99idx];
    }
    // Round up to nearest 10 μm for a clean slider value
    const rounded = Math.ceil(maxDev / 10) * 10;
    const newMax = Math.max(rounded, 10);
    this.params.colorRangeMax = newMax;
    this.controls.updateColorRangeMax(newMax, newMax);
  }

  // ---- Parameter updates ----

  private onParamsChange(newParams: AnalysisParams): void {
    const colorChanged = (
      newParams.colorRangeMin !== this.params.colorRangeMin ||
      newParams.colorRangeMax !== this.params.colorRangeMax ||
      newParams.colorMapName !== this.params.colorMapName
    );
    const rimTrimChanged = newParams.rimTrimPercent !== this.params.rimTrimPercent;
    const rimPlaneChanged =
      rimTrimChanged ||
      newParams.rimInclinationAngle !== this.params.rimInclinationAngle ||
      newParams.rimInclinationAzimuth !== this.params.rimInclinationAzimuth;
    this.params = { ...newParams };

    this.applyVisibilityFromParams();

    // If rim plane params changed, update live preview
    if (rimPlaneChanged) {
      // When a confirmed manual normal is active: at inclination=0, azimuth has no effect
      // on the plane (any rotation around the confirmed normal leaves the plane unchanged).
      // Inform the user so they know to increase inclination first.
      if (this._confirmedManualNormal &&
          Math.abs(this.params.rimInclinationAngle) < 1e-6 &&
          newParams.rimInclinationAzimuth !== this.params.rimInclinationAzimuth) {
        // (params already updated above)
        this.status.setStatus('Azimuth only takes effect when Inclination > 0. Increase Inclination to tilt the plane.');
      }
      this.updateRimPreview();
    }

    // If color range changed, update heat map in real time
    if (colorChanged && this.pipeline?.state.vertexDeviations) {
      const colors = this.heatMap.generateColors(
        this.pipeline.state.vertexDeviations,
        this.params.colorRangeMin,
        this.params.colorRangeMax,
        this.params.colorMapName
      );
      this.meshViewer.applyVertexColors(colors);
      this.heatMap.updateLegend(this.params.colorRangeMin, this.params.colorRangeMax, this.params.colorMapName);
      this.scene.requestRender();
    }

    // If rim trim changed and double-sphere analysis is active, recompute rim plane + volume live
    if (rimTrimChanged &&
        this.pipeline?.state.results?.analysisMode === 'double-sphere-metrics') {
      const p = this.pipeline;
      p.stepUpdateDoubleSphereRimPlane(this.params.rimTrimPercent);
      const results = p.state.results!;
      const zs = results.zoneSpheres ?? p.state.zoneSpheres;
      if (results.rimPlane && zs) {
        this.meshViewer.displayRimPlane(
          results.rimPlane.point,
          results.rimPlane.normal,
          zs.unwornSphere.radius,
          this.params.showRimPlane
        );
      }
      if (results.rimPlane && zs && p.state.separation) {
        this.meshViewer.displayVolumePreview(
          p.state.separation.inner,
          zs.unwornSphere.center,
          zs.unwornSphere.radius,
          results.rimPlane.point,
          results.rimPlane.normal,
          this.params.showMeshVolume || this.params.showSphereCapVolume || this.params.showWearVolume,
          this.params.repairInnerFace
        );
      }
      this.currentResults = results;
      this.resultsPanel.setYearsInVivo(this.params.yearsInVivo);
      this.resultsPanel.show(results);
      this.scene.requestRender();
    }
  }

  private applyVisibilityFromParams(): void {
    // Determine the active analysis mode for the currently-rendered state.
    const mode = this.pipeline?.state.results?.analysisMode ?? null;
    // Sphere-mode-only elements (commercial/worn/unworn spheres, wear plane, volume
    // overlays) must be hidden when rendering pure-geodesic or double-sphere states.
    const isSphereModeViz = mode === 'sphere-bestfit' || mode === 'double-sphere-metrics' || mode === 'manual-geodesic';

    this.toggleHeatMap(this.params.showHeatmap);
    this.annotations.setVisible(this.params.showAnnotations);
    this.meshViewer.setContextOpaque(this.params.contextOpaque);
    if (this.params.showOriginalMesh) {
      this.meshViewer.setInnerTransparency(1.0);
    }
    this.meshViewer.setWireframe(this.params.showWireframe);
    this.meshViewer.setReferenceSphereVisible(this.params.showReferenceShape);
    this.meshViewer.setCommercialSphereVisible(isSphereModeViz && this.params.showCommercialSphere);
    this.meshViewer.setWornSphereVisible(isSphereModeViz && this.params.showWornSphere);
    this.meshViewer.setUnwornSphereVisible(isSphereModeViz && this.params.showUnwornSphere);
    this.meshViewer.setRimPlaneVisible(isSphereModeViz && this.params.showRimPlane);
    this.meshViewer.setWearPlaneVisible(isSphereModeViz && this.params.showWearPlane);
    this.meshViewer.setMeshVolumeVisible(isSphereModeViz && this.params.showMeshVolume);
    this.meshViewer.setSphereCapVisible(isSphereModeViz && this.params.showSphereCapVolume);
    this.meshViewer.setWearVolumeVisible(isSphereModeViz && this.params.showWearVolume);
    this.meshViewer.setOriginalVisible(this.params.showOriginalMesh);
    // Linear wear vector: sphere modes use MeshViewer arrow; pure-geodesic uses Annotations wearVector
    this.meshViewer.setLinearWearVectorVisible(isSphereModeViz && this.params.showLinearWearVector);
    this.annotations.setWearVectorVisible(!isSphereModeViz && this.params.showLinearWearVector);
  }

  // ---- Exports ----

  private focusLinearWearVector(): void {
    const results = this.currentResults;
    if (!results || !('zoneSpheres' in results) || !results.zoneSpheres) {
      this.status.setStatus('No linear wear vector — run a sphere-mode analysis first');
      return;
    }
    const zs = results.zoneSpheres;
    const from = zs.unwornSphere.center;
    const to = zs.wornSphere.center;
    const mid = from.clone().add(to).multiplyScalar(0.5);
    // Pad at least 8 mm around the midpoint so the vector is clearly in frame
    const pad = Math.max(from.distanceTo(to) * 4, 8);
    const box = new THREE.Box3(
      mid.clone().subScalar(pad),
      mid.clone().addScalar(pad),
    );
    this.scene.focusOn(box);
    this.scene.requestRender();
  }

  private exportPNG(): void {
    this.exporter.exportPNG(this.fileName);
    this.status.setStatus('PNG exported');
  }

  private exportCSV(): void {
    const exportable = this.getExportableResults();
    if (!exportable) { this.status.setStatus('Run analysis first'); return; }
    this.exporter.exportCSV(exportable, this.fileName, this.params.yearsInVivo);
    this.status.setStatus('CSV exported');
  }

  private exportSTL(): void {
    if (!this.pipeline?.state.workingMesh || !this.pipeline.state.vertexDeviations) {
      this.status.setStatus('Run analysis first'); return;
    }
    this.exporter.exportColoredSTL(
      this.pipeline.state.workingMesh,
      this.pipeline.state.vertexDeviations,
      this.fileName
    );
    this.status.setStatus('Colored STL exported');
  }

  private async exportPDF(): Promise<void> {
    const exportable = this.getExportableResults();
    if (!exportable) { this.status.setStatus('Run analysis first'); return; }
    await this.exporter.exportPDF(exportable, this.fileName, this.params.yearsInVivo);
    this.status.setStatus('PDF report exported');
  }

  private getExportableResults(): AnalysisResults | null {
    if (!this.currentResults) return null;
    if (this.currentResults.analysisMode === 'compare-all-modes') {
      this.status.setStatus('Compare mode export uses Sphere BestFit results by default');
      return this.currentResults.sphereBestfit;
    }
    return this.currentResults;
  }

  // ---- Section Profile Mode ----

  private setupSectionModeButton(): void {
    this.sectionModeBtn.addEventListener('click', () => {
      this.toggleSectionMode();
    });
  }

  private setupSidebarResize(): void {
    const handle = document.getElementById('sidebar-right-resize-handle');
    const sidebar = document.getElementById('sidebar-right');
    if (!handle || !sidebar) return;

    const MIN_W = 200;
    const MAX_W = 640;
    let startX = 0;
    let startW = 0;

    const onMouseMove = (e: MouseEvent) => {
      // Handle is on the LEFT edge — dragging left increases width
      const delta = startX - e.clientX;
      const newW = Math.min(MAX_W, Math.max(MIN_W, startW + delta));
      sidebar.style.width = `${newW}px`;
      this.scene.requestRender();
    };

    const onMouseUp = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    handle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      startX = e.clientX;
      startW = sidebar.offsetWidth;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // ---- Manual Rim Plane Pick Mode ----

  /** Raw best-fit normal from last pick (before flip). Updated each time pts change. */
  private _manualRimNormal: THREE.Vector3 | null = null;
  /** Whether the fitted normal has been flipped by the user. */
  private _normalFlipped = false;
  /** Saved inclination/azimuth so Revert can restore the state that existed before pick mode. */
  private _prePickInclination = 0;
  private _prePickAzimuth = 0;
  /** Centroid of the last set of picked rim points — used as disc center after confirmation. */
  private _manualRimCenter: THREE.Vector3 | null = null;
  /**
   * The CONFIRMED manual rim plane normal (oriented toward the pole).
   * Set on confirm/exit-with-points; cleared by Revert to Auto.
   * When set, the Inclination/Azimuth sliders define tilt RELATIVE to this normal
   * (0/0 = exactly this plane, not relative to the cup axis).
   */
  private _confirmedManualNormal: THREE.Vector3 | null = null;
  /** User-defined pole point (mesh-local) — used to auto-orient the rim normal. */
  private _polePoint: THREE.Vector3 | null = null;
  /** True while waiting for a one-shot pole click. */
  private _polePickActive = false;
  private _onPoleClick: ((e: MouseEvent) => void) | null = null;

  private setupRimPlanePickButton(): void {
    this.rimPickBtn.addEventListener('click', () => this.toggleRimPlanePick());
  }

  private toggleRimPlanePick(): void {
    if (this.rimPickActive) {
      // Clicking the button while active → exit WITHOUT confirming (just stops adding points)
      this.exitRimPickMode(false /* cancel=false, keep current params */);
    } else {
      this.enterRimPickMode();
    }
  }

  private enterRimPickMode(): void {
    const innerMesh = this.meshViewer.getInnerMesh();
    if (!innerMesh) {
      this.status.setStatus('Run face separation first before picking rim points.');
      return;
    }

    // Save current state so Revert can restore it
    this._prePickInclination = this.params.rimInclinationAngle;
    this._prePickAzimuth = this.params.rimInclinationAzimuth;
    this._normalFlipped = false;
    this._manualRimNormal = null;
    this._manualRimCenter = null;
    this.meshViewer.clearRimNormalArrow();

    // Hide the automatic rim disc while in pick mode
    this.meshViewer.clearRimPlane();
    // Cancel any pending mesh rebuild
    if (this._rimMeshDebounce !== null) { clearTimeout(this._rimMeshDebounce); this._rimMeshDebounce = null; }

    // Initialise manager (lazy)
    if (!this.rimPickManager) {
      this.rimPickManager = new RimPlanePickManager(
        this.scene.renderer.domElement,
        this.scene.scene,
      );
      this.rimPickManager.setCallbacks({
        onPointAdded: (pts) => this.onRimPointsChanged(pts),
        onPointRemoved: (pts) => this.onRimPointsChanged(pts),
        onCancel: () => this.cancelRimPickMode(),
      });
    } else {
      this.rimPickManager.clear();
    }

    this.rimPickActive = true;
    this.rimPickBtn.classList.add('active');
    this.scene.controls.enabled = false;

    this.rimPickManager.enable(
      innerMesh,
      this.scene.camera,
      this.meshViewer.getGroupOffset(),
    );

    this.controls.updateRimPickUI(true, 0);
    this.status.setStatus('Rim pick: click points on the rim edge (need ≥3). Right-click = undo last. Escape = cancel.');
  }

  /** Exit pick mode — keep whatever params are currently set (normal not reverted). */
  private exitRimPickMode(cancel: boolean): void {
    if (!this.rimPickActive) return;
    this.rimPickActive = false;
    this.rimPickBtn.classList.remove('active');
    this.scene.controls.enabled = true;
    this.rimPickManager?.disable();

    const n = this.rimPickManager?.getPoints().length ?? 0;

    if (cancel) {
      // Escape pressed: revert everything
      this.rimPickManager?.clear();
      this._manualRimNormal = null;
      this._manualRimCenter = null;
      this.meshViewer.clearRimNormalArrow();
      this.params.rimInclinationAngle = this._prePickInclination;
      this.params.rimInclinationAzimuth = this._prePickAzimuth;
      this.controls.refreshRimSliders();
      this._rimAnchorCache = null;
      this.updateRimPreview();
      this.controls.updateRimPickUI(false, 0);
      this.status.setStatus('Rim pick cancelled — plane reverted to previous state.');
    } else {
      // Button clicked again to exit: keep current params, clear markers
      this.rimPickManager?.clear();
      this.meshViewer.clearRimNormalArrow();
      const hasManual = this._manualRimCenter !== null;
      this.controls.updateRimPickUI(false, n >= 3 ? n : 0, hasManual);
      if (n >= 3) {
        // Store confirmed normal and reset sliders to 0/0 (relative to this normal)
        if (this._manualRimNormal) {
          const effN = this._normalFlipped
            ? this._manualRimNormal.clone().negate()
            : this._manualRimNormal.clone();
          this._confirmedManualNormal = effN.normalize();
          this.params.rimInclinationAngle = 0;
          this.params.rimInclinationAzimuth = 0;
          this.controls.refreshRimSliders();
        }
        this._rimAnchorCache = null;
        this.updateRimPreview();
        this.controls.setPoleButtonEnabled(hasManual);
        this.status.setStatus(`Rim plane set. Inclination/Azimuth sliders now relative to this plane.`);
      } else {
        // Not enough points: revert to pre-pick state
        this._manualRimCenter = null;
        this.params.rimInclinationAngle = this._prePickInclination;
        this.params.rimInclinationAzimuth = this._prePickAzimuth;
        this.controls.refreshRimSliders();
        this._rimAnchorCache = null;
        this.updateRimPreview();
        this.status.setStatus('Rim pick exited (< 3 points) — plane reverted.');
      }
    }
  }

  /** Escape-key cancel (called by manager callback). */
  private cancelRimPickMode(): void {
    this.exitRimPickMode(true);
  }

  /** Confirm button in left panel: keep plane, clear markers, exit. */
  private confirmRimPlane(): void {
    if (!this.rimPickActive) return;
    // Cancel any pending pole click
    if (this._onPoleClick) {
      this.scene.renderer.domElement.removeEventListener('click', this._onPoleClick, true);
      this._onPoleClick = null;
      this._polePickActive = false;
    }
    this.rimPickManager?.disable();
    this.rimPickActive = false;
    this.rimPickBtn.classList.remove('active');
    this.scene.controls.enabled = true;

    const n = this.rimPickManager?.getPoints().length ?? 0;
    this.rimPickManager?.clear();
    this.meshViewer.clearRimNormalArrow();
    const hasManual = this._manualRimCenter !== null;
    // Store the confirmed normal (oriented toward pole) and reset sliders to 0/0.
    // From now on, Inclination/Azimuth sliders are relative to THIS normal, not the cup axis.
    if (this._manualRimNormal) {
      const effN = this._normalFlipped
        ? this._manualRimNormal.clone().negate()
        : this._manualRimNormal.clone();
      this._confirmedManualNormal = effN.normalize();
      this.params.rimInclinationAngle = 0;
      this.params.rimInclinationAzimuth = 0;
      this.controls.refreshRimSliders();
    }
    this.controls.updateRimPickUI(false, n, hasManual);
    this.controls.setPoleButtonEnabled(hasManual);
    this._rimAnchorCache = null;
    this.updateRimPreview();
    this.status.setStatus(`Rim plane confirmed. Inclination/Azimuth sliders now relative to this plane.`);
  }

  /** Undo last picked point (left panel button). */
  private undoLastRimPoint(): void {
    if (!this.rimPickActive || !this.rimPickManager) return;
    this.rimPickManager.removeLastPoint();
  }

  /** Flip the plane normal (swap pole direction). */
  private flipRimNormal(): void {
    if (!this._manualRimNormal) return;
    this._normalFlipped = !this._normalFlipped;
    this._applyManualNormal();
  }

  /** Clear all picked points and reset the disc to current params. */
  private clearRimPoints(): void {
    if (!this.rimPickActive || !this.rimPickManager) return;
    this.rimPickManager.clear();
    this._manualRimNormal = null;
    this._manualRimCenter = null;
    this._normalFlipped = false;
    this.meshViewer.clearRimNormalArrow();
    // Restore pre-pick plane
    this.params.rimInclinationAngle = this._prePickInclination;
    this.params.rimInclinationAzimuth = this._prePickAzimuth;
    this.controls.refreshRimSliders();
    this._rimAnchorCache = null;
    this.updateRimDiscOnly();
    this.controls.updateRimPickUI(true, 0);
    this.status.setStatus('All rim points cleared. Click on the rim edge to restart.');
  }

  /** Revert to automatic rim plane (reset inclination+azimuth to 0). */
  private revertRimToAuto(): void {
    // Cancel any pending pole click
    if (this._onPoleClick) {
      this.scene.renderer.domElement.removeEventListener('click', this._onPoleClick, true);
      this._onPoleClick = null;
      this._polePickActive = false;
    }
    // Exit pick mode if active
    if (this.rimPickActive) {
      this.rimPickManager?.disable();
      this.rimPickManager?.clear();
      this.rimPickActive = false;
      this.rimPickBtn.classList.remove('active');
      this.scene.controls.enabled = true;
    }
    this._manualRimNormal = null;
    this._manualRimCenter = null;
    this._confirmedManualNormal = null;
    this._polePoint = null;
    this._normalFlipped = false;
    this.meshViewer.clearRimNormalArrow();
    this.meshViewer.clearPoleMarker();
    this.params.rimInclinationAngle = 0;
    this.params.rimInclinationAzimuth = 0;
    this.controls.refreshRimSliders();
    this.controls.updateRimPickUI(false, 0, false);
    this.controls.setPoleButtonEnabled(false);
    this._rimAnchorCache = null;
    this.updateRimPreview();
    this.status.setStatus('Rim plane reset to automatic (perpendicular to cup axis).');
  }

  /**
   * Called every time a point is added or removed during pick mode.
   * If ≥3 points, computes and shows the disc ONLY — no mesh rebuild until confirm/exit.
   */
  private onRimPointsChanged(pts: THREE.Vector3[]): void {
    const n = pts.length;
    const cupAxis = this.pipeline?.state.separation?.cupAxis;

    this.controls.updateRimPickUI(true, n);

    if (n < 3 || !cupAxis) {
      // Not enough points yet — hide disc, show pre-pick disc would confuse so just clear
      if (n < 3) this.meshViewer.clearRimPlane();
      this.meshViewer.clearRimNormalArrow();
      this.status.setStatus(`Rim pick: ${n} point${n !== 1 ? 's' : ''} — need ≥3. Right-click = undo last.`);
      return;
    }

    // Fit plane and store raw normal + centroid
    const orientHint = new THREE.Vector3(...cupAxis);
    const { normal, center } = fitPlaneFromPoints(pts, orientHint);
    this._manualRimNormal = normal;
    this._manualRimCenter = center;

    this._applyManualNormal();
    this.status.setStatus(`Rim pick: ${n} pts — disc live-updated. Flip/Define Pole to orient. Confirm ✓ to apply.`);
  }

  /** Apply the stored manual normal (with flip) to params and update disc + normal arrow. */
  private _applyManualNormal(): void {
    const cupAxis = this.pipeline?.state.separation?.cupAxis;
    if (!this._manualRimNormal || !cupAxis) return;

    const effectiveNormal = this._normalFlipped
      ? this._manualRimNormal.clone().negate()
      : this._manualRimNormal.clone();

    const { inclinationDeg, azimuthDeg } = decomposeNormalToInclination(effectiveNormal, cupAxis);
    this.params.rimInclinationAngle = Math.round(inclinationDeg * 10) / 10;
    this.params.rimInclinationAzimuth = Math.round(azimuthDeg * 10) / 10;
    this.controls.refreshRimSliders();

    // During pick mode: only update the disc, never rebuild the mesh
    this._rimAnchorCache = null;
    this.updateRimDiscOnly();

    // Update normal arrow at rim centroid
    if (this._manualRimCenter) {
      if (!this._rimAnchorCache) {
        const sep = this.pipeline?.state.separation;
        if (sep) this._rimAnchorCache = computeRimAnchor(sep.inner, sep.cupAxis);
      }
      const arrowLen = (this._rimAnchorCache?.radius ?? 15) * 0.65;
      this.meshViewer.displayRimNormalArrow(this._manualRimCenter, effectiveNormal, arrowLen);
    }

    this.scene.requestRender();
  }

  /**
   * Phase 1 only: update the rim-plane disc geometry instantly.
   * Does NOT trigger a mesh rebuild — used during pick mode.
   * Uses the manually picked rim centroid (_manualRimCenter) as disc center when available.
   */
  private updateRimDiscOnly(): void {
    const sep = this.pipeline?.state.separation;
    if (!sep) return;

    // During pick mode: use the raw fitted normal + flip directly (not from params).
    // This avoids the confusion of params reflecting cupAxis-relative angles while
    // _confirmedManualNormal is set (which would make computeCurrentRimNormal give wrong result).
    let planeNormal: [number, number, number];
    if (this.rimPickActive && this._manualRimNormal) {
      const eff = this._normalFlipped
        ? this._manualRimNormal.clone().negate()
        : this._manualRimNormal.clone();
      planeNormal = [eff.x, eff.y, eff.z];
    } else {
      const pn = this.computeCurrentRimNormal();
      if (!pn) return;
      planeNormal = pn;
    }

    if (!this._rimAnchorCache) {
      this._rimAnchorCache = computeRimAnchor(sep.inner, sep.cupAxis);
    }
    const anchor = this._rimAnchorCache;

    // Disc center: shift along effective plane normal (toward pole).
    let planePt: THREE.Vector3;
    if (this._manualRimCenter) {
      const range = anchor.maxHA - anchor.minHA;
      const shift = (this.params.rimTrimPercent / 100) * range;
      planePt = this._manualRimCenter.clone()
        .addScaledVector(new THREE.Vector3(...planeNormal), shift);
    } else {
      const pc = rimAnchorToPlanePoint(anchor, sep.cupAxis, this.params.rimTrimPercent);
      planePt = new THREE.Vector3(pc[0], pc[1], pc[2]);
    }

    const [nx, ny, nz] = planeNormal;
    this.meshViewer.displayRimPlane(
      planePt,
      new THREE.Vector3(nx, ny, nz),
      anchor.radius,
      this.params.showRimPlane,
      new THREE.Vector3(...sep.cupAxis),
    );
    this.scene.requestRender();
  }

  private toggleSectionMode(): void {
    this.sectionModeActive = !this.sectionModeActive;
    this.geodesicInteraction.setEnabled(this.sectionModeActive);
    this.sectionModeBtn.classList.toggle('active', this.sectionModeActive);
    
    if (this.sectionModeActive) {
      this.status.setStatus('Section mode: Click on a geodesic to view its profile');
    } else {
      this.geodesicRenderer.resetHighlight();
      this.status.setStatus('Section mode disabled');
    }
  }

  private enableSectionModeButton(): void {
    this.sectionModeBtn.disabled = false;
    
    // Also update geodesic interaction with geodesic data
    if (this.pipeline?.state.geodesics.length) {
      const offset = this.meshViewer.getGroupOffset();
      this.geodesicInteraction.setGeodesics(this.pipeline.state.geodesics, offset);
      
      // Set sphere radius and center for profile charts
      // Prefer commercial sphere (unworn zone center + commercial radius) when available
      if (this.pipeline.state.zoneSpheres && this.pipeline.state.commercialSphere) {
        const R = this.pipeline.state.commercialSphere.commercialRadius;
        const c = this.pipeline.state.zoneSpheres.unwornSphere.center;
        this.profileWindows.setSphereRadius(R);
        this.profileWindows.setSphereCenter([c.x, c.y, c.z]);
      } else if (this.pipeline.state.sphereFit) {
        this.profileWindows.setSphereRadius(this.pipeline.state.sphereFit.radius);
        const center = this.pipeline.state.sphereFit.center;
        this.profileWindows.setSphereCenter([center.x, center.y, center.z]);
      }
      
      // Set outer mesh for real outer surface visualization
      if (this.pipeline.state.separation?.outer) {
        this.profileWindows.setOuterMesh(this.pipeline.state.separation.outer);
      }
    }
  }

  private disableSectionModeButton(): void {
    this.sectionModeBtn.disabled = true;
    this.sectionModeBtn.classList.remove('active');
    this.sectionModeActive = false;
    this.geodesicInteraction.setEnabled(false);
  }

  private openGeodesicProfile(dg: DoubleGeodesic): void {
    // Open profile window for the selected double geodesic
    this.profileWindows.openWindow(dg);
    this.status.setStatus(`Opened profile for geodesic ${dg.angleA}° — ${dg.angleB}°`);
  }

  // ---- Loading overlay ----

  private showLoading(text: string = 'Processing...'): void {
    const overlay = document.getElementById('loading-overlay');
    const txt = document.getElementById('loading-text');
    if (overlay) overlay.classList.remove('hidden');
    if (txt) txt.textContent = text;
    this.status.showLoading();
  }

  private hideLoading(): void {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.classList.add('hidden');
    this.status.hideLoading();
  }

  private updateLoadingText(text: string): void {
    const txt = document.getElementById('loading-text');
    if (txt) txt.textContent = text;
  }
}
