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
      onToggleWireframe: (v: boolean) => this.meshViewer.setWireframe(v),
      onGeodesicDisplayMode: (mode: string) => this.geodesicRenderer.setDisplayMode(mode),
      onToggleHeatmap: (v: boolean) => this.toggleHeatMap(v),
      onToggleAnnotations: (v: boolean) => this.annotations.setVisible(v),
      onToggleRefSphere: (v: boolean) => this.toggleRefSphere(v),
      onToggleContext: (opaque: boolean) => this.meshViewer.setContextOpaque(opaque),
      onToggleCommercialSphere: (v: boolean) => this.meshViewer.setCommercialSphereVisible(v),
      onToggleWornSphere: (v: boolean) => this.meshViewer.setWornSphereVisible(v),
      onToggleUnwornSphere: (v: boolean) => this.meshViewer.setUnwornSphereVisible(v),
      onToggleRimPlane: (v: boolean) => this.meshViewer.setRimPlaneVisible(v),
      onToggleWearPlane: (v: boolean) => this.meshViewer.setWearPlaneVisible(v),
      onToggleMeshVolume: (v: boolean) => this.meshViewer.setMeshVolumeVisible(v),
      onToggleSphereCapVolume: (v: boolean) => this.meshViewer.setSphereCapVisible(v),
      onToggleOriginalMesh: (v: boolean) => this.meshViewer.setOriginalVisible(v),
      // --- Export ---
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

      // --- Auto-detect unit scale (must be first, before anything else) ---
      // Acetabular cups have bounding-box diagonals ~ 30-50 mm.
      // If the diagonal is 1000× too large the file is in μm; if 1000× too small it is in m.
      {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        const pos = rawMesh.positions;
        for (let i = 0; i < rawMesh.vertexCount; i++) {
          const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        const diag = Math.sqrt(
          (maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2
        );

        let scaleFactor = 1;
        if (diag > 5000) {
          scaleFactor = 0.001;
          console.log(`[Auto-Scale] Diagonal=${diag.toFixed(1)} — detected μm units, scaling ×0.001`);
        } else if (diag < 0.1) {
          scaleFactor = 1000;
          console.log(`[Auto-Scale] Diagonal=${diag.toFixed(6)} — detected m units, scaling ×1000`);
        }

        if (scaleFactor !== 1) {
          // Scale raw mesh positions
          for (let i = 0; i < pos.length; i++) {
            pos[i] *= scaleFactor;
          }
          // Scale display geometry
          const geoPos = geometry.attributes.position.array as Float32Array;
          for (let i = 0; i < geoPos.length; i++) {
            (geoPos as Float32Array)[i] *= scaleFactor;
          }
          geometry.attributes.position.needsUpdate = true;
          geometry.computeBoundingBox();
          geometry.computeBoundingSphere();
          if (geometry.attributes.normal) {
            geometry.computeVertexNormals();
          }
          this.status.setStatus(`Auto-scaled from ${scaleFactor === 0.001 ? 'μm' : 'm'} to mm`);
        }
      }

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
        this.resultsPanel.show(p.state.results);
      }

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
    const results = p.state.results!;

    // Recreate full STL sample (hidden by default) so its UI toggle works
    // even after clearAll() during full analysis.
    if (this.currentMeshData) {
      this.meshViewer.displayOriginalMeshFromData(this.currentMeshData, false);
    }

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
    if (p.state.vertexDeviations) {
      this.autoScaleColorRange();
      const colors = this.heatMap.generateColors(
        p.state.vertexDeviations,
        this.params.colorRangeMin,
        this.params.colorRangeMax,
        this.params.colorMapName
      );
      this.meshViewer.applyVertexColors(colors);
      this.heatMap.updateLegend(this.params.colorRangeMin, this.params.colorRangeMax, this.params.colorMapName);
    }

    // Reference sphere (hidden by default)
    if (p.state.sphereFit) {
      this.meshViewer.displayReferenceSphere(p.state.sphereFit.center, p.state.sphereFit.radius, false);
    }

    // --- BestFit mode visualization ---
    if (results.analysisMode === 'sphere-bestfit') {
      if (results.commercialSphere) {
        // Commercial sphere hidden by default
        this.meshViewer.displayCommercialSphere(results.commercialSphere.center, results.commercialSphere.commercialRadius, false);
      }
      if (results.zoneSpheres) {
        this.meshViewer.displayWornSphere(results.zoneSpheres.wornSphere.center, results.zoneSpheres.wornSphere.radius);
        this.meshViewer.displayUnwornSphere(results.zoneSpheres.unwornSphere.center, results.zoneSpheres.unwornSphere.radius);
      }
      if (results.rimPlane && results.commercialSphere) {
        // Rim plane hidden by default
        this.meshViewer.displayRimPlane(
          results.rimPlane.point,
          results.rimPlane.normal,
          results.commercialSphere.commercialRadius,
          false
        );
      }
      // Wear section plane (hidden by default)
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
          false
        );
      }
      // Volume preview (mesh volume vs sphere cap, hidden by default)
      if (results.rimPlane && results.commercialSphere && p.state.workingMesh) {
        this.meshViewer.displayVolumePreview(
          p.state.workingMesh,
          results.commercialSphere.center,
          results.commercialSphere.commercialRadius,
          results.rimPlane.point,
          results.rimPlane.normal,
          false
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

    // Wear vector
    if (results.wearVector && p.state.polePosition) {
      const wv = results.wearVector;
      this.annotations.renderWearVector(
        wv.deepestPoint, p.state.polePosition, offset,
        wv.maxDepth, wv.angle
      );
    }
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
      this.resultsPanel.show(p.state.results!);
    } catch (e) {
      this.status.setStatus(`Error: ${(e as Error).message}`);
    }
  }

  private async stepClassifyWear(): Promise<void> {
    const p = this.ensurePipeline();
    try {
      this.status.setStatus('Classifying worn/unworn zones...');
      p.stepClassifyWear();
      this.autoScaleColorRange();
      this.status.setStatus(`Worn vertices: ${p.state.wearClassification!.wornCount}`);
      this.controls.markStepCompleted('classifywear');
      this.currentResults = p.state.results;
      this.resultsPanel.show(p.state.results!);
    } catch (e) {
      this.status.setStatus(`Error: ${(e as Error).message}`);
    }
  }

  private async stepWearVolume(): Promise<void> {
    const p = this.ensurePipeline();
    try {
      this.status.setStatus('Computing wear volume...');
      p.stepFitZoneSpheres();
      p.stepComputeRimPlane();
      p.stepComputeWearVolumeBestFit();
      p.stepComputeWearPlane();
      this.meshViewer.displayWornSphere(p.state.zoneSpheres!.wornSphere.center, p.state.zoneSpheres!.wornSphere.radius);
      this.meshViewer.displayUnwornSphere(p.state.zoneSpheres!.unwornSphere.center, p.state.zoneSpheres!.unwornSphere.radius);
      if (p.state.rimPlane && p.state.commercialSphere) {
        this.meshViewer.displayRimPlane(
          p.state.rimPlane.point,
          p.state.rimPlane.normal,
          p.state.commercialSphere.commercialRadius,
          false
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
          false
        );
      }
      // Volume preview (mesh volume vs sphere cap, hidden by default)
      if (p.state.rimPlane && p.state.commercialSphere && p.state.workingMesh) {
        this.meshViewer.displayVolumePreview(
          p.state.workingMesh,
          p.state.commercialSphere.center,
          p.state.commercialSphere.commercialRadius,
          p.state.rimPlane.point,
          p.state.rimPlane.normal,
          false
        );
      }
      this.status.setStatus(`Wear volume: ${p.state.wearVolume!.wearVolume.toFixed(4)} mm³`);
      this.controls.markStepCompleted('wearvolume');
      this.currentResults = p.state.results;
      this.resultsPanel.show(p.state.results!);
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
      
      // Set sphere radius and center for profile charts
      if (this.pipeline.state.sphereFit) {
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
