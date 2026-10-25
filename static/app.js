import { DEMO } from './demo-script.js';
import { createDemoChat } from './demo-chat.js';
import { ScenarioViews } from './scenarios.js';
// app.js — state, wiring, render loop.
//
// The whole precomputed sweep is fetched once. Every slider move redraws from
// that cached bundle with no backend call, which is why dragging the dose is
// instant and why a dead network at the judging table cannot stall the demo.

import { CellView } from './cell3d.js';
import { doseBundle, frameAt, BEAT_MS, CHANNELS, membraneColour,
         MEMBRANE_RAMP, V_MIN, V_MAX,
         MODES, MODE_LABEL, MODE_SHORT, MODE_COLOUR } from './signals.js';
import { drawAP, drawNet, drawStrip, drawTransmural } from './charts.js';

const $ = id => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const S = {
  sweep: null, validation: null,
  drug: 'dofetilide', dose: 1,
  t: 0, playing: !reduceMotion, speed: 0.25,
  bundle: null, control: null,
  xdT: 150, stage: 'heart',
};

let scenes, chat, stateVersion = 0;
let cell, lastTs = 0, whyTimer = 0, ctxTimer = 0;

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
  S.gemini = !!integ.gemini;
  $('integrations').innerHTML =
    `<span class="pill ${integ.gemini ? 'on' : ''}">Gemini ${integ.gemini ? 'live' : 'offline'}</span>` +
    `<span class="pill ${integ.tiger ? 'on' : ''}">Tiger Data ${integ.tiger ? 'live' : 'cached'}</span>` +
    `<span class="pill ${integ.gemini ? 'on' : ''}">Narration ${integ.gemini ? 'live' : 'offline'}</span>`;

  cell = new CellView($('cell'), { onHover: showTip, onModeChange: setStage });
  $('voltageScale').style.background = `linear-gradient(to top, ${
    MEMBRANE_RAMP.map(([p, c]) => `rgb(${c.join(',')}) ${p * 100}%`).join(',')})`;
  $('voltageScale').innerHTML = [V_MAX, 0, -40, V_MIN].map(v =>
    `<span style="top:${(V_MAX - v) / (V_MAX - V_MIN) * 100}%">${v}</span>`).join('');

  $('narrate').disabled = !S.gemini;
  renderModelCard();
  renderValidation();
  selectDrug(S.drug);
  setStage('heart');
  scenes = new ScenarioViews($('scenarioHost'), S.sweep);
  chat = createDemoChat({host:$('demoChat'), enabled:S.sweep.demo_enabled,
    names:Object.keys(S.sweep.drugs),
    onMode: active => { S.demo=active; stateVersion++; clearTimeout(whyTimer); clearTimeout(ctxTimer); stopNarration();
      $('ask').disabled=active; $('smiles').disabled=active; $('narrate').disabled=active || !S.gemini; },
    resetScene: () => { stateVersion++; scenes.reset(); applySingle(DEMO.start); S.t=0; cell.exitToHeart(); },
    apply: async (action,current) => {
      // Yield to paint the pending indicator; every commit is guarded against Reset/mode changes.
      const prepared=scenes.prepare(DEMO.a,DEMO.b);
      await new Promise(resolve=>setTimeout(resolve,300));
      if(!current()) return [];
      if(action==='single') { scenes.reset(); applySingle(DEMO.a); }
      else if(!scenes.open(action,DEMO.a,DEMO.b)) throw Error('Scene unavailable');
      S.t=0;
      await new Promise(resolve=>requestAnimationFrame(resolve));
      if(!current()) return [];
      return prepared.map(s=>s.data);
    },
  });
  const currentA=()=>({drug:S.drug,dose:S.dose});
  const currentB=()=>({drug:$('partner').value,dose:+$('partnerDose').value});
  $('singleView').onclick=()=>{const a=scenes.a || currentA(),b=scenes.b || currentB();if(chat.stage!=='complete')chat.manualChange();applySingle(a);scenes.open('single',a,b);};
  for(const [id,view] of [['compareView','comparison'],['combinedView','combined']]) $(id).onclick=()=>{
    const a=currentA(),b=currentB();if(chat.stage!=='complete')chat.manualChange();applySingle(a);scenes.open(view,a,b);
  };
  for(const id of ['partner','partnerDose']) $(id).onchange=()=>{const a=currentA(),b=currentB();chat.manualChange();applySingle(a);$('partner').value=b.drug;$('partnerDose').value=b.dose;scenes.reset();$('partner').value=b.drug;$('partnerDose').value=b.dose;};
  bindUI();

  if (reduceMotion) {
    // Hold a static frame on the plateau, with the scrub bar available.
    S.t = 150;
    $('play').textContent = '▶ Play';
  }
  requestAnimationFrame(loop);
}

function applySingle(scenario) {
  S.drug=scenario.drug; S.dose=scenario.dose;
  $('drug').value=S.drug; $('dose').value=S.dose;
  refresh();
}
function selectDrug(name) {
  chat?.manualChange(); scenes?.reset();
  applySingle({drug:name,dose:S.dose});
}

function refresh() {
  stateVersion++;
  S.bundle = doseBundle(S.sweep, S.drug, S.dose);
  // The heart's activation sweep samples this run's voltage trace, so the
  // organ view changes with the dose exactly as the cell view does.
  cell.heart.setWaveform(S.bundle.frames);
  renderSidebar();
  drawStrip($('strip'), S.validation, S.drug);
  renderTransmural();
  queueWhy();
  queueContext();
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

// ---- transmural heterogeneity -----------------------------------------------

function renderTransmural() {
  const byMode = {};
  for (const mode of MODES) byMode[mode] = doseBundle(S.sweep, S.drug, S.dose, mode);
  S.byMode = byMode;

  $('transLegend').innerHTML = MODES.map(m =>
    `<span><i style="background:${MODE_COLOUR[m]}"></i>${MODE_LABEL[m]}</span>`).join('');

  const apdText = b => b.repol_failure ? 'fail' : (b.APD90 == null ? '—' : `${b.APD90.toFixed(0)} ms`);
  const epi = byMode[1], mid = byMode[2];
  const dispersion = (!epi.repol_failure && !mid.repol_failure
                      && epi.APD90 != null && mid.APD90 != null)
    ? mid.APD90 - epi.APD90 : null;

  $('transMetrics').innerHTML = MODES.map(m => `
    <div class="metric">
      <div class="k" style="color:${MODE_COLOUR[m]}">${MODE_SHORT[m]} APD90</div>
      <div class="v mono">${apdText(byMode[m])}</div>
    </div>`).join('') +
    `<div class="note" style="grid-column:1/-1">Transmural dispersion
      (Mid − Epi): <strong class="mono">${dispersion == null ? '—' : `${dispersion >= 0 ? '+' : ''}${dispersion.toFixed(0)} ms`}</strong>
      ${dispersion != null && dispersion > 150 ? '— wide dispersion, the substrate re-entrant arrhythmias need.' : ''}</div>`;
}

// ---- Gemini explanation (the VERDICT) ---------------------------------------

function queueWhy() {
  clearTimeout(whyTimer);
  stopNarration();
  if(S.demo) { $('why').textContent='Independently computed single-drug metrics refer to A. No combined risk is calculated.'; $('whySrc').textContent='cached'; return; }
  const version=stateVersion;
  // Debounced, and cached server-side per (drug, dose): the slider never
  // triggers a model call on every tick.
  whyTimer = setTimeout(async () => {
    const drug = S.drug, dose = S.dose;
    $('why').textContent = '…';
    try {
      const r = await fetch('./api/explain', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drug, dose }),
      });
      const j = await r.json();
      if (stateVersion !== version || S.demo || S.drug !== drug || S.dose !== dose) return;
      $('why').textContent = j.text || '—';
      $('whySrc').textContent = j.source === 'template' ? 'offline' : j.source;
      $('whySrc').className = `pill ${j.source === 'template' ? '' : 'on'}`;
    } catch {
      if(stateVersion !== version || S.demo)return;
      $('why').textContent = 'explanation unavailable';
    }
  }, 280);
}

// ---- Gemini context narration (the VIEW) ------------------------------------
//
// Separate from queueWhy(): this narrates what's on screen (whole heart vs.
// single myocyte, which drug/dose is selected), and reacts to stage changes
// (clicking into the cell) as well as drug/dose changes. queueWhy() narrates
// the risk verdict; this narrates the view itself.

const CTX_KICKER = { heart: 'Human heart', cell: 'Ventricular myocyte', flying: 'Descending…' };
const CTX_TITLE = {
  heart: 'Whole-heart view',
  cell: 'Single-cell simulation',
  flying: '',
};

function queueContext() {
  clearTimeout(ctxTimer);
  if (S.stage === 'flying') return;
  $('ctxKicker').textContent = CTX_KICKER[S.stage] || '';
  $('ctxTitle').textContent = CTX_TITLE[S.stage] || '';
  if(S.demo) { $('ctxText').textContent='Explanatory heart animation driven by single-cell data. Use the chat to choose the next scene.'; $('ctxSrc').textContent='cached'; return; }
  const version=stateVersion;
  ctxTimer = setTimeout(async () => {
    const drug = S.drug, dose = S.dose, stage = S.stage;
    $('ctxText').textContent = '…';
    try {
      const r = await fetch('./api/context', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drug, dose, stage }),
      });
      const j = await r.json();
      if (stateVersion !== version || S.demo || S.drug !== drug || S.dose !== dose || S.stage !== stage) return;
      $('ctxText').textContent = j.text || '—';
      $('ctxSrc').textContent = j.source === 'template' ? 'offline' : j.source;
      $('ctxSrc').className = `pill ${j.source === 'template' ? '' : 'on'}`;
    } catch {
      if(stateVersion !== version || S.demo)return;
      $('ctxText').textContent = 'context unavailable';
    }
  }, 280);
}

// ---- narration (Gemini reads the Why explanation aloud) --------------------
//
// Same hard rule as the Gemini text explanation: this is handed a finished
// sentence and computes nothing. Cached server-side per explanation text,
// so re-clicking the same drug/dose doesn't re-spend quota.

let narrateAudio = null;

function stopNarration() {
  if (narrateAudio) { narrateAudio.pause(); narrateAudio = null; }
  $('narrateStatus').textContent = S.gemini ? '' : 'offline (no GEMINI_API_KEY)';
}

async function narrate() {
  if(S.demo)return;
  const version=stateVersion;
  if (!S.gemini) {
    $('narrateStatus').textContent = 'narration offline (no GEMINI_API_KEY)';
    return;
  }
  stopNarration();
  const drug = S.drug, dose = S.dose;
  $('narrateStatus').textContent = 'generating…';
  $('narrate').disabled = true;
  try {
    const r = await fetch('./api/narrate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drug, dose }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      $('narrateStatus').textContent = j.error || 'narration unavailable';
      return;
    }
    const blob = await r.blob();
    if(version !== stateVersion || S.demo)return;
    narrateAudio = new Audio(URL.createObjectURL(blob));
    narrateAudio.onended = () => { $('narrateStatus').textContent = ''; };
    narrateAudio.play();
    $('narrateStatus').textContent = 'playing…';
  } catch {
    $('narrateStatus').textContent = 'narration unavailable';
  } finally {
    $('narrate').disabled = S.demo || !S.gemini;
  }
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
  const version=stateVersion;
  const dose = Math.max(1, Math.min(4, Math.round(S.dose) || 1));
  $('xdTText').textContent = `${S.xdT} ms · ${xdPhaseLabel(S.xdT)}`;
  if(S.demo) {
    renderCrossDrug({source:'cache',drugs:Object.keys(S.sweep.drugs).map(drug=>({drug,V:frameAt(doseBundle(S.sweep,drug,dose).frames,S.xdT).V}))});return;
  }
  try {
    const r = await fetch(`./api/tiger/cross-drug?t=${S.xdT}&dose=${dose}`);
    if (!r.ok) return;
    const result=await r.json();
    if(version !== stateVersion || S.demo)return;
    renderCrossDrug(result);
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
  if(S.demo)return;
  chat?.manualChange(); scenes.reset(); const version=++stateVersion;
  $('askout').textContent = '…';
  try {
    const r = await fetch('./api/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q }),
    });
    const j = await r.json();
    if (!r.ok) { $('askout').textContent = j.error || 'could not parse'; return; }
    if(version !== stateVersion || S.demo)return;
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
  if(S.demo)return;
  scenes.reset();const version=++stateVersion;
  const out = $('smilesout');
  out.textContent = 'matching…';
  try {
    const r = await fetch(`./api/analogue?smiles=${encodeURIComponent(smiles)}`);
    const j = await r.json();
    if (!r.ok) { out.textContent = j.error || 'no match'; return; }
    if(version !== stateVersion || S.demo)return;
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

function setStage(mode) {
  S.stage = mode;
  $('ionLegend').style.display = mode === 'cell' ? 'block' : 'none';
  $('voltageLegend').style.display = mode === 'cell' ? 'block' : 'none';
  $('cellCaption').style.display = mode === 'cell' ? 'block' : 'none';
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
  if (S.sweep) queueContext();
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
  $('dose').oninput = e => { const dose=+e.target.value,drug=S.drug; chat?.manualChange();scenes.reset();applySingle({drug,dose}); };
  $('play').onclick = () => {
    S.playing = !S.playing;
    $('play').innerHTML = S.playing ? '&#10073;&#10073; Pause' : '&#9654; Play';
  };
  $('scrub').oninput = e => { S.t = +e.target.value; };
  $('speed').onchange = e => { S.speed = +e.target.value; };
  $('back').onclick = () => cell.exitToHeart();
  $('enterButton').onclick = () => cell.enterCell();
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
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
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

  scenes?.update(S.t,dt,S.playing);
  if (S.bundle && (!scenes || scenes.view==='single')) {
    const f = frameAt(S.bundle.frames, S.t);
    const g = S.dose > 0 ? frameAt(S.control, S.t) : null;
    cell.update(f, g, dt, S.playing, S.t / BEAT_MS);
    drawAP($('ap'), S.bundle.frames, S.dose > 0 ? S.control : null, S.t,
           { repolFailure: S.bundle.repol_failure, apd90: S.bundle.APD90,
             controlApd90: S.sweep.control.APD90 });
    drawNet($('net'), S.bundle.frames, S.dose > 0 ? S.control : null, S.t);
  }
  if (S.byMode) drawTransmural($('transmural'), S.byMode, S.t);
  requestAnimationFrame(loop);
}

boot().catch(e => {
  document.body.insertAdjacentHTML('afterbegin',
    `<div style="padding:16px;color:#ff5470">Failed to start: ${e.message}.
     Run <code>python app.py</code> and open the page it serves.</div>`);
  console.error(e);
});
