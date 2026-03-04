// ============================================================
// GeoWear — App Orchestrator
// Wires together all modules: viewer, analysis, UI
// ============================================================

import * as THREE from 'three';
import type { MeshData, AnalysisParams, AnalysisResults, DoubleGeodesic } from './types';
import { DEFAULT_PARAMS } from './types';
import { weldVertices, buildTriangleIndices } from './utils/geometry';
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
  private currentResults: AnalysisResults | null = null;
  private fileName: string = '';
  private isRunning = false;

  // Parameters (copy from defaults)
  private params: AnalysisParams = { ...DEFAULT_PARAMS };

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

    const callbacks: ControlCallbacks = {
      onLoadSTL: () => this.openFileDialog(),
      onRunAnalysis: () => this.runAnalysis(),
      onStepSeparate: () => this.stepSeparate(),
      onStepTrim: () => this.stepTrim(),
      onStepFitSphere: () => this.stepFitSphere(),
      onStepGeodesics: () => this.stepGeodesics(),
      onStepAnalyze: () => this.stepAnalyze(),
      onToggleWireframe: (v: boolean) => this.meshViewer.setWireframe(v),
      onGeodesicDisplayMode: (mode: string) => this.geodesicRenderer.setDisplayMode(mode),
      onToggleHeatmap: (v: boolean) => this.toggleHeatMap(v),
      onToggleAnnotations: (v: boolean) => this.annotations.setVisible(v),
      onToggleRefSphere: (v: boolean) => this.toggleRefSphere(v),
      onToggleContext: (opaque: boolean) => this.meshViewer.setContextOpaque(opaque),
      onExportPNG: () => this.exportPNG(),
      onExportCSV: () => this.exportCSV(),
      onExportSTL: () => this.exportSTL(),
      onExportPDF: () => this.exportPDF(),
      onShowResults: () => {
        if (this.currentResults) this.resultsPanel.show(this.currentResults);
      },
      onParamsChange: (p: AnalysisParams) => this.onParamsChange(p),
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

      // Yield to allow the UI to update before heavy parsing
      await new Promise(resolve => setTimeout(resolve, 0));

      // Use MeshViewer's loadSTL for parsing & display geometry
      this.status.setStatus('Parsing STL geometry...');
      const { geometry, meshData: rawMesh } = await this.meshViewer.loadSTL(buffer, file.name);

      // Validate parsed geometry
      if (rawMesh.vertexCount === 0) {
        throw new Error('STL file contains no vertices');
      }
      if (rawMesh.faceCount === 0) {
        throw new Error('STL file contains no faces');
      }

      // Check for NaN/Infinity in positions
      let hasInvalid = false;
      for (let i = 0; i < Math.min(rawMesh.positions.length, 300); i++) {
        if (!isFinite(rawMesh.positions[i])) { hasInvalid = true; break; }
      }
      if (hasInvalid) {
        throw new Error('STL file contains invalid coordinate values (NaN or Infinity)');
      }

      console.log(`Parsed STL: ${rawMesh.vertexCount} vertices, ${rawMesh.faceCount} faces`);

      // Yield before heavy vertex welding
      await new Promise(resolve => setTimeout(resolve, 0));

      // Weld vertices for adjacency graph construction
      this.status.setStatus('Welding vertices...');
      const welded = weldVertices(rawMesh.positions, rawMesh.normals, 1e-6);
      const indices = buildTriangleIndices(welded.indices);

      const meshData: MeshData = {
        positions: welded.positions,
        normals: welded.normals,
        indices,
        vertexCount: welded.positions.length / 3,
        faceCount: indices.length / 3,
      };

      if (meshData.vertexCount === 0) {
        throw new Error('Vertex welding produced no vertices — check the STL file');
      }

      console.log(`Welded: ${rawMesh.vertexCount} → ${meshData.vertexCount} vertices, ${meshData.faceCount} faces`);

      this.currentMeshData = meshData;
      this.currentResults = null;
      this.pipeline = null;

      // Clear previous visualization
      this.clearVisualization();

      // Yield before display
      await new Promise(resolve => setTimeout(resolve, 0));

      // Display original mesh
      this.meshViewer.displayOriginalMesh(geometry);

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

    this.pipeline = new WearAnalysisPipeline((stage, progress, message) => {
      this.status.setProgress(progress);
      this.status.setStatus(message);
    });

    try {
      const results = await this.pipeline.runFullAnalysis(this.currentMeshData, this.params);
      this.currentResults = results;
      this.applyVisualization();
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
      const sep = p.state.separation!;
      this.meshViewer.displayInnerMesh(sep.inner);
      this.meshViewer.displayOuterMesh(sep.outer);
      this.meshViewer.hideOriginal();
      this.status.setStatus(`Separated: ${sep.inner.faceCount} inner / ${sep.outer.faceCount} outer faces`);
      this.controls.markStepCompleted('separate');
    } catch (e) {
      this.status.setStatus(`Error: ${(e as Error).message}`);
    }
  }

  private async stepTrim(): Promise<void> {
    const p = this.ensurePipeline();
    try {
      this.status.setStatus('Trimming rim...');
      const trim = p.stepTrimRim(this.params.rimTrimPercent);
      this.meshViewer.displayInnerMesh(trim.mesh);
      this.meshViewer.displayGhostMesh(trim.rimMesh);
      this.meshViewer.hideOriginal();
      this.status.setStatus(`Trimmed: ${(trim.rimPercentRemoved).toFixed(1)}% rim removed`);
      this.controls.markStepCompleted('trim');
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
    } catch (e) {
      this.status.setStatus(`Error: ${(e as Error).message}`);
    }
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
      
      // Enable section profile mode
      this.enableSectionModeButton();
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
      this.setProgress(0);

      // Yield so the loading overlay / spinner can paint
      await new Promise<void>(r => setTimeout(r, 30));

      // 1. Deviation analysis (~25%)
      this.updateLoadingText('Computing vertex deviations...');
      this.setProgress(5);
      await new Promise<void>(r => setTimeout(r, 0));

      p.stepAnalyzeDeviations(this.params.thresholdMicrons);
      this.setProgress(25);

      // 2. Heat map (~40%)
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
      this.setProgress(40);

      // 3. Geodesic rendering (~55%)
      this.updateLoadingText('Rendering geodesics...');
      await new Promise<void>(r => setTimeout(r, 0));

      if (p.state.geodesics.length > 0) {
        this.geodesicRenderer.renderGeodesics(p.state.geodesics, offset, true, p.state.curvatureThreshold || 0);
        this.geodesicRenderer.setDisplayMode(this.params.geodesicDisplayMode);
      }
      if (p.state.polePosition) {
        this.geodesicRenderer.renderPole(p.state.polePosition, offset);
      }
      this.setProgress(55);

      // 4. Volume computation (~75%)
      this.updateLoadingText('Computing defect volumes...');
      this.status.setStatus('Computing defect volumes...');
      await new Promise<void>(r => setTimeout(r, 0));

      p.stepComputeVolumes(this.params.thresholdMicrons, this.params.density);
      this.setProgress(75);

      // 5. Annotations & wear vector (~90%)
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
        this.resultsPanel.show(p.state.results);
      }

      this.setProgress(100);
      this.status.setStatus(`Analysis complete: ${p.state.results?.totalAnomalyPoints || 0} anomaly points`);
      this.hideLoading();
      this.controls.markStepCompleted('analyze');
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

    // Heat map
    if (p.state.vertexDeviations) {
      const colors = this.heatMap.generateColors(
        p.state.vertexDeviations,
        this.params.colorRangeMin,
        this.params.colorRangeMax,
        this.params.colorMapName
      );
      this.meshViewer.applyVertexColors(colors);
      this.heatMap.updateLegend(this.params.colorRangeMin, this.params.colorRangeMax, this.params.colorMapName);
    }

    // Reference sphere
    if (p.state.sphereFit) {
      this.meshViewer.displayReferenceSphere(p.state.sphereFit.center, p.state.sphereFit.radius);
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
    const results = p.state.results!;
    const allClusters = [
      ...results.bumpClusters,
      ...results.dipClusters,
    ];
    this.annotations.addClusterAnnotations(
      allClusters, offset,
      p.state.workingMesh?.positions,
      p.state.vertexDeviations ?? undefined
    );

    // Wear vector
    if (results.wearVector && p.state.polePosition) {
      const wv = results.wearVector;
      this.annotations.renderWearVector(
        wv.deepestPoint, p.state.polePosition, offset,
        wv.maxDepth, wv.angle
      );
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
  }

  private toggleRefSphere(visible: boolean): void {
    this.meshViewer.setReferenceSphereVisible(visible);
  }

  // ---- Parameter updates ----

  private onParamsChange(newParams: AnalysisParams): void {
    const colorChanged = (
      newParams.colorRangeMin !== this.params.colorRangeMin ||
      newParams.colorRangeMax !== this.params.colorRangeMax ||
      newParams.colorMapName !== this.params.colorMapName
    );
    this.params = { ...newParams };

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
    }
  }

  // ---- Exports ----

  private exportPNG(): void {
    this.exporter.exportPNG(this.fileName);
    this.status.setStatus('PNG exported');
  }

  private exportCSV(): void {
    if (!this.currentResults) { this.status.setStatus('Run analysis first'); return; }
    this.exporter.exportCSV(this.currentResults, this.fileName);
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
    if (!this.currentResults) { this.status.setStatus('Run analysis first'); return; }
    await this.exporter.exportPDF(this.currentResults, this.fileName);
    this.status.setStatus('PDF report exported');
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
      
      // Set sphere radius for profile charts
      if (this.pipeline.state.sphereFit) {
        this.profileWindows.setSphereRadius(this.pipeline.state.sphereFit.radius);
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

  private setProgress(percent: number): void {
    const bar = document.getElementById('progress-bar');
    const pText = document.getElementById('progress-text');
    if (bar) bar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    if (pText) pText.textContent = `${Math.round(percent)}%`;
  }
}
