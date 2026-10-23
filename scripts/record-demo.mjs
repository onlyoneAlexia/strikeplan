// Records an isolated, paper-only instance with the local Edge DevTools protocol.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createApp } from '../server.mjs';
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
const app = createApp({directory:`.data/recording-instance-${Date.now()}`,mode:'paper'});
await new Promise(resolve => app.server.listen(8788,'127.0.0.1',resolve));
const info = await (await fetch('http://localhost:9223/json/version')).json();
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
let id=0; const pending=new Map(),frames=[]; let started=0;
ws.onmessage=event=>{
  const message=JSON.parse(event.data);
  if(message.id){const p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(Error(message.error.message)):p.resolve(message.result);}}
  if(message.method==='Page.screencastFrame'){
    const now=Date.now();if(!started)started=now;
    frames.push({time:now-started,data:message.params.data});
    command('Page.screencastFrameAck',{sessionId:message.params.sessionId},message.sessionId).catch(()=>{});
  }
};
function command(method,params={},sessionId){return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params,...(sessionId?{sessionId}:{})}));});}
const target=await command('Target.createTarget',{url:'about:blank'});
const {sessionId}=await command('Target.attachToTarget',{targetId:target.targetId,flatten:true});
const call=(method,params={})=>command(method,params,sessionId);
async function evaluate(expression){const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);return result.result?.value;}
try {
  await call('Page.enable');await call('Runtime.enable');
  // This isolated recording tab needs data images for canvas encoding and a caption overlay.
  await call('Page.setBypassCSP',{enabled:true});
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await call('Page.navigate',{url:'http://localhost:8788'});await wait(3000);
  await evaluate(`(()=>{const bar=document.createElement('div');bar.id='recording-label';bar.textContent='STRIKEPLAN PAPER DEMO / No exchange orders';bar.style.cssText='position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:9999;background:#172010;color:#e9edda;padding:12px 24px;font:12px Arial;letter-spacing:1px;border-bottom:3px solid #a5b307';document.body.append(bar)})()`);
  mkdirSync('artifacts',{recursive:true});
  const shot=await call('Page.captureScreenshot',{format:'png'});writeFileSync('artifacts/strikeplan-desktop.png',Buffer.from(shot.data,'base64'));
  await call('Page.startScreencast',{format:'jpeg',quality:75,maxWidth:1440,maxHeight:900,everyNthFrame:2});
  async function scene(caption,expression,duration=3500){
    await evaluate(`document.getElementById('recording-label').textContent=${JSON.stringify(caption)}`);
    if(expression)await evaluate(expression);await wait(duration);console.log(caption);
  }
  await scene('STRIKEPLAN / Your risk. Your rules. Your trade.',`window.scrollTo({top:0,behavior:'smooth'})`,3000);
  await scene('01 / Choose your risk budget, limit entry, stop and target.',`document.getElementById('planner').scrollIntoView({behavior:'smooth',block:'start'})`,4000);
  await scene('02 / Fees and stop-slippage estimates are included in sizing.',`document.querySelector('.cost-assumptions').open=true;document.querySelector('.plan-results').scrollIntoView({behavior:'smooth',block:'center'})`,3500);
  await scene('03 / Review a server-calculated plan before submitting.',`document.getElementById('plan-form').requestSubmit()`,3000);
  await scene('04 / Confirm a PAPER position with simulated protection.',`document.getElementById('acknowledge').click();document.getElementById('execute').click()`,3500);
  await scene('05 / Entry, stop and target have separate status indicators.',`document.getElementById('monitor').scrollIntoView({behavior:'smooth',block:'start'})`,3000);
  await scene('06 / Simulate a stop hit and inspect the modeled net result.',`document.querySelector('.plan-row .buttons button').click()`,4000);
  await scene('NEXT / Connect a Strike testnet wallet for native bracket orders.',`window.scrollTo({top:0,behavior:'smooth'})`,3000);
  await call('Page.stopScreencast');
  if(!frames.length)throw Error('Browser produced no recording frames.');
  console.log(`Captured ${frames.length} real browser frames. Encoding WebM…`);
  // Encode the captured real browser frames with the browser's native MediaRecorder.
  await evaluate(`window.demoFrames=${JSON.stringify(frames)}; window.demoDuration=${Date.now()-started}; true`);
  const encoded = await evaluate(`(async()=>{
    const canvas=document.createElement('canvas');canvas.width=1440;canvas.height=900;const ctx=canvas.getContext('2d');
    const stream=canvas.captureStream(24);const types=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'];const mimeType=types.find(t=>MediaRecorder.isTypeSupported(t));
    const recorder=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:3500000});const chunks=[];recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
    const finished=new Promise(resolve=>recorder.onstop=resolve);recorder.start(1000);const origin=performance.now();
    for(const frame of window.demoFrames){const image=new Image();image.src='data:image/jpeg;base64,'+frame.data;await image.decode();const delay=frame.time-(performance.now()-origin);if(delay>0)await new Promise(r=>setTimeout(r,delay));ctx.drawImage(image,0,0,1440,900)}
    const tail=window.demoDuration-(performance.now()-origin);if(tail>0)await new Promise(r=>setTimeout(r,tail));recorder.stop();await finished;stream.getTracks().forEach(t=>t.stop());
    const bytes=new Uint8Array(await new Blob(chunks,{type:mimeType}).arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(binary)
  })()`);
  writeFileSync('artifacts/strikeplan-paper-demo.webm',Buffer.from(encoded,'base64'));
  writeFileSync('artifacts/strikeplan-evidence.json',JSON.stringify({mode:'paper',recordedAt:new Date().toISOString(),frames:frames.length,plans:app.planner.list(),liveStrikeVerified:false},null,2));
  console.log('Saved artifacts/strikeplan-paper-demo.webm and desktop screenshot.');
} finally { await command('Target.closeTarget',{targetId:target.targetId}).catch(()=>{});ws.close();await new Promise(resolve=>app.server.close(resolve)); }
