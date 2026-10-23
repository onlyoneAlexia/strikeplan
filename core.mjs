import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, timingSafeEqual } from 'node:crypto';

export const TESTNET = 'https://api-v2-testnet.strikefinance.org';
export function sameSecret(a, b) {
  return typeof a === 'string' && typeof b === 'string' && timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
export function validateAlert(body, config, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected a JSON object.');
  if (!sameSecret(body.secret, config.secret)) throw new Error('Invalid webhook secret.');
  if (typeof body.id !== 'string' || !/^[\w.:\-]{1,160}$/.test(body.id)) throw new Error('id must be 1–160 letters, numbers, dots, colons, underscores or hyphens.');
  if (!['open_long', 'open_short', 'close'].includes(body.action)) throw new Error('Unsupported action.');
  if (body.symbol !== config.symbol) throw new Error(`Only ${config.symbol} is enabled.`);
  const timestamp = typeof body.timestamp === 'string' ? Date.parse(body.timestamp) : NaN;
  if (!Number.isFinite(timestamp) || now - timestamp > 120_000 || timestamp - now > 30_000) throw new Error('Alert expired or timestamp invalid (120 second limit).');
  return { id: body.id, action: body.action, symbol: body.symbol, timestamp: body.timestamp };
}
export function validateSettings(body) {
  const quantity = String(body.quantity ?? '');
  if (!/^0\.\d{1,6}$/.test(quantity) || Number(quantity) <= 0 || Number(quantity) > 0.01) throw new Error('BTC quantity must be greater than 0 and at most 0.01 (up to 6 decimals).');
  if (typeof body.enabled !== 'boolean') throw new Error('enabled must be a boolean.');
  return { quantity, enabled: body.enabled, symbol: 'BTC-USD' };
}
export function signedHeaders(method, path, body, publicKey, privateHex) {
  if (!/^[a-f\d]{64}$/i.test(publicKey) || !/^(?:[a-f\d]{64}|[a-f\d]{128})$/i.test(privateHex)) throw new Error('Strike keys must be raw Ed25519 hex.');
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(privateHex.slice(0, 64), 'hex')]), format: 'der', type: 'pkcs8' });
  const derived = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  if (derived !== publicKey.toLowerCase()) throw new Error('Strike public and private keys do not match.');
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
  const hash = createHash('sha256').update(body).digest('hex');
  return { 'Content-Type': 'application/json', 'X-API-Wallet-Public-Key': publicKey, 'X-API-Wallet-Timestamp': timestamp, 'X-API-Wallet-Nonce': nonce, 'X-API-Wallet-Signature': sign(null, Buffer.from(`${method}:${path}:${timestamp}:${nonce}:${hash}`), key).toString('hex') };
}
export class StrikeClient {
  constructor(env = process.env, fetcher = fetch) { this.env = env; this.fetcher = fetcher; }
  async request(method, path, payload) {
    const body = payload ? JSON.stringify(payload) : '';
    const headers = signedHeaders(method, path, body, this.env.STRIKE_PUBLIC_KEY || '', this.env.STRIKE_PRIVATE_KEY || '');
    const response = await this.fetcher(TESTNET + path, { method, headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(8000) });
    if (!response.ok) { const error = new Error(`Strike HTTP ${response.status}; check the account connection and order parameters.`); error.httpStatus = response.status; throw error; }
    return response.json();
  }
  async position(symbol) {
    const query = new URLSearchParams({ symbol });
    if (this.env.STRIKE_SUB_ACCOUNT_ID) query.set('sub_account_id', this.env.STRIKE_SUB_ACCOUNT_ID);
    const result = await this.request('GET', `/v2/positions?${query}`);
    if (!Array.isArray(result.positions)) throw new Error('Unexpected Strike positions response.');
    const positions = result.positions.filter(p => p.symbol === symbol && Number(p.size) !== 0);
    if (positions.length > 1) throw new Error('Multiple positions are unsupported.');
    const size = Number(positions[0]?.size || 0);
    if (!Number.isFinite(size)) throw new Error('Invalid Strike position size.');
    return size;
  }
  async order(order) {
    if (this.env.STRIKE_SUB_ACCOUNT_ID) order.sub_account_id = this.env.STRIKE_SUB_ACCOUNT_ID;
    return this.request('POST', '/v2/order', order);
  }
  async getOrder(symbol, clientOrderID) {
    const query = new URLSearchParams({ symbol, client_order_id: clientOrderID });
    if (this.env.STRIKE_SUB_ACCOUNT_ID) query.set('sub_account_id', this.env.STRIKE_SUB_ACCOUNT_ID);
    return this.request('GET', `/v2/order?${query}`);
  }
  async bracket(order) {
    if(this.env.STRIKE_SUB_ACCOUNT_ID)order.sub_account_id=this.env.STRIKE_SUB_ACCOUNT_ID;
    return this.request('POST','/v2/order/strategy',order);
  }
  async openOrders() {
    const query=new URLSearchParams({symbol:'BTC-USD'});
    if(this.env.STRIKE_SUB_ACCOUNT_ID)query.set('sub_account_id',this.env.STRIKE_SUB_ACCOUNT_ID);
    const result=await this.request('GET',`/v2/openOrders?${query}`);
    if(!Array.isArray(result.orders))throw Error('Cannot verify existing open orders.');
    return result.orders;
  }
  async setLeverage(leverage) {
    const body={symbol:'BTC-USD',leverage};
    if(this.env.STRIKE_SUB_ACCOUNT_ID)body.sub_account_id=this.env.STRIKE_SUB_ACCOUNT_ID;
    return this.request('POST','/v2/leverage',body);
  }
  async isolated() {
    const body={symbol:'BTC-USD',marginMode:'isolated'};
    if(this.env.STRIKE_SUB_ACCOUNT_ID)body.sub_account_id=this.env.STRIKE_SUB_ACCOUNT_ID;
    return this.request('POST','/v2/marginMode',body);
  }
  async marketRules() {
    const res=await this.fetcher(TESTNET+'/price/v2/exchangeInfo',{signal:AbortSignal.timeout(8000)});
    if(!res.ok)throw Error('Cannot load Strike testnet market rules.');
    const data=await res.json(),symbol=data.symbols?.find(s=>s.symbol==='BTC-USD');
    if(!symbol||String(symbol.status).toUpperCase()!=='TRADING')throw Error('BTC-USD is not available for trading on testnet.');
    const lot=symbol.filters?.find(f=>f.filterType==='LOT_SIZE'),price=symbol.filters?.find(f=>f.filterType==='PRICE_FILTER'),minimum=symbol.filters?.find(f=>f.filterType==='MIN_NOTIONAL');
    const result={symbol:'BTC-USD',stepSize:Number(lot?.stepSize),minQty:Number(lot?.minQty),maxQty:Number(lot?.maxQty),tickSize:Number(price?.tickSize),minPrice:Number(price?.minPrice),maxPrice:Number(price?.maxPrice),minNotional:Number(minimum?.notional??minimum?.minNotional),precision:symbol.quantityPrecision,source:'Strike testnet'};
    if(![result.stepSize,result.minQty,result.maxQty,result.tickSize,result.minNotional].every(n=>Number.isFinite(n)&&n>0)||!Number.isInteger(result.precision)||result.precision>8)throw Error('Incomplete market rules; testnet execution unavailable.');
    return result;
  }
  async markPrice() {
    const res=await this.fetcher(TESTNET+'/price/v2/markPrice?symbol=BTC-USD',{signal:AbortSignal.timeout(8000)});
    if(!res.ok)throw Error('Cannot load testnet price.');
    const data=await res.json();const price=Number(data.p??data.markPrice);
    if(!Number.isFinite(price)||price<=0)throw Error('Invalid testnet price response.');
    return {price,checkedAt:new Date().toISOString(),source:'Strike testnet mark price'};
  }
}
