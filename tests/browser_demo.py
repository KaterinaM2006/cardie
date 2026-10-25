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
    async def open_chat(self):
        await self.click('#chatLauncher')
        await self.wait("document.querySelector('#chatDrawer').getBoundingClientRect().left===0 && document.activeElement.id==='chatInput'")
    async def send(self,text):
        await self.click('#chatInput');await self.type(text);await self.key('Enter')
        await self.wait("!document.querySelector('#chatSend').disabled")
    async def stage(self): return await self.js("document.querySelector('#demoStage').textContent")
    async def shot(self,name):
        data=await self.call('Page.captureScreenshot',{'format':'png'})
        Path('/tmp/'+name+'.png').write_bytes(base64.b64decode(data['data']))

async def main():
 async with Browser() as b:
    await b.call('Emulation.setDeviceMetricsOverride',dict(width=1366,height=768,deviceScaleFactor=1,mobile=False))
    await b.call('Page.navigate',dict(url=URL+'/?demo=0'))
    await b.wait("!!document.querySelector('#chatLauncher')")
    assert await b.js("!document.querySelector('#demoToggle') && !document.querySelector('#demoStage') && !document.querySelector('#resetDemo') && !/scripted demo|demo mode/i.test(document.body.innerText)")
    assert await b.js("document.querySelector('#chatDrawer').inert && document.querySelector('#chatHistory').children.length===0 && +document.querySelector('#dose').value===1")
    bounds="JSON.stringify(['#cell','#scenarioHost','#scientificSidebar'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.width,r.height]}))"
    before=await b.js(bounds)
    await b.open_chat();await asyncio.sleep(.35)
    await b.wait("document.querySelector('#chatLauncher').getAttribute('aria-expanded')==='true' && Math.abs(document.querySelector('#chatDrawer').getBoundingClientRect().left)<1 && document.activeElement.id==='chatInput'")
    assert before==await b.js(bounds),'Opening chat moved the application'
    await asyncio.sleep(2.2)
    assert await b.js("document.querySelector('#chatHistory').children.length===0 && +document.querySelector('#dose').value===1")
    await b.click('#suggestion')
    assert await b.js("document.querySelector('#chatInput').value.includes('2x') && +document.querySelector('#dose').value===1")
    await b.key('Escape');await asyncio.sleep(.3)
    assert await b.js("document.querySelector('#chatDrawer').inert && document.activeElement.id==='chatLauncher'")
    assert before==await b.js(bounds),'Closing chat moved the application'
    await b.open_chat();await b.click('#chatInput');await b.key('Enter')
    await b.wait("document.querySelector('#chatHistory').textContent.includes('346.9')")
    assert await b.js("document.querySelector('#drug').value==='dofetilide' && +document.querySelector('#dose').value===2 && document.querySelector('#apdNote').textContent.includes('346.9')")
    await b.send('hello')
    await b.send('Show dofetilide at 3x reference exposure')
    assert await b.js("document.body.dataset.scenario==='single' && +document.querySelector('#dose').value===2")
    await b.send('Compare it with verapamil at the same exposure')
    assert await b.js("document.body.dataset.scenario==='comparison' && document.querySelector('#metricsA').textContent.includes('346.9') && document.querySelector('#metricsB').textContent.includes('300.2') && document.querySelector('#chartA').toDataURL()!==document.querySelector('#chartB').toDataURL()")
    # Native click outside the drawer closes the overlay without activating the background.
    await b.click('#sceneTitle');await asyncio.sleep(.3)
    assert await b.js("document.querySelector('#chatDrawer').inert")
    await b.shot('torsade-drawer-closed')
    await b.open_chat();await b.send('What happens if both are taken together?')
    assert await b.js("document.body.dataset.scenario==='combined' && document.querySelector('#sceneSource').textContent.includes('not a validated') && document.querySelector('#combinedScene').textContent.includes('Not calculated') && !/scripted demo|demo mode/i.test(document.body.innerText)")
    await b.shot('torsade-drawer-open')
    await b.click('#resetChat');await b.click('#suggestion');await b.key('Enter');await b.click('#resetChat')
    await asyncio.sleep(.6)
    assert await b.js("document.querySelector('#chatHistory').children.length===0 && +document.querySelector('#dose').value===1 && document.body.dataset.scenario==='single'")
    await b.click('#suggestion');await b.key('Enter');await b.key('Enter')
    await b.wait("!document.querySelector('#chatSend').disabled")
    assert await b.js("document.querySelector('#chatHistory').children.length===2")
    await b.click('#chatInput');await b.type('test');await b.key('Enter',modifiers=8)
    assert await b.js("document.querySelector('#chatInput').value.includes('\\n') && document.querySelector('#chatHistory').children.length===2")
    # Focus remains inside the drawer and is restored on close.
    await b.click('#resetChat');await b.key('Tab')
    assert await b.js("document.activeElement.id==='chatClose'")
    await b.click('#chatClose');await asyncio.sleep(.3)
    assert await b.js("document.activeElement.id==='chatLauncher'")
    await b.call('Emulation.setDeviceMetricsOverride',dict(width=390,height=844,deviceScaleFactor=1,mobile=False))
    await b.open_chat();await asyncio.sleep(.3)
    assert await b.js("Math.abs(document.querySelector('#chatDrawer').getBoundingClientRect().width-innerWidth)<1 && document.documentElement.scrollWidth<=innerWidth")
    await b.shot('torsade-drawer-mobile')
    errors=[e for e in b.events if e.get('method')=='Runtime.exceptionThrown' or e.get('method')=='Log.entryAdded' and e['params']['entry']['level']=='error' or e.get('method')=='Network.loadingFailed']
    assert not errors,json.dumps(errors)
    print('PASS: startup-only mode, hidden mode indicators, overlay without layout shift, open/close/Escape/backdrop/focus trap, full sequence, reset/duplicate races, Shift+Enter, mobile width, console/network')

if __name__=='__main__': asyncio.run(main())
