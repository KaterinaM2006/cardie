import { DEMO, DemoSequence } from './demo-script.js';
export function createDemoChat({host,enabled,apply,resetScene,names,onMode}) {
  const sequence=new DemoSequence();const active=Boolean(enabled);
  let drawerOpen=false;
  host.hidden=!enabled;
  host.innerHTML=`<button id="chatLauncher" aria-label="Open chat" aria-controls="chatDrawer" aria-expanded="false" title="Chat">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-8 8H4l1.4-4.2A8 8 0 1 1 20 11.5Z"/><path d="M8 9h8M8 13h5"/></svg>
    </button>
    <div id="chatBackdrop" hidden></div>
    <section id="chatDrawer" role="dialog" aria-modal="true" aria-labelledby="chatTitle" aria-hidden="true" inert>
      <div class="chat-heading"><h2 id="chatTitle">Torsade chat</h2><button id="chatClose" aria-label="Close chat">✕</button></div>
      <p id="demoNotice" role="status"></p>
      <div id="chatHistory" role="log" aria-live="polite"></div>
      <div class="chat-compose"><button id="suggestion" type="button"></button>
      <form id="chatForm"><label for="chatInput">Your message</label><textarea id="chatInput" rows="3" placeholder="Ask about the next scenario"></textarea><button id="chatSend" type="submit">Send</button> <span id="chatPending" role="status"></span></form>
      <button id="resetChat" type="button">New conversation</button></div>
    </section>`;
  const $=id=>host.querySelector('#'+id);
  function render(){
    $('suggestion').textContent=DEMO.stages[sequence.stage].prompt;
    $('suggestion').hidden=sequence.stage==='complete';
    $('resetChat').textContent=sequence.stage==='complete'?'Replay / Reset':'New conversation';
    $('chatSend').disabled=sequence.pending;
    $('chatPending').textContent=sequence.pending?'Preparing scene…':'';
  }
  function message(role,text){const p=document.createElement('p');p.className='chat-'+role;p.textContent=`${role==='user'?'You':'Torsade'}: ${text}`;$('chatHistory').append(p);$('chatHistory').scrollTop=$('chatHistory').scrollHeight;}
  function reset(notice=''){sequence.reset();$('chatHistory').replaceChildren();$('chatInput').value='';$('demoNotice').textContent=notice;resetScene();render();}
  function setOpen(open) {
    drawerOpen=open;
    $('chatDrawer').classList.toggle('open',open);
    $('chatDrawer').inert=!open;
    $('chatDrawer').setAttribute('aria-hidden',String(!open));
    $('chatLauncher').setAttribute('aria-expanded',String(open));
    $('chatBackdrop').hidden=!open;
    (open?$('chatInput'):$('chatLauncher')).focus();
  }
  $('chatLauncher').onclick=()=>setOpen(!drawerOpen);
  $('chatClose').onclick=()=>setOpen(false);
  $('chatBackdrop').onclick=()=>setOpen(false);
  $('chatDrawer').onkeydown=e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setOpen(false);}
    if(e.key==='Tab'){
      const controls=[...$('chatDrawer').querySelectorAll('button,textarea')].filter(el=>!el.hidden&&!el.disabled);
      const first=controls[0],last=controls.at(-1);
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
    }
  };
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
  $('resetChat').onclick=()=>reset();
  onMode(active);
  if(active)reset();
  addEventListener('pagehide',()=>sequence.reset());
  render();
  return {get active(){return active;},get stage(){return sequence.stage;},
    manualChange(){if(active)reset('Settings changed. Start a new conversation with the suggested prompt.');}};
}
