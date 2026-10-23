import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes, createHash, generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { sameSecret, validateAlert, validateSettings, StrikeClient } from './core.mjs';
import { createPlanner } from './planner.mjs';

export function createApp({ directory = '.data', mode = process.env.EXECUTION_MODE || 'paper', client = new StrikeClient(), clientFactory = keys => new StrikeClient(keys), legacyWebhooks = false } = {}) {
  if (!['paper', 'testnet'].includes(mode)) throw new Error('Only paper and testnet modes are supported.');
  mkdirSync(directory, { recursive: true });
  const secretPath = `${directory}/secrets.json`;
  if (!existsSync(secretPath)) writeFileSync(secretPath, JSON.stringify({ admin: randomBytes(32).toString('hex'), webhook: randomBytes(32).toString('hex') }), { mode: 0o600 });
  const secrets = JSON.parse(readFileSync(secretPath, 'utf8'));
  const connectionPath = `${directory}/connection.json`;
  let connection = existsSync(connectionPath) ? JSON.parse(readFileSync(connectionPath, 'utf8')) : {};
  mode = connection.mode || mode;
  if (!['paper', 'testnet'].includes(mode)) throw new Error('Invalid saved execution mode.');
  if (client instanceof StrikeClient) client.env = { ...process.env, ...connection.keys };
  let account = { size: null, checkedAt: null, error: null };
  let configuring = false;
  const db = new DatabaseSync(`${directory}/bridge.sqlite`);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, action TEXT, symbol TEXT, received TEXT, status TEXT, detail TEXT, client_id TEXT, mode TEXT, quantity TEXT);
    CREATE TABLE IF NOT EXISTS paper (id INTEGER PRIMARY KEY, size REAL NOT NULL);
    INSERT OR IGNORE INTO paper VALUES (1,0);`);
  const columns = db.prepare('PRAGMA table_info(alerts)').all().map(c => c.name);
  if (!columns.includes('expires')) db.exec('ALTER TABLE alerts ADD COLUMN expires INTEGER');
  db.prepare('INSERT OR IGNORE INTO settings VALUES (1,?)').run(JSON.stringify({ symbol: 'BTC-USD', quantity: '0.001', enabled: true }));
  // An interrupted submission cannot safely be sent again automatically.
  db.exec("UPDATE alerts SET status='unknown', detail='Process restarted during submission. Inspect Strike account; never automatically retried.' WHERE status='processing'");
  const settings = () => JSON.parse(db.prepare('SELECT value FROM settings WHERE id=1').get().value);
  const update = (id, status, detail) => db.prepare('UPDATE alerts SET status=?,detail=? WHERE id=?').run(status, detail, id);
  let working = false;
  let polling = false;
  const planner=createPlanner({db,client,getMode:()=>mode,unavailable:()=>configuring||working||polling||Boolean(db.prepare("SELECT id FROM alerts WHERE status IN ('queued','processing','submitted','unknown') LIMIT 1").get())||db.prepare('SELECT size FROM paper WHERE id=1').get().size!==0});
  async function reconcile() {
    if (polling || configuring || mode !== 'testnet' || typeof client.getOrder !== 'function') return;
    polling = true;
    try {
      const rows = db.prepare("SELECT * FROM alerts WHERE mode='testnet' AND status IN ('submitted','unknown') ORDER BY rowid LIMIT 5").all();
      for (const row of rows) {
        try {
          const order = await client.getOrder(row.symbol, row.client_id);
          if (order.ClientOrderID !== row.client_id || order.Symbol !== row.symbol) throw new Error('Order response does not match the requested order.');
          const status = order.Status;
          const filled = String(order.Filled ?? '0');
          if (['filled','canceled','rejected','expired'].includes(status)) {
            update(row.id, status, `Strike ${status}. Filled ${filled} / ${order.Size ?? row.quantity} BTC.${order.CloseReason ? ` ${String(order.CloseReason).slice(0, 150)}` : ''}`);
          } else if (['pending','open','untriggered'].includes(status)) {
            update(row.id, 'submitted', `Strike ${status}. Filled ${filled} / ${order.Size ?? row.quantity} BTC. Tracking automatically.`);
          }
        } catch { /* Keep the execution block on timeout, missing order, or invalid response. */ }
      }
    } finally { polling = false; }
  }
  async function checkAccount() {
    if (mode === 'paper') return { size: db.prepare('SELECT size FROM paper WHERE id=1').get().size, checkedAt: new Date().toISOString(), error: null };
    try { account = { size: await client.position('BTC-USD'), checkedAt: new Date().toISOString(), error: null }; }
    catch (e) { account = { size: null, checkedAt: new Date().toISOString(), error: e.message }; }
    return account;
  }
  async function drain() {
    if (working || configuring) return;
    working = true;
    try {
      for (;;) {
        const row = db.prepare("SELECT * FROM alerts WHERE status='queued' ORDER BY rowid LIMIT 1").get();
        if (!row) break;
        if (!settings().enabled) { update(row.id, 'skipped', 'Connector paused before execution.'); continue; }
        if (row.mode !== mode) { update(row.id, 'skipped', 'Execution mode changed; alert not executed.'); continue; }
        if (Date.now() > (row.expires || Date.parse(row.received) + 120000)) { update(row.id, 'skipped', 'Queue entry expired.'); continue; }
        if (db.prepare("SELECT id FROM alerts WHERE status IN ('unknown','submitted') AND mode=? LIMIT 1").get(mode)) break;
        update(row.id, 'processing', 'Checking position.');
        let submitting = false;
        try {
          const position = mode === 'paper' ? db.prepare('SELECT size FROM paper WHERE id=1').get().size : await client.position(row.symbol);
          if (row.action !== 'close' && position !== 0) { update(row.id, 'skipped', 'Position already open. Close it before another entry.'); continue; }
          if (row.action === 'close' && position === 0) { update(row.id, 'skipped', 'No open position to close.'); continue; }
          const order = { client_order_id: row.client_id, symbol: row.symbol, side: row.action === 'close' ? (position > 0 ? 'sell' : 'buy') : (row.action === 'open_long' ? 'buy' : 'sell'), type: 'market', size: row.action === 'close' ? String(Math.abs(position)) : row.quantity, reduce_only: row.action === 'close', slippage: '0.005' };
          if (mode === 'paper') {
            db.exec('BEGIN');
            try {
              db.prepare('UPDATE paper SET size=? WHERE id=1').run(row.action === 'close' ? 0 : Number(row.quantity) * (order.side === 'buy' ? 1 : -1));
              update(row.id, 'paper', `Simulated ${order.side} ${order.size} BTC. No exchange order or price simulation.`);
              db.exec('COMMIT');
            } catch (error) { db.exec('ROLLBACK'); throw error; }
          } else {
            submitting = true;
            const receipt = await client.order(order);
            if (!receipt.message_id && !receipt.sequence_id && !receipt.client_order_id) throw new Error('Unexpected order acknowledgement.');
            update(row.id, 'submitted', 'Strike acknowledged submission. Tracking fill automatically.');
          }
        } catch (error) { update(row.id, submitting ? 'unknown' : 'failed', submitting ? 'Submission outcome uncertain. Inspect Strike using the client order ID. No automatic retry.' : error.message); }
      }
    } finally { working = false; }
  }
  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  async function json(req) {
    let body = '';
    for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) throw new Error('Request too large.'); }
    try { return JSON.parse(body); } catch { throw new Error('Invalid JSON.'); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const path = new URL(req.url, 'http://localhost').pathname;
    try {
      if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
      if (req.method === 'POST' && path === '/webhook/tradingview') {
        if(!legacyWebhooks)return send(res,410,{error:'SignalBridge is now a direct Strike trade planner. Legacy TradingView execution is disabled.'});
        if (configuring) return send(res, 409, { error: 'Connection is being updated. Try again shortly.' });
        const body = await json(req);
        if (!sameSecret(body?.secret, secrets.webhook)) return send(res, 401, { error: 'Invalid webhook secret.' });
        const config = settings();
        const alert = validateAlert(body, { ...config, secret: secrets.webhook });
        const existing = db.prepare('SELECT status FROM alerts WHERE id=?').get(alert.id);
        if (existing) return send(res, 200, { duplicate: true, status: existing.status });
        if (!config.enabled) return send(res, 409, { error: 'Connector paused.' });
        const pending = db.prepare("SELECT COUNT(*) AS count FROM alerts WHERE status IN ('queued','processing')").get().count;
        if (pending >= 25) return send(res, 429, { error: 'Queue full.' });
        const clientID = 'sb-' + createHash('sha256').update(alert.id).digest('hex').slice(0, 28);
        db.prepare('INSERT INTO alerts (id,action,symbol,received,status,detail,client_id,mode,quantity,expires) VALUES (?,?,?,?,?,?,?,?,?,?)').run(alert.id, alert.action, alert.symbol, new Date().toISOString(), 'queued', 'Alert validated and queued.', clientID, mode, config.quantity, Date.parse(alert.timestamp) + 120000);
        send(res, 202, { accepted: true, id: alert.id });
        setImmediate(drain);
        return;
      }
      if (path === '/api/local-session' && req.method === 'POST') {
        const local = ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        const host = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host || '');
        const origin = req.headers.origin;
        const forwarded = ['forwarded','x-forwarded-for','x-forwarded-host','x-real-ip','cf-connecting-ip','cf-ray'].some(h => req.headers[h]);
        if (!local || !host || forwarded || req.headers['sec-fetch-site'] !== 'same-origin' || (origin && origin !== `http://${req.headers.host}`)) return send(res, 403, { error: 'Automatic connection is available only in a same-origin localhost browser.' });
        return send(res, 200, { token: secrets.admin });
      }
      if (path.startsWith('/api/')) {
        if (!sameSecret(req.headers.authorization, `Bearer ${secrets.admin}`)) return send(res, 401, { error: 'Dashboard token required.' });
        if(path.startsWith('/api/planner/'))return await planner.handle(req,path,json,send,res);
        if (path === '/api/state' && req.method === 'GET') return send(res, 200, { mode, config: settings(), webhookSecret: secrets.webhook, publicUrl: connection.publicUrl || process.env.PUBLIC_URL || '', credentialsReady: Boolean(client.env?.STRIKE_PUBLIC_KEY && client.env?.STRIKE_PRIVATE_KEY), publicKey: client.env?.STRIKE_PUBLIC_KEY || '', subAccount: client.env?.STRIKE_SUB_ACCOUNT_ID || '', account, paperPosition: db.prepare('SELECT size FROM paper WHERE id=1').get().size, alerts: db.prepare('SELECT * FROM alerts ORDER BY rowid DESC LIMIT 100').all() });
        if (path === '/api/account' && req.method === 'POST') return send(res, 200, await checkAccount());
        if (path === '/api/wallet/generate' && req.method === 'POST') {
          const pendingPath = `${directory}/pending-wallet.json`;
          if (!existsSync(pendingPath)) {
            const pair = generateKeyPairSync('ed25519');
            const pending = { publicKey: pair.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex'), privateKey: pair.privateKey.export({type:'pkcs8',format:'der'}).subarray(-32).toString('hex') };
            writeFileSync(pendingPath, JSON.stringify(pending), {mode:0o600});
          }
          const pending = JSON.parse(readFileSync(pendingPath,'utf8'));
          return send(res,200,{publicKey:pending.publicKey, registrationUrl:'https://testnet.strikefinance.org/api-keys'});
        }
        if (path === '/api/connection' && req.method === 'PUT') {
          if (working || polling || configuring || planner.busy || planner.active()) return send(res, 409, { error: 'Close or resolve the current plan before changing the connection.' });
          configuring = true;
          try {
            const body = await json(req);
            if (!['paper','testnet'].includes(body.mode)) throw new Error('Choose paper or testnet.');
            let publicUrl = String(body.publicUrl || '').trim().replace(/\/$/, '');
            if (publicUrl) { const u = new URL(publicUrl); if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('Webhook origin must be an HTTPS URL without a path, query or credentials.'); publicUrl = u.origin; }
            if (db.prepare("SELECT id FROM alerts WHERE status IN ('queued','processing','submitted','unknown') LIMIT 1").get()) throw new Error('Resolve pending alerts before changing the connection.');
            if (body.mode !== mode) { const current = await checkAccount(); if (current.error || current.size !== 0) throw new Error('Close the current position and verify the account before switching modes.'); }
            let generatedPrivate = '';
            if (body.useGeneratedKey) {
              const pendingPath = `${directory}/pending-wallet.json`;
              if (!existsSync(pendingPath)) throw new Error('Generate an API wallet first.');
              const pending = JSON.parse(readFileSync(pendingPath,'utf8'));
              if (body.publicKey !== pending.publicKey) throw new Error('Public key does not match the generated wallet.');
              generatedPrivate = pending.privateKey;
            }
            const keys = { STRIKE_PUBLIC_KEY: String(body.publicKey || client.env?.STRIKE_PUBLIC_KEY || '').trim(), STRIKE_PRIVATE_KEY: String(generatedPrivate || body.privateKey || client.env?.STRIKE_PRIVATE_KEY || '').trim(), STRIKE_SUB_ACCOUNT_ID: String(body.subAccount || '').trim() };
            const changedAccount = mode === 'testnet' && (keys.STRIKE_PUBLIC_KEY !== client.env?.STRIKE_PUBLIC_KEY || keys.STRIKE_SUB_ACCOUNT_ID !== (client.env?.STRIKE_SUB_ACCOUNT_ID || ''));
            if (changedAccount) { const current = await checkAccount(); if (current.error || current.size !== 0) throw new Error('Close the current testnet position before changing accounts.'); }
            if (keys.STRIKE_SUB_ACCOUNT_ID && !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(keys.STRIKE_SUB_ACCOUNT_ID)) throw new Error('Subaccount must be a UUID.');
            if (body.mode === 'testnet') {
              const probe = clientFactory(keys);
              const size = await probe.position('BTC-USD');
              account = { size, checkedAt: new Date().toISOString(), error: null };
            }
            connection = { mode: body.mode, publicUrl, keys };
            const { writeFileSync: write, renameSync } = await import('node:fs');
            write(`${connectionPath}.tmp`, JSON.stringify(connection), { mode: 0o600 }); renameSync(`${connectionPath}.tmp`, connectionPath);
            mode = body.mode; client.env = keys;
            return send(res, 200, { ok: true, mode });
          } finally { configuring = false; }
        }
        if (path === '/api/export' && req.method === 'GET') {
          const rows = db.prepare('SELECT received,id,action,symbol,quantity,mode,status,client_id,detail FROM alerts ORDER BY rowid DESC').all();
          const fields = ['received','id','action','symbol','quantity','mode','status','client_id','detail'];
          const escape = value => '"' + String(value ?? '').replace(/^[=+@-]/, "'$&").replaceAll('"','""') + '"';
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="signalbridge-activity.csv"', 'Cache-Control': 'no-store' });
          return res.end([fields.join(','), ...rows.map(row => fields.map(key => escape(row[key])).join(','))].join('\r\n'));
        }
        if (path === '/api/settings' && req.method === 'PUT') {
          const config = validateSettings(await json(req));
          db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(config));
          return send(res, 200, { ok: true });
        }
        if (path === '/api/reconcile' && req.method === 'POST') {
          const body = await json(req);
          const row = db.prepare('SELECT * FROM alerts WHERE id=?').get(body.id);
          if (!row || !['unknown','submitted'].includes(row.status) || body.confirm !== 'CHECKED_STRIKE') throw new Error('Inspect the order in Strike before acknowledging it.');
          update(row.id, 'reviewed', 'Operator confirmed checking the order and position in Strike. No order was retried.');
          return send(res, 200, { ok: true });
        }
        return send(res, 404, { error: 'Not found.' });
      }
      const files = { '/': ['index.html','text/html'], '/risk.mjs':['risk.mjs','text/javascript'], '/planner-app.js':['planner-app.js','text/javascript'], '/planner.css':['planner.css','text/css'], '/style.css': ['style.css','text/css'], '/theme.css': ['theme.css','text/css'], '/trading.svg': ['trading.svg','image/svg+xml'], '/functionality.css': ['functionality.css','text/css'], '/animations.css': ['animations.css','text/css'], '/animations.js': ['animations.js','text/javascript'], '/depth.css': ['depth.css','text/css'], '/depth.js': ['depth.js','text/javascript'] };
      if (req.method === 'GET' && files[path]) {
        const content = readFileSync(new URL(`./public/${files[path][0]}`, import.meta.url));
        if (path === '/trading.svg') {
          const style = content.toString().match(/<style>([\s\S]*?)<\/style>/)?.[1];
          const hash = createHash('sha256').update(style || '').digest('base64');
          res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'sha256-${hash}'; frame-ancestors 'none'`);
        }
        res.writeHead(200, { 'Content-Type': files[path][1], 'Cache-Control': 'no-store' });
        return res.end(content);
      }
      send(res, 404, { error: 'Not found.' });
    } catch (error) { send(res, 400, { error: error.message }); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  const timer = setInterval(async () => { try { await reconcile(); await drain(); if(!configuring&&!working)await planner.poll(); } catch { /* Preserve durable state; next tick can recover. */ } }, 1500); timer.unref();
  server.on('close', () => { clearInterval(timer); db.close(); });
  return { server, secrets, db, drain, reconcile, planner };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.server.on('error', error => { console.error(`Could not start server: ${error.code}. Set PORT in .env to an available port.`); process.exit(1); });
  app.server.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1', () => {
    console.log(`StrikePlan ready at http://localhost:${process.env.PORT || 8787} — ${process.env.EXECUTION_MODE || 'paper'} mode`);
    console.log('Run npm.cmd run token in another terminal to get your dashboard login token.');
  });
}
