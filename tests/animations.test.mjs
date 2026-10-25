// Run with: node --test tests/animations.test.mjs
// Exercise geometry and transition state without a browser or GPU. Browser
// captures remain necessary for visual acceptance and shader compilation.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../static/vendor/three.module.min.js';
import { CellView } from '../static/cell3d.js';
import { Heart } from '../static/heart3d.js';
import { CA_MIN, CA_MAX, V_MIN, V_MAX, membraneRGB } from '../static/signals.js';

function cell() {
  const v = Object.create(CellView.prototype);
  Object.assign(v, {
    cellRoot: new THREE.Group(), glyphs: [], hergGlyphs: [],
    camera: new THREE.PerspectiveCamera(38, 1, 0.1, 100),
    cameraTarget: new THREE.Vector3(), flight: { progress: 0 },
    heart: new Heart(), mode: 'heart', cellFade: 0,
  });
  v._buildGhost();
  v._buildCell();
  v._buildGlyphs();
  v._buildParticles();
  v._captureCellMaterials();
  return v;
}

function near(a, b, tolerance = 1e-6) {
  assert.ok(Math.abs(a - b) < tolerance, `${a} differs from ${b}`);
}

test('cell caps join the body smoothly and surface normals point outwards', () => {
  const v = cell(), p = v.membrane.geometry.attributes.position;
  const n = v.membrane.geometry.attributes.normal;
  assert.ok(Array.from(p.array).every(Number.isFinite));
  assert.ok(Array.from(n.array).every(Number.isFinite));
  // Adjacent radial samples cannot jump at the former cap/body shoulders.
  const rows = 112, columns = 65;
  let previous;
  for (let i = 1; i < rows; i++) {
    const top = new THREE.Vector3().fromBufferAttribute(p, i * columns);
    const bottom = new THREE.Vector3().fromBufferAttribute(p, i * columns + 32);
    const radius = top.distanceTo(bottom) / 2;
    if (previous !== undefined) assert.ok(Math.abs(radius - previous) < 0.07);
    previous = radius;
    assert.ok(n.getY(i * columns) > 0);
  }
});

test('every channel sits on the curved membrane and points outwards', () => {
  const v = cell();
  v.cellRoot.updateMatrixWorld(true);
  for (const gl of v.glyphs) {
    const worldOrigin = gl.origin.clone().addScaledVector(gl.dir, 0.3);
    const hit = new THREE.Raycaster(worldOrigin, gl.dir.clone().negate())
      .intersectObject(v.membrane)[0];
    assert.ok(hit, `${gl.name} has no membrane underneath it`);
    assert.ok(hit.point.distanceTo(gl.origin) < 0.035, `${gl.name} floats above the membrane`);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(gl.group.quaternion);
    near(up.dot(gl.dir), 1);
  }
});

test('particle streams share channel transforms during contraction and rotation', () => {
  const v = cell(), gl = v.glyphs[0];
  assert.equal(v.particles.parent, v.cell);
  v._emit(gl, 2);
  const p = v.pool[0];
  assert.ok(p.pos.distanceTo(gl.origin) < 0.2);
  assert.ok(p.vel.dot(gl.dir) * gl.spec.dir > 0);
  v.cell.scale.set(0.93, 1.03, 1.03);
  v.cell.rotation.set(0.03, 0.2, 0.3);
  v.cellRoot.updateMatrixWorld(true);
  const channel = gl.group.getWorldPosition(new THREE.Vector3());
  const stream = p.pos.clone().applyMatrix4(v.particles.matrixWorld);
  assert.ok(channel.distanceTo(stream) < 0.2);
});

test('shared materials retain their opacity through repeated fades', () => {
  const v = cell(), original = Array.from(v.cellMats, ([mat, opacity]) => [mat, opacity]);
  // The two nuclei intentionally share one material.
  const nuclei = v.cell.children.filter(o => o.geometry?.type === 'SphereGeometry');
  assert.equal(nuclei[0].material, nuclei[1].material);
  for (let i = 0; i < 4; i++) {
    for (const f of [1, 0.5, 0, 0.25, 1]) {
      v.cellFade = f;
      v._applyFade();
      for (const [mat, opacity] of original) near(mat.opacity, opacity * f);
    }
  }
});

test('missing GSAP restores complete enter and exit states after a partial fade', () => {
  const oldWindow = globalThis.window;
  globalThis.window = { gsap: null };
  try {
    const v = cell();
    v.cellFade = 0.3; v._applyFade();
    v.enterCell();
    assert.equal(v.mode, 'cell');
    assert.equal(v.flight.progress, 1);
    assert.equal(v.cellRoot.visible, true);
    assert.equal(v.heart.group.visible, false);
    for (const [mat, opacity] of v.cellMats) near(mat.opacity, opacity);
    v.exitToHeart();
    assert.equal(v.mode, 'heart');
    assert.equal(v.flight.progress, 0);
    assert.equal(v.cellRoot.visible, false);
    assert.equal(v.heart.group.visible, true);
    near(v.heart._fade, 1);
    for (const [mat] of v.cellMats) near(mat.opacity, 0);
  } finally { globalThis.window = oldWindow; }
});

test('camera targets stay centred and narrow panels fit the full cell', () => {
  const v = cell();
  for (const aspect of [0.55, 0.8, 1, 1.6, 2.4]) {
    v.camera.aspect = aspect;
    v.camera.updateProjectionMatrix();
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      v.flight.progress = progress; v._aimCamera();
      v.camera.updateMatrixWorld(true);
      const target = v.cameraTarget.clone().project(v.camera);
      near(target.x, 0); near(target.y, 0);
    }
    v.cellRoot.rotation.set(0.05, -0.14, 0.24);
    v.cellRoot.updateMatrixWorld(true);
    const p = v.membrane.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const point = new THREE.Vector3().fromBufferAttribute(p, i)
        .applyMatrix4(v.membrane.matrixWorld).project(v.camera);
      assert.ok(Math.abs(point.x) < 0.9, `cell clipped at aspect ${aspect}`);
      assert.ok(Math.abs(point.y) < 0.9, `cell clipped at aspect ${aspect}`);
    }
  }
});

test('heart contraction follows calcium and fades preserve tissue detail opacity', () => {
  const h = new Heart();
  h.update({ Ca_i: CA_MIN }, 0);
  const relaxed = h.body.scale.clone();
  h.update({ Ca_i: CA_MAX }, 0.15);
  assert.ok(h.body.scale.x < relaxed.x && h.body.scale.y < relaxed.y);
  near(h.contraction, 1);
  const original = h.fadeMats.map(m => m.opacity);
  for (const f of [0.5, 0, 1, 0.2, 1]) {
    h.setFade(f);
    h.fadeMats.forEach((m, i) => near(m.opacity, original[i] * f));
  }
});

test('the heart and great vessels fit inside a narrow panel at full relaxation', () => {
  const v = cell();
  v._finishExit();
  v.heart.update({ Ca_i: CA_MIN }, 0);
  for (const aspect of [0.55, 0.65, 0.8, 1.6]) {
    v.camera.aspect = aspect;
    v.camera.updateProjectionMatrix();
    v._aimCamera();
    v.camera.updateMatrixWorld(true);
    v.heart.group.updateMatrixWorld(true);
    for (const mesh of v.heart.pickTargets) {
      const positions = mesh.geometry.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        const point = new THREE.Vector3().fromBufferAttribute(positions, i)
          .applyMatrix4(mesh.matrixWorld).project(v.camera);
        assert.ok(Math.abs(point.x) < 0.96, `vessel clipped horizontally at ${aspect}`);
        assert.ok(Math.abs(point.y) < 0.96, `heart clipped vertically at ${aspect}`);
      }
    }
  }
});

test('the fixed voltage ramp remains blue at rest and red at peak', () => {
  const rest = membraneRGB(V_MIN), peak = membraneRGB(V_MAX);
  assert.ok(rest[2] > rest[0] * 3);
  assert.ok(peak[0] > peak[2] * 3);
  assert.deepEqual(membraneRGB(V_MIN - 20), rest);
  assert.deepEqual(membraneRGB(V_MAX + 20), peak);
});
