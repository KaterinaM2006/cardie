import { DEMO, DemoSequence } from './demo-script.js';
export function createDemoChat({host,enabled,apply,resetScene,names,onMode}) {
  const sequence=new DemoSequence();let active=false;
  host.hidden=!enabled;
  host.innerHTML=`${enabled?'<label><input type="checkbox" id="demoToggle"> Demo Mode</label> <button id="resetDemo">Reset Demo</button>':''}
    <p id="demoNotice" role="status"></p>
    <details id="demoPanel" hidden open><summary>Chat <span class="pill">Scripted demo</span></summary>
    <small id="demoStage"></small><div id="chatHistory" role="log" aria-live="polite"></div>
    <button id="suggestion" type="button"></button>
    <form id="chatForm"><label for="chatInput">Your message</label><textarea id="chatInput" rows="3" placeholder="Ask about the next scenario"></textarea><button id="chatSend" type="submit">Send</button> <span id="chatPending" role="status"></span></form>
    <button id="replayDemo" hidden>Replay / Reset</button></details>`;
  const $=id=>host.querySelector('#'+id);
  function render(){
    $('demoPanel').hidden=!active;
    $('demoStage').textContent=sequence.stage;
    $('suggestion').textContent=DEMO.stages[sequence.stage].prompt;
    $('suggestion').hidden=sequence.stage==='complete';
    $('replayDemo').hidden=sequence.stage!=='complete';
    $('chatSend').disabled=sequence.pending;
    $('chatPending').textContent=sequence.pending?'Preparing scene…':'';
  }
  function message(role,text){const p=document.createElement('p');p.className='chat-'+role;p.textContent=`${role==='user'?'You':'Torsade'}: ${text}`;$('chatHistory').append(p);$('chatHistory').scrollTop=$('chatHistory').scrollHeight;}
  function reset(notice=''){sequence.reset();$('chatHistory').replaceChildren();$('chatInput').value='';$('demoNotice').textContent=notice;resetScene();render();}
  function setMode(value){active=value;onMode(value);reset();if(enabled)$('demoToggle').checked=value;}
  $('suggestion').onclick=()=>{$('chatInput').value=DEMO.stages[sequence.stage].prompt;$('chatInput').focus();};
  $('chatForm').onsubmit=async e=>{
    e.preventDefault();const text=$('chatInput').value.trim();if(!active || sequence.pending || !text)return;
    message('user',text);$('chatInput').value='';
    const promise=sequence.submit(text,names,apply);render();
    const result=await promise;
    if(!result.ignored)message('assistant',result.reply||result.error);
    render();
  };
  $('chatInput').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('chatForm').requestSubmit();}};
  $('replayDemo').onclick=()=>reset();
  if(enabled){$('demoToggle').onchange=e=>setMode(e.target.checked);$('resetDemo').onclick=()=>reset();}
  addEventListener('pagehide',()=>sequence.reset());
  render();
  return {get active(){return active;},get stage(){return sequence.stage;},setMode,
    manualChange(){if(active)reset('Manual scenario change reset the scripted sequence. Start again with the suggested prompt.');}};
}
