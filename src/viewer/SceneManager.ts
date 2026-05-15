// ============================================================
// GeoWear — SceneManager
// Three.js scene, camera, renderer, controls, lighting
// ============================================================

import * as THREE from 'three';
import { Timer } from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

export type ControlMode = 'basic' | 'alternative';

export class SceneManager {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public renderer: THREE.WebGLRenderer;
  public cssRenderer: CSS2DRenderer;

  // ---- Dual control mode support ----
  private _trackballControls!: TrackballControls;
  private _orbitControls!: OrbitControls;
  private _controlMode: ControlMode = 'basic';

  /** Returns the currently active controls (either TrackballControls or OrbitControls). */
  public get controls(): TrackballControls | OrbitControls {
    return this._controlMode === 'basic' ? this._trackballControls : this._orbitControls;
  }

  /** Arrow handler for middle-click pivot in alternative mode — bound once, added/removed dynamically. */
  private _altModeMouseDown = (e: MouseEvent): void => {
    if (e.button !== 1) return; // middle button only
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    const meshes: THREE.Object3D[] = [];
    this.scene.traverse(obj => { if ((obj as THREE.Mesh).isMesh && obj.visible) meshes.push(obj); });
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length > 0) {
      this._orbitControls.target.copy(hits[0].point);
      this._orbitControls.update();
      this._needsRender = true;
    }
  };

  private canvas: HTMLCanvasElement;
  private container: HTMLElement;
  private timer = new Timer();
  private frameCallbacks: Array<(dt: number) => void> = [];
  private animationId: number = 0;
  private fpsElement: HTMLElement | null;
  private fpsFrames = 0;
  private fpsTime = 0;
  private _needsRender = true;
  private _idleFrameCount = 0;
  private _fullPixelRatio = 1;
  private _largeScene = false;

  constructor() {
    this.canvas = document.getElementById('three-canvas') as HTMLCanvasElement;
    this.container = document.getElementById('viewport') as HTMLElement;
    this.fpsElement = document.getElementById('fps-counter');

    // ---- Scene ----
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xe8e8e8);

    // Fog for depth perception
    this.scene.fog = new THREE.FogExp2(0xe8e8e8, 0.012);

    // ---- Camera ----
    const aspect = this.container.clientWidth / this.container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.01, 1000);
    this.camera.position.set(0, 30, 60);

    // ---- Renderer ----
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true, // needed for PNG screenshots
    });
    this._fullPixelRatio = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(this._fullPixelRatio);
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.shadowMap.enabled = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.sortObjects = false;

    // ---- CSS2D Renderer (for annotations) ----
    this.cssRenderer = new CSS2DRenderer();
    this.cssRenderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.cssRenderer.domElement.style.position = 'absolute';
    this.cssRenderer.domElement.style.top = '0';
    this.cssRenderer.domElement.style.left = '0';
    this.cssRenderer.domElement.style.pointerEvents = 'none';
    const overlay = document.getElementById('annotations-overlay')!;
    overlay.appendChild(this.cssRenderer.domElement);

    // ---- Controls: Basic (TrackballControls) ----
    this._trackballControls = new TrackballControls(this.camera, this.renderer.domElement);
    this._trackballControls.rotateSpeed = 3.0;
    this._trackballControls.zoomSpeed = 1.2;
    this._trackballControls.panSpeed = 0.6;
    this._trackballControls.dynamicDampingFactor = 0.15;
    this._trackballControls.minDistance = 5;
    this._trackballControls.maxDistance = 200;
    this._trackballControls.target.set(0, 0, 0);

    this._trackballControls.addEventListener('change', () => { this._needsRender = true; });
    this._trackballControls.addEventListener('start', () => {
      if (this._largeScene && this._fullPixelRatio > 1) {
        this.renderer.setPixelRatio(1);
        this.onResize();
      }
    });
    this._trackballControls.addEventListener('end', () => {
      if (this._largeScene) {
        this.renderer.setPixelRatio(this._fullPixelRatio);
        this.onResize();
        this._needsRender = true;
      }
    });

    // ---- Controls: Alternative (OrbitControls) ----
    this._orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
    this._orbitControls.rotateSpeed = 2.5;
    this._orbitControls.zoomSpeed = 2.0;         // more relaxed zoom
    this._orbitControls.panSpeed = 0.8;
    this._orbitControls.enableDamping = true;
    this._orbitControls.dampingFactor = 0.1;
    this._orbitControls.minDistance = 5;
    this._orbitControls.maxDistance = 400;        // wider zoom range
    this._orbitControls.minPolarAngle = 0;        // free vertical rotation
    this._orbitControls.maxPolarAngle = Math.PI;  // free vertical rotation
    this._orbitControls.mouseButtons = {
      LEFT:   THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.ROTATE, // middle = orbit around clicked point (pivot set by _altModeMouseDown)
      RIGHT:  THREE.MOUSE.PAN,
    };
    this._orbitControls.target.set(0, 0, 0);
    this._orbitControls.enabled = false; // starts disabled

    this._orbitControls.addEventListener('change', () => { this._needsRender = true; });
    this._orbitControls.addEventListener('start', () => {
      if (this._largeScene && this._fullPixelRatio > 1) {
        this.renderer.setPixelRatio(1);
        this.onResize();
      }
    });
    this._orbitControls.addEventListener('end', () => {
      if (this._largeScene) {
        this.renderer.setPixelRatio(this._fullPixelRatio);
        this.onResize();
        this._needsRender = true;
      }
    });

    // ---- Lighting ----
    this.setupLighting();

    // ---- Helpers ----
    this.setupHelpers();

    // ---- Event listeners ----
    window.addEventListener('resize', this.onResize.bind(this));

    // ---- Start animation loop ----
    this.animate();
  }

  private setupLighting(): void {
    // Soft ambient — not too bright, gives depth
    const ambientLight = new THREE.AmbientLight(0xe8e8f0, 0.45);
    this.scene.add(ambientLight);

    // Hemisphere: warm sky / cool ground for subtle gradient
    const hemiLight = new THREE.HemisphereLight(0xf0ece0, 0xb0b8c8, 0.5);
    hemiLight.position.set(0, 50, 0);
    this.scene.add(hemiLight);

    // Key light — warm white, main shadow caster (top-right-front)
    const keyLight = new THREE.DirectionalLight(0xfff5e8, 1.2);
    keyLight.position.set(25, 45, 35);
    this.scene.add(keyLight);

    // Fill light — cool tint, opposite side, softer (left-front)
    const fillLight = new THREE.DirectionalLight(0xd8e4f0, 0.5);
    fillLight.position.set(-20, 25, 15);
    this.scene.add(fillLight);

    // Rim/back light — subtle edge definition
    const rimLight = new THREE.DirectionalLight(0xc0d0e0, 0.35);
    rimLight.position.set(5, 10, -35);
    this.scene.add(rimLight);
  }

  private setupHelpers(): void {
    // Axes
    const axes = new THREE.AxesHelper(10);
    (axes.material as THREE.Material).transparent = true;
    (axes.material as THREE.Material).opacity = 0.5;
    this.scene.add(axes);
  }

  /** Register a callback running each frame */
  public onFrame(callback: (dt: number) => void): void {
    this.frameCallbacks.push(callback);
  }

  /** Remove a frame callback */
  public removeFrameCallback(callback: (dt: number) => void): void {
    const idx = this.frameCallbacks.indexOf(callback);
    if (idx !== -1) this.frameCallbacks.splice(idx, 1);
  }

  /** Focus camera on a given target box */
  public focusOn(box: THREE.Box3): void {
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = this.camera.fov * (Math.PI / 180);
    let distance = maxDim / (2 * Math.tan(fov / 2));
    distance *= 1.5; // margin

    // Adapt camera planes and controls to mesh size
    this.camera.near = Math.max(distance * 0.001, 0.001);
    this.camera.far = distance * 20;
    this.camera.updateProjectionMatrix();

    // Update both controls so switching mode doesn't reset the camera
    const minDist = distance * 0.1;
    const maxDistBasic  = distance * 10;
    const maxDistAlt    = Math.max(distance * 10, 400);
    this._trackballControls.minDistance = minDist;
    this._trackballControls.maxDistance = maxDistBasic;
    this._trackballControls.target.copy(center);
    this._orbitControls.minDistance = minDist;
    this._orbitControls.maxDistance = maxDistAlt;
    this._orbitControls.target.copy(center);

    this.camera.position.copy(
      center.clone().add(new THREE.Vector3(0, distance * 0.5, distance))
    );
    this._trackballControls.update();
    this._orbitControls.update();
    this._needsRender = true;

    // Adjust fog — color must match scene background for correct blending
    const bgColor = (this.scene.background as THREE.Color)?.getHex?.() ?? 0xe8e8e8;
    this.scene.fog = new THREE.FogExp2(bgColor, 0.5 / distance);
  }

  /**
   * Switch between 'basic' (TrackballControls) and 'alternative' (OrbitControls) mode.
   * Syncs the orbit target so the camera pivot is preserved on switch.
   */
  public setControlMode(mode: ControlMode): void {
    if (mode === this._controlMode) return;
    this._controlMode = mode;

    if (mode === 'alternative') {
      // Sync orbit target from trackball, then swap active control
      this._orbitControls.target.copy(this._trackballControls.target);
      this._orbitControls.update();
      this._trackballControls.enabled = false;
      this._orbitControls.enabled = true;
      // Capture middle-click BEFORE OrbitControls handles it (capture phase)
      this.canvas.addEventListener('mousedown', this._altModeMouseDown, true);
    } else {
      // Sync trackball target from orbit, then swap active control
      this._trackballControls.target.copy(this._orbitControls.target);
      this._trackballControls.update();
      this._orbitControls.enabled = false;
      this._trackballControls.enabled = true;
      this.canvas.removeEventListener('mousedown', this._altModeMouseDown, true);
    }
    this._needsRender = true;
  }

  /** Get a screenshot as data URL */
  public screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }

  /** Reset camera to frame all visible objects */
  public resetView(): void {
    const box = new THREE.Box3();
    this.scene.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh && obj.visible) {
        box.expandByObject(obj);
      }
    });
    if (!box.isEmpty()) {
      this.focusOn(box);
    }
  }

  private onResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.cssRenderer.setSize(w, h);
    this._needsRender = true;
  }

  private animate = (): void => {
    this.animationId = requestAnimationFrame(this.animate);

    this.timer.update();
    const dt = this.timer.getDelta();

    // Update active controls every frame (TrackballControls needs it for inertia;
    // OrbitControls needs it when enableDamping=true)
    if (this._controlMode === 'basic') {
      this._trackballControls.update();
    } else {
      this._orbitControls.update();
    }

    // Run frame callbacks
    for (const cb of this.frameCallbacks) {
      cb(dt);
    }

    // Render-on-demand: skip expensive GPU work when idle
    this._idleFrameCount++;
    const shouldRender = this._needsRender || this._idleFrameCount >= 60;

    if (shouldRender) {
      this.renderer.render(this.scene, this.camera);
      this.cssRenderer.render(this.scene, this.camera);
      this._needsRender = false;
      this._idleFrameCount = 0;
      this.fpsFrames++;
    }

    // FPS counter
    this.fpsTime += dt;
    if (this.fpsTime >= 1.0 && this.fpsElement) {
      const fps = Math.round(this.fpsFrames / this.fpsTime);
      this.fpsElement.textContent = fps > 0 ? `${fps} FPS` : 'idle';
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
  };

  /** Trigger a resize (e.g., when sidebar toggles) */
  public resize(): void {
    this.onResize();
  }

  /** Request a render on the next animation frame */
  public requestRender(): void {
    this._needsRender = true;
  }

  /** Mark the scene as large (enables adaptive quality during interaction) */
  public setLargeScene(large: boolean): void {
    this._largeScene = large;
  }

  /** Dispose of all resources */
  public dispose(): void {
    cancelAnimationFrame(this.animationId);
    this._trackballControls.dispose();
    this._orbitControls.dispose();
    if (this._controlMode === 'alternative') {
      this.canvas.removeEventListener('mousedown', this._altModeMouseDown, true);
    }
    this.renderer.dispose();
    window.removeEventListener('resize', this.onResize.bind(this));
  }
}
