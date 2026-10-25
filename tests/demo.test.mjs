import test from 'node:test';
import assert from 'node:assert/strict';
import {DEMO,DemoSequence,matchRequest} from '../static/demo-script.js';
import {doseBundle} from '../static/signals.js';
import {readFileSync} from 'node:fs';
const names=['dofetilide','verapamil','quinidine'];
const initial='await_single_request', comparison='await_comparison_request', combined='await_combination_request';
test('documented prompts and paraphrases validate intent and exposure',()=>{
 for(const [stage,action] of [[initial,'single'],[comparison,'comparison'],[combined,'combined']])assert.equal(matchRequest(stage,DEMO.stages[stage].prompt,names).action,action);
 assert.equal(matchRequest(initial,'SHOW Dofetilide at twice Cmax!',names).action,'single');
 assert.equal(matchRequest(comparison,'Compare it vs VERAPAMIL at 2× Cmax?',names).action,'comparison');
 for(const q of ['hi','Show dofetilide','Show quinidine at 2x','Show dofetilide at 3x','Show dofetilide at 2 mg','Show dofetilide and aspirin at 2x','Do not show dofetilide at 2x','Compare it with verapamil at the same exposure','What happens if both are taken together?'])assert.ok(matchRequest(initial,q,names).error,q);
 for(const q of ['Compare it with quinidine at 2x','Compare it with verapamil at 3x','Compare it with verapamil'])assert.ok(matchRequest(comparison,q,names).error,q);
 assert.ok(matchRequest(combined,'Combine both at 4x',names).error);
});
test('commit follows scene success, rejects duplicates and failures remain retryable',async()=>{
 const d=new DemoSequence();let ready;const pending=d.submit(DEMO.stages[initial].prompt,names,()=>new Promise(r=>ready=r));
 assert.equal(d.stage,initial);assert.equal(d.pending,true);
 assert.equal((await d.submit(DEMO.stages[initial].prompt,names,()=>assert.fail())).ignored,true);
 ready([{APD90:346.9}]);assert.match((await pending).reply,/346.9/);assert.equal(d.stage,comparison);
 assert.ok((await d.submit(DEMO.stages[comparison].prompt,names,()=>{throw Error();})).error);assert.equal(d.stage,comparison);
});
test('reset invalidates pending actions, replies and stage changes',async()=>{
 const d=new DemoSequence();let finish;let current;
 const p=d.submit(DEMO.stages[initial].prompt,names,(_,valid)=>{current=valid;return new Promise(r=>finish=r);});
 d.reset();assert.equal(current(),false);finish([{APD90:1}]);assert.equal((await p).ignored,true);assert.equal(d.stage,initial);assert.equal(d.pending,false);
});
test('configured scenario identities are backed by different real cached results',()=>{
 const sweep=JSON.parse(readFileSync(new URL('../data/sweep.json',import.meta.url)));
 const a=doseBundle(sweep,DEMO.a.drug,DEMO.a.dose),b=doseBundle(sweep,DEMO.b.drug,DEMO.b.dose);
 assert.equal(a.interpolated,false);assert.equal(b.interpolated,false);
 assert.ok(Math.abs(a.APD90-346.918365)<.001);assert.ok(Math.abs(b.APD90-300.228095)<.001);
 assert.notDeepEqual(a.frames.V,b.frames.V);assert.notEqual(DEMO.a.id,DEMO.b.id);
 assert.equal(DEMO.combined.source,'illustrative_combination');assert.ok(DEMO.combined.recoveryFraction>0&&DEMO.combined.recoveryFraction<1);
});
