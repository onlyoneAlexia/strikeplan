// Scan staged text/binary bytes for known local credentials without printing them.
import {execFileSync} from 'node:child_process';
import {existsSync,readdirSync,readFileSync} from 'node:fs';
const secrets=new Set();
function collect(value){if(!value||typeof value!=='object')return;for(const[key,item]of Object.entries(value)){if(typeof item==='string'&&/^(admin|webhook|privateKey|STRIKE_PRIVATE_KEY)$/i.test(key)&&item.length>=16)secrets.add(item);else if(typeof item==='object')collect(item)}}
if(existsSync('.data'))for(const name of readdirSync('.data'))if(name.endsWith('.json')){try{collect(JSON.parse(readFileSync('.data/'+name,'utf8')))}catch{}}
const git=['-c',`safe.directory=${process.cwd().replaceAll('\\','/')}`];
const names=execFileSync('git',[...git,'diff','--cached','--name-only','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);const problems=[];
for(const name of names){if(/(^|\/)\.data\//.test(name)||/(^|\/)\.env($|\.)/.test(name)&&!name.endsWith('.env.example'))problems.push({file:name,reason:'Private runtime path staged'});const data=execFileSync('git',[...git,'show',':'+name],{maxBuffer:20*1024*1024});for(const secret of secrets)if(data.includes(Buffer.from(secret)))problems.push({file:name,reason:'Contains a known local credential'});}
console.log(JSON.stringify({stagedFiles:names.length,knownCredentialsChecked:secrets.size,problems},null,2));if(problems.length)process.exitCode=1;
