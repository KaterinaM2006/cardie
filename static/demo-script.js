// Script configuration and intent/state logic. No DOM, network or scientific calculations.
export const DEMO = {
  start: { drug: 'dofetilide', dose: 1 },
  a: { id: 'dofetilide-2x-endo', drug: 'dofetilide', dose: 2 },
  b: { id: 'verapamil-2x-endo', drug: 'verapamil', dose: 2 },
  combined: { id: 'dofetilide-verapamil-2x-illustration', source: 'illustrative_combination',
    // Bounded artistic timing, not an estimate of the pair's pharmacology.
    recoveryFraction: 0.42, label: 'Illustrative combined scenario — not a validated drug-interaction prediction.' },
  stages: {
    await_single_request: { action: 'single', next: 'await_comparison_request',
      prompt: 'Show me dofetilide at 2x reference exposure.',
      response: a => `Dofetilide blocks hERG. At 2× Cmax, the endocardial simulation has APD90 ${a.APD90.toFixed(1)} ms. The heart is an explanatory animation, not a tissue simulation.` },
    await_comparison_request: { action: 'comparison', next: 'await_combination_request',
      prompt: 'Compare it with verapamil at the same reference-exposure multiple.',
      response: (a,b) => `A remains dofetilide at 2× Cmax; B is verapamil at 2× Cmax. APD90 is ${a.APD90.toFixed(1)} vs ${b.APD90.toFixed(1)} ms in these endocardial runs. Playback and graph scales are shared.` },
    await_combination_request: { action: 'combined', next: 'complete',
      prompt: 'What happens if both are taken together?',
      response: () => 'Both inputs are retained at 2× Cmax each. This schematic illustrates hypothetical slower recovery; it is not a validated drug-interaction prediction. Combined metrics are not calculated. A/B remains available.' },
    complete: { prompt: '', action: null },
  },
};
export function matchRequest(stage, text, names = ['dofetilide', 'verapamil']) {
  const s = text.toLowerCase().replace(/×/g,'x').replace(/\.(?!\d)|(?<!\d)\./g,' ').replace(/[^a-z0-9.]+/g,' ').trim();
  const cfg = DEMO.stages[stage];
  const fail = reason => ({ error: `${reason} ${cfg.prompt ? 'Try: '+cfg.prompt : 'Use Replay / Reset to start again.'}` });
  if (!cfg.action) return fail('The sequence is complete.');
  if (/\b(mg|mcg|ug|milligrams?|nm|micromolar)\b/.test(s)) return fail('Use exposure multiples of Cmax; no dose-to-exposure conversion is available.');
  if (/\b(not|don|dont|instead|except|without)\b/.test(s)) return fail('Please submit an unambiguous positive request.');
  const vocabulary = new Set(('show me at x reference exposure times fold twice double cmax normal dose the same multiple compare comparison it with versus vs to what happens happen if both are taken take together combine combined combination and a b please can could you display simulate see tell about drug drugs medicine medicines these two for of do does would when we happen happen taking them their i want like how will look as before now happen happens effect effects').split(' '));
  const unknown = s.split(/\s+/).filter(w => !names.includes(w) && !vocabulary.has(w) && !/^\d+(?:\.\d+)?x?$/.test(w));
  if (unknown.length) return fail('Please use the suggested prompt or a close paraphrase.');
  const drugs = names.filter(n => new RegExp(`\\b${n}\\b`).test(s));
  const numbers = s.match(/\d+(?:\.\d+)?/g) || [];
  if (numbers.some(n => +n !== 2) || /\b(once|one|three|four|half|triple)\b/.test(s)) return fail('This conversation supports 2× Cmax for each drug.');
  const exposure = /\b2\s*x\b|\b2\s*(times|fold)\b|\b(twice|double)\b|\btwo\s*(times|fold)\b/.test(s);
  const same = /\bsame\b/.test(s) && /exposure|multiple|cmax|dose/.test(s);
  const compare = /\b(compare|comparison|versus|vs)\b/.test(s);
  const combined = /\b(together|combine|combined|combination)\b/.test(s);
  if (cfg.action === 'single' && !compare && !combined && drugs.length === 1 && drugs[0] === DEMO.a.drug && exposure && /\b(show|see|display|dofetilide|simulate)\b/.test(s)) return {action:cfg.action};
  if (cfg.action === 'comparison' && compare && !combined && drugs.includes(DEMO.b.drug) && drugs.every(n => [DEMO.a.drug,DEMO.b.drug].includes(n)) && (same || exposure)) return {action:cfg.action};
  if (cfg.action === 'combined' && combined && !compare && (/\b(both|them)\b/.test(s) || (drugs.includes(DEMO.a.drug) && drugs.includes(DEMO.b.drug))) && drugs.every(n=>[DEMO.a.drug,DEMO.b.drug].includes(n))) return {action:cfg.action};
  return fail('That request does not match this step and its supported drugs/exposure.');
}
export class DemoSequence {
  constructor() { this.reset(); }
  reset() { this.version = (this.version || 0)+1; this.stage='await_single_request'; this.pending=false; }
  async submit(text, names, apply) {
    if (this.pending) return { ignored:true };
    const match=matchRequest(this.stage,text,names);
    if(match.error) return match;
    const version=this.version, cfg=DEMO.stages[this.stage];
    this.pending=true;
    const current=()=>this.version===version;
    try {
      const result=await apply(match.action,current);
      if(!current()) return {ignored:true};
      this.stage=cfg.next;
      return {reply:cfg.response(...result)};
    } catch { return current() ? {error:'Scene could not be prepared. Please send the same request to retry.'} : {ignored:true}; }
    finally { if(current()) this.pending=false; }
  }
}
