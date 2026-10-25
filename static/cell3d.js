// cell3d.js — the animated myocyte, in WebGL.
//
// A cross-section-through-the-round of a human ventricular cardiomyocyte.
// Every channel of this animation is bound to a real simulated signal:
//
//   membrane colour      <- membrane.V
//   cell shortening      <- calcium.Ca_i
//   channel pore opening <- |I| for that channel
//   ion particle streams <- |I|, direction by ion species
//   hERG open glyphs     <- ikr.O
//   drug-plugged glyphs  <- ikr.Obound + ikr.IObound + ikr.Cbound
//   ghost cell behind    <- the drug-free control run, in sync
//
// Surface anatomy and lighting are illustrative; motion and channel activity
// remain bound to the precomputed simulation.

import * as THREE from './vendor/three.module.min.js';
import { CHANNELS, I_SCALE, membraneRGB, shortening, hergGlyphStates,
         clamp01 } from './signals.js';
import { Heart } from './heart3d.js';

// Two scales in one scene, so the descent from organ to cell is a single
// continuous camera move rather than a cut between two views.
// The organ view sits further back with the heart scaled up, so the descent
// is a real dolly-in rather than a camera that retreats while the model grows.
export const HEART_CAM_Z = 13.5, CELL_CAM_Z = 9.5;
const HEART_BASE = 1.92, HEART_FLYTHROUGH = HEART_BASE * 4;

const CELL_LEN = 5.2, CELL_R = 0.94, GHOST_SCALE = 0.72;
const CELL_HALF = CELL_LEN / 2 + CELL_R;

// A continuous capsule profile with a curved centreline. All visible surface
// details and channel anchors sample this function, including the rounded caps.
function cellSurface(x, theta, radial = 1) {
  const cap = Math.max(0, (Math.abs(x) - CELL_LEN / 2) / CELL_R);
  const r = CELL_R * (0.91 + 0.09 * Math.cos(x * 1.15))
    * Math.sqrt(Math.max(0, 1 - cap * cap)) * radial;
  const bow = -0.28 * Math.cos(x * 0.85) + 0.11 * x;
  const ripple = 1 + 0.012 * Math.sin(x * 22 + 2 * Math.sin(theta * 3));
  return new THREE.Vector3(x, bow + r * Math.cos(theta) * ripple,
    r * Math.sin(theta) * 0.86 * ripple);
}

function surfaceNormal(x, theta) {
  const along = cellSurface(x + 0.001, theta).sub(cellSurface(x - 0.001, theta));
  const around = cellSurface(x, theta + 0.001).sub(cellSurface(x, theta - 0.001));
  return around.cross(along).normalize();
}
const N_HERG = 10;
const GLYPH_COUNT = { INa: 4, INaL: 3, ICaL: 4, Ito: 3, IKr: N_HERG, IKs: 3, IK1: 3 };
const MAX_PARTICLES = 400;

const ION_COLOUR = {
  Na: new THREE.Color(0xffc048),
  Ca: new THREE.Color(0x5fd38d),
  K:  new THREE.Color(0x6ec3f0),
};

export class CellView {
  constructor(canvas, { onHover, onModeChange } = {}) {
    this.canvas = canvas;
    this.onHover = onHover;
    this.onModeChange = onModeChange;
    this.glyphs = [];
    this.hergGlyphs = [];
    this.mode = 'heart';            // 'heart' | 'cell', plus 'flying' between
    this.cellFade = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    this.camera.position.set(0, 0.45, HEART_CAM_Z);
    this.cameraTarget = new THREE.Vector3(0, 0.20, 0);
    this.camera.lookAt(this.cameraTarget);
    this.flight = { progress: 0 };

    // A soft warm key and cool rim reveal the surface without overwhelming
    // the voltage colours with tinted illumination.
    this.scene.add(new THREE.HemisphereLight(0xf5faff, 0xc6b4bd, 1.25));
    const key = new THREE.DirectionalLight(0xfff4ed, 2.5);
    key.position.set(-3, 5, 7);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xabcfff, 1.8);
    rim.position.set(4, 2, -4);
    this.scene.add(rim);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    // Everything at cell scale lives under cellRoot so the descent can fade
    // and bloom it as one object.
    this.cellRoot = new THREE.Group();
    this.cellRoot.visible = false;
    this.root.add(this.cellRoot);
    this.cellRoot.rotation.set(0.05, -0.14, 0.24);

    this.heart = new Heart();
    this.heart.group.scale.setScalar(HEART_BASE);
    this.root.add(this.heart.group);

    this._buildGhost();
    this._buildCell();
    this._buildGlyphs();
    this._buildParticles();
    this._bindPointer();

    this._captureCellMaterials();
    this._applyFade();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  _captureCellMaterials() {
    // Capture opacity before any transition, once per shared material.
    this.cellMats = new Map();
    this.cellRoot.traverse(o => {
      if (!o.material || o === this.membrane || o === this.core || o === this.ghost) return;
      this.cellMats.set(o.material, o.material.opacity);
      o.material.transparent = true;
    });
  }

  // ---- geometry -----------------------------------------------------------

  _rod(radius, length, segments = 64) {
    const points = [], indices = [], uv = [], rows = 112;
    for (let i = 0; i <= rows; i++) {
      // Cosine spacing resolves the cap normals without a shoulder or seam.
      const x = -CELL_HALF * Math.cos(i / rows * Math.PI);
      for (let j = 0; j <= segments; j++) {
        const p = cellSurface(x, j / segments * Math.PI * 2, radius / CELL_R);
        points.push(p.x * length / CELL_LEN, p.y, p.z);
        uv.push(i / rows, j / segments);
        if (i < rows && j < segments) {
          const k = i * (segments + 1) + j;
          indices.push(k, k + 1, k + segments + 1,
            k + 1, k + segments + 2, k + segments + 1);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  _buildGhost() {
    // The drug-free beat, running in sync behind the dosed cell. As the dose
    // climbs the dosed cell stays lit long after the ghost has gone dark.
    this.ghost = new THREE.Mesh(
      this._rod(CELL_R, CELL_LEN, 32),
      new THREE.MeshStandardMaterial({
        color: 0x2a2f52, emissive: 0x2a2f52, emissiveIntensity: 0.5,
        transparent: true, opacity: 0.25,
        roughness: 0.8, metalness: 0.0, depthWrite: false }));
    // Offset up and back so a clear band of it stays visible past the dosed
    // cell: the point is to compare how long each one stays lit.
    this.ghost.position.set(0, 1.28, -2.05);
    this.ghost.scale.setScalar(GHOST_SCALE);
    this.cellRoot.add(this.ghost);
  }

  _buildCell() {
    this.cell = new THREE.Group();
    this.cellRoot.add(this.cell);
    this.membraneMat = new THREE.MeshPhysicalMaterial({
      color: 0xf36d7e, emissive: 0xc82d48, emissiveIntensity: 0.15,
      roughness: 0.32, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.25,
      transparent: true, opacity: 0.48, side: THREE.FrontSide, depthWrite: false,
    });
    this.membrane = new THREE.Mesh(this._rod(CELL_R, CELL_LEN), this.membraneMat);
    this.membrane.renderOrder = 2;
    this.cell.add(this.membrane);
    this.coreMat = new THREE.MeshStandardMaterial({
      color: 0xf46378, roughness: 0.58, emissive: 0xb92f42,
      emissiveIntensity: 0.10, transparent: true, opacity: 0.92, depthWrite: false,
    });
    this.core = new THREE.Mesh(this._rod(CELL_R * 0.86, CELL_LEN), this.coreMat);
    this.cell.add(this.core);

    // A single line buffer for the membrane lattice: continuous curved
    // meridians and transverse striations, not separate floating torus rings.
    const lattice = [], fibres = [];
    const line = (buffer, points) => {
      for (let i = 1; i < points.length; i++) {
        buffer.push(...points[i - 1].toArray(), ...points[i].toArray());
      }
    };
    for (let i = 1; i < 54; i++) {
      const x = -CELL_HALF + i / 54 * CELL_HALF * 2, points = [];
      for (let j = 0; j <= 64; j++) {
        const theta = j / 64 * Math.PI * 2;
        points.push(cellSurface(x + 0.018 * Math.sin(theta * 5 + i), theta, 1.012));
      }
      line(lattice, points);
    }
    for (let j = 0; j < 32; j++) {
      const points = [], inside = [];
      for (let i = 1; i < 112; i++) {
        const x = -CELL_HALF * Math.cos(i / 112 * Math.PI);
        const theta = j / 32 * Math.PI * 2 + 0.025 * Math.sin(x * 3 + j);
        points.push(cellSurface(x, theta, 1.012));
        inside.push(cellSurface(x * 0.96, theta, 0.80));
      }
      line(lattice, points);
      line(fibres, inside);
    }
    const addLines = (positions, colour, opacity) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
        color: colour, transparent: true, opacity, depthWrite: false,
      }));
      mesh.renderOrder = 3;
      this.cell.add(mesh);
      return mesh;
    };
    this.striations = addLines(lattice, 0xfff1ff, 0.34);
    addLines(fibres, 0xffc7cf, 0.38);

    const nucGeo = new THREE.SphereGeometry(0.19, 24, 18);
    nucGeo.scale(1.9, 1, 0.82);
    const nucMat = new THREE.MeshStandardMaterial({
      color: 0x91446d, roughness: 0.65, transparent: true, opacity: 0.55,
      depthWrite: false,
    });
    for (const x of [-0.9, 0.9]) {
      const n = new THREE.Mesh(nucGeo, nucMat);
      n.position.copy(cellSurface(x, 0, 0));
      this.cell.add(n);
    }
  }

  _buildGlyphs() {
    // Ion channels embedded in the sarcolemma. Each glyph is a barrel with a
    // pore that opens with |current|; the hERG ones can additionally be
    // plugged by a drug molecule.
    const barrel = new THREE.CylinderGeometry(0.075, 0.09, 0.13, 14);
    const poreGeo = new THREE.CylinderGeometry(0.043, 0.043, 0.15, 12);
    const drugGeo = new THREE.CylinderGeometry(0.052, 0.052, 0.1, 8);

    let seq = 0;
    const total = Object.values(GLYPH_COUNT).reduce((a, b) => a + b, 0);

    for (const [name, count] of Object.entries(GLYPH_COUNT)) {
      const spec = CHANNELS[name];
      for (let i = 0; i < count; i++) {
        // Distribute around the rod on a golden-angle spiral so no two
        // channel types end up stacked on the same meridian.
        const f = (seq + 0.5) / total;
        const x = (f - 0.5) * CELL_LEN * 0.88;
        const theta = seq * 2.399963;
        seq++;

        const g = new THREE.Group();
        const dir = surfaceNormal(x, theta);
        g.position.copy(cellSurface(x, theta, 1.015));
        g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);

        const mat = new THREE.MeshStandardMaterial({
          color: spec.colour, emissive: spec.colour, emissiveIntensity: 0.15,
          roughness: 0.5 });
        const body = new THREE.Mesh(barrel, mat);
        g.add(body);

        const poreMat = new THREE.MeshStandardMaterial({
          color: 0x05060f, emissive: spec.colour, emissiveIntensity: 0.0,
          roughness: 0.3 });
        const pore = new THREE.Mesh(poreGeo, poreMat);
        g.add(pore);

        const drug = new THREE.Mesh(drugGeo, new THREE.MeshStandardMaterial({
          color: 0xc8ccd8, emissive: 0x7a7f90, emissiveIntensity: 0.25,
          roughness: 0.35, metalness: 0.3 }));
        drug.position.y = 0.06;
        drug.visible = false;
        g.add(drug);

        this.cell.add(g);
        const rec = { name, spec, group: g, body, pore, poreMat, mat, drug,
                      dir, origin: g.position.clone(), open: 0 };
        this.glyphs.push(rec);
        if (name === 'IKr') this.hergGlyphs.push(rec);
        body.userData.glyph = rec;
      }
    }
    this.pickTargets = this.glyphs.map(g => g.body);
  }

  _buildParticles() {
    // Fixed pool, recycled. Allocating per frame is what turns a smooth
    // animation into a stuttering one on a laptop at a judging table.
    const geo = new THREE.SphereGeometry(0.052, 6, 5);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95 });
    this.particles = new THREE.InstancedMesh(geo, mat, MAX_PARTICLES);
    this.particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.particles.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_PARTICLES * 3), 3);
    this.particles.instanceColor.setUsage(THREE.DynamicDrawUsage);
    // Keep the pool in cell-local space: contraction, twist and rotation then
    // transform both channel anchors and emitted streams together.
    this.cell.add(this.particles);
    this.particles.frustumCulled = false;

    this.pool = Array.from({ length: MAX_PARTICLES }, () => ({
      life: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      colour: new THREE.Color(),
    }));
    this.next = 0;
    this._m = new THREE.Matrix4();
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  }

  _emit(glyph, speed) {
    const p = this.pool[this.next];
    this.next = (this.next + 1) % MAX_PARTICLES;
    const d = glyph.spec.dir;          // -1 inward, +1 outward
    const jitter = 0.16;
    p.pos.copy(glyph.origin).addScaledVector(glyph.dir, d > 0 ? 0.12 : 0.0);
    p.pos.x += (Math.random() - 0.5) * jitter;
    p.vel.copy(glyph.dir).multiplyScalar(d * speed);
    p.vel.x += (Math.random() - 0.5) * 0.25;
    p.vel.y += (Math.random() - 0.5) * 0.12;
    p.colour.copy(ION_COLOUR[glyph.spec.ion]);
    p.life = 1;
  }

  // ---- interaction --------------------------------------------------------

  _bindPointer() {
    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.drag = null;
    this.yaw = 0;
    this.pitch = 0;

    const updateNdc = e => {
      const r = this.canvas.getBoundingClientRect();
      this.ndc.set((e.clientX - r.left) / r.width * 2 - 1,
        -(e.clientY - r.top) / r.height * 2 + 1);
    };
    this.canvas.addEventListener('pointerdown', e => {
      updateNdc(e);
      this.drag = { x: e.clientX, y: e.clientY, yaw: this.yaw,
                    pitch: this.pitch, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointerup', e => {
      updateNdc(e);
      // A click that did not drag, on the heart, descends into the cell.
      if (this.drag && !this.drag.moved && this.mode === 'heart'
          && this._hitHeart()) {
        this.enterCell();
      }
      this.drag = null;
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', e => {
      const r = this.canvas.getBoundingClientRect();
      this.ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      if (this.drag) {
        if (Math.abs(e.clientX - this.drag.x) > 3 ||
            Math.abs(e.clientY - this.drag.y) > 3) this.drag.moved = true;
        this.yaw = this.drag.yaw + (e.clientX - this.drag.x) * 0.006;
        this.pitch = Math.max(-0.7, Math.min(0.7,
          this.drag.pitch + (e.clientY - this.drag.y) * 0.005));
        return;
      }
      this._pick(e.clientX - r.left, e.clientY - r.top);
    });
    this.canvas.addEventListener('pointerleave', () => this.onHover?.(null));
    this.canvas.addEventListener('pointercancel', () => { this.drag = null; });
  }

  _hitHeart() {
    this.ray.setFromCamera(this.ndc, this.camera);
    return this.ray.intersectObjects(this.heart.pickTargets, false).length > 0;
  }

  _pick(px, py) {
    if (this.mode === 'heart') {
      this.canvas.style.cursor = this._hitHeart() ? 'zoom-in' : 'grab';
      this.onHover?.(null);
      return;
    }
    this.canvas.style.cursor = 'grab';
    if (this.mode !== 'cell' || !this.onHover) { this.onHover?.(null); return; }
    this.ray.setFromCamera(this.ndc, this.camera);
    const hit = this.ray.intersectObjects(this.pickTargets, false)[0];
    this.onHover(hit ? { ...hit.object.userData.glyph, px, py } : null);
  }

  // ---- descent from organ to cell -----------------------------------------

  /**
   * One continuous move: the camera pushes in, the heart swells past it and
   * fades as we pass through the ventricular wall, and the myocyte blooms
   * up from nothing. GSAP is doing the sequencing; nothing here touches the
   * simulated numbers.
   */
  enterCell() {
    if (this.mode !== 'heart' || this._tl) return;
    const gsap = window.gsap;
    this.mode = 'flying';
    this.onModeChange?.('flying');
    this.cellRoot.visible = true;
    this.cellRoot.scale.setScalar(0.04);

    if (!gsap || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this._finishEnter();
      return;
    }
    const tl = gsap.timeline({
      defaults: { ease: 'power2.inOut' },
      onComplete: () => { this._tl = null; this._finishEnter(); },
    });
    this._tl = tl;
    tl.to(this.flight, { progress: 1, duration: 1.5 }, 0)
      .to(this.heart.group.scale, { x: HEART_FLYTHROUGH, y: HEART_FLYTHROUGH,
                                    z: HEART_FLYTHROUGH, duration: 1.5 }, 0)
      .to(this, { cellFade: 1, duration: 0.9,
                  onUpdate: () => this._applyFade() }, 0.35)
      .to(this.cellRoot.scale, { x: 1, y: 1, z: 1, duration: 1.1,
                                 ease: 'power2.out' }, 0.35)
      .to(this.heart, { _fade: 0, duration: 0.5,
                        onUpdate: () => this.heart.setFade(this.heart._fade) }, 0.12);
  }

  exitToHeart() {
    if (this.mode !== 'cell' || this._tl) return;
    const gsap = window.gsap;
    this.mode = 'flying';
    this.onModeChange?.('flying');
    this.heart.group.visible = true;

    if (!gsap || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this._finishExit();
      return;
    }
    const tl = gsap.timeline({
      defaults: { ease: 'power2.inOut' },
      onComplete: () => { this._tl = null; this._finishExit(); },
    });
    this._tl = tl;
    tl.to(this.flight, { progress: 0, duration: 1.3 }, 0)
      .to(this.heart.group.scale, { x: HEART_BASE, y: HEART_BASE, z: HEART_BASE,
                                    duration: 1.3 }, 0)
      .to(this.heart, { _fade: 1, duration: 0.75,
                        onUpdate: () => this.heart.setFade(this.heart._fade) }, 0.5)
      .to(this, { cellFade: 0, duration: 0.7,
                  onUpdate: () => this._applyFade() }, 0.1)
      .to(this.cellRoot.scale, { x: 0.04, y: 0.04, z: 0.04, duration: 0.9 }, 0);
  }

  _applyFade() {
    const f = this.cellFade;
    this.cellRoot.visible = f > 0.001;
    for (const [mat, opacity] of this.cellMats) {
      mat.opacity = opacity * f;
      mat.depthWrite = f > 0.98 && mat !== this.particles.material;
      // Lines and interior details should never obscure the membrane.
      if (mat.isLineBasicMaterial || mat === this.coreMat) mat.depthWrite = false;
    }
  }

  _aimCamera() {
    const p = this.flight.progress;
    // At narrow aspect ratios the horizontal cell span determines distance.
    // Reserve the lower part of the panel for captions and interaction hints.
    const aspect = Math.max(this.camera.aspect, 0.1);
    const heartZ = Math.max(HEART_CAM_Z, 9.5 / aspect);
    const cellZ = Math.max(CELL_CAM_Z, 13.0 / aspect);
    this.camera.position.set(0, 0.45 * (1 - p),
      THREE.MathUtils.lerp(heartZ, cellZ, p));
    this.cameraTarget.set(0, THREE.MathUtils.lerp(0.25, -0.12, p), 0);
    this.camera.lookAt(this.cameraTarget);
  }

  _finishEnter() {
    this.mode = 'cell';
    this.cellFade = 1;
    this.cellRoot.scale.setScalar(1);
    this.cellRoot.visible = true;
    this.flight.progress = 1;
    this._aimCamera();
    this._applyFade();
    this.heart.setFade(0);
    this.heart.group.scale.setScalar(HEART_FLYTHROUGH);
    this.onModeChange?.('cell');
  }

  _finishExit() {
    this.mode = 'heart';
    this.cellFade = 0;
    this.cellRoot.visible = false;
    this.flight.progress = 0;
    this._aimCamera();
    this._applyFade();
    this.heart.setFade(1);
    this.heart.group.scale.setScalar(HEART_BASE);
    this.onModeChange?.('heart');
  }

  resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._aimCamera();
  }

  // ---- per-frame ----------------------------------------------------------

  /**
   * @param frame     interpolated dosed frame {V, Ca_i, hERG_open, hERG_bound, I...}
   * @param ghost     the matching control frame, or null to hide the ghost
   * @param dt        seconds since last render, for particle integration
   * @param emitting  false while paused — the cell holds its pose
   */
  update(frame, ghost, dt, emitting = true, phase = 0) {
    this._aimCamera();
    // The heart runs off the same frame: same solved beat, organ scale.
    if (this.heart.group.visible) this.heart.update(frame, phase);
    this.root.rotation.y = this.yaw;
    this.root.rotation.x = this.pitch;
    if (this.cellFade < 0.01 && this.mode === 'heart') {
      this.renderer.render(this.scene, this.camera);
      return;
    }

    // Membrane potential -> fill colour and restrained emission. Decode the
    // sRGB ramp before lighting so material and CSS legend colours agree.
    const [r, g, b] = membraneRGB(frame.V);
    this.membraneMat.color.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
    this.membraneMat.emissive.copy(this.membraneMat.color);
    this.coreMat.color.copy(this.membraneMat.color);
    this.coreMat.color.multiplyScalar(0.55);
    this.coreMat.emissive.copy(this.coreMat.color);
    this.coreMat.opacity = 0.92 * this.cellFade;
    this.coreMat.depthWrite = this.cellFade > 0.98;
    this.membraneMat.emissiveIntensity = 0.10 + 0.18 *
      clamp01((frame.V + 88) / 133);
    // Scaled by the descent fade: this opacity is rewritten every frame, so
    // the transition cannot own it.
    this.membraneMat.opacity =
      (0.38 + 0.10 * clamp01((frame.V + 88) / 133)) * this.cellFade;

    // Calcium transient -> contraction. Lags the upstroke, as it should.
    const s = shortening(frame.Ca_i);
    // Longitudinal shortening and radial bulging follow the same calcium
    // transient, with a slight twist that makes the striations readable.
    this.cell.scale.set(1 - s, 1 + s * 0.32, 1 + s * 0.32);
    this.cell.rotation.x = 0.025 * Math.sin(phase * Math.PI * 2);

    if (ghost) {
      const [gr, gg, gb] = membraneRGB(ghost.V);
      this.ghost.material.color.setRGB(gr / 255, gg / 255, gb / 255, THREE.SRGBColorSpace);
      this.ghost.material.emissive.copy(this.ghost.material.color);
      this.ghost.material.emissiveIntensity =
        0.25 + 0.75 * clamp01((ghost.V + 88) / 133);
      this.ghost.material.opacity =
        (0.2 + 0.2 * clamp01((ghost.V + 88) / 133)) * this.cellFade;
      const gs = shortening(ghost.Ca_i);
      this.ghost.scale.set(GHOST_SCALE * (1 - gs), GHOST_SCALE * (1 + gs * 0.32),
                           GHOST_SCALE * (1 + gs * 0.32));
      this.ghost.visible = true;
    } else {
      this.ghost.visible = false;
    }

    // hERG: which glyphs are open, and which are plugged by a drug molecule.
    const states = hergGlyphStates(frame.hERG_open, frame.hERG_bound, N_HERG);
    this.hergGlyphs.forEach((gl, i) => { gl.state = states[i]; });

    for (const gl of this.glyphs) {
      const I = frame[gl.name] ?? 0;
      const drive = clamp01(Math.abs(I) / I_SCALE[gl.name]);
      const blocked = gl.state === 'blocked';
      const open = blocked ? 0 : (gl.state === 'closed' ? 0 : drive);
      gl.open = open;

      gl.pore.scale.set(0.35 + 0.65 * open, 1, 0.35 + 0.65 * open);
      gl.poreMat.emissiveIntensity = blocked ? 0 : 0.1 + 1.3 * open;
      gl.mat.emissiveIntensity = blocked ? 0.04 : 0.12 + 0.5 * open;
      gl.mat.color.setHex(blocked ? 0x55596a : gl.spec.colour);
      if (gl.drug.visible !== blocked) gl.drug.visible = blocked;

      // Emission rate proportional to |current|. Blocked channels emit
      // nothing — that is the whole point of the drug.
      if (emitting && open > 0.02) {
        const rate = open * 42 * dt;
        if (Math.random() < rate) this._emit(gl, 0.9 + 1.8 * open);
      }
    }

    // Integrate and upload the particle pool.
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.pool[i];
      if (p.life <= 0) {
        this.particles.setMatrixAt(i, this._hidden);
        continue;
      }
      if (emitting) {
        p.life -= dt * 1.5;
        p.pos.addScaledVector(p.vel, dt);
      }
      const k = Math.max(0, Math.min(1, p.life));
      this._m.makeScale(k, k, k).setPosition(p.pos);
      this.particles.setMatrixAt(i, this._m);
      this.particles.setColorAt(i, p.colour);
    }
    this.particles.instanceMatrix.needsUpdate = true;
    if (this.particles.instanceColor) this.particles.instanceColor.needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
  }
}
