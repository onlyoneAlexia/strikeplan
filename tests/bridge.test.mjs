import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, verify, createHash } from 'node:crypto';
import { createApp } from '../server.mjs';
import { validateAlert, signedHeaders, StrikeClient, TESTNET } from '../core.mjs';

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'signalbridge-'));
  const app = createApp({ directory, legacyWebhooks:true, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const request = async (path, body, auth = true, method = 'POST') => {
    const res = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${app.secrets.admin}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() };
  };
  const alert = (action = 'open_long', id = 'test-1') => ({ id, action, symbol: 'BTC-USD', secret: app.secrets.webhook, timestamp: new Date().toISOString() });
  return { ...app, request, alert, directory, origin };
}
test('webhook requires a secret and admin endpoints require authentication', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/webhook/tradingview', { ...f.alert(), secret: 'wrong' }, false)).status, 401);
  assert.equal((await f.request('/api/state', undefined, false, 'GET')).status, 401);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM alerts').get().n, 0);
});
test('expired, future, unsupported-market and malformed alerts are rejected', () => {
  const config = { secret: 'test', symbol: 'BTC-USD' };
  const body = { secret: 'test', id: 'a', symbol: 'BTC-USD', action: 'open_long', timestamp: new Date().toISOString() };
  for (const override of [{ timestamp: new Date(Date.now() - 121000).toISOString() }, { timestamp: new Date(Date.now() + 60000).toISOString() }, { symbol: 'ETH-USD' }, { action: 'buy' }, { id: '../x' }, { timestamp: 123 }]) assert.throws(() => validateAlert({ ...body, ...override }, config));
});
test('paper lifecycle deduplicates entries, prevents pyramiding, and closes', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/webhook/tradingview', f.alert())).status, 202);
  await f.drain();
  assert.equal((await f.request('/webhook/tradingview', f.alert())).body.duplicate, true);
  await f.request('/webhook/tradingview', f.alert('open_short', 'second'));
  await f.drain();
  assert.equal(f.db.prepare('SELECT status FROM alerts WHERE id=?').get('second').status, 'skipped');
  assert.equal(f.db.prepare('SELECT size FROM paper').get().size, 0.001);
  await f.request('/webhook/tradingview', f.alert('close', 'exit'));
  await f.drain();
  assert.equal(f.db.prepare('SELECT size FROM paper').get().size, 0);
});
test('pause and fixed quantity limits are enforced', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/settings', { quantity: '1', enabled: true }, true, 'PUT')).status, 400);
  assert.equal((await f.request('/api/settings', { quantity: '0.002', enabled: false }, true, 'PUT')).status, 200);
  assert.equal((await f.request('/webhook/tradingview', f.alert())).status, 409);
});
test('testnet acknowledgement remains unconfirmed and blocks subsequent orders', async t => {
  const orders = [];
  const f = await fixture(t, { mode: 'testnet', client: { position: async () => 0, order: async order => { orders.push(order); return { message_id: 'accepted' }; } } });
  await f.request('/webhook/tradingview', f.alert()); await f.drain();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].slippage, '0.005');
  assert.equal(f.db.prepare('SELECT status FROM alerts').get().status, 'submitted');
  await f.request('/webhook/tradingview', f.alert('open_long', 'next')); await f.drain();
  assert.equal(f.db.prepare('SELECT status FROM alerts WHERE id=?').get('next').status, 'queued');
  assert.equal(orders.length, 1);
  assert.equal((await f.request('/api/reconcile', { id: 'test-1', confirm: 'CHECKED_STRIKE' })).status, 200);
});
test('ambiguous submission never retries and blocks later entries', async t => {
  let calls = 0;
  const f = await fixture(t, { mode: 'testnet', client: { position: async () => 0, order: async () => { calls++; throw new Error('Timeout'); } } });
  await f.request('/webhook/tradingview', f.alert()); await f.drain();
  assert.equal(f.db.prepare('SELECT status FROM alerts').get().status, 'unknown');
  await f.request('/webhook/tradingview', f.alert()); await f.drain();
  assert.equal(calls, 1);
});
test('close uses exchange position size and reduce-only, never reverses', async t => {
  let order;
  const f = await fixture(t, { mode: 'testnet', client: { position: async () => -0.003, order: async value => { order = value; return { message_id: 'ok' }; } } });
  await f.request('/webhook/tradingview', f.alert('close')); await f.drain();
  assert.equal(order.side, 'buy'); assert.equal(order.size, '0.003'); assert.equal(order.reduce_only, true);
});
test('deduplication and uncertain submission state survive restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-restart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let f = createApp({ directory });
  f.db.prepare('INSERT INTO alerts (id,action,symbol,received,status,detail,client_id,mode,quantity) VALUES (?,?,?,?,?,?,?,?,?)').run('persisted', 'open_long', 'BTC-USD', new Date().toISOString(), 'processing', 'in flight', 'client', 'testnet', '0.001');
  const secret = f.secrets.webhook;
  f.server.emit('close');
  f = createApp({ directory });
  assert.equal(f.secrets.webhook, secret);
  assert.equal(f.db.prepare('SELECT status FROM alerts').get().status, 'unknown');
  f.server.emit('close');
});
test('Ed25519 signatures match method, exact path, body hash and registered public key', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('hex');
  const body = '{"symbol":"BTC-USD"}', path = '/v2/order';
  const h = signedHeaders('POST', path, body, pub, seed);
  const message = `POST:${path}:${h['X-API-Wallet-Timestamp']}:${h['X-API-Wallet-Nonce']}:${createHash('sha256').update(body).digest('hex')}`;
  assert.equal(verify(null, Buffer.from(message), publicKey, Buffer.from(h['X-API-Wallet-Signature'], 'hex')), true);
  assert.throws(() => signedHeaders('GET', path, '', '0'.repeat(64), seed), /match/);
});
test('Strike adapter targets testnet and handles documented position response', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const env = { STRIKE_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), STRIKE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('hex') };
  const client = new StrikeClient(env, async (url, options) => { assert.ok(url.startsWith(TESTNET + '/v2/positions?')); assert.ok(options.headers['X-API-Wallet-Signature']); return { ok: true, json: async () => ({ positions: [{ symbol: 'BTC-USD', size: '-0.01' }] }) }; });
  assert.equal(await client.position('BTC-USD'), -0.01);
});
test('dashboard serves assets and does not expose secrets without login', async t => {
  const f = await fixture(t);
  for (const path of ['/', '/planner-app.js', '/style.css', '/theme.css', '/functionality.css', '/trading.svg']) { const r = await fetch(f.origin + path); assert.equal(r.status, 200); assert.ok(r.headers.get('content-security-policy')); assert.ok(!(await r.text()).includes(f.secrets.webhook)); }
  assert.equal((await fetch(f.origin + '/.data/secrets.json')).status, 404);
});
test('confirmed fills release queued exit and reduce-only closes the actual position', async t => {
  let size = 0; const orders = [];
  const f = await fixture(t, { mode: 'testnet', client: {
    position: async () => size,
    order: async order => { orders.push(order); size = order.reduce_only ? 0 : Number(order.size); return { message_id: 'ok' }; },
    getOrder: async (symbol, id) => ({ Symbol: symbol, ClientOrderID: id, Status: 'filled', Size: '0.001', Filled: '0.001' })
  } });
  await f.request('/webhook/tradingview', f.alert()); await f.drain();
  await f.request('/webhook/tradingview', f.alert('close','exit')); await f.drain();
  assert.equal(orders.length, 1);
  await f.reconcile(); await f.drain();
  assert.equal(orders.length, 2); assert.equal(orders[1].reduce_only, true);
  await f.reconcile();
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE status='filled'").get().n, 2);
});
test('lookup errors and mismatched order identity keep execution blocked', async t => {
  const f = await fixture(t, { mode: 'testnet', client: { position: async () => 0, order: async () => ({ message_id: 'ok' }), getOrder: async () => ({ Symbol: 'BTC-USD', ClientOrderID: 'other', Status: 'filled' }) } });
  await f.request('/webhook/tradingview', f.alert()); await f.drain(); await f.reconcile();
  assert.equal(f.db.prepare('SELECT status FROM alerts').get().status, 'submitted');
});
test('a recovered unknown order is reconciled without submitting it again', async t => {
  let calls = 0;
  const f = await fixture(t, { mode: 'testnet', client: { position: async () => 0, order: async () => { calls++; throw Error('lost response'); }, getOrder: async (symbol,id) => ({ Symbol: symbol, ClientOrderID: id, Status: 'filled', Filled: '0.001', Size: '0.001' }) } });
  await f.request('/webhook/tradingview', f.alert()); await f.drain(); await f.reconcile();
  assert.equal(calls, 1); assert.equal(f.db.prepare('SELECT status FROM alerts').get().status,'filled');
});
test('public origin validation, persisted paper connection, account check and CSV export', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/connection', { mode:'paper', publicUrl:'http://example.com' }, true, 'PUT')).status,400);
  assert.equal((await f.request('/api/connection', { mode:'paper', publicUrl:'https://example.com/hook' }, true, 'PUT')).status,400);
  assert.equal((await f.request('/api/connection', { mode:'paper', publicUrl:'https://example.com' }, true, 'PUT')).status,200);
  const snapshot = await f.request('/api/state', undefined, true, 'GET'); assert.equal(snapshot.body.publicUrl,'https://example.com'); assert.equal('privateKey' in snapshot.body,false);
  assert.equal((await f.request('/api/account', {})).body.size,0);
  await f.request('/webhook/tradingview', f.alert()); await f.drain();
  const response = await fetch(f.origin+'/api/export',{headers:{Authorization:`Bearer ${f.secrets.admin}`}});
  assert.equal(response.status,200); assert.match(response.headers.get('content-type'),/text\/csv/); assert.match(await response.text(),/test-1/);
});
test('automatic localhost session rejects untrusted origin and forwarded requests', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/local-session',{},false)).status,403);
  const response=await fetch(f.origin+'/api/local-session',{method:'POST',headers:{'Sec-Fetch-Site':'same-origin',Origin:'https://evil.example'}}); assert.equal(response.status,403);
  const forwarded=await fetch(f.origin+'/api/local-session',{method:'POST',headers:{'Sec-Fetch-Site':'same-origin','X-Forwarded-For':'203.0.113.1'}}); assert.equal(forwarded.status,403);
});
test('in-app testnet setup verifies before persisting and never returns a private key', async t => {
  const privateKey = 'a'.repeat(64), publicKey = 'b'.repeat(64);
  let verified = false;
  const f = await fixture(t, { client: { env: {}, position: async () => 0 }, clientFactory: keys => ({ position: async symbol => { assert.equal(symbol,'BTC-USD'); assert.equal(keys.STRIKE_PRIVATE_KEY,privateKey); verified = true; return 0; } }) });
  const saved = await f.request('/api/connection',{mode:'testnet', publicKey, privateKey, publicUrl:'https://example.com'},true,'PUT');
  assert.equal(saved.status,200); assert.equal(verified,true);
  const snapshot = await f.request('/api/state',undefined,true,'GET');
  assert.equal(snapshot.body.mode,'testnet'); assert.equal(snapshot.body.credentialsReady,true); assert.equal(JSON.stringify(snapshot.body).includes(privateKey),false);
  assert.equal(JSON.parse(readFileSync(join(f.directory,'connection.json'),'utf8')).keys.STRIKE_PRIVATE_KEY,privateKey);
});
test('failed connection verification keeps existing mode and does not save credentials', async t => {
  const f = await fixture(t,{clientFactory:()=>({position:async()=>{throw Error('Authentication failed');}})});
  assert.equal((await f.request('/api/connection',{mode:'testnet',publicKey:'bad',privateKey:'bad'},true,'PUT')).status,400);
  assert.equal((await f.request('/api/state',undefined,true,'GET')).body.mode,'paper');
});
test('local wallet generation returns only the reusable public key and stores the seed server-side', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/wallet/generate',{},false)).status,401);
  const first = await f.request('/api/wallet/generate',{});
  const second = await f.request('/api/wallet/generate',{});
  assert.match(first.body.publicKey,/^[a-f\d]{64}$/);
  assert.equal(first.body.publicKey,second.body.publicKey);
  const pending=JSON.parse(readFileSync(join(f.directory,'pending-wallet.json'),'utf8'));
  assert.match(pending.privateKey,/^[a-f\d]{64}$/);
  assert.equal(JSON.stringify(first.body).includes(pending.privateKey),false);
  assert.doesNotThrow(()=>signedHeaders('GET','/v2/positions','',pending.publicKey,pending.privateKey));
});
