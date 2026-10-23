import {randomUUID} from 'node:crypto';
import {calculatePlan,PAPER_RULES} from './public/risk.mjs';
export function createPlanner({db,client,getMode,unavailable}) {
  db.exec(`CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,created TEXT,mode TEXT,status TEXT,plan TEXT,detail TEXT,entry_id TEXT,stop_id TEXT,target_id TEXT,entry_status TEXT,stop_status TEXT,target_status TEXT,filled REAL DEFAULT 0,result REAL,updated TEXT)`);
  db.exec("UPDATE plans SET status='unknown',detail='Server restarted during submission. Reconciling by client order IDs; no automatic resubmission.' WHERE status='submitting'");
  let busy=false,polling=false;
  const active=()=>db.prepare("SELECT id FROM plans WHERE status IN ('submitting','unknown','submitted','open','unprotected','partial') LIMIT 1").get();
  const list=()=>db.prepare('SELECT * FROM plans ORDER BY rowid DESC LIMIT 50').all().map(row=>({...row,plan:JSON.parse(row.plan)}));
  const update=(id,fields)=>{const names=Object.keys(fields);db.prepare(`UPDATE plans SET ${names.map(n=>n+'=?').join(',')},updated=? WHERE id=?`).run(...Object.values(fields),new Date().toISOString(),id)};
  async function poll(){
    if(polling||busy||getMode()!=='testnet')return;polling=true;
    try{for(const row of db.prepare("SELECT * FROM plans WHERE mode='testnet' AND status IN ('submitted','unknown','open','unprotected','partial') ORDER BY rowid LIMIT 1").all()){
      const read=async id=>{if(!id)return null;try{const o=await client.getOrder('BTC-USD',id);return o.ClientOrderID===id&&o.Symbol==='BTC-USD'?o:null}catch{return null}};
      const entry=await read(row.entry_id),stop=await read(row.stop_id),target=await read(row.target_id);
      const filled=Number(entry?.Filled??row.filled);const fields={entry_status:entry?.Status??'unconfirmed',stop_status:stop?.Status??'unconfirmed',target_status:row.target_id?(target?.Status??'unconfirmed'):'not_set',filled:Number.isFinite(filled)?filled:0};
      let externallyClosed=false;
      if(filled>0&&entry&&['filled','canceled','expired'].includes(entry.Status)){
        try{const position=await client.position('BTC-USD');if(position===0){const remaining=await client.openOrders();externallyClosed=remaining.length===0}}catch{/* An unavailable account/order lookup must never imply a closed position. */}
      }
      if(stop?.Status==='filled'||target?.Status==='filled'){fields.status='closed';fields.detail=`${stop?.Status==='filled'?'Stop loss':'Take profit'} filled on Strike. Check trade history for actual net P&L.`;}
      else if(externallyClosed){fields.status='closed';fields.detail='Position closed outside StrikePlan. Strike confirms zero BTC exposure and no remaining BTC orders. Check Strike trade history for actual net P&L.';}
      else if(entry&&['canceled','rejected','expired'].includes(entry.Status)&&!filled){fields.status=entry.Status;fields.detail=`Entry ${entry.Status}; no filled quantity reported.`;}
      else if(filled>0){const plan=JSON.parse(row.plan);const protectedStop=stop&&['open','untriggered'].includes(stop.Status)&&Number(stop.Size)>=filled&&Number(stop.StopPrice)===plan.stop&&stop.Side===(plan.direction==='long'?'sell':'buy')&&['stop','stop_limit'].includes(stop.Type);fields.status=protectedStop?(entry?.Status==='filled'?'open':'partial'):'unprotected';fields.detail=protectedStop?'A matching live stop covers the reported filled quantity. Actual losses can exceed the estimate.':'Position has filled quantity, but a matching live stop is not confirmed. Inspect the account in Strike immediately.';}
      else{fields.status=entry?'submitted':'unknown';fields.detail=entry?'Waiting for entry fill. Stop will activate according to Strike bracket-order rules.':'Submission outcome unconfirmed. Looking up client order IDs; never automatically retried.';}
      update(row.id,fields);
    }}finally{polling=false}
  }
  async function handle(req,path,body,send,res){
    if(path==='/api/planner/state'&&req.method==='GET')return send(res,200,{plans:list(),mode:getMode(),rules:PAPER_RULES});
    if(path==='/api/planner/price'&&req.method==='POST'){try{return send(res,200,await client.markPrice())}catch(e){return send(res,503,{error:e.message})}}
    if(path==='/api/planner/preview'&&req.method==='POST'){
      const input=await body(req),mode=getMode(),rules=mode==='testnet'?await client.marketRules():PAPER_RULES,plan=calculatePlan(input,rules),id=randomUUID(),now=new Date().toISOString();
      db.prepare('INSERT INTO plans(id,created,mode,status,plan,detail,entry_id,stop_id,target_id,updated) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,now,mode,'draft',JSON.stringify(plan),'Ready for review. No order submitted.','rp-'+id.slice(0,20),'sl-'+id.slice(0,20),plan.target?'tp-'+id.slice(0,20):null,now);
      return send(res,200,{id,plan,mode,expiresAt:Date.now()+60000});
    }
    if(path==='/api/planner/execute'&&req.method==='POST'){
      const input=await body(req);if(input.confirm!=='SUBMIT_REVIEWED_PLAN')throw Error('Review the order before submitting.');
      const row=db.prepare('SELECT * FROM plans WHERE id=?').get(input.id);if(!row)throw Error('Plan not found.');
      if(row.status!=='draft')return send(res,200,{id:row.id,status:row.status,duplicate:true});
      if(row.mode!==getMode()||Date.now()-Date.parse(row.created)>60000)throw Error('Preview expired or execution mode changed. Preview again.');
      if(busy||polling||unavailable()||active())throw Error('Another position or submission needs attention. Resolve it before opening a new plan.');
      busy=true;let submitting=false;
      try{
        const plan=JSON.parse(row.plan);
        if(getMode()==='paper'){
          update(row.id,{status:'open',entry_status:'paper_filled',stop_status:'paper_active',target_status:plan.target?'paper_active':'not_set',filled:plan.quantity,detail:'Paper position entered at the planned price with simulated protection. No exchange order sent.'});
        }else{
          if(await client.position('BTC-USD')!==0)throw Error('Use a flat dedicated Strike account. An existing BTC position is open.');
          if((await client.openOrders()).length)throw Error('Cancel existing BTC orders in Strike before submitting a new plan.');
          const rules=await client.marketRules();const fresh=calculatePlan(plan,rules);
          if(fresh.quantityText!==plan.quantityText)throw Error('Market rules changed. Preview the plan again.');
          const mark=await client.markPrice();if(plan.direction==='long'?mark.price<=plan.stop:mark.price>=plan.stop)throw Error('The stop is already on the triggered side of the market. Update the plan.');
          await client.isolated();await client.setLeverage(plan.leverage);
          const order={strategy_id:row.id,client_order_id:row.entry_id,symbol:'BTC-USD',side:plan.direction==='long'?'buy':'sell',type:'limit',price:String(plan.entry),size:plan.quantityText,time_in_force:'GTC',sl_order:{client_order_id:row.stop_id,type:'stop',size:plan.quantityText,stop_price:String(plan.stop),working_type:'mark_price'}};
          if(plan.target)order.tp_order={client_order_id:row.target_id,type:'take_profit',size:plan.quantityText,stop_price:String(plan.target),working_type:'mark_price'};
          update(row.id,{status:'submitting',detail:'Submitting native Strike bracket order.'});submitting=true;
          const result=await client.bracket(order);if(!result.strategy_id&&!result.message_id&&!result.sequence_id)throw Error('Unexpected bracket acknowledgement.');
          update(row.id,{status:'submitted',entry_status:'unconfirmed',stop_status:'unconfirmed',target_status:plan.target?'unconfirmed':'not_set',detail:'Bracket submission acknowledged. Tracking entry and protective legs; protection is not yet confirmed.'});
        }
        return send(res,200,{id:row.id,status:getMode()==='paper'?'open':'submitted'});
      }catch(e){update(row.id,{status:submitting?'unknown':'failed',detail:submitting?'Submission outcome uncertain. Tracking client order IDs; do not submit a replacement.':e.message});return send(res,submitting?202:400,{id:row.id,error:submitting?'Submission uncertain. Inspect the monitor; no automatic retry.':e.message})}finally{busy=false}
    }
    if(path==='/api/planner/simulate'&&req.method==='POST'){
      const input=await body(req),row=db.prepare('SELECT * FROM plans WHERE id=?').get(input.id);
      if(!row||row.mode!=='paper'||getMode()!=='paper'||row.status!=='open'||!['stop','target','close'].includes(input.outcome))throw Error('Choose an open paper plan and a valid outcome.');
      const plan=JSON.parse(row.plan);if(input.outcome==='target'&&!plan.target)throw Error('No target was set.');
      const result=input.outcome==='stop'?-plan.intendedLoss:input.outcome==='target'?plan.targetProfit:-plan.quantity*plan.entry*plan.feeBps/10000*2;
      update(row.id,{status:'closed',result,stop_status:input.outcome==='stop'?'paper_filled':'paper_canceled',target_status:plan.target?(input.outcome==='target'?'paper_filled':'paper_canceled'):'not_set',detail:`Paper ${input.outcome} scenario. Net result ${result.toFixed(2)} USD from the reviewed assumptions; not an actual market fill.`});
      return send(res,200,{ok:true,result});
    }
    if(path==='/api/planner/refresh'&&req.method==='POST'){await poll();return send(res,200,{plans:list(),mode:getMode()})}
    return send(res,404,{error:'Planner route not found.'});
  }
  return {handle,poll,active,list,get busy(){return busy||polling}};
}
