import { CellView } from './cell3d.js';
import { doseBundle, frameAt, BEAT_MS } from './signals.js';
import { drawAP } from './charts.js';
import { DEMO } from './demo-script.js';

// Reusable scenes: caller owns the selected A settings and shared playback clock.
export class ScenarioViews {
  constructor(host, sweep) {
    this.host=host; this.sweep=sweep; this.view='single'; this.a=null; this.b=null;
    host.innerHTML=`<div class="card scenario-controls"><strong>Scenario</strong>
      <button id="singleView">Single / A</button><button id="compareView">A/B comparison</button><button id="combinedView">Combined preset</button>
      <label>B drug <select id="partner" aria-label="B drug"></select></label>
      <label>B exposure <select id="partnerDose" aria-label="B exposure">${[1,2,3,4].map(n=>`<option value="${n}">${n}× Cmax</option>`).join('')}</select></label>
      <span id="sceneNotice" role="status"></span></div>
      <section id="multiScene" class="card" hidden>
        <h2 id="sceneTitle"></h2><p id="sceneSource"></p>
        <div id="abScenes" class="ab-scenes">${['A','B'].map(k=>`<article data-side="${k}"><h3 id="label${k}"></h3><div class="comparison-stage"><canvas class="comparison-animation" id="animation${k}" aria-label="${k} explanatory heart animation"></canvas></div><p id="metrics${k}"></p><canvas class="comparison-chart" id="chart${k}" aria-label="${k} action potential"></canvas></article>`).join('')}</div>
        <div id="combinedScene" hidden><canvas id="combinedAnimation" aria-label="Schematic hypothetical combined recovery animation"></canvas><p>qNet: Not calculated · APD90: Not calculated · Risk: Not calculated</p><p>Schematic electrical recovery; no simulated trace, tissue rhythm or clinical verdict. A/B provides the independently computed reference scenarios.</p></div>
      </section>`;
    this.$=id=>host.querySelector('#'+id);
    for(const n of Object.keys(sweep.drugs)) this.$('partner').add(new Option(n,n));
    this.$('partner').value='verapamil'; this.$('partnerDose').value='2';
  }
  prepare(a,b) {
    const bundle = s => {
      if(!this.sweep.drugs[s.drug] || !Number.isFinite(s.dose) || s.dose<0 || s.dose>4) throw Error('Unsupported scenario');
      const data=doseBundle(this.sweep,s.drug,s.dose);
      if(!data.frames?.V?.length) throw Error('Missing frames');
      return {...s,id:`${s.drug}-${s.dose}x-endo`,data};
    };
    return [bundle(a),bundle(b)];
  }
  supports(a,b) {return [a,b].every(s=>s.dose===2) && [a.drug,b.drug].sort().join(',')==='dofetilide,verapamil';}
  open(view,a,b) {
    const prepared=this.prepare(a,b);
    if(view==='combined' && !this.supports(a,b)) { this.$('sceneNotice').textContent='No combined scenario is available for this pair/exposure. Use dofetilide + verapamil at 2× Cmax each.'; return false; }
    // Prepare WebGL resources before committing the view.
    if(view==='comparison' && !this.views) this.views=['A','B'].map(k=>new CellView(this.$('animation'+k)));
    [this.a,this.b]=prepared; this.view=view;
    this.$('partner').value=b.drug;this.$('partnerDose').value=b.dose;
    this.$('sceneNotice').textContent='';
    this.$('multiScene').hidden=view==='single';
    this.$('abScenes').hidden=view!=='comparison';this.$('combinedScene').hidden=view!=='combined';
    document.body.dataset.scenario=view;
    this.$('sceneTitle').textContent=view==='combined'?'Combined · dofetilide + verapamil':'A/B · independent endocardial simulations';
    this.$('sceneSource').textContent=view==='combined'?`${DEMO.combined.label} Source: ${DEMO.combined.source}. A: ${a.drug} ${a.dose}× Cmax; B: ${b.drug} ${b.dose}× Cmax.`:'Same 0–2000 ms and −95 to 50 mV axes; shared playback. Heart motion explains single-cell data; it is not a tissue simulation. Sidebar metrics refer to A.';
    this.$('multiScene').dataset.source=view==='combined'?DEMO.combined.source:'precomputed_single_cell';
    this.$('multiScene').dataset.scenarioId=view==='combined'?DEMO.combined.id:prepared.map(s=>s.id).join('__');
    for(const [i,k] of ['A','B'].entries()) {
      const s=prepared[i];
      this.$('label'+k).textContent=`${k}: ${s.drug} · ${s.dose}× Cmax · ${s.data.conc_nM.toFixed(1)} nM`;
      this.$('animation'+k).dataset.scenario=s.id;
      this.$('metrics'+k).textContent=`APD90 ${s.data.APD90?.toFixed(1) ?? 'unavailable'} ms · qNet ${s.data.qNet.toFixed(4)} µC/µF`;
      this.views?.[i].heart.setWaveform(s.data.frames);
      this.views?.[i].resize();
    }
    return true;
  }
  reset(){ this.view='single';this.a=null;this.b=null; this.$('multiScene').hidden=true;document.body.dataset.scenario='single';this.$('sceneNotice').textContent='';this.$('partner').value='verapamil';this.$('partnerDose').value='2'; }
  update(t,dt,playing) {
    if(this.view==='comparison') for(const [i,k] of ['A','B'].entries()) {
      const s=i?this.b:this.a;
      this.views[i].update(frameAt(s.data.frames,t),null,dt,playing,t/BEAT_MS);
      drawAP(this.$('chart'+k),s.data.frames,this.sweep.control.frames,t,{apd90:s.data.APD90});
    }
    if(this.view==='combined') this.drawSchematic(t);
  }
  drawSchematic(t) {
    const c=this.$('combinedAnimation'), w=c.clientWidth,h=250;
    c.width=w*devicePixelRatio;c.height=h*devicePixelRatio;
    const ctx=c.getContext('2d');ctx.scale(devicePixelRatio,devicePixelRatio);
    const phase=t/BEAT_MS, recovery=Math.max(0,1-phase/DEMO.combined.recoveryFraction);
    ctx.fillStyle='#f3f5fc';ctx.fillRect(0,0,w,h);
    ctx.fillStyle=`hsl(${225-220*recovery} 80% 65%)`;
    const width=Math.max(80,w*.65)*(1-.07*recovery);
    ctx.beginPath();ctx.roundRect((w-width)/2,85,width,75,38);ctx.fill();
    ctx.fillStyle='#131a3a';ctx.font='14px system-ui';ctx.textAlign='center';
    ctx.fillText('SCHEMATIC · hypothetical electrical recovery',w/2,35);
    ctx.fillText(recovery>0?'Illustrative activation → recovery':'Illustrative resting state',w/2,205);
    ctx.fillText('Artistic timing only · no pharmacology calculated',w/2,230);
  }
}
