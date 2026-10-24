// app.js — state, wiring, render loop.
//
// The whole precomputed sweep is fetched once. Every slider move redraws from
// that cached bundle with no backend call, which is why dragging the dose is
// instant and why a dead network at the judging table cannot stall the demo.

import { CellView } from './cell3d.js';
import { doseBundle, frameAt, BEAT_MS, CHANNELS, membraneColour } from './signals.js';
import { drawAP, drawNet, drawStrip } from './charts.js';

const $ = id => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const S = {
  sweep: null, validation: null,
  drug: 'dofetilide', dose: 1,
  t: 0, playing: !reduceMotion, speed: 0.25,
  bundle: null, control: null,
  xdT: 150,
};

let cell, lastTs = 0, whyTimer = 0;

// ---- data ------------------------------------------------------------------

async function boot() {
  const r = await fetch('./api/sweep');
  if (!r.ok) throw new Error(`sweep fetch failed: ${r.status}`);
  S.sweep = await r.json();
  S.validation = S.sweep.validation;
  S.control = S.sweep.control.frames;

  const sel = $('drug');
  const order = { HIGH: 0, INTERMEDIATE: 1, LOW: 2 };
  for (const name of Object.keys(S.sweep.drugs).sort((a, b) =>
      order[S.sweep.drugs[a].label] - order[S.sweep.drugs[b].label] ||
      a.localeCompare(b))) {
    const d = S.sweep.drugs[name];
    sel.add(new Option(`${name} — FDA ${d.label}`, name));
  }
  sel.value = S.drug;

  const integ = S.sweep.integrations || {};
  S.speech = 'speechSynthesis' in window;
  $('integrations').innerHTML =
    `<span class="pill ${integ.gemini ? 'on' : ''}">Gemini ${integ.gemini ? 'live' : 'offline'}</span>` +
    `<span class="pill ${integ.tiger ? 'on' : ''}">Tiger Data ${integ.tiger ? 'live' : 'cached'}</span>` +
    `<span class="pill ${S.speech ? 'on' : ''}">Narration ${S.speech ? 'browser' : 'unsupported'}</span>`;

  cell = new CellView($('cell'), { onHover: showTip, onModeChange: setStage });

  $('narrate').disabled = !S.speech;
  renderModelCard();
  renderValidation();
  selectDrug(S.drug);
  setStage('heart');
  bindUI();

  if (reduceMotion) {
    // Hold a static frame on the plateau, with the scrub bar available.
    S.t = 150;
    $('play').textContent = '▶ Play';
  }
  requestAnimationFrame(loop);
}

function selectDrug(name) {
  S.drug = name;
  refresh();
}

function refresh() {
  S.bundle = doseBundle(S.sweep, S.drug, S.dose);
  // The heart's activation sweep samples this run's voltage trace, so the
  // organ view changes with the dose exactly as the cell view does.
  cell.heart.setWaveform(S.bundle.frames);
  renderSidebar();
  drawStrip($('strip'), S.validation, S.drug);
  queueWhy();
  refreshCrossDrug();
}

// ---- model & drug info -----------------------------------------------------

function renderModelCard() {
  const m = S.sweep.model_info;
  if (!m) return;
  $('modelDl').innerHTML = [
    ['Cell model', m.cell_model], ['Protocol', m.protocol],
    ['Drug binding', m.binding_model], ['Other channels', m.other_channels],
    ['Metric', m.metric],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('modelScope').textContent = m.scope;
}

function renderDrugCard() {
  const info = (S.sweep.drug_info || {})[S.drug];
  $('drugAboutName').textContent = S.drug;
  if (!info) {
    $('drugDl').innerHTML = '';
    $('drugStatus').textContent = 'No clinical reference data for this compound.';
    return;
  }
  $('drugDl').innerHTML = [
    ['Class', info.drug_class], ['Clinical use', info.use],
    ['Mechanism', info.mechanism],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('drugStatus').textContent = info.status;
}

// ---- sidebar ---------------------------------------------------------------

const fmt = (x, n = 4) => x === null || x === undefined ? '—' : x.toFixed(n);

function renderSidebar() {
  const b = S.bundle, d = S.sweep.drugs[S.drug];
  const risk = S.validation.drugs.find(x => x.name === S.drug);

  renderDrugCard();
  $('doseText').innerHTML = `${S.dose.toFixed(2)}&times; C<sub>max</sub>`;
  $('concText').textContent = `${b.conc_nM.toFixed(1)} nM`;

  $('verdict').className = `verdict ${risk.pred_qnet}`;
  $('riskClass').textContent = risk.pred_qnet;
  $('riskSub').textContent =
    `predicted from qNet ${fmt(d.qnet_mean)} · FDA label ${d.label}`;

  $('qnet').textContent = fmt(b.qNet);
  $('dapd').textContent = b.repol_failure ? 'fail'
    : (b.dAPD90 === null ? '—' : `${b.dAPD90 >= 0 ? '+' : ''}${b.dAPD90.toFixed(1)}`);
  $('apdNote').textContent = b.repol_failure
    ? 'no repolarisation' : `APD90 ${fmt(b.APD90, 1)} ms`;
  $('bound').textContent = `${(b.peak_bound * 100).toFixed(0)}%`;
  $('fda').textContent = d.label;

  $('interpNote').textContent = b.interpolated
    ? `Interpolated between simulated doses ${b.between[0]}× and ${b.between[1]}× Cmax. `
      + `Integer multiples are solved; intermediate points are linear interpolation.`
    : (S.dose === 0 ? 'Drug-free control run.' : 'Directly simulated dose.');

  // Channel block bars. hERG is reported from the dynamic Markov occupancy,
  // not from a Hill curve, so it is labelled separately.
  const rows = [['hERG', b.peak_bound, true]].concat(
    Object.entries(b.block).sort((a, c) => c[1] - a[1]).map(([k, v]) => [k, v, false]));
  $('blocks').innerHTML = rows.map(([k, v, dyn]) => {
    const colour = dyn ? 'var(--accent)'
      : `var(--${CHANNELS[k] && CHANNELS[k].ion === 'K' ? 'low' : 'interm'})`;
    return `<div class="bar"><span class="mono">${k}</span>
      <span class="track"><span class="fill" style="width:${(v * 100).toFixed(1)}%;
        background:${colour}"></span></span>
      <span class="pc">${(v * 100).toFixed(0)}%</span></div>`;
  }).join('') +
    `<div class="note">hERG from the dynamic Markov binding model (peak
     occupancy); the rest from the static Hill block at this concentration.</div>`;

  $('banner').style.display = b.repol_failure ? 'block' : 'none';
}

// ---- Gemini ----------------------------------------------------------------

function queueWhy() {
  clearTimeout(whyTimer);
  stopNarration();
  // Debounced, and cached server-side per (drug, dose): the slider never
  // triggers a model call on every tick.
  whyTimer = setTimeout(async () => {
    const drug = S.drug, dose = Math.round(S.dose * 2) / 2;
    $('why').textContent = '…';
    try {
      const r = await fetch('./api/explain', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drug, dose }),
      });
      const j = await r.json();
      if (S.drug !== drug) return;
      $('why').textContent = j.text || '—';
      $('whySrc').textContent = j.source === 'template' ? 'offline' : j.source;
      $('whySrc').className = `pill ${j.source === 'template' ? '' : 'on'}`;
    } catch {
      $('why').textContent = 'explanation unavailable';
    }
  }, 280);
}

// ---- narration (Web Speech API) ---------------------------------------------
//
// The browser's own voice reads the text already on screen. No network
// call, no key, no account: speechSynthesis is native to the browser, so
// this can never be the thing that breaks at a judging table.

function stopNarration() {
  if (S.speech) speechSynthesis.cancel();
  $('narrateStatus').textContent = S.speech ? '' : 'speech synthesis not supported here';
}

function narrate() {
  if (!S.speech) {
    $('narrateStatus').textContent = 'speech synthesis not supported in this browser';
    return;
  }
  speechSynthesis.cancel();
  const text = $('why').textContent;
  if (!text || text === '—' || text === '…') return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.0;
  utter.onstart = () => { $('narrateStatus').textContent = 'speaking…'; };
  utter.onend = () => { $('narrateStatus').textContent = ''; };
  utter.onerror = () => { $('narrateStatus').textContent = 'narration failed'; };
  speechSynthesis.speak(utter);
}

// ---- Tiger Data cross-drug comparison --------------------------------------

const CLASS_V = { HIGH: 'high', INTERMEDIATE: 'interm', LOW: 'low' };

function xdPhaseLabel(t) {
  if (t < 15) return 'upstroke';
  if (t < 60) return 'early plateau';
  if (t < 250) return 'plateau';
  if (t < 450) return 'repolarising';
  return 'resting';
}

async function refreshCrossDrug() {
  if (!S.bundle) return;
  const dose = Math.max(1, Math.min(4, Math.round(S.dose) || 1));
  $('xdTText').textContent = `${S.xdT} ms · ${xdPhaseLabel(S.xdT)}`;
  try {
    const r = await fetch(`./api/tiger/cross-drug?t=${S.xdT}&dose=${dose}`);
    if (!r.ok) return;
    renderCrossDrug(await r.json());
  } catch { /* the panel just doesn't update this tick */ }
}

function renderCrossDrug(j) {
  const risk = Object.fromEntries(S.validation.drugs.map(x => [x.name, x.true]));
  $('tigerSrc').textContent = j.source === 'tiger' ? 'live query' : 'cached';
  $('tigerSrc').className = `pill ${j.source === 'tiger' ? 'on' : ''}`;

  const order = { HIGH: 0, INTERMEDIATE: 1, LOW: 2 };
  const rows = [...j.drugs].sort((a, b) =>
    order[risk[a.drug]] - order[risk[b.drug]] || a.drug.localeCompare(b.drug));

  $('crossdrug').innerHTML = rows.map(d => {
    const cls = risk[d.drug] || 'LOW';
    const on = d.drug === S.drug;
    const ring = on ? 'var(--text)' : `var(--${CLASS_V[cls]})`;
    return `<div class="xd-cell" data-drug="${d.drug}" style="border-color:${ring}">
      <div class="xd-swatch" style="background:${membraneColour(d.V)}"></div>
      <div class="xd-name">${d.drug}</div>
      <div class="xd-v">${d.V.toFixed(0)} mV</div>
    </div>`;
  }).join('');
  for (const el of $('crossdrug').querySelectorAll('.xd-cell')) {
    el.onclick = () => { $('drug').value = el.dataset.drug; selectDrug(el.dataset.drug); };
  }
}

async function ask(q) {
  $('askout').textContent = '…';
  try {
    const r = await fetch('./api/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q }),
    });
    const j = await r.json();
    if (!r.ok) { $('askout').textContent = j.error || 'could not parse'; return; }
    $('drug').value = j.drug;
    S.drug = j.drug;
    S.dose = j.dose_mult;
    $('dose').value = S.dose;
    refresh();
    $('askout').textContent =
      `${j.drug} at ${j.dose_mult}× Cmax → ${j.risk} (FDA ${j.fda_label}), `
      + `parsed by ${j.parsed.source}`;
  } catch {
    $('askout').textContent = 'ask unavailable';
  }
}

async function lookupSmiles(smiles) {
  const out = $('smilesout');
  out.textContent = 'matching…';
  try {
    const r = await fetch(`./api/analogue?smiles=${encodeURIComponent(smiles)}`);
    const j = await r.json();
    if (!r.ok) { out.textContent = j.error || 'no match'; return; }
    $('drug').value = j.drug;
    S.drug = j.drug;
    refresh();
    // The note has to keep saying whose numbers these are. A borrowed curve
    // presented as the query compound's own would be the one dishonest
    // thing in the pipeline.
    out.innerHTML = `<strong>${j.note}</strong><br>` + j.ranked.map(x =>
      `${x.drug} ${x.tanimoto.toFixed(2)}`).join(' · ');
  } catch {
    out.textContent = 'lookup unavailable';
  }
}

// ---- validation panel ------------------------------------------------------

const CLASSES = ['HIGH', 'INTERMEDIATE', 'LOW'];

function renderValidation() {
  const v = S.validation;
  const build = cm => {
    let h = '<tr><th></th>' + CLASSES.map(c =>
      `<th>${c.slice(0, 6).toLowerCase()}</th>`).join('') + '</tr>';
    for (const a of CLASSES) {
      h += `<tr><th>${a.slice(0, 6).toLowerCase()}</th>` + CLASSES.map(b => {
        const n = cm[a][b];
        return `<td class="${n === 0 ? 'zero' : (a === b ? 'hit' : 'miss')}">${n}</td>`;
      }).join('') + '</tr>';
    }
    return h;
  };

  $('cm').innerHTML = build(v.qnet.confusion);
  $('cm2').innerHTML = build(v.dapd90.confusion);
  $('score').innerHTML = `${v.qnet.correct}/${v.qnet.n}` +
    `<small>qNet, mean over 1–4× C<sub>max</sub> · thresholds ` +
    `${v.qnet.t_high.toFixed(4)} / ${v.qnet.t_low.toFixed(4)} µC/µF</small>`;
  $('score2').innerHTML = `${v.dapd90.correct}/${v.dapd90.n}` +
    `<small>ΔAPD90 at 4× C<sub>max</sub> · thresholds ` +
    `${v.dapd90.t_high.toFixed(1)} / ${v.dapd90.t_low.toFixed(1)} ms</small>`;
  $('vnote').textContent = v.disclaimer +
    ' ΔAPD90 is shown because it is the legible number, and because where it'
    + ' disagrees with qNet is itself the argument for using qNet.';
}

// ---- interaction -----------------------------------------------------------

// The whole-heart view is a presentation of a single-cell solution, and the
// caption says exactly that. Overclaiming a tissue simulation is the one
// thing that would undo the project's credibility.
const STAGE_TITLE = {
  heart: 'Human heart',
  cell: 'Human ventricular myocyte &mdash; live simulated state',
  flying: 'Descending…',
};

const STAGE_SUB = {
  heart: 'Contraction follows the simulated calcium transient; the colour '
       + 'sweep is the simulated membrane potential. ORd-CiPA is a '
       + 'single-cell model &mdash; the spread across the ventricle is an '
       + 'illustrative conduction delay, not a tissue simulation.',
  cell: '',
  flying: '',
};

function setStage(mode) {
  $('stageTitle').innerHTML = STAGE_TITLE[mode] || '';
  $('stageSub').innerHTML = STAGE_SUB[mode] || '';
  $('ionLegend').style.display = mode === 'cell' ? 'block' : 'none';
  $('enter').style.display = mode === 'heart' ? 'block' : 'none';
  $('back').style.display = mode === 'cell' ? 'block' : 'none';
  $('cellHint').style.display = mode === 'cell' ? 'block' : 'none';
  document.body.dataset.stage = mode;
  // A 2000 ms cycle length is 30 bpm — the CiPA protocol, deliberately slow.
  // Real time reads as a heartbeat at organ scale; the cell view is slowed
  // down so the plateau and the channel traffic are actually watchable.
  if (mode === 'heart' || mode === 'cell') {
    S.speed = mode === 'heart' ? 1 : 0.25;
    $('speed').value = String(S.speed);
  }
}

function showTip(g) {
  const tip = $('tip');
  if (!g) { tip.style.display = 'none'; return; }
  const b = S.bundle;
  const f = frameAt(b.frames, S.t);
  const I = f[g.name] ?? 0;
  const blockPc = g.name === 'IKr'
    ? `${(f.hERG_bound * 100).toFixed(0)}% drug-bound now`
    : `${((b.block[g.name] ?? 0) * 100).toFixed(0)}% blocked at this dose`;
  tip.innerHTML = `<b>${g.spec.label}</b> &nbsp; ${I.toFixed(4)} A/F<br>${blockPc}`;
  tip.style.display = 'block';
  tip.style.left = `${Math.min(g.px + 14, $('cell').clientWidth - 170)}px`;
  tip.style.top = `${g.py + 14}px`;
}

function bindUI() {
  $('drug').onchange = e => selectDrug(e.target.value);
  $('dose').oninput = e => { S.dose = +e.target.value; refresh(); };
  $('play').onclick = () => {
    S.playing = !S.playing;
    $('play').innerHTML = S.playing ? '&#10073;&#10073; Pause' : '&#9654; Play';
  };
  $('scrub').oninput = e => { S.t = +e.target.value; };
  $('speed').onchange = e => { S.speed = +e.target.value; };
  $('back').onclick = () => cell.exitToHeart();
  addEventListener('keydown', e => {
    if (e.key === 'Escape' && cell.mode === 'cell') cell.exitToHeart();
  });
  $('ask').onkeydown = e => {
    if (e.key === 'Enter' && e.target.value.trim()) ask(e.target.value.trim());
  };
  $('narrate').onclick = narrate;
  $('xdT').oninput = e => { S.xdT = +e.target.value; refreshCrossDrug(); };
  $('smiles').onkeydown = e => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      lookupSmiles(e.target.value.trim());
    }
  };
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
  });
}

// ---- render loop -----------------------------------------------------------

function loop(ts) {
  const dt = Math.min((ts - lastTs) / 1000, 0.05) || 0;
  lastTs = ts;

  if (S.playing) {
    S.t = (S.t + dt * 1000 * S.speed) % BEAT_MS;
    $('scrub').value = S.t;
  }
  $('tText').textContent = `${S.t.toFixed(0)} ms`;

  if (S.bundle) {
    const f = frameAt(S.bundle.frames, S.t);
    const g = S.dose > 0 ? frameAt(S.control, S.t) : null;
    cell.update(f, g, dt, S.playing, S.t / BEAT_MS);
    drawAP($('ap'), S.bundle.frames, S.dose > 0 ? S.control : null, S.t,
           { repolFailure: S.bundle.repol_failure, apd90: S.bundle.APD90,
             controlApd90: S.sweep.control.APD90 });
    drawNet($('net'), S.bundle.frames, S.dose > 0 ? S.control : null, S.t);
  }
  requestAnimationFrame(loop);
}

boot().catch(e => {
  document.body.insertAdjacentHTML('afterbegin',
    `<div style="padding:16px;color:#ff5470">Failed to start: ${e.message}.
     Run <code>python app.py</code> and open the page it serves.</div>`);
  console.error(e);
});
