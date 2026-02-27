// ============================================================
// GeoWear — SceneManager
// Three.js scene, camera, renderer, controls, lighting
// ============================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

export class SceneManager {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public renderer: THREE.WebGLRenderer;
  public cssRenderer: CSS2DRenderer;
  public controls: OrbitControls;

  private canvas: HTMLCanvasElement;
  private container: HTMLElement;
  private clock = new THREE.Clock();
  private frameCallbacks: Array<(dt: number) => void> = [];
  private animationId: number = 0;
  private fpsElement: HTMLElement | null;
  private fpsFrames = 0;
  private fpsTime = 0;

  constructor() {
    this.canvas = document.getElementById('three-canvas') as HTMLCanvasElement;
    this.container = document.getElementById('viewport') as HTMLElement;
    this.fpsElement = document.getElementById('fps-counter');

    // ---- Scene ----
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d1117);

    // Fog for depth perception
    this.scene.fog = new THREE.FogExp2(0x0d1117, 0.015);

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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.sortObjects = true; // Enable renderOrder sorting for transparency

    // ---- CSS2D Renderer (for annotations) ----
    this.cssRenderer = new CSS2DRenderer();
    this.cssRenderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.cssRenderer.domElement.style.position = 'absolute';
    this.cssRenderer.domElement.style.top = '0';
    this.cssRenderer.domElement.style.left = '0';
    this.cssRenderer.domElement.style.pointerEvents = 'none';
    const overlay = document.getElementById('annotations-overlay')!;
    overlay.appendChild(this.cssRenderer.domElement);

    // ---- Controls ----
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.8;
    this.controls.zoomSpeed = 1.2;
    this.controls.panSpeed = 0.6;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 200;
    this.controls.target.set(0, 0, 0);

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
    // Ambient base
    const ambientLight = new THREE.AmbientLight(0x404050, 0.6);
    this.scene.add(ambientLight);

    // Hemisphere light for natural top/bottom contrast
    const hemiLight = new THREE.HemisphereLight(0xc8dff5, 0x3a3a5c, 0.7);
    hemiLight.position.set(0, 50, 0);
    this.scene.add(hemiLight);

    // Main directional light (simulating clinical lamp)
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(20, 40, 30);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 200;
    dirLight.shadow.camera.left = -50;
    dirLight.shadow.camera.right = 50;
    dirLight.shadow.camera.top = 50;
    dirLight.shadow.camera.bottom = -50;
    dirLight.shadow.bias = -0.0001;
    this.scene.add(dirLight);

    // Fill light (opposite side, softer)
    const fillLight = new THREE.DirectionalLight(0x8899bb, 0.4);
    fillLight.position.set(-15, 20, -20);
    this.scene.add(fillLight);

    // Rim light (back)
    const rimLight = new THREE.DirectionalLight(0x445566, 0.3);
    rimLight.position.set(0, -10, -30);
    this.scene.add(rimLight);
  }

  private setupHelpers(): void {
    // Grid
    const grid = new THREE.GridHelper(100, 50, 0x222233, 0x181825);
    grid.position.y = -0.01;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.3;
    this.scene.add(grid);

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

    this.controls.target.copy(center);
    this.camera.position.copy(
      center.clone().add(new THREE.Vector3(0, distance * 0.5, distance))
    );
    this.controls.update();
    
    // Adjust fog
    this.scene.fog = new THREE.FogExp2(0x0d1117, 0.5 / distance);
  }

  /** Get a screenshot as data URL */
  public screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }

  private onResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.cssRenderer.setSize(w, h);
  }

  private animate = (): void => {
    this.animationId = requestAnimationFrame(this.animate);

    const dt = this.clock.getDelta();

    this.controls.update();

    // Run frame callbacks
    for (const cb of this.frameCallbacks) {
      cb(dt);
    }

    this.renderer.render(this.scene, this.camera);
    this.cssRenderer.render(this.scene, this.camera);

    // FPS counter
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 1.0 && this.fpsElement) {
      this.fpsElement.textContent = `${Math.round(this.fpsFrames / this.fpsTime)} FPS`;
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
  };

  /** Trigger a resize (e.g., when sidebar toggles) */
  public resize(): void {
    this.onResize();
  }

  /** Dispose of all resources */
  public dispose(): void {
    cancelAnimationFrame(this.animationId);
    this.controls.dispose();
    this.renderer.dispose();
    window.removeEventListener('resize', this.onResize.bind(this));
  }
}
