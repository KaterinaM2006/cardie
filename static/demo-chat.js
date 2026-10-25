const EXAMPLE_PROMPT = 'show me terfenadine at 3x Cmax';
const DEFAULT_NOTICE = 'Ask about any of the 12 CiPA compounds — parsed and '
  + 'answered live by Gemini, grounded in the already-computed simulation.';

// A genuinely free-text chat: the message goes to /api/chat, which asks
// Gemini to parse it into a compound + dose and then explains the already
// -computed result for that pair. No scripted stages, no fixed vocabulary.
export function createDemoChat({host,enabled,apply,resetScene,onMode}) {
  const active=Boolean(enabled);
  let drawerOpen=false, pending=false, generation=0;
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
      <form id="chatForm"><label for="chatInput">Your message</label><textarea id="chatInput" rows="3" placeholder="Ask about a compound, e.g. is verapamil safe at 2x dose?"></textarea><button id="chatSend" type="submit">Send</button> <span id="chatPending" role="status"></span></form>
      <button id="resetChat" type="button">New conversation</button></div>
    </section>`;
  const $=id=>host.querySelector('#'+id);
  $('suggestion').textContent=`Try: "${EXAMPLE_PROMPT}"`;
  function render(){
    $('chatSend').disabled=pending;
    $('chatPending').textContent=pending?'Asking Gemini…':'';
  }
  function message(role,text){const p=document.createElement('p');p.className='chat-'+role;p.textContent=`${role==='user'?'You':'Torsade'}: ${text}`;$('chatHistory').append(p);$('chatHistory').scrollTop=$('chatHistory').scrollHeight;}
  function reset(notice=''){
    generation++; pending=false;
    $('chatHistory').replaceChildren();$('chatInput').value='';
    $('demoNotice').textContent=notice||DEFAULT_NOTICE;
    resetScene();render();
  }
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
  $('suggestion').onclick=()=>{$('chatInput').value=EXAMPLE_PROMPT;$('chatInput').focus();};
  $('chatForm').onsubmit=async e=>{
    e.preventDefault();const text=$('chatInput').value.trim();if(!active||pending||!text)return;
    const gen=generation;
    message('user',text);$('chatInput').value='';
    pending=true;render();
    let reply;
    try { ({reply}=await apply(text)); }
    catch { reply="Sorry, I couldn't reach Gemini just now. Please try again."; }
    if(gen!==generation)return;   // a reset happened while this was in flight
    pending=false;
    message('assistant',reply);
    render();
  };
  $('chatInput').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('chatForm').requestSubmit();}};
  $('resetChat').onclick=()=>reset();
  onMode(active);
  if(active)reset();
  addEventListener('pagehide',()=>{generation++;});
  render();
  return {get active(){return active;},
    manualChange(){if(active)$('demoNotice').textContent='The dose slider and scenario buttons act on their own view; this chat keeps its own conversation.';}};
}
