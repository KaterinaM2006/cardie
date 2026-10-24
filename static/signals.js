// signals.js — bind simulated state to pixels.
//
// This is the mapping layer, and it is the part that is easy to get subtly
// wrong. The normalisation bounds are hard-coded from Appendix B of the
// build brief (measured across control and dosed runs) so the colour and
// contraction scales stay stable as the user moves the dose slider, rather
// than rescaling per run and hiding the very change we are trying to show.

export const V_MIN = -88, V_MAX = 45;
export const CA_MIN = 7.33e-5, CA_MAX = 2.14e-4;
export const HERG_OPEN_MAX = 0.496;     // control peak
export const BEAT_MS = 2000;

// Transmural cell modes. 0 is the only one the qNet classifier is
// validated against; 1/2 are an additive heterogeneity view (see README).
export const MODES = [0, 1, 2];
export const MODE_LABEL = { 0: 'Endocardial', 1: 'Epicardial', 2: 'Mid-myocardial' };
export const MODE_SHORT = { 0: 'Endo', 1: 'Epi', 2: 'Mid' };
export const MODE_COLOUR = { 0: '#ffc448', 1: '#6ec3f0', 2: '#ff6b9d' };

export const clamp01 = x => Math.max(0, Math.min(1, x));

// Perceptually ordered: indigo -> violet -> orange -> amber. Not a rainbow:
// a rainbow ramp implies categories where there is a continuum.
const MEMBRANE_RAMP = [[0.00, [26, 22, 66]], [0.35, [78, 42, 120]],
                       [0.65, [214, 109, 44]], [1.00, [255, 196, 72]]];

export function membraneRGB(v) {
  const x = clamp01((v - V_MIN) / (V_MAX - V_MIN));
  for (let i = 1; i < MEMBRANE_RAMP.length; i++) {
    const [p1, c1] = MEMBRANE_RAMP[i - 1], [p2, c2] = MEMBRANE_RAMP[i];
    if (x <= p2) {
      const f = (x - p1) / (p2 - p1);
      return c1.map((c, k) => c + f * (c2[k] - c));
    }
  }
  return MEMBRANE_RAMP[MEMBRANE_RAMP.length - 1][1].slice();
}

export const membraneColour = v =>
  `rgb(${membraneRGB(v).map(Math.round).join(',')})`;

// Contraction lags the voltage upstroke. That lag is physiologically
// correct — calcium has to enter and be released before the myofilaments
// shorten — and it is worth pointing out in the demo.
export const shortening = ca => 0.07 * clamp01((ca - CA_MIN) / (CA_MAX - CA_MIN));

// How many of the N drawn hERG glyphs are open / drug-blocked this frame.
export function hergGlyphStates(open, bound, n = 10) {
  const blocked = Math.round(bound * n);
  const openN = Math.round((open / HERG_OPEN_MAX) * (n - blocked));
  return Array.from({ length: n }, (_, i) =>
    i < blocked ? 'blocked' : i < blocked + openN ? 'open' : 'closed');
}

const LERP_KEYS = ['V', 'Ca_i', 'hERG_open', 'hERG_bound', 'INa', 'INaL',
                   'ICaL', 'Ito', 'IKr', 'IKs', 'IK1'];

// Interpolate between the 300 precomputed frames. The client does zero
// physics; every number here came out of the ODE solver.
export function frameAt(frames, tMs) {
  const n = frames.t.length;
  const x = clamp01(tMs / frames.t[n - 1]) * (n - 1);
  const i = Math.floor(x), g = x - i, j = Math.min(i + 1, n - 1);
  const out = {};
  for (const k of LERP_KEYS) {
    if (frames[k]) out[k] = frames[k][i] + g * (frames[k][j] - frames[k][i]);
  }
  return out;
}

const lerp = (a, b, f) => a + (b - a) * f;

// The dose slider is continuous but only integer multiples were simulated.
// Between them we interpolate and say so in the UI — we never extrapolate,
// and we never pretend an interpolated point is a simulated one.
//
// mode: 0 (endocardial, the default and the only mode the qNet classifier
// is validated against), 1 (epicardial) or 2 (mid-myocardial). sweep.json
// always carries mode 0 under control_by_mode/doses_by_mode too, even from
// a --no-transmural sweep, so this never needs a mode==0 special case.
export function doseBundle(sweep, drugName, dose, mode = 0) {
  const drug = sweep.drugs[drugName];
  const control = sweep.control_by_mode[mode];
  const modeDoses = drug.doses_by_mode[mode];
  dose = Math.max(0, Math.min(4, dose));

  const at = m => m === 0 ? {
    mult: 0, conc_nM: 0, qNet: control.qNet, APD90: control.APD90,
    dAPD90: 0, repol_failure: false, peak_bound: 0,
    block: Object.fromEntries(Object.keys(modeDoses[0].block).map(k => [k, 0])),
    frames: control.frames,
  } : modeDoses[m - 1];

  const loI = Math.floor(dose), hiI = Math.ceil(dose);
  const lo = at(loI), hi = at(hiI);
  if (loI === hiI) return { ...lo, interpolated: false, cmax: drug.cmax };

  const f = dose - loI;
  const frames = { t: lo.frames.t };
  for (const k of LERP_KEYS) {
    if (!lo.frames[k]) continue;
    frames[k] = lo.frames[k].map((a, i) => lerp(a, hi.frames[k][i], f));
  }
  const repol = hi.repol_failure;
  return {
    mult: dose,
    conc_nM: dose * drug.cmax,
    cmax: drug.cmax,
    qNet: lerp(lo.qNet, hi.qNet, f),
    APD90: repol ? null : lerp(lo.APD90, hi.APD90, f),
    dAPD90: repol ? null : lerp(lo.dAPD90, hi.dAPD90, f),
    repol_failure: repol,
    peak_bound: lerp(lo.peak_bound, hi.peak_bound, f),
    block: Object.fromEntries(Object.keys(lo.block).map(
      k => [k, lerp(lo.block[k], hi.block[k], f)])),
    frames,
    interpolated: true,
    between: [loI, hiI],
  };
}

// Ion species per channel, for particle colour and flux direction.
export const CHANNELS = {
  INa:  { ion: 'Na',  dir: -1, colour: 0xffc048, label: 'I_Na'  },
  INaL: { ion: 'Na',  dir: -1, colour: 0xf0a030, label: 'I_NaL' },
  ICaL: { ion: 'Ca',  dir: -1, colour: 0x5fd38d, label: 'I_CaL' },
  Ito:  { ion: 'K',   dir:  1, colour: 0x6ec3f0, label: 'I_to'  },
  IKr:  { ion: 'K',   dir:  1, colour: 0x4da3ff, label: 'I_Kr'  },
  IKs:  { ion: 'K',   dir:  1, colour: 0x7fb0ff, label: 'I_Ks'  },
  IK1:  { ion: 'K',   dir:  1, colour: 0x9ec9ff, label: 'I_K1'  },
};

// Per-channel current scale (A/F) for particle emission rate. Fixed, for the
// same reason the colour ramp is fixed.
export const I_SCALE = {
  INa: 100, INaL: 0.05, ICaL: 1.2, Ito: 0.3, IKr: 0.6, IKs: 0.1, IK1: 0.5,
};
