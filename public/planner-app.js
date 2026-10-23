import {calculatePlan,PAPER_RULES} from './risk.mjs';
const $=id=>document.getElementById(id),money=n=>n==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(n);
let token=sessionStorage.getItem('signalbridge-token')||'',connected=false,mode='paper',direction='long',review=null,rules=PAPER_RULES,plans=[],generated=false,connectionDirty=false,toastTimer,hosted=false,refreshing=false;
const fields=['budget','entry','stop','target','leverage','feeBps','slippageBps'];
const input=()=>Object.fromEntries([['direction',direction],...fields.map(key=>[key,$(key).value])]);
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6000)}
async function api(path,options={}){const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...options.headers}});const result=await response.json();if(!response.ok)throw Error(result.error||`Request failed (${response.status}).`);return result}
function invalidate(){review=null;$('review').hidden=true;$('acknowledge').checked=false;$('execute').disabled=true;$('preview-status').textContent='ESTIMATE'}
function calculate(){
  try{
    const p=calculatePlan(input(),rules);$('plan-error').hidden=true;
    $('size').textContent=p.quantityText;$('loss').textContent=money(p.intendedLoss);$('margin').textContent=money(p.margin);$('notional').textContent=money(p.notional);$('ratio').textContent=p.rewardRisk===null?'No target':`${p.rewardRisk.toFixed(2)} : 1`;
    $('price-loss').textContent=money(p.priceLoss);$('fees').textContent=money(p.estimatedFees);$('slippage').textContent=money(p.slippageBuffer);$('profit').textContent=money(p.targetProfit);
    for(const[id,value]of[['price-segment',p.priceLoss],['fees-segment',p.estimatedFees],['slip-segment',p.slippageBuffer]])$(id).style.width=`${value/p.intendedLoss*100}%`;
    $('risk-explanation').textContent=`${money(p.budget)} budget → ${p.quantityText} BTC. ${p.warnings.join(' ')}`;
    $('rules-source').textContent=`${rules.source} · Size increment ${rules.stepSize} BTC · Price increment ${money(rules.tickSize)}. Fees are your editable estimate.`;
    return p;
  }catch(e){$('plan-error').hidden=false;$('plan-error').textContent=e.message;$('size').textContent='—';for(const id of ['loss','margin','notional','ratio','price-loss','fees','slippage','profit'])$(id).textContent='—';$('risk-explanation').textContent='Correct the inputs to calculate your position.';return null}
}
fields.forEach(key=>$(key).addEventListener('input',()=>{invalidate();calculate()}));
function setDirection(value){direction=value;const entry=Number($('entry').value),distance=Math.abs(entry-Number($('stop').value));if(Number.isFinite(distance)&&distance>0){$('stop').value=(entry+(value==='long'?-distance:distance)).toFixed(1);if($('target').value!=='')$('target').value=(entry+(value==='long'?2*distance:-2*distance)).toFixed(1)}$('long').classList.toggle('selected',value==='long');$('short').classList.toggle('selected',value==='short');$('long').setAttribute('aria-pressed',String(value==='long'));$('short').setAttribute('aria-pressed',String(value==='short'));invalidate();calculate()}
$('long').addEventListener('click',()=>{if(direction!=='long')setDirection('long')});$('short').addEventListener('click',()=>{if(direction!=='short')setDirection('short')});
document.querySelectorAll('[data-budget]').forEach(button=>button.addEventListener('click',()=>{$('budget').value=button.dataset.budget;invalidate();calculate()}));
$('plan-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!calculate())return;if(!connected){$('setup').open=true;return toast('Start the local server or enter your dashboard token to review and save plans.')}
  const button=$('preview');button.disabled=true;button.textContent='Checking your plan…';
  try{review=await api('/api/planner/preview',{method:'POST',body:JSON.stringify(input())});rules=review.plan.rules;calculate();$('preview-status').textContent=review.mode==='paper'?'PAPER REVIEW':'TESTNET REVIEW';$('order-review').textContent=`${review.plan.direction.toUpperCase()} ${review.plan.quantityText} BTC · limit ${money(review.plan.entry)} · stop ${money(review.plan.stop)}${review.plan.target?` · target ${money(review.plan.target)}`:''}. ${review.plan.leverage}× isolated on testnet. Review expires in 60 seconds.`;$('review').hidden=false;$('acknowledge').checked=false;$('execute').disabled=true;$('execute').textContent=review.mode==='paper'?'Confirm paper plan':'Submit bracket to Strike testnet';await loadPlans();$('review').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'nearest'})}catch(e){invalidate();toast(e.message)}finally{button.disabled=false;button.textContent='Review this plan ↗'}
});
$('acknowledge').addEventListener('change',()=>{$('execute').disabled=!$('acknowledge').checked||!review});
$('execute').addEventListener('click',async()=>{
  if(!review||!$('acknowledge').checked)return;if(Date.now()>review.expiresAt){invalidate();return toast('Review expired. Preview again.')}
  if(review.mode==='testnet'&&!confirm('Submit this limit entry and linked stop/target to Strike TESTNET using the reviewed quantity and leverage?'))return;
  const button=$('execute');button.disabled=true;
  try{const result=await api('/api/planner/execute',{method:'POST',body:JSON.stringify({id:review.id,confirm:'SUBMIT_REVIEWED_PLAN'})});invalidate();globalThis.signalbridgeMotion?.signal();await loadPlans();toast(result.error|| (mode==='paper'?'Paper position opened. Try a stop or target scenario below.':'Bracket submitted. Watch entry and stop confirmation below.'));$('monitor').scrollIntoView({behavior:'smooth',block:'start'})}catch(e){invalidate();await loadPlans().catch(()=>{});toast(e.message)}
});
function append(parent,tag,text,cls){const node=document.createElement(tag);node.textContent=text;if(cls)node.className=cls;parent.append(node);return node}
function renderPlans(){
  const visible=plans.filter(row=>row.status!=='draft');$('plans-list').replaceChildren();$('empty').hidden=visible.length>0;
  for(const row of visible){
    const p=row.plan,card=document.createElement('article');card.className='plan-row';const head=append(card,'div','','plan-row-head');append(head,'h3',`${p.direction.toUpperCase()} · ${p.quantityText} BTC`);append(head,'span',`${row.mode.toUpperCase()} / ${row.status.toUpperCase()}`,'pill'+(['unknown','unprotected','failed'].includes(row.status)?' danger':''));
    append(card,'small',`${new Date(row.created).toLocaleString()} · ${money(p.intendedLoss)} intended risk · ${money(p.margin)} estimated margin`);
    const legs=append(card,'div','','plan-legs');for(const[label,status,price]of[['Entry',row.entry_status,p.entry],['Stop loss',row.stop_status,p.stop],['Take profit',row.target_status,p.target]]){const leg=append(legs,'div','','plan-leg');append(leg,'span',`${label.toUpperCase()} ${price?money(price):''}`);append(leg,'b',status||'Not yet confirmed')}
    append(card,'p',row.detail);append(card,'small',`Plan ${row.id}`);if(row.result!==null)append(card,'p',`Simulated net result: ${money(row.result)}`,'paper-result');
    if(row.mode==='paper'&&row.status==='open'){const buttons=append(card,'div','','buttons');for(const[outcome,label]of[['stop','Simulate stop hit'],['target','Simulate target hit'],['close','Close at entry']]){if(outcome==='target'&&!p.target)continue;const b=append(buttons,'button',label,'secondary');b.type='button';b.addEventListener('click',async()=>{b.disabled=true;try{await api('/api/planner/simulate',{method:'POST',body:JSON.stringify({id:row.id,outcome})});await loadPlans();toast('Paper scenario completed. No exchange order was sent.')}catch(e){b.disabled=false;toast(e.message)}})}}
    if(row.mode==='testnet'){const a=append(card,'a','Manage / cancel orders in Strike ↗','guide-link');a.href='https://testnet.strikefinance.org';a.target='_blank';a.rel='noreferrer'}
    $('plans-list').append(card);
  }
}
async function loadPlans(){if(!connected)return;const data=await api('/api/planner/state');plans=data.plans;renderPlans()}
async function refreshConnection(){
  const s=await api('/api/state');hosted=Boolean(s.hosted);if(hosted){$('connection-form').hidden=true;$('setup-status').textContent='Hosted settings are managed in Vercel. Status refreshes while this page is open.'}connected=true;mode=s.mode;$('mode').textContent=mode==='paper'?'● PAPER SCENARIOS':'● STRIKE TESTNET';$('connection-label').textContent='● Server connected';$('login').hidden=true;$('setup-status').textContent=mode==='paper'?'Paper mode ready':s.credentialsReady?'Testnet configured':'Testnet keys required';
  if(!connectionDirty){$('execution-mode').value=mode;$('public-key').value=s.publicKey||'';$('sub-account').value=s.subAccount||''}
  $('account-status').textContent=mode==='paper'?'Paper scenarios ready. No account, public webhook or TradingView subscription needed.':s.account?.error?`Account check: ${s.account.error}`:s.account?.checkedAt?`Last Strike position check: ${s.account.size} BTC. Use a dedicated account.`:'Testnet configured. Refresh the position and inspect protection after submission.';
}
async function connect(){await refreshConnection();sessionStorage.setItem('signalbridge-token',token);invalidate();rules=PAPER_RULES;calculate();await loadPlans()}
$('connect-token').addEventListener('click',async()=>{token=$('token').value.trim();try{await connect();$('token').value='';toast('Workspace connected.')}catch(e){toast(e.message)}});
$('connection-form').addEventListener('input',()=>{connectionDirty=true});
$('connection-form').addEventListener('submit',async event=>{event.preventDefault();if(!connected)return toast('Connect your local server first.');const b=$('save-connection');b.disabled=true;try{await api('/api/connection',{method:'PUT',body:JSON.stringify({mode:$('execution-mode').value,publicKey:$('public-key').value,privateKey:$('private-key').value,subAccount:$('sub-account').value,useGeneratedKey:generated})});$('private-key').value='';connectionDirty=false;await connect();toast('Connection verified and saved.')}catch(e){toast(e.message)}finally{b.disabled=false}});
$('generate-wallet').addEventListener('click',async()=>{try{const result=await api('/api/wallet/generate',{method:'POST',body:'{}'});$('public-key').value=result.publicKey;$('private-key').value='';$('registration-key').value=result.publicKey;generated=true;connectionDirty=true;$('wallet-help').hidden=false;toast('Register this public key with Strike testnet.')}catch(e){toast(e.message)}});
for(const id of ['public-key','private-key'])$(id).addEventListener('input',()=>{generated=false});
$('copy-registration-key').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('registration-key').value);toast('Public key copied.')}catch{toast('Select the public key and copy it manually.')}});
$('check-account').addEventListener('click',async()=>{try{const a=await api('/api/account',{method:'POST',body:'{}'});await refreshConnection();toast(a.error||`Account position: ${a.size} BTC`)}catch(e){toast(e.message)}});
$('load-price').addEventListener('click',async()=>{if(!connected)return toast('Start or connect the server to fetch Strike prices.');const b=$('load-price');b.disabled=true;try{const quote=await api('/api/planner/price',{method:'POST',body:'{}'});const entry=Math.round(quote.price/rules.tickSize)*rules.tickSize;$('entry').value=entry.toFixed(1);$('stop').value=(Math.round(entry*(direction==='long'?.99:1.01)/rules.tickSize)*rules.tickSize).toFixed(1);$('target').value=(Math.round(entry*(direction==='long'?1.02:.98)/rules.tickSize)*rules.tickSize).toFixed(1);$('price-source').textContent=`${quote.source} · ${new Date(quote.checkedAt).toLocaleTimeString()}. Stop/target reset to example 1% / 2% distances; choose your own.`;invalidate();calculate()}catch(e){toast(e.message)}finally{b.disabled=false}});
$('refresh-plans').addEventListener('click',async()=>{try{const result=await api('/api/planner/refresh',{method:'POST',body:'{}'});plans=result.plans;renderPlans();toast('Plan statuses refreshed.')}catch(e){toast(e.message)}});
$('export-plans').addEventListener('click',()=>{const blob=new Blob([JSON.stringify(plans,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='strikeplan-plans.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)});
calculate();
async function boot(){try{if(!token){const r=await fetch('/api/local-session',{method:'POST'});if(!r.ok)return;token=(await r.json()).token}await connect()}catch(e){connected=false;$('login').hidden=false;$('connection-label').textContent='Calculator only';$('account-status').textContent='Start npm.cmd start and open localhost:8787, or enter a valid dashboard token.'}}
boot();setInterval(async()=>{if(!connected||refreshing||document.hidden)return;refreshing=true;try{if(hosted){const data=await api('/api/planner/refresh',{method:'POST',body:'{}'});plans=data.plans;renderPlans()}else await loadPlans()}catch{}finally{refreshing=false}},15000);
