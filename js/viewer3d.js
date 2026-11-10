/**
 * 3D Build Volume & Toolhead WebGL Viewer for Creality Ender-3 S1 Plus
 * Built with Three.js (r128+)
 * 
 * Features:
 * - 300x300mm authentic PEI textured spring steel bed plate with fine grids & coordinate marks.
 * - Realistic Sprite Pro Direct Drive extruder assembly with brass nozzle, CR-Touch probe & LED downlight.
 * - Dynamic heater block temperature gradient glow (cold blue -> fiery orange/red).
 * - Touch & mouse OrbitControls with buttery smooth damping, pinch-to-zoom & two-finger pan.
 * - Real-time toolhead position interpolation (lerp) from Klipper telemetry (X: 0..300, Y: 0..300, Z: 0..300).
 * - Real-time extrusion trail path showing recent toolhead trajectory.
 * - Built-in STL parser (binary & ASCII) & InstancedMesh voxel generator for model preview.
 * - Intelligent low-power rendering (pauses when hidden/idle to save smartphone battery).
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Ender3DViewer = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Constants for Ender-3 S1 Plus build volume (in mm)
  const BED_SIZE_X = 300;
  const BED_SIZE_Y = 300;
  const BUILD_HEIGHT_Z = 300;

  /**
   * Helper to ensure THREE is available
   */
  function getThree() {
    if (typeof window !== 'undefined' && window.THREE) {
      return window.THREE;
    }
    throw new Error('Three.js is required for Ender3DViewer. Please include three.min.js before initializing.');
  }

  /**
   * Custom robust Touch & Mouse OrbitControls (standalone fallback with damping)
   */
  class SmoothOrbitControls {
    constructor(camera, domElement) {
      this.camera = camera;
      this.domElement = domElement;
      this.target = new (getThree().Vector3)(0, 50, 0);

      // Spherical coordinates
      this.radius = 420;
      this.theta = Math.PI / 4; // Azimuthal angle (horizontal)
      this.phi = Math.PI / 3;   // Polar angle (vertical from top)

      this.targetRadius = this.radius;
      this.targetTheta = this.theta;
      this.targetPhi = this.phi;
      this.targetPan = new (getThree().Vector3)().copy(this.target);

      // Constraints
      this.minDistance = 60;
      this.maxDistance = 850;
      this.minPolarAngle = 0.08; // Don't look strictly top-down
      this.maxPolarAngle = Math.PI / 2 + 0.12; // Allow slightly below bed horizon
      this.dampingFactor = 0.12;
      this.rotateSpeed = 0.006;
      this.zoomSpeed = 0.8;
      this.panSpeed = 0.6;

      this.isInteracting = false;
      this.hasChanged = true;

      // Pointer tracking
      this._pointers = new Map();
      this._prevPinchDist = 0;
      this._prevPinchCenter = { x: 0, y: 0 };

      this._onPointerDown = this._onPointerDown.bind(this);
      this._onPointerMove = this._onPointerMove.bind(this);
      this._onPointerUp = this._onPointerUp.bind(this);
      this._onWheel = this._onWheel.bind(this);
      this._onContextMenu = (e) => e.preventDefault();

      this._bindEvents();
      this.update(1.0);
    }

    _bindEvents() {
      const el = this.domElement;
      el.style.touchAction = 'none';
      el.addEventListener('pointerdown', this._onPointerDown, { passive: false });
      el.addEventListener('pointermove', this._onPointerMove, { passive: false });
      el.addEventListener('pointerup', this._onPointerUp, { passive: false });
      el.addEventListener('pointercancel', this._onPointerUp, { passive: false });
      el.addEventListener('wheel', this._onWheel, { passive: false });
      el.addEventListener('contextmenu', this._onContextMenu);
    }

    dispose() {
      const el = this.domElement;
      el.removeEventListener('pointerdown', this._onPointerDown);
      el.removeEventListener('pointermove', this._onPointerMove);
      el.removeEventListener('pointerup', this._onPointerUp);
      el.removeEventListener('pointercancel', this._onPointerUp);
      el.removeEventListener('wheel', this._onWheel);
      el.removeEventListener('contextmenu', this._onContextMenu);
    }

    _onPointerDown(e) {
      this.domElement.setPointerCapture(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.isInteracting = true;
      this.hasChanged = true;

      if (this._pointers.size === 2) {
        const pts = Array.from(this._pointers.values());
        this._prevPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        this._prevPinchCenter = {
          x: (pts[0].x + pts[1].x) / 2,
          y: (pts[0].y + pts[1].y) / 2
        };
      }
    }

    _onPointerMove(e) {
      if (!this._pointers.has(e.pointerId)) return;
      const prev = this._pointers.get(e.pointerId);
      const curr = { x: e.clientX, y: e.clientY };
      this._pointers.set(e.pointerId, curr);

      const dx = curr.x - prev.x;
      const dy = curr.y - prev.y;

      if (this._pointers.size === 1) {
        // Rotate if primary button or touch
        if (e.buttons === 2 || e.shiftKey) {
          // Pan with right click or Shift+drag
          this._pan(dx, dy);
        } else {
          // Normal orbit rotation
          this.targetTheta -= dx * this.rotateSpeed;
          this.targetPhi = Math.max(this.minPolarAngle, Math.min(this.maxPolarAngle, this.targetPhi - dy * this.rotateSpeed));
        }
        this.hasChanged = true;
      } else if (this._pointers.size === 2) {
        // 2-finger pinch-zoom + pan
        const pts = Array.from(this._pointers.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const center = {
          x: (pts[0].x + pts[1].x) / 2,
          y: (pts[0].y + pts[1].y) / 2
        };

        if (this._prevPinchDist > 0) {
          const pinchDelta = dist - this._prevPinchDist;
          this.targetRadius = Math.max(this.minDistance, Math.min(this.maxDistance, this.targetRadius - pinchDelta * 1.5));

          const panDx = center.x - this._prevPinchCenter.x;
          const panDy = center.y - this._prevPinchCenter.y;
          this._pan(panDx, panDy);
        }

        this._prevPinchDist = dist;
        this._prevPinchCenter = center;
        this.hasChanged = true;
      }
    }

    _onPointerUp(e) {
      try {
        this.domElement.releasePointerCapture(e.pointerId);
      } catch (err) {}
      this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) {
        this._prevPinchDist = 0;
      }
      if (this._pointers.size === 0) {
        this.isInteracting = false;
      }
    }

    _onWheel(e) {
      e.preventDefault();
      const zoomFactor = e.deltaY > 0 ? 1.12 : 0.89;
      this.targetRadius = Math.max(this.minDistance, Math.min(this.maxDistance, this.targetRadius * zoomFactor));
      this.hasChanged = true;
    }

    _pan(deltaX, deltaY) {
      const THREE = getThree();
      const offset = new THREE.Vector3();
      const camera = this.camera;

      // Camera local axes
      const matrix = new THREE.Matrix4().extractRotation(camera.matrix);
      const right = new THREE.Vector3(1, 0, 0).applyMatrix4(matrix);
      const up = new THREE.Vector3(0, 1, 0).applyMatrix4(matrix);

      const factor = (this.radius / 500) * this.panSpeed;
      offset.addScaledVector(right, -deltaX * factor);
      offset.addScaledVector(up, deltaY * factor);

      this.targetPan.add(offset);
      this.target.add(offset);
    }

    setPreset(name) {
      switch (name) {
        case 'isometric':
          this.targetTheta = Math.PI / 4;
          this.targetPhi = Math.PI / 3;
          this.targetRadius = 420;
          this.target.set(0, 50, 0);
          break;
        case 'top':
          this.targetTheta = 0;
          this.targetPhi = 0.08;
          this.targetRadius = 380;
          this.target.set(0, 0, 0);
          break;
        case 'front':
          this.targetTheta = 0;
          this.targetPhi = Math.PI / 2;
          this.targetRadius = 380;
          this.target.set(0, 60, 0);
          break;
        case 'side':
          this.targetTheta = Math.PI / 2;
          this.targetPhi = Math.PI / 2;
          this.targetRadius = 380;
          this.target.set(0, 60, 0);
          break;
      }
      this.hasChanged = true;
    }

    update(dt = 0.1) {
      const THREE = getThree();
      // Smooth damping interpolation
      const damping = 1 - Math.pow(1 - this.dampingFactor, dt * 60);

      this.radius += (this.targetRadius - this.radius) * damping;
      this.theta += (this.targetTheta - this.theta) * damping;
      this.phi += (this.targetPhi - this.phi) * damping;

      // Position camera based on spherical coordinates around target
      const sinPhi = Math.sin(this.phi);
      const cosPhi = Math.cos(this.phi);
      const sinTheta = Math.sin(this.theta);
      const cosTheta = Math.cos(this.theta);

      this.camera.position.x = this.target.x + this.radius * sinPhi * sinTheta;
      this.camera.position.y = this.target.y + this.radius * cosPhi;
      this.camera.position.z = this.target.z + this.radius * sinPhi * cosTheta;

      this.camera.lookAt(this.target);

      // Check if motion has virtually settled
      const delta = Math.abs(this.targetRadius - this.radius) +
                    Math.abs(this.targetTheta - this.theta) +
                    Math.abs(this.targetPhi - this.phi);

      if (delta > 0.0005) {
        this.hasChanged = true;
      }
      return this.hasChanged;
    }
  }

  /**
   * Main Ender3DViewer Class
   */
  class Ender3DViewer {
    /**
     * @param {HTMLElement|string} container - DOM element or ID for canvas container
     * @param {Object} options - Configuration options
     */
    constructor(container, options = {}) {
      this.container = typeof container === 'string' ? document.getElementById(container) : container;
      if (!this.container) {
        throw new Error(`[Ender3DViewer] Target container not found: ${container}`);
      }

      this.options = Object.assign({
        antialias: true,
        alpha: true,
        lowPowerMode: true,
        maxFps: 60,
        enableShadows: true,
        enableExtrusionTrail: true,
        maxTrailPoints: 120,
        backgroundColor: 0x06090e,
        accentColor: 0x10b981,
      }, options);

      this.THREE = getThree();

      // State
      this.isInitialized = false;
      this.isDestroyed = false;
      this.isPaused = false;
      this.isLowPowerIdle = false;
      this.idleFramesCount = 0;

      // Telemetry & toolhead state (Klipper coordinate system in mm: 0..300)
      this.toolTarget = { x: 150, y: 150, z: 15 };
      this.toolCurrent = { x: 150, y: 150, z: 15 };
      this.nozzleTemp = { current: 24, target: 0 };
      this.bedTemp = { current: 24, target: 0 };

      // Three.js core objects
      this.scene = null;
      this.camera = null;
      this.renderer = null;
      this.controls = null;
      this.clock = new this.THREE.Clock();

      // Scene groups
      this.bedGroup = null;
      this.cageGroup = null;
      this.toolheadGroup = null;
      this.modelPreviewGroup = null;
      this.trailGroup = null;

      // Dynamic sub-elements
      this.heaterBlockMaterial = null;
      this.crTouchLed = null;
      this.nozzleSpotlight = null;
      this.trailLine = null;
      this.trailPositions = [];

      // Bound handlers
      this._animate = this._animate.bind(this);
      this._onResize = this._onResize.bind(this);
      this._onVisibilityChange = this._onVisibilityChange.bind(this);

      this.init();
    }

    /**
     * Initialize Three.js Scene, Camera, Renderer and Objects
     */
    init() {
      if (this.isInitialized) return;
      const THREE = this.THREE;

      // 1. Scene
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(this.options.backgroundColor);
      this.scene.fog = new THREE.FogExp2(this.options.backgroundColor, 0.0018);

      // 2. Camera
      const width = this.container.clientWidth || 360;
      const height = this.container.clientHeight || 300;
      this.camera = new THREE.PerspectiveCamera(45, width / height, 1, 2000);
      this.camera.position.set(220, 260, 320);

      // 3. Renderer
      this.renderer = new THREE.WebGLRenderer({
        antialias: this.options.antialias,
        alpha: this.options.alpha,
        powerPreference: 'high-performance',
      });
      this.renderer.setSize(width, height);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

      if (this.options.enableShadows) {
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      }
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.15;

      this.container.innerHTML = '';
      this.container.appendChild(this.renderer.domElement);
      this.renderer.domElement.style.display = 'block';
      this.renderer.domElement.style.outline = 'none';

      // 4. Orbit Controls (Uses custom smooth controller)
      if (THREE.OrbitControls) {
        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.target.set(0, 50, 0);
        this.controls.maxPolarAngle = Math.PI / 2 + 0.12;
        this.controls.minDistance = 60;
        this.controls.maxDistance = 850;
      } else {
        this.controls = new SmoothOrbitControls(this.camera, this.renderer.domElement);
      }

      // 5. Lighting Setup (Cinematic Atelier Dark Obsidian Theme)
      this._setupLighting();

      // 6. Build Scene Components
      this._buildBedPlate();
      this._buildBuildCage();
      this._buildToolhead();
      this._buildExtrusionTrail();

      this.modelPreviewGroup = new THREE.Group();
      this.modelPreviewGroup.name = 'ModelPreviewGroup';
      this.scene.add(this.modelPreviewGroup);

      // 7. Event Listeners
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('resize', this._onResize, { passive: true });
      }
      if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('visibilitychange', this._onVisibilityChange);
      }

      if (typeof window !== 'undefined' && window.ResizeObserver && this.container) {
        this.resizeObserver = new ResizeObserver(() => this._onResize());
        this.resizeObserver.observe(this.container);
      }

      this.isInitialized = true;
      this._requestWakeup();
      this._animate();
    }

    /**
     * Lighting: Ambient + Key Directional with Soft Shadow + Cyan/Amber Rim Lights
     */
    _setupLighting() {
      const THREE = this.THREE;

      // Soft ambient fill
      const ambientLight = new THREE.AmbientLight(0xdde5ed, 0.55);
      this.scene.add(ambientLight);

      // Key light from top-front-right
      const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
      keyLight.position.set(180, 400, 220);
      if (this.options.enableShadows) {
        keyLight.castShadow = true;
        keyLight.shadow.mapSize.width = 1024;
        keyLight.shadow.mapSize.height = 1024;
        keyLight.shadow.camera.near = 100;
        keyLight.shadow.camera.far = 800;
        const d = 220;
        keyLight.shadow.camera.left = -d;
        keyLight.shadow.camera.right = d;
        keyLight.shadow.camera.top = d;
        keyLight.shadow.camera.bottom = -d;
        keyLight.shadow.bias = -0.0005;
      }
      this.scene.add(keyLight);

      // Cool Cyber-Cyan Rim Light from back-left
      const rimLightCyan = new THREE.DirectionalLight(0x06b6d4, 0.65);
      rimLightCyan.position.set(-250, 180, -220);
      this.scene.add(rimLightCyan);

      // Subtle Warm Ground Reflection Light
      const groundLight = new THREE.HemisphereLight(0x18243e, 0x06090e, 0.4);
      this.scene.add(groundLight);
    }

    /**
     * Procedural Texture Generator for PEI Spring Steel Sheet (300x300mm)
     * Creates realistic dark metallic shimmer, 10mm & 50mm grid lines, ruler marks & logo.
     */
    _generatePEITexture() {
      const canvas = document.createElement('canvas');
      canvas.width = 1024;
      canvas.height = 1024;
      const ctx = canvas.getContext('2d');

      // 1. Base dark charcoal metallic fill
      const bgGrad = ctx.createRadialGradient(512, 512, 100, 512, 512, 600);
      bgGrad.addColorStop(0, '#191d24');
      bgGrad.addColorStop(1, '#0f1217');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, 1024, 1024);

      // 2. Fine PEI granular micro-texture (procedural fleck noise)
      const imgData = ctx.getImageData(0, 0, 1024, 1024);
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        const noise = (Math.random() - 0.5) * 16;
        data[i] = Math.min(255, Math.max(0, data[i] + noise + (Math.random() > 0.98 ? 14 : 0))); // Golden fleck
        data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise + (Math.random() > 0.98 ? 10 : 0)));
        data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise));
      }
      ctx.putImageData(imgData, 0, 0);

      // 3. Gold perimeter border
      ctx.strokeStyle = '#cda45e';
      ctx.lineWidth = 4;
      ctx.strokeRect(32, 32, 960, 960);

      // Inner faint perimeter
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 1;
      ctx.strokeRect(40, 40, 944, 944);

      // 4. Grid Lines (300mm represented over 960px -> 3.2px per mm)
      const originX = 32;
      const originY = 32;
      const step10mm = 960 / 30; // 32px
      const step50mm = 960 / 6;  // 160px

      // 10mm faint grid
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.055)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= 30; i++) {
        const p = originX + i * step10mm;
        // Vertical
        ctx.moveTo(p, originY);
        ctx.lineTo(p, originY + 960);
        // Horizontal
        ctx.moveTo(originX, p);
        ctx.lineTo(originX + 960, p);
      }
      ctx.stroke();

      // 50mm major grid with subtle dashes
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i <= 6; i++) {
        const p = originX + i * step50mm;
        // Vertical
        ctx.moveTo(p, originY);
        ctx.lineTo(p, originY + 960);
        // Horizontal
        ctx.moveTo(originX, p);
        ctx.lineTo(originX + 960, p);
      }
      ctx.stroke();

      // 5. Center Crosshair (150, 150)
      const cx = 512;
      const cy = 512;
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 32, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(cx - 48, cy); ctx.lineTo(cx + 48, cy);
      ctx.moveTo(cx, cy - 48); ctx.lineTo(cx, cy + 48);
      ctx.stroke();

      // 6. Coordinate Marks and Text
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.font = 'bold 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // X/Y Axis Labels
      for (let i = 0; i <= 6; i++) {
        const val = i * 50;
        const pos = originX + i * step50mm;
        // Bottom edge (X Axis)
        ctx.fillText(`${val}`, pos, 1008);
        // Left edge (Y Axis)
        if (i > 0) ctx.fillText(`${val}`, 18, 1024 - pos);
      }

      // Origin badge [0, 0]
      ctx.fillStyle = '#10b981';
      ctx.font = 'bold 16px monospace';
      ctx.textAlign = 'left';
      ctx.fillText('[X:0, Y:0]', 44, 980);

      // Corner bounds
      ctx.textAlign = 'right';
      ctx.fillText('[300, 300]', 980, 56);

      // Center Branding Logo
      ctx.fillStyle = 'rgba(205, 164, 94, 0.85)'; // Metallic Gold
      ctx.font = 'bold 22px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('CREALITY ENDER-3 S1 PLUS', 512, 430);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.font = '14px monospace';
      ctx.fillText('300 x 300 mm • PEI SPRING STEEL SHEET', 512, 458);

      const texture = new (this.THREE.CanvasTexture)(canvas);
      texture.anisotropy = 4;
      return texture;
    }

    /**
     * Construct 300x300mm Bed Plate with Aluminum Heating Bed, Springs & Leveling Knobs
     */
    _buildBedPlate() {
      const THREE = this.THREE;
      this.bedGroup = new THREE.Group();
      this.bedGroup.name = 'BedPlateGroup';

      // 1. Spring Steel PEI Top Plate
      const peiTexture = this._generatePEITexture();
      const peiMaterial = new THREE.MeshStandardMaterial({
        map: peiTexture,
        roughness: 0.55,
        metalness: 0.35,
      });

      const bedGeometry = new THREE.BoxGeometry(BED_SIZE_X, 2, BED_SIZE_Y);
      const bedMesh = new THREE.Mesh(bedGeometry, peiMaterial);
      bedMesh.position.set(0, -1, 0); // Bed surface exactly at Y = 0
      bedMesh.receiveShadow = true;
      this.bedGroup.add(bedMesh);

      // Front handle tab (classic Ender-3 S1 Plus spring steel sheet tab)
      const tabGeo = new THREE.BoxGeometry(60, 2, 16);
      const tabMesh = new THREE.Mesh(tabGeo, peiMaterial);
      tabMesh.position.set(0, -1, BED_SIZE_Y / 2 + 8);
      tabMesh.receiveShadow = true;
      this.bedGroup.add(tabMesh);

      // 2. Aluminum Substrate Heating Plate (310x310x5mm dark anodized)
      const aluMaterial = new THREE.MeshStandardMaterial({
        color: 0x181c24,
        roughness: 0.4,
        metalness: 0.7,
      });
      const aluGeo = new THREE.BoxGeometry(BED_SIZE_X + 10, 5, BED_SIZE_Y + 10);
      const aluMesh = new THREE.Mesh(aluGeo, aluMaterial);
      aluMesh.position.set(0, -4.5, 0);
      aluMesh.receiveShadow = true;
      this.bedGroup.add(aluMesh);

      // 3. Four Screws Tilt Leveling Wheels & Golden Springs (Corners)
      const screwPositions = [
        [-BED_SIZE_X / 2 + 35, -BED_SIZE_Y / 2 + 35], // RL (Rear-Left)
        [ BED_SIZE_X / 2 - 35, -BED_SIZE_Y / 2 + 35], // RR (Rear-Right)
        [-BED_SIZE_X / 2 + 35,  BED_SIZE_Y / 2 - 35], // FL (Front-Left)
        [ BED_SIZE_X / 2 - 35,  BED_SIZE_Y / 2 - 35], // FR (Front-Right)
      ];

      const wheelGeo = new THREE.CylinderGeometry(20, 20, 6, 24);
      const wheelMat = new THREE.MeshStandardMaterial({ color: 0x8b1e1e, roughness: 0.5, metalness: 0.4 }); // Red aluminum dials
      const springGeo = new THREE.CylinderGeometry(8, 8, 12, 16);
      const springMat = new THREE.MeshStandardMaterial({ color: 0xeab308, roughness: 0.3, metalness: 0.8 }); // Yellow spring

      screwPositions.forEach(([sx, sz]) => {
        // Spring
        const spring = new THREE.Mesh(springGeo, springMat);
        spring.position.set(sx, -13, sz);
        this.bedGroup.add(spring);

        // Dial Knob
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.position.set(sx, -21, sz);
        this.bedGroup.add(wheel);
      });

      this.scene.add(this.bedGroup);
    }

    /**
     * Build 300x300x300mm Wireframe Build Cage with Corner Markers & Z Rulers
     */
    _buildBuildCage() {
      const THREE = this.THREE;
      this.cageGroup = new THREE.Group();
      this.cageGroup.name = 'BuildCageGroup';

      // 1. Subtle Boundary Box Wireframe
      const boxGeo = new THREE.BoxGeometry(BED_SIZE_X, BUILD_HEIGHT_Z, BED_SIZE_Y);
      const edges = new THREE.EdgesGeometry(boxGeo);
      const lineMat = new THREE.LineBasicMaterial({
        color: 0x334155,
        transparent: true,
        opacity: 0.35,
      });
      const wireframe = new THREE.LineSegments(edges, lineMat);
      wireframe.position.set(0, BUILD_HEIGHT_Z / 2, 0);
      this.cageGroup.add(wireframe);

      // 2. Glowing Corner Accent Brackets (Cyber-Cyan / Emerald)
      const bracketMat = new THREE.LineBasicMaterial({
        color: 0x06b6d4,
        transparent: true,
        opacity: 0.85,
        linewidth: 2,
      });

      const corners = [
        [-1, 1], [1, 1], [-1, -1], [1, -1]
      ];
      const hx = BED_SIZE_X / 2;
      const hz = BED_SIZE_Y / 2;
      const bracketLen = 25;

      corners.forEach(([cx, cz]) => {
        // Bottom corner brackets
        const ptsBottom = [
          new THREE.Vector3(cx * hx, 0, cz * (hz - bracketLen)),
          new THREE.Vector3(cx * hx, 0, cz * hz),
          new THREE.Vector3(cx * (hx - bracketLen), 0, cz * hz),
          new THREE.Vector3(cx * hx, 0, cz * hz),
          new THREE.Vector3(cx * hx, bracketLen, cz * hz),
        ];
        const gBottom = new THREE.BufferGeometry().setFromPoints(ptsBottom);
        this.cageGroup.add(new THREE.Line(gBottom, bracketMat));

        // Top corner brackets
        const ptsTop = [
          new THREE.Vector3(cx * hx, BUILD_HEIGHT_Z, cz * (hz - bracketLen)),
          new THREE.Vector3(cx * hx, BUILD_HEIGHT_Z, cz * hz),
          new THREE.Vector3(cx * (hx - bracketLen), BUILD_HEIGHT_Z, cz * hz),
          new THREE.Vector3(cx * hx, BUILD_HEIGHT_Z, cz * hz),
          new THREE.Vector3(cx * hx, BUILD_HEIGHT_Z - bracketLen, cz * hz),
        ];
        const gTop = new THREE.BufferGeometry().setFromPoints(ptsTop);
        this.cageGroup.add(new THREE.Line(gTop, bracketMat));
      });

      this.scene.add(this.cageGroup);
    }

    /**
     * Construct Sprite Pro Direct Drive Extruder & Tool Assembly
     * Realistic dual-gear Direct Drive extruder with brass nozzle, heatblock glow,
     * CR-Touch probe with LED indicator, and focused nozzle worklight.
     */
    _buildToolhead() {
      const THREE = this.THREE;
      this.toolheadGroup = new THREE.Group();
      this.toolheadGroup.name = 'SpriteExtruderToolhead';

      // 1. Sprite Extruder Main Body (Gunmetal Anodized Aluminum)
      const bodyMat = new THREE.MeshStandardMaterial({
        color: 0x1f242e,
        roughness: 0.35,
        metalness: 0.8,
      });
      const bodyGeo = new THREE.BoxGeometry(42, 38, 36);
      const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
      bodyMesh.position.set(0, 32, 0);
      bodyMesh.castShadow = true;
      this.toolheadGroup.add(bodyMesh);

      // 2. Lightweight Pancake Stepper Motor (Behind Extruder)
      const motorMat = new THREE.MeshStandardMaterial({ color: 0x111317, roughness: 0.6, metalness: 0.4 });
      const motorGeo = new THREE.CylinderGeometry(18, 18, 14, 24);
      const motorMesh = new THREE.Mesh(motorGeo, motorMat);
      motorMesh.rotation.x = Math.PI / 2;
      motorMesh.position.set(0, 32, -24);
      motorMesh.castShadow = true;
      this.toolheadGroup.add(motorMesh);

      // 3. Heat Sink Fins (Horizontal grooves)
      const finMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, roughness: 0.25, metalness: 0.85 });
      const finGeo = new THREE.BoxGeometry(34, 16, 28);
      const finMesh = new THREE.Mesh(finGeo, finMat);
      finMesh.position.set(0, 16, 0);
      finMesh.castShadow = true;
      this.toolheadGroup.add(finMesh);

      // 4. Aluminum Heater Block with Dynamic Emissive Gradient
      this.heaterBlockMaterial = new THREE.MeshStandardMaterial({
        color: 0x9ca3af,
        roughness: 0.3,
        metalness: 0.9,
        emissive: 0x000000,
        emissiveIntensity: 0.0,
      });
      const heaterGeo = new THREE.BoxGeometry(16, 10, 14);
      const heaterMesh = new THREE.Mesh(heaterGeo, this.heaterBlockMaterial);
      heaterMesh.position.set(0, 7, 0);
      heaterMesh.castShadow = true;
      this.toolheadGroup.add(heaterMesh);

      // 5. Brass Nozzle Cone (Points downward to Y = 0)
      const nozzleMat = new THREE.MeshStandardMaterial({
        color: 0xd97706, // Brass Gold
        roughness: 0.25,
        metalness: 0.9,
      });
      // Cylinder base + cone tip
      const nozzleBaseGeo = new THREE.CylinderGeometry(3.5, 3.5, 3, 16);
      const nozzleBase = new THREE.Mesh(nozzleBaseGeo, nozzleMat);
      nozzleBase.position.set(0, 3.5, 0);
      this.toolheadGroup.add(nozzleBase);

      const nozzleTipGeo = new THREE.ConeGeometry(3.2, 3.5, 16);
      const nozzleTip = new THREE.Mesh(nozzleTipGeo, nozzleMat);
      nozzleTip.rotation.x = Math.PI; // Point down
      nozzleTip.position.set(0, 1.75, 0);
      this.toolheadGroup.add(nozzleTip);

      // 6. CR-Touch Auto-Bed Leveling Probe (Right side)
      const crTouchGroup = new THREE.Group();
      crTouchGroup.position.set(28, 20, 2);

      const crBodyGeo = new THREE.BoxGeometry(12, 24, 12);
      const crBodyMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.4 });
      const crBody = new THREE.Mesh(crBodyGeo, crBodyMat);
      crTouchGroup.add(crBody);

      // Retractable probe pin
      const pinGeo = new THREE.CylinderGeometry(1.2, 1.2, 8, 12);
      const pinMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.9 });
      const pin = new THREE.Mesh(pinGeo, pinMat);
      pin.position.set(0, -14, 0);
      crTouchGroup.add(pin);

      // CR-Touch Glowing Status LED (Violet/Purple)
      const ledGeo = new THREE.SphereGeometry(2, 12, 12);
      this.crTouchLedMat = new THREE.MeshBasicMaterial({ color: 0x8b5cf6 });
      const ledMesh = new THREE.Mesh(ledGeo, this.crTouchLedMat);
      ledMesh.position.set(0, 8, 6);
      crTouchGroup.add(ledMesh);

      this.toolheadGroup.add(crTouchGroup);

      // 7. Part Cooling 5015 Blower Duct Snout (Front-angled)
      const ductMat = new THREE.MeshStandardMaterial({ color: 0x0284c7, roughness: 0.4 });
      const ductGeo = new THREE.BoxGeometry(18, 12, 16);
      const ductMesh = new THREE.Mesh(ductGeo, ductMat);
      ductMesh.position.set(0, 10, 16);
      ductMesh.rotation.x = 0.25;
      this.toolheadGroup.add(ductMesh);

      // 8. Extruder Downlight Spotlight (projects cone onto bed under nozzle)
      this.nozzleSpotlight = new THREE.SpotLight(0xffffff, 1.8, 160, Math.PI / 5, 0.4, 1.5);
      this.nozzleSpotlight.position.set(0, 20, 0);
      this.nozzleSpotlight.target.position.set(0, 0, 0);
      this.toolheadGroup.add(this.nozzleSpotlight);
      this.toolheadGroup.add(this.nozzleSpotlight.target);

      // Initial placement in scene
      this._applyToolheadTransform();
      this.scene.add(this.toolheadGroup);
    }

    /**
     * Extrusion Trajectory Trail (Smooth glowing path of recent nozzle movements)
     */
    _buildExtrusionTrail() {
      if (!this.options.enableExtrusionTrail) return;
      const THREE = this.THREE;

      this.trailGroup = new THREE.Group();
      this.trailGroup.name = 'ExtrusionTrailGroup';

      const maxPoints = this.options.maxTrailPoints;
      const positions = new Float32Array(maxPoints * 3);
      const colors = new Float32Array(maxPoints * 3);

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      const material = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        linewidth: 2,
      });

      this.trailLine = new THREE.Line(geometry, material);
      this.trailLine.frustumCulled = false;
      this.trailGroup.add(this.trailLine);
      this.scene.add(this.trailGroup);
    }

    /**
     * Map Klipper coordinates (X: 0..300, Y: 0..300, Z: 0..300) to Three.js Scene coordinates
     */
    _klipperToSceneCoords(px, py, pz) {
      // In Three.js:
      // X = px - 150 (centered)
      // Y = pz (height above bed)
      // Z = py - 150 (depth, Y=0 is front, Y=300 is rear)
      return {
        x: px - BED_SIZE_X / 2,
        y: Math.max(0, pz),
        z: py - BED_SIZE_Y / 2,
      };
    }

    /**
     * Apply position from current interpolated values
     */
    _applyToolheadTransform() {
      const scenePos = this._klipperToSceneCoords(
        this.toolCurrent.x,
        this.toolCurrent.y,
        this.toolCurrent.z
      );
      if (this.toolheadGroup) {
        this.toolheadGroup.position.set(scenePos.x, scenePos.y, scenePos.z);
      }
    }

    /**
     * Public Method: updateToolPosition(x, y, z, immediate)
     * Smoothly updates nozzle position in 3D space with interpolation.
     * @param {number} x - Klipper X (0..300 mm)
     * @param {number} y - Klipper Y (0..300 mm)
     * @param {number} z - Klipper Z (0..300 mm)
     * @param {boolean} [immediate=false] - If true, jumps without lerp
     */
    updateToolPosition(x, y, z, immediate = false) {
      if (typeof x === 'number' && !isNaN(x)) this.toolTarget.x = Math.max(0, Math.min(BED_SIZE_X, x));
      if (typeof y === 'number' && !isNaN(y)) this.toolTarget.y = Math.max(0, Math.min(BED_SIZE_Y, y));
      if (typeof z === 'number' && !isNaN(z)) this.toolTarget.z = Math.max(0, Math.min(BUILD_HEIGHT_Z, z));

      if (immediate) {
        this.toolCurrent.x = this.toolTarget.x;
        this.toolCurrent.y = this.toolTarget.y;
        this.toolCurrent.z = this.toolTarget.z;
        this._applyToolheadTransform();
      }

      this._requestWakeup();
    }

    /**
     * Public Method: setNozzleTemperature(current, target)
     * Adjusts the heater block emissive color & glow intensity.
     */
    setNozzleTemperature(current, target = 0) {
      this.nozzleTemp.current = current;
      this.nozzleTemp.target = target;

      if (!this.heaterBlockMaterial) return;

      const THREE = this.THREE;
      if (current < 45) {
        // Cold / Ambient
        this.heaterBlockMaterial.emissive.setHex(0x000000);
        this.heaterBlockMaterial.emissiveIntensity = 0.0;
        if (this.nozzleSpotlight) this.nozzleSpotlight.color.setHex(0xffffff);
      } else {
        // Heating gradient: 50C -> amber, 180C -> bright orange, 240C+ -> hot red/white
        const ratio = Math.min(1.0, Math.max(0.0, (current - 45) / 210));
        const heatColor = new THREE.Color().lerpColors(
          new THREE.Color(0xf59e0b), // amber
          new THREE.Color(0xef4444), // fiery red
          ratio
        );
        this.heaterBlockMaterial.emissive.copy(heatColor);
        this.heaterBlockMaterial.emissiveIntensity = 0.4 + ratio * 0.9;

        if (this.nozzleSpotlight) {
          this.nozzleSpotlight.color.copy(heatColor);
        }
      }
      this._requestWakeup();
    }

    /**
     * Public Method: setBedTemperature(current, target)
     */
    setBedTemperature(current, target = 0) {
      this.bedTemp.current = current;
      this.bedTemp.target = target;
      this._requestWakeup();
    }

    /**
     * Public Method: loadModelPreview(meshDataOrUrl, options)
     * Supports:
     * - 'cube', 'cylinder', 'benchy' presets
     * - ArrayBuffer / Binary STL or ASCII STL string
     * - Voxel coordinate array [{x, y, z}, ...] or [[x,y,z], ...]
     */
    async loadModelPreview(meshDataOrUrl, options = {}) {
      this.clearModelPreview();
      const THREE = this.THREE;

      const opts = Object.assign({
        color: 0x10b981, // Emerald PETG
        metalness: 0.2,
        roughness: 0.35,
        clearcoat: 0.5,
        scale: 1.0,
      }, options);

      const mat = new THREE.MeshPhysicalMaterial({
        color: opts.color,
        metalness: opts.metalness,
        roughness: opts.roughness,
        clearcoat: opts.clearcoat,
        clearcoatRoughness: 0.2,
      });

      // 1. String Preset Handling
      if (typeof meshDataOrUrl === 'string') {
        const lower = meshDataOrUrl.toLowerCase().trim();
        if (lower === 'cube' || lower === 'calibration_cube') {
          this._loadCalibrationCube(mat);
          return;
        } else if (lower === 'benchy' || lower === 'boat') {
          this._loadBenchySilhouette(mat);
          return;
        } else if (lower === 'cylinder') {
          this._loadCylinder(mat);
          return;
        } else if (lower.startsWith('http://') || lower.startsWith('https://') || lower.endsWith('.stl')) {
          // Fetch remote STL
          try {
            const resp = await fetch(meshDataOrUrl);
            const buffer = await resp.arrayBuffer();
            this._parseSTLAndMount(buffer, mat);
          } catch (err) {
            console.warn('[Ender3DViewer] Failed to fetch STL:', err);
            this._loadCalibrationCube(mat);
          }
          return;
        }
      }

      // 2. Binary / ArrayBuffer STL Handling
      if (meshDataOrUrl instanceof ArrayBuffer) {
        this._parseSTLAndMount(meshDataOrUrl, mat);
        return;
      }

      // 3. Voxel Grid Array Handling
      if (Array.isArray(meshDataOrUrl)) {
        this._loadVoxelArray(meshDataOrUrl, opts);
        return;
      }

      // Default fallback
      this._loadCalibrationCube(mat);
    }

    /**
     * High-speed Binary & ASCII STL Parser (Zero external dependency)
     */
    _parseSTLAndMount(buffer, material) {
      const THREE = this.THREE;
      try {
        const isBinary = (function (buf) {
          const reader = new DataView(buf);
          const faceCount = reader.getUint32(80, true);
          return 84 + faceCount * 50 === buf.byteLength;
        })(buffer);

        let geometry;
        if (isBinary) {
          geometry = this._parseBinarySTL(buffer);
        } else {
          const text = new TextDecoder().decode(buffer);
          geometry = this._parseAsciiSTL(text);
        }

        if (geometry) {
          geometry.computeVertexNormals();
          geometry.center();

          // Rest bottom of model exactly on the bed (Y = 0)
          geometry.computeBoundingBox();
          const bbox = geometry.boundingBox;
          const minY = bbox.min.y;

          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.set(0, -minY, 0);
          mesh.castShadow = true;
          mesh.receiveShadow = true;

          this.modelPreviewGroup.add(mesh);
          this._requestWakeup();
        }
      } catch (err) {
        console.error('[Ender3DViewer] Error parsing STL:', err);
      }
    }

    _parseBinarySTL(buffer) {
      const THREE = this.THREE;
      const reader = new DataView(buffer);
      const faces = reader.getUint32(80, true);
      const dataOffset = 84;
      const faceLength = 12 * 4 + 2;

      const vertices = new Float32Array(faces * 3 * 3);
      let vIndex = 0;

      for (let face = 0; face < faces; face++) {
        const offset = dataOffset + face * faceLength;
        // Vertices at offset + 12
        for (let v = 1; v <= 3; v++) {
          const vOffset = offset + v * 12;
          vertices[vIndex++] = reader.getFloat32(vOffset, true);
          vertices[vIndex++] = reader.getFloat32(vOffset + 4, true);
          vertices[vIndex++] = reader.getFloat32(vOffset + 8, true);
        }
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
      return geometry;
    }

    _parseAsciiSTL(text) {
      const THREE = this.THREE;
      const vertexPattern = /vertex\s+([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s+([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s+([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
      const vertices = [];
      let match;
      while ((match = vertexPattern.exec(text)) !== null) {
        vertices.push(parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3]));
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
      return geometry;
    }

    /**
     * Voxel Array InstancedMesh Generator (10k+ cubes at 60fps)
     */
    _loadVoxelArray(voxels, opts) {
      const THREE = this.THREE;
      const voxelSize = opts.voxelSize || 4;
      const cubeGeo = new THREE.BoxGeometry(voxelSize, voxelSize, voxelSize);
      const cubeMat = new THREE.MeshStandardMaterial({
        color: opts.color || 0x10b981,
        roughness: 0.4,
      });

      const instancedMesh = new THREE.InstancedMesh(cubeGeo, cubeMat, voxels.length);
      const dummy = new THREE.Object3D();

      voxels.forEach((v, idx) => {
        const x = (Array.isArray(v) ? v[0] : v.x) || 0;
        const y = (Array.isArray(v) ? v[1] : v.y) || 0;
        const z = (Array.isArray(v) ? v[2] : v.z) || 0;
        dummy.position.set(x, Math.max(voxelSize / 2, y), z);
        dummy.updateMatrix();
        instancedMesh.setMatrixAt(idx, dummy.matrix);
      });

      instancedMesh.instanceMatrix.needsUpdate = true;
      instancedMesh.castShadow = true;
      this.modelPreviewGroup.add(instancedMesh);
      this._requestWakeup();
    }

    /**
     * Procedural Preset: Calibration Cube 20x20x20mm
     */
    _loadCalibrationCube(material) {
      const THREE = this.THREE;
      const size = 28;
      const geo = new THREE.BoxGeometry(size, size, size);
      const mesh = new THREE.Mesh(geo, material);
      mesh.position.set(0, size / 2, 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.modelPreviewGroup.add(mesh);
      this._requestWakeup();
    }

    /**
     * Procedural Preset: Stylized Benchy Silhouette
     */
    _loadBenchySilhouette(material) {
      const THREE = this.THREE;
      const group = new THREE.Group();

      // Hull
      const hullGeo = new THREE.CylinderGeometry(14, 22, 28, 6);
      const hull = new THREE.Mesh(hullGeo, material);
      hull.rotation.y = Math.PI / 6;
      hull.position.set(0, 14, 0);
      group.add(hull);

      // Cabin
      const cabinGeo = new THREE.BoxGeometry(18, 20, 16);
      const cabin = new THREE.Mesh(cabinGeo, material);
      cabin.position.set(0, 26, -2);
      group.add(cabin);

      // Chimney
      const chimGeo = new THREE.CylinderGeometry(3.5, 4, 14, 16);
      const chim = new THREE.Mesh(chimGeo, material);
      chim.position.set(0, 38, -2);
      group.add(chim);

      group.castShadow = true;
      this.modelPreviewGroup.add(group);
      this._requestWakeup();
    }

    /**
     * Procedural Preset: Cylinder
     */
    _loadCylinder(material) {
      const THREE = this.THREE;
      const geo = new THREE.CylinderGeometry(16, 16, 35, 32);
      const mesh = new THREE.Mesh(geo, material);
      mesh.position.set(0, 17.5, 0);
      mesh.castShadow = true;
      this.modelPreviewGroup.add(mesh);
      this._requestWakeup();
    }

    /**
     * Clear active model preview
     */
    clearModelPreview() {
      if (!this.modelPreviewGroup) return;
      while (this.modelPreviewGroup.children.length > 0) {
        const obj = this.modelPreviewGroup.children[0];
        this.modelPreviewGroup.remove(obj);
        if (obj.geometry && typeof obj.geometry.dispose === 'function') obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => m && typeof m.dispose === 'function' && m.dispose());
          } else if (typeof obj.material.dispose === 'function') {
            obj.material.dispose();
          }
        }
      }
      this._requestWakeup();
    }

    /**
     * Camera View Presets
     */
    setCameraPreset(name) {
      if (this.controls && this.controls.setPreset) {
        this.controls.setPreset(name);
      } else if (this.camera) {
        switch (name) {
          case 'isometric':
            this.camera.position.set(220, 260, 320);
            this.camera.lookAt(0, 50, 0);
            break;
          case 'top':
            this.camera.position.set(0, 480, 0);
            this.camera.lookAt(0, 0, 0);
            break;
          case 'front':
            this.camera.position.set(0, 150, 450);
            this.camera.lookAt(0, 50, 0);
            break;
          case 'side':
            this.camera.position.set(450, 150, 0);
            this.camera.lookAt(0, 50, 0);
            break;
        }
      }
      this._requestWakeup();
    }

    /**
     * Toggle visibility of cage wireframe
     */
    toggleBuildVolume(visible) {
      if (this.cageGroup) {
        this.cageGroup.visible = visible !== undefined ? visible : !this.cageGroup.visible;
        this._requestWakeup();
      }
    }

    /**
     * Reset toolhead to Home position (0, 0, 0)
     */
    homeToolhead() {
      this.updateToolPosition(0, 0, 0);
    }

    /**
     * Smart Low-Power Wakeup Trigger
     */
    _requestWakeup() {
      this.isLowPowerIdle = false;
      this.idleFramesCount = 0;
    }

    /**
     * Handle visibility change (document or container tab switched)
     */
    _onVisibilityChange() {
      if (document.hidden) {
        this.isPaused = true;
      } else {
        this.isPaused = false;
        this._requestWakeup();
      }
    }

    /**
     * Resize event handler with Retina sharpness
     */
    _onResize() {
      if (!this.container || !this.renderer || !this.camera) return;
      const width = this.container.clientWidth;
      const height = this.container.clientHeight;
      if (width === 0 || height === 0) return;

      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();

      this.renderer.setSize(width, height);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this._requestWakeup();
    }

    /**
     * Main 60fps RequestAnimationFrame Loop with Low-Power Idle Throttle
     */
    _animate() {
      if (this.isDestroyed) return;
      requestAnimationFrame(this._animate);

      if (this.isPaused) return;

      // Check if container is actually visible in DOM (e.g. Tab 2 active)
      if (this.container.offsetParent === null) {
        // Tab is hidden, skip rendering to save battery
        return;
      }

      const dt = Math.min(this.clock.getDelta(), 0.1);

      // 1. Interpolate Toolhead Position (Smooth lerp)
      const lerpSpeed = 12.0 * dt;
      const dx = this.toolTarget.x - this.toolCurrent.x;
      const dy = this.toolTarget.y - this.toolCurrent.y;
      const dz = this.toolTarget.z - this.toolCurrent.z;
      const toolDist = Math.hypot(dx, dy, dz);

      let isMoving = false;
      if (toolDist > 0.05) {
        this.toolCurrent.x += dx * Math.min(1.0, lerpSpeed);
        this.toolCurrent.y += dy * Math.min(1.0, lerpSpeed);
        this.toolCurrent.z += dz * Math.min(1.0, lerpSpeed);
        this._applyToolheadTransform();
        this._updateTrailPoint();
        isMoving = true;
        this._requestWakeup();
      }

      // 2. Update OrbitControls
      let controlsChanged = false;
      if (this.controls) {
        controlsChanged = this.controls.update(dt) || (this.controls.isInteracting);
      }

      // 3. Low-Power Idle Logic (Reduces GPU load on mobile phones when static)
      if (this.options.lowPowerMode && !isMoving && !controlsChanged) {
        this.idleFramesCount++;
        if (this.idleFramesCount > 90) {
          this.isLowPowerIdle = true;
          return; // Skip render call when completely static
        }
      } else {
        this.idleFramesCount = 0;
      }

      // 4. Render Frame
      this.renderer.render(this.scene, this.camera);
    }

    /**
     * Record toolhead position into extrusion trail buffer
     */
    _updateTrailPoint() {
      if (!this.trailLine) return;
      const scenePos = this._klipperToSceneCoords(
        this.toolCurrent.x,
        this.toolCurrent.y,
        this.toolCurrent.z
      );

      this.trailPositions.push({ x: scenePos.x, y: scenePos.y, z: scenePos.z });
      if (this.trailPositions.length > this.options.maxTrailPoints) {
        this.trailPositions.shift();
      }

      const posAttr = this.trailLine.geometry.attributes.position;
      const colAttr = this.trailLine.geometry.attributes.color;
      const len = this.trailPositions.length;

      for (let i = 0; i < len; i++) {
        const pt = this.trailPositions[i];
        posAttr.setXYZ(i, pt.x, pt.y, pt.z);
        // Alpha gradient (fades to transparent at older points)
        const alpha = i / len;
        colAttr.setXYZ(i, 0.06 * alpha, 0.73 * alpha, 0.51 * alpha); // Emerald glow
      }
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      this.trailLine.geometry.setDrawRange(0, len);
    }

    /**
     * Public Method: pause()
     */
    pause() {
      this.isPaused = true;
    }

    /**
     * Public Method: resume()
     */
    resume() {
      this.isPaused = false;
      this._requestWakeup();
    }

    /**
     * Public Method: setTheme(theme)
     * Dynamically shifts background color between Obsidian Dark and Pearl Light
     */
    setTheme(theme) {
      if (!this.scene) return;
      const isLight = (theme === 'light');
      const bgHex = isLight ? 0xE2E8F0 : (this.options.backgroundColor || 0x06090e);
      this.scene.background = new THREE.Color(bgHex);
      if (this.scene.fog) {
        this.scene.fog.color = new THREE.Color(bgHex);
      }
      if (this.renderer) {
        this.renderer.setClearColor(bgHex, 1);
      }
      this._requestWakeup();
    }

    /**
     * Public Method: destroy()
     * Completely disposes Three.js memory, buffers, materials & event listeners.
     */
    destroy() {
      this.isDestroyed = true;
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('resize', this._onResize);
      }
      if (typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
      }

      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
      }

      if (this.controls && this.controls.dispose) {
        this.controls.dispose();
      }

      if (this.renderer) {
        this.renderer.dispose();
        if (this.renderer.domElement && this.renderer.domElement.parentNode) {
          this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
        }
      }

      // Traverse scene and dispose geometries and textures
      if (this.scene) {
        this.scene.traverse((obj) => {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            if (Array.isArray(obj.material)) {
              obj.material.forEach((m) => m.dispose());
            } else {
              obj.material.dispose();
            }
          }
        });
      }
    }
  }

  return Ender3DViewer;
}));
