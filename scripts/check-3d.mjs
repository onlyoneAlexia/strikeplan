import {mkdirSync,writeFileSync} from 'node:fs';
const info=await(await fetch('http://localhost:9223/json/version')).json();const socket=new WebSocket(info.webSocketDebuggerUrl);await new Promise(resolve=>socket.onopen=resolve);
let id=0;const requests=new Map(),errors=[];
socket.onmessage=event=>{const m=JSON.parse(event.data);if(m.id){const p=requests.get(m.id);requests.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text)};
const command=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const n=++id;requests.set(n,{resolve,reject});socket.send(JSON.stringify({id:n,method,params,...(sessionId?{sessionId}:{})}))});
const {targetId}=await command('Target.createTarget',{url:'about:blank'});const{sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});const call=(m,p)=>command(m,p,sessionId);const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
try{
await call('Page.enable');await call('Runtime.enable');await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await call('Page.navigate',{url:'http://localhost:8787'});await wait(3000);
const count=await evaluate(`document.querySelectorAll('.candle-3d').length`);if(count!==44)throw Error('Missing 3D candles');
await evaluate(`document.querySelectorAll('.orbit-buttons button')[1].click()`);await wait(700);
const rotation=await evaluate(`document.querySelector('.chart-model').style.getPropertyValue('--chart-ry')`);if(rotation!=='-10deg')throw Error('Rotation control did not respond');
await evaluate(`document.querySelector('.candle-3d').click()`);if(!await evaluate(`!document.querySelector('.chart-tooltip').hidden`))throw Error('Candle inspection failed');
await evaluate(`document.querySelectorAll('.orbit-buttons button')[2].click()`);await wait(700);
mkdirSync('artifacts',{recursive:true});let shot=await call('Page.captureScreenshot',{format:'png'});writeFileSync('artifacts/dashboard-3d-desktop.png',Buffer.from(shot.data,'base64'));
await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await wait(1500);
const width=await evaluate(`({viewport:innerWidth,page:document.documentElement.scrollWidth,controls:getComputedStyle(document.querySelector('.hero-art')).pointerEvents})`);if(width.page>width.viewport)throw Error('Mobile horizontal overflow');if(width.controls==='none')throw Error('Mobile controls are blocked');shot=await call('Page.captureScreenshot',{format:'png'});writeFileSync('artifacts/dashboard-3d-mobile.png',Buffer.from(shot.data,'base64'));
await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await wait(200);const reduced=await evaluate(`getComputedStyle(document.querySelector('.chart-model')).transform`);if(!reduced)throw Error('Reduced-motion chart missing');
if(errors.length)throw Error(errors.join('; '));console.log(JSON.stringify({candles:count,rotationControl:'passed',candleInspection:'passed',mobile:width,reducedMotion:'passed',browserErrors:errors.length}));
}finally{await command('Target.closeTarget',{targetId});socket.close()}
