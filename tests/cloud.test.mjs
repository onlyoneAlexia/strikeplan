import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createPlanner} from '../planner.mjs';
import {plannerDatabase} from '../cloud-store.mjs';

test('Postgres adapter parameterizes values and preserves ordering',async()=>{
  let received;
  const db=plannerDatabase({query:async(sql,values)=>{received={sql,values};return {rows:[{id:'one'}]}}});
  assert.equal((await db.prepare('SELECT * FROM plans WHERE id=? ORDER BY rowid').get('untrusted')).id,'one');
  assert.deepEqual(received,{sql:'SELECT * FROM plans WHERE id=$1 ORDER BY sequence',values:['untrusted']});
});
test('planner persists through asynchronous storage and deduplicates execution',async()=>{
  const sqlite=new DatabaseSync(':memory:');
  createPlanner({db:sqlite,client:{},getMode:()=> 'paper',unavailable:()=>false});
  const db={prepare(sql){const statement=sqlite.prepare(sql);return Object.fromEntries(['get','all','run'].map(method=>[method,async(...values)=>{await new Promise(resolve=>setImmediate(resolve));return statement[method](...values)}]))}};
  const planner=createPlanner({db,client:{},getMode:()=> 'paper',unavailable:()=>false,initialize:false});
  const request=async(path,input)=>{let response;await planner.handle({method:'POST'},path,async()=>input,(_res,status,body)=>{response={status,body}},{});return response};
  const preview=await request('/api/planner/preview',{direction:'long',budget:10,entry:80000,stop:79000,target:82000,leverage:3,feeBps:5,slippageBps:10});
  const input={id:preview.body.id,confirm:'SUBMIT_REVIEWED_PLAN'};
  assert.equal((await request('/api/planner/execute',input)).body.status,'open');
  assert.equal((await request('/api/planner/execute',input)).body.duplicate,true);
  assert.equal((await planner.list())[0].status,'open');
  await request('/api/planner/simulate',{id:input.id,outcome:'stop'});
  assert.equal((await planner.list())[0].status,'closed');sqlite.close();
});
