// Anatomical organ view. Calcium drives contraction; the activation delay is
// illustrative: ORd-CiPA solves one cell, not spatial cardiac conduction.
import * as THREE from './vendor/three.module.min.js';
import { V_MIN, V_MAX, CA_MIN, CA_MAX, clamp01, membraneRGB } from './signals.js';

const APEX_Y = -1.45, BASE_Y = 1.2, VMAP_N = 256, SPREAD = 0.055;

function section(y) {
  const t = clamp01((y - APEX_Y) / (BASE_Y - APEX_Y));
  return { radius: Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2)) * (0.88 + 0.25 * t),
           centre: 0.28 - 0.5 * t };
}

// The coronary tree uses the same surface as the ventricular mesh, so branches
// sit on the myocardium rather than floating in front of it.
function anterior(x, y, lift = 0.025) {
  const { radius, centre } = section(y);
  const z = 0.74 * Math.sqrt(Math.max(0, radius ** 2 - (x - centre) ** 2));
  const angle = Math.acos(THREE.MathUtils.clamp((x - centre) / Math.max(radius, 0.001), -1, 1));
  const u = (y + 1.05) / 1.92, v = (angle / Math.PI - 0.40) / 0.57;
  const rv = u > 0 && u < 1 && v > 0 && v < 1
    ? 0.105 * Math.sin(u * Math.PI) * Math.sin(v * Math.PI) : 0;
  return [x, y, z + rv + lift];
}

function tube(points, radius, segments = 48) {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(
    points.map(p => new THREE.Vector3(...p))), segments, radius, 10, false);
}

function tissueTexture() {
  const w = 256, h = 512, data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / w * Math.PI * 2, v = y / h * Math.PI * 2;
    const fibres = Math.sin(v * 92 + 5 * Math.sin(u * 3 + v * 2));
    const grain = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    const c = 128 + fibres * 36 + (grain - Math.floor(grain) - 0.5) * 22;
    const i = (y * w + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = c;
    data[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, w, h);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export class Heart {
  constructor() {
    // Camera flight and contraction own separate transforms.
    this.group = new THREE.Group();
    this.body = new THREE.Group();
    this.group.add(this.body);
    this._fade = 1;
    this.pickTargets = [];
    this.fadeMats = [];
    this.bump = tissueTexture();
    this._buildActivationMap();
    this._buildMyocardium();
    this._buildVessels();
    this.group.rotation.set(-0.04, -0.12, -0.10);
    this.group.position.y = -0.36;
    this.contraction = 0;
  }

  _buildActivationMap() {
    this.vData = new Uint8Array(VMAP_N * 4);
    this.vMap = new THREE.DataTexture(this.vData, VMAP_N, 1, THREE.RGBAFormat);
    this.vMap.wrapS = THREE.RepeatWrapping;
    this.vMap.minFilter = this.vMap.magFilter = THREE.LinearFilter;
    this.vMap.needsUpdate = true;
    this.uniforms = { uVmap: { value: this.vMap }, uPhase: { value: 0 },
                      uSpread: { value: SPREAD } };
  }

  setWaveform(frames) {
    const v = frames.V, n = v.length;
    for (let i = 0; i < VMAP_N; i++) {
      // Texel centres correspond to phases i/N; RepeatWrapping then joins
      // the last sample back to the first without duplicating an endpoint.
      const x = i / VMAP_N * (n - 1);
      const a = Math.floor(x), b = Math.min(a + 1, n - 1);
      const mv = v[a] + (x - a) * (v[b] - v[a]);
      const [r, g, bl] = membraneRGB(mv);
      this.vData.set([Math.round(clamp01((mv - V_MIN) / (V_MAX - V_MIN)) * 255),
                     Math.round(r), Math.round(g), Math.round(bl)], i * 4);
    }
    this.vMap.needsUpdate = true;
  }

  _tissue(colour, activation = false) {
    const mat = new THREE.MeshPhysicalMaterial({
      color: colour, roughness: 0.38, metalness: 0,
      clearcoat: 0.3, clearcoatRoughness: 0.3,
      bumpMap: this.bump, bumpScale: 0.05, transparent: true,
    });
    if (activation) {
      mat.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, this.uniforms);
        shader.vertexShader = 'varying float vAB;\n' + shader.vertexShader
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            vAB = clamp((position.y + 1.45) / 2.65, 0.0, 1.0);`);
        shader.fragmentShader = 'uniform sampler2D uVmap;\n'
          + 'uniform float uPhase;\nuniform float uSpread;\nvarying float vAB;\n'
          + shader.fragmentShader.replace('#include <dithering_fragment>', `
            #include <dithering_fragment>
            float activation = texture2D(uVmap,
              vec2(fract(uPhase - vAB * uSpread) + 0.5 / 256.0, 0.5)).r;
            // Preserve the tissue shading and coronary detail at every voltage.
            gl_FragColor.rgb = mix(gl_FragColor.rgb,
              vec3(1.0, 0.40, 0.30), activation * 0.22);
          `);
      };
    }
    this.fadeMats.push(mat);
    return mat;
  }

  _add(geo, mat, pick = false) {
    const mesh = new THREE.Mesh(geo, mat);
    this.body.add(mesh);
    if (pick) this.pickTargets.push(mesh);
    return mesh;
  }

  _lobe(position, scale, mat, rotation = 0) {
    const g = new THREE.SphereGeometry(1, 48, 36);
    g.scale(...scale);
    g.rotateZ(rotation);
    g.translate(...position);
    return this._add(g, mat, true);
  }

  _buildMyocardium() {
    this.myoMat = this._tissue(0xd84948, true);
    const g = new THREE.SphereGeometry(1, 96, 72);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const qy = p.getY(i), t = (qy + 1) / 2;
      const width = 0.88 + 0.25 * t;
      const y = APEX_Y + t * (BASE_Y - APEX_Y);
      p.setXYZ(i, p.getX(i) * width + 0.28 - 0.5 * t,
        y, p.getZ(i) * width * 0.74);
    }
    g.computeVertexNormals();
    this.lv = this._add(g, this.myoMat, true);

    // A shallow RV patch wraps the shared ventricular surface. Taper its
    // boundary into the LV instead of superimposing a separate ellipsoid.
    const vertices = [], indices = [], uv = [], rows = 48, cols = 40;
    for (let i = 0; i <= rows; i++) for (let j = 0; j <= cols; j++) {
      const u = i / rows, v = j / cols, y = -1.05 + u * 1.92;
      const { radius, centre } = section(y), angle = (0.40 + v * 0.57) * Math.PI;
      const lift = 0.105 * Math.sin(u * Math.PI) * Math.sin(v * Math.PI) - 0.008;
      vertices.push(centre + (radius + lift) * Math.cos(angle), y,
        (radius * 0.74 + lift) * Math.sin(angle));
      uv.push(v, u);
      if (i < rows && j < cols) {
        const k = i * (cols + 1) + j;
        indices.push(k, k + cols + 1, k + 1, k + 1, k + cols + 1, k + cols + 2);
      }
    }
    const rv = new THREE.BufferGeometry();
    rv.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    rv.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    rv.setIndex(indices);
    rv.computeVertexNormals();
    this.rv = this._add(rv, this._tissue(0xc74b4c, true), true);
    const atrial = this._tissue(0xe26a60);
    this._lobe([-0.83, 0.63, 0.05], [0.48, 0.6, 0.48], atrial, -0.35);
    this._lobe([0.73, 0.82, -0.08], [0.36, 0.43, 0.40], atrial, 0.35);
    // Auricles curl around the roots of the great vessels.
    this._lobe([-0.66, 0.97, 0.44], [0.35, 0.16, 0.29], atrial, 0.45);
    this._lobe([0.64, 0.93, 0.35], [0.28, 0.16, 0.25], atrial, -0.55);
  }

  _vessel(points, radius, mat, open = false) {
    const mesh = this._add(tube(points, radius, 56), mat, true);
    if (open) {
      const end = new THREE.Vector3(...points.at(-1));
      const tangent = end.clone().sub(new THREE.Vector3(...points.at(-2))).normalize();
      const rim = this._add(new THREE.TorusGeometry(radius * 0.91,
        radius * 0.09, 8, 32), mat);
      rim.position.copy(end);
      rim.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);
      // A recessed dark lumen gives a vessel wall rather than a solid pipe.
      const lumen = this._add(new THREE.CircleGeometry(radius * 0.83, 32), this.lumenMat);
      lumen.position.copy(end).addScaledVector(tangent, -0.035);
      lumen.quaternion.copy(rim.quaternion);
    }
    return mesh;
  }

  _buildVessels() {
    const arterial = this._tissue(0xd93540);
    const venous = this._tissue(0x347ed0);
    this.lumenMat = new THREE.MeshStandardMaterial({
      color: 0x451c37, roughness: 0.8, side: THREE.DoubleSide, transparent: true });
    const artery = new THREE.MeshPhysicalMaterial({ color: 0xf07d69,
      roughness: 0.4, clearcoat: 0.25, transparent: true });
    const vein = new THREE.MeshPhysicalMaterial({ color: 0x36518a,
      roughness: 0.38, clearcoat: 0.25, transparent: true });
    this.fadeMats.push(this.lumenMat, artery, vein);

    // Anterior reference: aorta arches behind the pulmonary trunk; the
    // superior vena cava is on the viewer's left.
    this._vessel([[0.0, 0.82, -0.04], [-0.18, 1.43, -0.06],
      [-0.15, 2.00, -0.12], [0.24, 2.18, -0.18],
      [0.59, 1.91, -0.24], [0.60, 1.15, -0.32]], 0.23, arterial);
    this._vessel([[-0.10, 1.9, -0.13], [-0.13, 2.28, -0.12],
      [-0.12, 2.52, -0.12]], 0.145, arterial, true);
    this._vessel([[0.28, 2.09, -0.18], [0.43, 2.36, -0.19],
      [0.51, 2.43, -0.18]], 0.12, arterial, true);
    this._vessel([[0.12, 0.78, 0.40], [0.28, 1.22, 0.45],
      [0.30, 1.58, 0.34], [0.69, 1.73, 0.25],
      [1.19, 1.72, 0.18]], 0.19, venous, true);
    this._vessel([[0.32, 1.55, 0.29], [-0.07, 1.76, 0.05],
      [-0.56, 1.84, -0.08]], 0.12, venous, true);
    this._vessel([[-0.76, 0.66, -0.18], [-0.79, 1.35, -0.18],
      [-0.81, 2.34, -0.21]], 0.18, venous, true);
    this._vessel([[-0.8, 1.79, -0.13], [-0.58, 1.97, 0.04],
      [-0.43, 2.03, 0.12]], 0.135, venous, true);
    this._vessel([[-0.76, 0.60, -0.24], [-1.00, 0.22, -0.28],
      [-1.00, -0.15, -0.28]], 0.14, venous);

    const branches = [
      [[0.29, 0.85], [0.35, 0.47], [0.29, 0.02], [0.20, -0.45], [0.29, -1.28]],
      [[0.31, 0.55], [0.03, 0.48], [-0.32, 0.31], [-0.68, 0.10]],
      [[0.32, 0.25], [0.62, 0.08], [0.82, -0.17], [0.84, -0.53]],
      [[0.27, -0.08], [-0.02, -0.15], [-0.35, -0.38], [-0.49, -0.60]],
      [[0.23, -0.43], [0.48, -0.61], [0.60, -0.90]],
      [[0.24, -0.70], [0.06, -0.81], [-0.11, -1.04]],
      [[-0.65, 0.64], [-0.82, 0.37], [-0.85, -0.01], [-0.62, -0.54]],
      [[-0.81, 0.15], [-0.59, 0.06], [-0.41, -0.12]],
    ];
    branches.forEach((path, i) => {
      const radius = i === 0 ? 0.037 : i === 6 ? 0.027 : 0.018;
      this._add(tube(path.map(([x, y]) => anterior(x, y)), radius), artery);
      if (i < 6) this._add(tube(path.map(([x, y]) =>
        anterior(x - 0.065, y, 0.03)), radius * 0.72), vein);
    });

    // Fine curved muscle bundles follow the anterior surface. Their scale is
    // small enough to read as tissue detail rather than raised surface cords.
    const fibreMat = new THREE.MeshStandardMaterial({ color: 0xf7957c,
      roughness: 0.65, transparent: true, opacity: 0.28 });
    this.fadeMats.push(fibreMat);
    for (let i = 0; i < 28; i++) {
      const y = -1.13 + i * 0.074, { radius, centre } = section(y);
      const points = [];
      for (let j = 0; j <= 18; j++) {
        const q = -0.83 + j / 18 * 1.66;
        points.push(anterior(centre + q * radius,
          y + 0.07 * Math.sin(q * Math.PI), 0.008));
      }
      this._add(tube(points, 0.005, 24), fibreMat);
    }
  }

  update(frame, phase) {
    this.uniforms.uPhase.value = phase;
    const ca = clamp01((frame.Ca_i - CA_MIN) / (CA_MAX - CA_MIN));
    this.contraction = ca;
    this.body.scale.set(1.12 * (1 - 0.08 * ca), 1 - 0.11 * ca, 1 - 0.08 * ca);
    this.body.rotation.y = 0.07 * ca;
    this.body.rotation.x = -0.018 * ca;
  }

  setFade(f) {
    this._fade = f;
    for (const mat of this.fadeMats) {
      mat.userData.baseOpacity ??= mat.opacity;
      mat.opacity = mat.userData.baseOpacity * f;
      // Keep hidden tissue and the backs of vessels occluded during flight.
      mat.depthWrite = true;
    }
    this.group.visible = f > 0.001;
  }
}
