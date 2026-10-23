import pg from 'pg';
import {sameSecret,StrikeClient} from '../core.mjs';
import {createPlanner} from '../planner.mjs';
import {plannerDatabase,initializeCloud} from '../cloud-store.mjs';

export default async function handler(req,res) {
  const send=(res,code,body)=>{res.statusCode=code;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body))};
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const path=new URL(req.url,'https://localhost').pathname;
  if(path==='/health')return send(res,200,{ok:true,storage:'postgres',monitoring:'refresh'});
  if(path==='/api/local-session')return send(res,403,{error:'Enter your dashboard token to connect to this hosted workspace.'});
  if(!process.env.DASHBOARD_TOKEN||process.env.DASHBOARD_TOKEN.length<32)return send(res,503,{error:'Configure a dashboard token of at least 32 characters in Vercel.'});
  if(!sameSecret(req.headers.authorization,`Bearer ${process.env.DASHBOARD_TOKEN}`))return send(res,401,{error:'Dashboard token required.'});
  const mode=process.env.EXECUTION_MODE||'paper';
  if(!['paper','testnet'].includes(mode))return send(res,503,{error:'Only paper and testnet are supported.'});
  const client=new StrikeClient();
  const body=async(req)=>{
    if(req.body!==undefined){const data=typeof req.body==='string'?req.body:JSON.stringify(req.body);if(Buffer.byteLength(data)>8192)throw Error('Request too large.');return JSON.parse(data)}
    let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>8192)throw Error('Request too large.')}return JSON.parse(data||'{}');
  };
  if(path==='/api/state')return send(res,200,{mode,hosted:true,credentialsReady:Boolean(process.env.STRIKE_PUBLIC_KEY&&process.env.STRIKE_PRIVATE_KEY),publicKey:process.env.STRIKE_PUBLIC_KEY||'',subAccount:process.env.STRIKE_SUB_ACCOUNT_ID||'',account:{}});
  if(path==='/api/account'&&req.method==='POST'){
    try{return send(res,200,{size:mode==='paper'?0:await client.position('BTC-USD'),checkedAt:new Date().toISOString()})}catch{return send(res,503,{error:'Strike account check failed. Verify testnet credentials in Vercel.'})}
  }
  if(path==='/api/connection'||path==='/api/wallet/generate')return send(res,409,{error:'Hosted credentials and execution mode are configured through Vercel environment variables. Wallet generation is available in the local app.'});
  let connection;
  try{
    if(!process.env.DATABASE_URL)throw Error('Database not configured.');
    const url=new URL(process.env.DATABASE_URL);
    if(url.hostname.includes('-pooler'))throw Error('Use a direct database connection URL, not a pooled URL.');
    connection=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:8000});
    await connection.connect();
    await connection.query("SET lock_timeout='3s'");
    // Session lock serializes requests across serverless instances. Each write commits
    // immediately, including the submitting marker BEFORE any exchange submission.
    await connection.query('SELECT pg_advisory_lock(724319001)');
    await initializeCloud(connection);
    const planner=createPlanner({db:plannerDatabase(connection),client,getMode:()=>mode,unavailable:()=>false,initialize:false});
    return await planner.handle(req,path,body,send,res);
  }catch(error){
    console.error('Hosted request failed:',error.code||error.name);
    return send(res,503,{error:'Hosted storage or request unavailable. Check configuration and refresh. Do not resubmit an uncertain trade.'});
  }finally{if(connection)await connection.end().catch(()=>{})}
}
