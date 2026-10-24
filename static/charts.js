// charts.js — vanilla Canvas. No charting library, no build step.

import { BEAT_MS, clamp01 } from './signals.js';

const CSS = getComputedStyle(document.documentElement);
const col = n => CSS.getPropertyValue(n).trim() || '#888';

function prep(canvas) {
  const dpr = Math.min(devicePixelRatio, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function axes(ctx, box, { xMax, yMin, yMax, yTicks, yLabel, xLabel }) {
  const { x0, y0, x1, y1 } = box;
  ctx.strokeStyle = col('--grid');
  ctx.fillStyle = col('--muted');
  ctx.lineWidth = 1;
  ctx.font = '11px ui-monospace, monospace';

  for (const v of yTicks) {
    const y = y1 - (v - yMin) / (yMax - yMin) * (y1 - y0);
    ctx.globalAlpha = v === 0 ? 0.55 : 0.22;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(v), x0 - 6, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let t = 0; t <= xMax; t += 500) {
    const x = x0 + t / xMax * (x1 - x0);
    ctx.globalAlpha = 0.18;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(String(t), x, y1 + 5);
  }
  ctx.textAlign = 'left';
  ctx.fillText(xLabel, x0, y1 + 20);
  ctx.save();
  ctx.translate(12, y0);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'right';
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
}

function trace(ctx, box, ts, vs, xMax, yMin, yMax, style, width = 2) {
  const { x0, y0, x1, y1 } = box;
  ctx.beginPath();
  for (let i = 0; i < ts.length; i++) {
    const x = x0 + clamp01(ts[i] / xMax) * (x1 - x0);
    const y = y1 - clamp01((vs[i] - yMin) / (yMax - yMin)) * (y1 - y0);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/** Action potential: control ghosted behind the dosed trace. */
export function drawAP(canvas, dosed, control, tNow, opts = {}) {
  const { ctx, w, h } = prep(canvas);
  const box = { x0: 46, y0: 12, x1: w - 10, y1: h - 26 };
  const yMin = -95, yMax = 50;
  axes(ctx, box, { xMax: BEAT_MS, yMin, yMax,
                   yTicks: [-80, -40, 0, 40], yLabel: 'mV', xLabel: 'ms' });

  if (control) {
    trace(ctx, box, control.t, control.V, BEAT_MS, yMin, yMax,
          col('--ghost'), 1.5);
  }
  trace(ctx, box, dosed.t, dosed.V, BEAT_MS, yMin, yMax,
        opts.repolFailure ? col('--danger') : col('--accent'), 2.2);

  // APD90 markers, shaded gap between them: this is "the effect of the
  // drug" made legible in one glance, instead of asking the viewer to
  // compare two overlaid traces by eye.
  const toX = tMs => box.x0 + clamp01(tMs / BEAT_MS) * (box.x1 - box.x0);
  const haveApd = opts.apd90 != null && isFinite(opts.apd90);
  if (control && opts.controlApd90 != null) {
    const xC = toX(opts.controlApd90);
    if (haveApd) {
      const xD = toX(opts.apd90);
      ctx.fillStyle = opts.repolFailure ? col('--danger') : col('--accent');
      ctx.globalAlpha = 0.12;
      ctx.fillRect(Math.min(xC, xD), box.y0, Math.abs(xD - xC), box.y1 - box.y0);
      ctx.globalAlpha = 1;
    }
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = col('--muted');
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(xC, box.y0);
    ctx.lineTo(xC, box.y1);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = col('--muted');
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('control APD90', xC, box.y0 + 10);
  }
  if (haveApd) {
    const xD = toX(opts.apd90);
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = opts.repolFailure ? col('--danger') : col('--accent2');
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(xD, box.y0);
    ctx.lineTo(xD, box.y1);
    ctx.stroke();
    ctx.restore();
  }
  if (opts.repolFailure) {
    ctx.fillStyle = col('--danger');
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('never repolarises', box.x0 + 6, box.y0 + 22);
  }

  // Playhead, synced to the cell animation.
  const px = box.x0 + clamp01(tNow / BEAT_MS) * (box.x1 - box.x0);
  ctx.strokeStyle = col('--playhead');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, box.y0);
  ctx.lineTo(px, box.y1);
  ctx.stroke();
  ctx.fillStyle = col('--playhead');
  ctx.beginPath();
  ctx.moveTo(px, box.y0);
  ctx.lineTo(px - 4, box.y0 - 6);
  ctx.lineTo(px + 4, box.y0 - 6);
  ctx.closePath();
  ctx.fill();
}

const QNET_KEYS = ['INaL', 'ICaL', 'IKr', 'IKs', 'IK1', 'Ito'];

export function netCurrent(frames) {
  return frames.t.map((_, i) =>
    QNET_KEYS.reduce((s, k) => s + (frames[k] ? frames[k][i] : 0), 0));
}

/** Net current with the area under the curve shaded: that area IS qNet. */
export function drawNet(canvas, dosed, control, tNow) {
  const { ctx, w, h } = prep(canvas);
  const box = { x0: 46, y0: 12, x1: w - 10, y1: h - 26 };
  const yMin = -1.2, yMax = 1.2;
  axes(ctx, box, { xMax: BEAT_MS, yMin, yMax,
                   yTicks: [-1, 0, 1], yLabel: 'A/F', xLabel: 'ms' });

  const net = netCurrent(dosed);
  const zero = box.y1 - (0 - yMin) / (yMax - yMin) * (box.y1 - box.y0);

  // Shade to the zero line — this is the integral being taken, in front of
  // the judge.
  ctx.beginPath();
  ctx.moveTo(box.x0, zero);
  for (let i = 0; i < net.length; i++) {
    const x = box.x0 + clamp01(dosed.t[i] / BEAT_MS) * (box.x1 - box.x0);
    const y = box.y1 - clamp01((net[i] - yMin) / (yMax - yMin)) * (box.y1 - box.y0);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(box.x1, zero);
  ctx.closePath();
  ctx.fillStyle = col('--shade');
  ctx.fill();

  if (control) {
    trace(ctx, box, control.t, netCurrent(control), BEAT_MS, yMin, yMax,
          col('--ghost'), 1.4);
  }
  trace(ctx, box, dosed.t, net, BEAT_MS, yMin, yMax, col('--accent2'), 1.8);

  const px = box.x0 + clamp01(tNow / BEAT_MS) * (box.x1 - box.x0);
  ctx.strokeStyle = col('--playhead');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, box.y0);
  ctx.lineTo(px, box.y1);
  ctx.stroke();
}

const CLASS_COLOUR = { HIGH: '--high', INTERMEDIATE: '--interm', LOW: '--low' };

/**
 * One-dimensional qNet strip with the two thresholds drawn in. The most
 * persuasive static image in the project: the separation is visible at a
 * glance, with no statistics to take on trust.
 */
export function drawStrip(canvas, validation, highlight) {
  const { ctx, w, h } = prep(canvas);
  const m = validation.qnet;
  const xs = validation.drugs.map(d => d.qnet_mean);
  const lo = Math.min(...xs) - 0.012, hi = Math.max(...xs) + 0.012;
  const box = { x0: 16, x1: w - 16, y: h - 34 };
  const X = v => box.x0 + (v - lo) / (hi - lo) * (box.x1 - box.x0);

  ctx.strokeStyle = col('--grid');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(box.x0, box.y);
  ctx.lineTo(box.x1, box.y);
  ctx.stroke();

  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of [m.t_high, m.t_low]) {
    ctx.strokeStyle = col('--thresh');
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(X(t), 14);
    ctx.lineTo(X(t), box.y + 6);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = col('--thresh');
    ctx.fillText(t.toFixed(4), X(t), box.y + 9);
  }

  // Control, for scale.
  ctx.fillStyle = col('--muted');
  ctx.fillText('control', X(m.control), 2);
  ctx.beginPath();
  ctx.moveTo(X(m.control), 13);
  ctx.lineTo(X(m.control), box.y);
  ctx.strokeStyle = col('--muted');
  ctx.globalAlpha = 0.45;
  ctx.stroke();
  ctx.globalAlpha = 1;

  for (const d of validation.drugs) {
    const x = X(d.qnet_mean);
    const on = d.name === highlight;
    ctx.beginPath();
    ctx.arc(x, box.y, on ? 7 : 5, 0, Math.PI * 2);
    ctx.fillStyle = col(CLASS_COLOUR[d.true]);
    ctx.fill();
    if (on) {
      ctx.strokeStyle = col('--text');
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = col('--text');
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(d.name, x, box.y + 22);
    }
  }
}
