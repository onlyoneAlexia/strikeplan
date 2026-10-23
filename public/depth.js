const art = document.querySelector('.hero-art');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const fine = matchMedia('(pointer: fine)');
if (art) {
  const chart = document.createElement('div'); chart.className = 'chart-3d';
  chart.innerHTML = `<div class="chart-orbit" aria-hidden="true"></div><div class="chart-viewport" tabindex="0" role="group" aria-label="Interactive illustrative candlestick chart. Drag or use arrow keys to rotate. Press Home to reset."><div class="chart-model"><div class="chart-plane"><div class="chart-title">BTC / USD <span>ILLUSTRATIVE CHART</span></div><div class="chart-axis"><span>SIGNAL</span><span>VALIDATE</span><span>EXECUTE</span></div></div></div></div><div class="chart-float float-left" aria-hidden="true"><small>YOUR STRATEGY</small><b>Signal detected ↗</b></div><div class="chart-float float-right" aria-hidden="true"><small>BUILT FOR STRIKE</small><b>Execution, connected.</b></div><div class="chart-tooltip" hidden><strong>ILLUSTRATIVE CANDLE</strong><span></span></div><div class="chart-controls"><span>DRAG TO EXPLORE · SELECT A CANDLE</span><div class="orbit-buttons"><button type="button" aria-label="Rotate chart left">←</button><button type="button" aria-label="Rotate chart right">→</button><button type="button" aria-label="Reset chart view">Reset view</button></div></div>`;
  const model = chart.querySelector('.chart-model'), viewport = chart.querySelector('.chart-viewport'), plane = chart.querySelector('.chart-plane');
  const tooltip = chart.querySelector('.chart-tooltip');
  const points = [155,146,150,133,121,124,104,90,73,58,70,62,48,92,108,80,89,54,58,31,51,57,85,120,94,116,108,126,128,102,51,21,-9,1,-5,-22,-33,-25,-47,-26,-56,-59,-86,-112];
  const colors = ['#00606a','#28123e','#85054e','#b50b35','#d48a00','#a9b500'];
  const lights = ['#138f96','#55315f','#b8277d','#dc365b','#efb530','#d0db39'];
  points.forEach((close, index) => {
    const open = index ? points[index-1] : 164, high = Math.min(open,close)-10-(index%4)*3, low = Math.max(open,close)+10+(index%3)*5;
    const top = Math.min(open,close)*.8+185, height = Math.max(5,Math.abs(close-open)*.8);
    const candle = document.createElement('button'); candle.type='button'; candle.className='candle-3d';
    const color = Math.min(5,Math.floor(index/7.5));
    candle.style.cssText=`left:${32+index*12}px;top:${top}px;height:${height}px;--candle-color:${colors[color]};--candle-light:${lights[color]};--wick-top:${high*.8+185-top}px;--wick-height:${(low-high)*.8}px`;
    candle.innerHTML='<span class="candle-face"></span><span class="candle-side"></span><span class="candle-top"></span>';
    const price = value => (100000-value*50).toLocaleString('en-US');
    candle.setAttribute('aria-label',`Illustrative candle ${index+1}. Open ${price(open)}, close ${price(close)}.`);
    const show = () => { tooltip.hidden=false; tooltip.querySelector('span').textContent=`CANDLE ${String(index+1).padStart(2,'0')} · SAMPLE DATA\nO  ${price(open)}    C  ${price(close)}\nH  ${price(high)}    L  ${price(low)}`; };
    candle.addEventListener('pointerenter',show); candle.addEventListener('focus',show); candle.addEventListener('click',show);
    candle.addEventListener('pointerleave',()=>{if(document.activeElement!==candle)tooltip.hidden=true});
    candle.addEventListener('blur',()=>tooltip.hidden=true);
    // Keep keyboard navigation concise while retaining individual pointer exploration.
    candle.tabIndex=index%7===0 ? 0 : -1; plane.append(candle);
  });
  art.querySelector('img')?.remove(); art.removeAttribute('aria-hidden'); art.prepend(chart);
  let rx=16,ry=-18,drag=null,frame=0;
  function paint(){frame=0;model.style.setProperty('--chart-rx',`${rx}deg`);model.style.setProperty('--chart-ry',`${ry}deg`)}
  function update(){if(!frame)frame=requestAnimationFrame(paint)}
  function reset(){rx=16;ry=-18;tooltip.hidden=true;update()}
  function resize(){model.style.setProperty('--chart-scale',String(Math.min(1,(art.clientWidth-22)/620,Math.max(.3,(art.clientHeight-75)/440))))}
  new ResizeObserver(resize).observe(art);resize();
  viewport.addEventListener('pointerdown',event=>{if(reduced.matches||event.pointerType==='touch'||event.target.closest('button'))return;drag={x:event.clientX,y:event.clientY,rx,ry};viewport.setPointerCapture(event.pointerId);viewport.classList.add('is-dragging')});
  viewport.addEventListener('pointermove',event=>{if(reduced.matches||!fine.matches)return;const box=viewport.getBoundingClientRect();if(drag){ry=Math.max(-40,Math.min(40,drag.ry+(event.clientX-drag.x)*.16));rx=Math.max(-20,Math.min(35,drag.rx-(event.clientY-drag.y)*.12))}else{ry=-18+((event.clientX-box.left)/box.width-.5)*15;rx=16-((event.clientY-box.top)/box.height-.5)*12}update()});
  function release(){drag=null;viewport.classList.remove('is-dragging')}
  viewport.addEventListener('pointerup',release);viewport.addEventListener('pointercancel',release);viewport.addEventListener('lostpointercapture',release);
  viewport.addEventListener('pointerleave',()=>{if(!drag)reset()});
  viewport.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','Escape'].includes(event.key))return;event.preventDefault();if(event.key==='Escape'||event.key==='Home')return reset();if(reduced.matches)return;ry=Math.max(-40,Math.min(40,ry+(event.key==='ArrowLeft'?-5:event.key==='ArrowRight'?5:0)));rx=Math.max(-20,Math.min(35,rx+(event.key==='ArrowUp'?-5:event.key==='ArrowDown'?5:0)));update()});
  const buttons=chart.querySelectorAll('.orbit-buttons button');buttons[0].addEventListener('click',()=>{if(!reduced.matches){ry=Math.max(-40,ry-8);update()}});buttons[1].addEventListener('click',()=>{if(!reduced.matches){ry=Math.min(40,ry+8);update()}});buttons[2].addEventListener('click',reset);
  reduced.addEventListener('change',reset);
}
if(fine.matches&&!reduced.matches){
  document.querySelectorAll('.metrics>.card,.columns>.card,.tester').forEach(card=>{
    card.classList.add('depth-card');let frame;
    card.addEventListener('pointermove',event=>{if(reduced.matches||event.target.closest('input,select,button'))return;cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const b=card.getBoundingClientRect(),x=(event.clientX-b.left)/b.width-.5,y=(event.clientY-b.top)/b.height-.5;card.style.setProperty('--tilt-axis',`${-y} ${x} 0`);card.style.setProperty('--tilt-angle',`${Math.hypot(x,y)*4}deg`);card.classList.add('is-tilting')})});
    card.addEventListener('pointerleave',()=>{cancelAnimationFrame(frame);card.style.setProperty('--tilt-angle','0deg');card.classList.remove('is-tilting')});
  });
}
