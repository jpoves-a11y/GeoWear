// ============================================================
// GeoWear — SceneManager
// Three.js scene, camera, renderer, controls, lighting
// ============================================================

import * as THREE from 'three';
import { Timer } from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

export class SceneManager {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public renderer: THREE.WebGLRenderer;
  public cssRenderer: CSS2DRenderer;
  public controls: TrackballControls;

  private canvas: HTMLCanvasElement;
  private container: HTMLElement;
  private timer = new Timer();
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
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
    this.controls = new TrackballControls(this.camera, this.renderer.domElement);
    this.controls.rotateSpeed = 3.0;
    this.controls.zoomSpeed = 1.2;
    this.controls.panSpeed = 0.6;
    this.controls.dynamicDampingFactor = 0.15;
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
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 200;
    keyLight.shadow.camera.left = -50;
    keyLight.shadow.camera.right = 50;
    keyLight.shadow.camera.top = 50;
    keyLight.shadow.camera.bottom = -50;
    keyLight.shadow.bias = -0.0001;
    this.scene.add(keyLight);

    // Fill light — cool tint, opposite side, softer (left-front)
    const fillLight = new THREE.DirectionalLight(0xd8e4f0, 0.5);
    fillLight.position.set(-20, 25, 15);
    this.scene.add(fillLight);

    // Rim/back light — subtle edge definition
    const rimLight = new THREE.DirectionalLight(0xc0d0e0, 0.35);
    rimLight.position.set(5, 10, -35);
    this.scene.add(rimLight);

    // Bottom fill — very soft, reduces harsh underside shadows
    const bottomLight = new THREE.DirectionalLight(0xe0e0e8, 0.15);
    bottomLight.position.set(0, -30, 10);
    this.scene.add(bottomLight);
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

    this.controls.minDistance = distance * 0.1;
    this.controls.maxDistance = distance * 10;
    this.controls.target.copy(center);
    this.camera.position.copy(
      center.clone().add(new THREE.Vector3(0, distance * 0.5, distance))
    );
    this.controls.update();
    
    // Adjust fog — color must match scene background for correct blending
    const bgColor = (this.scene.background as THREE.Color)?.getHex?.() ?? 0xe8e8e8;
    this.scene.fog = new THREE.FogExp2(bgColor, 0.5 / distance);
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
  }

  private animate = (): void => {
    this.animationId = requestAnimationFrame(this.animate);

    this.timer.update();
    const dt = this.timer.getDelta();

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
