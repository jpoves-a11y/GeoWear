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
import { trimRim, computeRimAnchor, rimAnchorToPlanePoint, type RimAnchor } from './analysis/MeshProcessor';
import { computeTiltedRimNormal } from './utils/geometry';

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

  // State
  private pipeline: WearAnalysisPipeline | null = null;
  private currentMeshData: MeshData | null = null;
  private currentResults: AnalysisRunResult | null = null;
  private fileName: string = '';
  private isRunning = false;
  private stlWorker: Worker | null = null;

  // Parameters (copy from defaults)
  private params: AnalysisParams = { ...DEFAULT_PARAMS };

  // Exclusion zone
  private excludedInnerMeshVertices: Set<number> = new Set();
  private lassoManager: LassoSelectionManager | null = null;

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

    // Setup recenter button
    const recenterBtn = document.getElementById('btn-recenter');
    if (recenterBtn) {
      recenterBtn.addEventListener('click', () => this.scene.resetView());
    }

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

      this.currentMeshData = meshData;
      this.currentResults = null;
      this.pipeline = null;

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

    this.isRunning = true;
    this.showLoading('Running analysis...');
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
      if (existingSeparation) this.pipeline.setSeparation(existingSeparation);
      const results = await this.pipeline.runFullAnalysis(this.currentMeshData, this.params);
      // Init lasso manager so the user can draw exclusions after full analysis too
      this.ensureLassoManager();
      this.currentResults = results;
      this.applyVisualization();
      this.applyVisibilityFromParams();
      // Restore rim plane disc to user-configured position (applyVisualization may
      // have drawn the algorithm-computed rimPlane — we always want the user params).
      this._rimAnchorCache = null; // separation may have changed — invalidate cache
      this.updateRimPreview();
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
      if (this.params.repairInnerFace) {
        p.stepRepairInnerFace();
      }
      const sep = p.state.separation!;
      this.meshViewer.displayInnerMesh(sep.inner);
      this.meshViewer.displayOuterMesh(sep.outer);
      this.meshViewer.hideOriginal();
      this._rimAnchorCache = null; // new separation — invalidate cache
      this.status.setStatus(`Separated: ${sep.inner.faceCount} inner / ${sep.outer.faceCount} outer faces${this.params.repairInnerFace ? ' (inner repaired)' : ''}`);
      this.controls.markStepCompleted('separate');
      this.applyVisibilityFromParams();
      this.scene.requestRender();
      // Init lasso manager after we have a separation
      this.ensureLassoManager();
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
      const trim = p.stepTrimRim(this.params.rimTrimPercent);
      this.meshViewer.displayInnerMesh(trim.mesh);
      this.meshViewer.displayGhostMesh(trim.rimMesh);
      this.meshViewer.hideOriginal();
      this.status.setStatus(`Trimmed: ${(trim.rimPercentRemoved).toFixed(1)}% rim removed`);
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
    const sep = this.pipeline?.state.separation;
    if (!sep) return undefined;
    const { rimInclinationAngle, rimInclinationAzimuth } = this.params;
    // Always return a plane normal — this ensures consistent plane-based trim when previewing
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
    const sep = this.pipeline?.state.separation;
    if (!sep) return;
    const planeNormal = this.computeCurrentRimNormal();
    if (!planeNormal) return;

    // --- Phase 1: instant disc update using cached geometry stats ---
    if (!this._rimAnchorCache) {
      this._rimAnchorCache = computeRimAnchor(sep.inner, sep.cupAxis);
    }
    const anchor = this._rimAnchorCache;
    const planeCenter = rimAnchorToPlanePoint(anchor, sep.cupAxis, this.params.rimTrimPercent);
    const planePt = new THREE.Vector3(planeCenter[0], planeCenter[1], planeCenter[2]);
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
      const trimResult = trimRim(
        sep2.inner,
        sep2.cupAxis,
        this.params.rimTrimPercent,
        undefined,   // no exclusion mask for preview
        pn,
        this._rimAnchorCache ?? undefined,
      );
      this.meshViewer.displayInnerMesh(trimResult.mesh);
      this.meshViewer.displayGhostMesh(trimResult.rimMesh);
      this.scene.requestRender();
    }, 300);
  }

  // ---- Exclusion zone methods ----

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
      this.applyVisibilityFromParams();
      this.scene.requestRender();
    } catch (e) {
      this.status.setStatus(`Error: ${(e as Error).message}`);
      this.hideLoading();
    }
  }

  // ---- Visualization ----

  private applyVisualization(): void {
    if (!this.pipeline || !this.pipeline.state.results) return;
    const p = this.pipeline;
    const offset = this.meshViewer.getGroupOffset();
    const results = p.state.results!;

    // Show inner mesh (trimmed, opaque)
    if (p.state.workingMesh) {
      this.meshViewer.displayInnerMesh(p.state.workingMesh);
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

    // --- BestFit mode visualization ---
    if (results.analysisMode === 'sphere-bestfit' || results.analysisMode === 'double-sphere-metrics') {
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
      } else if (results.rimPlane && results.analysisMode === 'double-sphere-metrics' && zs) {
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
      } else if (results.rimPlane && results.analysisMode === 'double-sphere-metrics' && zs && p.state.separation) {
        // Double-sphere: volume preview uses unworn sphere (sphere 1) as reference
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

    // Wear vector
    if (results.wearVector && p.state.polePosition) {
      const wv = results.wearVector;
      this.annotations.renderWearVector(
        wv.deepestPoint, p.state.polePosition, offset,
        wv.maxDepth, wv.angle
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
    this.scene.requestRender();
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
    let maxDev = 0;
    for (let i = 0; i < devs.length; i++) {
      if (devs[i] > maxDev) maxDev = devs[i];
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
    this.toggleHeatMap(this.params.showHeatmap);
    this.annotations.setVisible(this.params.showAnnotations);
    this.meshViewer.setContextOpaque(this.params.contextOpaque);
    if (this.params.showOriginalMesh) {
      this.meshViewer.setInnerTransparency(1.0);
    }
    this.meshViewer.setWireframe(this.params.showWireframe);
    this.meshViewer.setReferenceSphereVisible(this.params.showReferenceShape);
    this.meshViewer.setCommercialSphereVisible(this.params.showCommercialSphere);
    this.meshViewer.setWornSphereVisible(this.params.showWornSphere);
    this.meshViewer.setUnwornSphereVisible(this.params.showUnwornSphere);
    this.meshViewer.setRimPlaneVisible(this.params.showRimPlane);
    this.meshViewer.setWearPlaneVisible(this.params.showWearPlane);
    this.meshViewer.setMeshVolumeVisible(this.params.showMeshVolume);
    this.meshViewer.setSphereCapVisible(this.params.showSphereCapVolume);
    this.meshViewer.setWearVolumeVisible(this.params.showWearVolume);
    this.meshViewer.setOriginalVisible(this.params.showOriginalMesh);
  }

  // ---- Exports ----

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
