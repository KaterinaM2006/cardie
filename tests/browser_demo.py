"""Real Chrome UI regression via CDP. No app state functions are called.
Start Flask with TORSADE_DEMO_ENABLED=1 PORT=5055, then Chrome with
--headless=new --no-sandbox --enable-unsafe-swiftshader --remote-debugging-port=9231.
Run: .venv/bin/python tests/browser_demo.py (requires websockets).
"""
import asyncio
import base64
import json
import os
from pathlib import Path
import urllib.request
import websockets

URL = os.environ.get('DEMO_TEST_URL', 'http://127.0.0.1:5055')
class Browser:
    def __init__(self): self.ident=0; self.events=[]
    async def __aenter__(self):
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        tabs=json.load(opener.open('http://127.0.0.1:9231/json'))
        self.ws=await websockets.connect(next(t for t in tabs if t['type']=='page')['webSocketDebuggerUrl'],max_size=30000000,proxy=None)
        for command in ['Runtime.enable','Log.enable','Network.enable']: await self.call(command)
        return self
    async def __aexit__(self,*args): await self.ws.close()
    async def call(self,method,params=None):
        self.ident+=1; ident=self.ident
        await self.ws.send(json.dumps(dict(id=ident,method=method,params=params or {})))
        while True:
            msg=json.loads(await asyncio.wait_for(self.ws.recv(),30))
            if msg.get('id')==ident:
                if 'error' in msg: raise RuntimeError(msg)
                return msg.get('result',{})
            self.events.append(msg)
    async def js(self,expression):
        r=await self.call('Runtime.evaluate',dict(expression=expression,returnByValue=True,awaitPromise=True))
        if 'exceptionDetails' in r: raise RuntimeError(r)
        return r.get('result',{}).get('value')
    async def wait(self,expression):
        for _ in range(150):
            if await self.js(expression): return
            await asyncio.sleep(.1)
        raise AssertionError('Timed out: '+expression)
    async def click(self,selector):
        # Native pointer events, including scrolling the control into view.
        r=await self.js(f"(()=>{{const e=document.querySelector({json.dumps(selector)});e.scrollIntoView({{block:'center'}});const r=e.getBoundingClientRect();return {{x:r.x+r.width/2,y:r.y+r.height/2}};}})()")
        for typ in ['mousePressed','mouseReleased']: await self.call('Input.dispatchMouseEvent',dict(type=typ,button='left',clickCount=1,**r))
    async def key(self,key,**kwargs):
        codes={'Enter':13,'Home':36,'End':35,'Escape':27,'ArrowLeft':37,'ArrowUp':38,'ArrowRight':39,'ArrowDown':40,'PageUp':33,'PageDown':34}
        if key in codes:kwargs.setdefault('windowsVirtualKeyCode',codes[key])
        if key=='Enter':kwargs.update(text='\r',unmodifiedText='\r')
        await self.call('Input.dispatchKeyEvent',dict(type='keyDown',key=key,**kwargs));await self.call('Input.dispatchKeyEvent',dict(type='keyUp',key=key,**kwargs))
    async def select(self,selector,value):
        index=await self.js(f"[...document.querySelector({json.dumps(selector)}).options].findIndex(o=>o.value==={json.dumps(value)})")
        assert index>=0
        await self.click(selector);await self.key('Home')
        for _ in range(index):await self.key('ArrowDown')
        await self.key('Enter')
        assert await self.js(f"document.querySelector({json.dumps(selector)}).value==={json.dumps(value)}")
    async def type(self,text): await self.call('Input.insertText',dict(text=text))
    async def send(self,text):
        await self.click('#chatInput');await self.type(text);await self.key('Enter')
        await self.wait("!document.querySelector('#chatSend').disabled")
    async def stage(self): return await self.js("document.querySelector('#demoStage').textContent")
    async def shot(self,name):
        data=await self.call('Page.captureScreenshot',{'format':'png'})
        Path('/tmp/'+name+'.png').write_bytes(base64.b64decode(data['data']))

async def main():
 async with Browser() as b:
    await b.call('Emulation.setDeviceMetricsOverride',dict(width=1440,height=900,deviceScaleFactor=1,mobile=False))
    await b.call('Page.navigate',dict(url=URL))
    await b.wait("!!document.querySelector('#demoToggle')")
    assert await b.js("document.querySelector('#demoPanel').hidden")
    # Existing manual selection / camera workflow through native keys and clicks.
    await b.select('#drug','verapamil')
    await b.click('#dose');await b.key('ArrowRight')
    await b.click('#enterButton');await b.wait("document.body.dataset.stage==='cell'")
    await b.click('#back');await b.wait("document.body.dataset.stage==='heart'")
    await b.click('#demoToggle')
    assert await b.stage()=='await_single_request'
    assert await b.js("document.querySelector('#chatHistory').children.length===0 && document.querySelector('#drug').value==='dofetilide' && +document.querySelector('#dose').value===1")
    await asyncio.sleep(4.2)
    assert await b.stage()=='await_single_request'
    await b.call('Network.emulateNetworkConditions',dict(offline=True,latency=0,downloadThroughput=-1,uploadThroughput=-1))
    await b.send('What happens if both are taken together?')
    await b.send('hello!')
    await b.send('Show dofetilide at 3x reference exposure')
    assert await b.stage()=='await_single_request'
    await b.click('#suggestion')
    assert await b.js("document.querySelector('#chatInput').value.includes('2x') && +document.querySelector('#dose').value===1")
    await asyncio.sleep(.5)
    assert await b.stage()=='await_single_request'
    await b.key('Enter')
    await b.wait("document.querySelector('#demoStage').textContent==='await_comparison_request'")
    assert await b.js("document.querySelector('#drug').value==='dofetilide' && +document.querySelector('#dose').value===2 && document.querySelector('#apdNote').textContent.includes('346.9')")
    await b.send('Compare it with VERAPAMIL at the same exposure!')
    assert await b.stage()=='await_combination_request'
    await b.wait("document.body.dataset.scenario==='comparison'")
    assert await b.js("document.querySelector('#labelA').textContent.includes('dofetilide') && document.querySelector('#labelB').textContent.includes('verapamil') && document.querySelector('#metricsA').textContent.includes('346.9') && document.querySelector('#metricsB').textContent.includes('300.2')")
    assert await b.js("['A','B'].every(k=>{const r=document.querySelector('#animation'+k).getBoundingClientRect();return r.width>100&&r.height>100})")
    # Screenshot plus actual rendered pixel differences: different waveforms and frames, not just containers.
    await b.click('#play')
    await b.click('#scrub');await b.key('Home');
    await b.key('PageUp')
    await b.click('#multiScene');await b.shot('torsade-comparison')
    assert await b.js("document.querySelector('#chartA').toDataURL()!==document.querySelector('#chartB').toDataURL()")
    await b.send('What if both are taken together?')
    assert await b.stage()=='complete'
    assert await b.js("document.body.dataset.scenario==='combined' && document.querySelector('#multiScene').dataset.source==='illustrative_combination' && document.querySelector('#sceneSource').textContent.includes('not a validated') && document.querySelector('#combinedScene').textContent.includes('Not calculated')")
    await b.click('#multiScene');await b.shot('torsade-combined')
    await b.click('#compareView')
    assert await b.stage()=='complete'
    assert await b.js("document.body.dataset.scenario==='comparison'")
    await b.click('#resetDemo');assert await b.stage()=='await_single_request'
    print('PASS initial sequence and A/B / combined views',flush=True)
    # Submit twice rapidly; there must be only one user/success message pair.
    await b.click('#suggestion');await b.key('Enter');await b.key('Enter')
    await b.wait("document.querySelector('#demoStage').textContent==='await_comparison_request'")
    assert await b.js("document.querySelector('#chatHistory').children.length===2")
    await b.click('#resetDemo');await b.click('#suggestion');await b.key('Enter');await b.click('#resetDemo')
    await asyncio.sleep(.6)
    assert await b.stage()=='await_single_request'
    assert await b.js("document.querySelector('#chatHistory').children.length===0 && +document.querySelector('#dose').value===1")
    # Repeat all three documented prompts after reset.
    for stage in ['await_single_request','await_comparison_request','await_combination_request']:
        assert await b.stage()==stage
        await b.click('#suggestion');await b.key('Enter');await b.wait("!document.querySelector('#chatSend').disabled")
    assert await b.stage()=='complete'
    await b.click('#resetDemo');await b.click('#suggestion');await b.key('Enter');await b.call('Network.emulateNetworkConditions',dict(offline=False,latency=0,downloadThroughput=-1,uploadThroughput=-1));await b.click('#demoToggle');await asyncio.sleep(.6)
    assert await b.js("document.querySelector('#demoPanel').hidden && document.body.dataset.scenario==='single' && +document.querySelector('#dose').value===1")
    print('PASS duplicate/reset/mode races and repeated sequence',flush=True)
    await b.call('Network.emulateNetworkConditions',dict(offline=False,latency=0,downloadThroughput=-1,uploadThroughput=-1))
    # Normal manual A/B, supported preset and unsupported pair handling.
    await b.click('#dose');await b.key('Home')
    # Range step is 0.05, move with native keyboard to 2x.
    step=await b.js("+document.querySelector('#dose').step")
    for _ in range(round(2/step)): await b.key('ArrowRight')
    await b.click('#compareView')
    assert await b.js("document.body.dataset.scenario==='comparison' && document.querySelector('#metricsA').textContent.includes('346.9') && document.querySelector('#metricsB').textContent.includes('300.2')")
    await b.click('#combinedView');assert await b.js("document.body.dataset.scenario==='combined'")
    await b.select('#partner','quinidine');await b.click('#combinedView')
    assert await b.js("document.querySelector('#sceneNotice').textContent.includes('No combined scenario') && document.body.dataset.scenario==='single'")
    # Manual drug/exposure changes explicitly invalidate an active sequence.
    await b.click('#demoToggle');await b.send('Show DOFETILIDE at twice Cmax!')
    await b.click('#dose');await b.key('ArrowRight')
    assert await b.stage()=='await_single_request'
    assert await b.js("document.querySelector('#demoNotice').textContent.includes('reset')")
    # Laptop layout, including side-by-side animation and chat.
    await b.call('Emulation.setDeviceMetricsOverride',dict(width=1366,height=768,deviceScaleFactor=1,mobile=False))
    await b.click('#resetDemo')
    await b.send('Show dofetilide at 2x Cmax');await b.send('Compare it with verapamil at the same exposure')
    await b.click('#multiScene');await b.shot('torsade-laptop')
    assert await b.js("document.documentElement.scrollWidth<=innerWidth && ['A','B'].every(k=>{let r=document.querySelector('#animation'+k).getBoundingClientRect();return r.width>=150&&r.right<=innerWidth})")
    # Shift+Enter inserts a newline without sending.
    await b.click('#chatInput');await b.type('test');await b.key('Enter',modifiers=8)
    assert await b.js("document.querySelector('#chatInput').value.includes('\\n')")
    assert await b.stage()=='await_combination_request'
    errors=[e for e in b.events if e.get('method')=='Runtime.exceptionThrown' or e.get('method')=='Log.entryAdded' and e['params']['entry']['level']=='error' or e.get('method')=='Network.loadingFailed']
    assert not errors,json.dumps(errors)
    print('PASS: normal workflow, user-paced sequence, rejection/paraphrase, A/B identities, combined provenance, reset/races, mode cancellation, manual presets, laptop layout, console/network')

if __name__=='__main__': asyncio.run(main())
