import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

type ViewerMode = 'isometric' | 'interactive';

export class ModelViewer {
  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly mode: ViewerMode;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private object = new THREE.Group();
  private size = 10;

  constructor(container: HTMLElement, mode: ViewerMode) {
    this.container = container;
    this.canvas = container.querySelector('canvas') as HTMLCanvasElement;
    this.mode = mode;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = mode === 'isometric'
      ? new THREE.OrthographicCamera(-8, 8, 8, -8, 0.1, 100)
      : new THREE.PerspectiveCamera(38, 1, 0.1, 120);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = mode === 'interactive';
    this.controls.dampingFactor = 0.07;
    this.controls.enableRotate = mode === 'interactive';
    this.controls.enablePan = mode === 'interactive';
    this.controls.zoomToCursor = true;

    this.setupScene();
    this.resetCamera();
    new ResizeObserver(() => this.resize()).observe(container);
    this.animate();
  }

  setGeometry(source: THREE.BufferGeometry): void {
    this.scene.remove(this.object);
    disposeGroup(this.object);
    this.object = new THREE.Group();

    if (source.getAttribute('position')?.count) {
      const geometry = source.clone();
      const material = new THREE.MeshStandardMaterial({
        color: this.mode === 'isometric' ? 0xdde9ed : 0x58a8c8,
        roughness: 0.72,
        metalness: 0.03,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 8),
        new THREE.LineBasicMaterial({ color: 0x17374b }),
      );
      this.object.add(mesh, edges);
      this.size = geometry.boundingSphere?.radius ? geometry.boundingSphere.radius * 2 : 10;
    } else {
      this.size = 10;
    }

    this.scene.add(this.object);
    this.resetCamera();
  }

  resetCamera(): void {
    const distance = Math.max(this.size * 1.45, 13);
    const target = new THREE.Vector3(0, Math.max(this.size * 0.2, 1.6), 0);
    if (this.mode === 'isometric') {
      this.camera.position.copy(target).add(new THREE.Vector3(distance, distance, distance));
    } else {
      this.camera.position.copy(target).add(new THREE.Vector3(distance * 1.15, distance * 0.85, distance * 1.25));
    }
    this.controls.target.copy(target);
    this.controls.update();
    this.resize();
  }

  private setupScene(): void {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xc2d1d8, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.7);
    key.position.set(-7, 13, 9);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    this.scene.add(key);

    const grid = new THREE.GridHelper(26, 26, 0xaac0ca, 0xd8e2e6);
    grid.position.y = -0.02;
    const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
    gridMaterials.forEach((material) => { material.transparent = true; material.opacity = this.mode === 'isometric' ? 0.38 : 0.25; });
    this.scene.add(grid);
  }

  private resize(): void {
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    if (this.camera instanceof THREE.PerspectiveCamera) {
      this.camera.aspect = aspect;
    } else {
      const halfHeight = Math.max(this.size * 0.7, 6.8);
      this.camera.left = -halfHeight * aspect;
      this.camera.right = halfHeight * aspect;
      this.camera.top = halfHeight;
      this.camera.bottom = -halfHeight;
    }
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}

function disposeGroup(group: THREE.Group): void {
  group.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => material.dispose());
    }
  });
}
