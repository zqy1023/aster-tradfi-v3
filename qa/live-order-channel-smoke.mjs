import { readFile } from 'node:fs/promises';
import { OKXPrivateGateway } from '../backend/okx-private-gateway.mjs';
import { normalizeOkxInstrument } from '../backend/tradfi-domain.mjs';

if (process.env.ASTER_ALLOW_REJECTED_LIVE_PROBE !== 'true') throw new Error('必须显式设置 ASTER_ALLOW_REJECTED_LIVE_PROBE=true');
const credentialFile = process.env.OKX_CREDENTIAL_FILE || '/root/.ssh/okx.json';
const raw = JSON.parse(await readFile(credentialFile, 'utf8'));
const source = raw.credentials && typeof raw.credentials === 'object' ? raw.credentials : raw;
const credentials = {
  apiKey: source.apiKey || source.apikey || source.api_key,
  secretKey: source.secretKey || source.secretkey || source.secret_key,
  passphrase: source.passphrase || source.Passphrase,
};
if (!credentials.apiKey || !credentials.secretKey || !credentials.passphrase) throw new Error('OKX 凭证文件字段不完整');

const instrumentsResponse = await fetch('https://www.okx.com/api/v5/public/instruments?instType=SWAP');
const instrumentsPayload = await instrumentsResponse.json();
const instrument = (instrumentsPayload.data || []).map((row) => normalizeOkxInstrument(row)).find((row) => row.assetClass === 'equity' && row.instId.endsWith('-USDT-SWAP') && row.state === 'live');
if (!instrument) throw new Error('没有找到可用于零数量拒单探针的股票 USDT 永续合约');
const tickerResponse = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(instrument.instId)}`);
const tickerPayload = await tickerResponse.json();
const price = Number(tickerPayload.data?.[0]?.last || 0);
if (!(price > 0)) throw new Error('无法读取探针合约最新价');

let connectedResolve;
let connectedReject;
const connected = new Promise((resolve, reject) => { connectedResolve = resolve; connectedReject = reject; });
const gateway = new OKXPrivateGateway({
  credentials,
  accountId: 'live-order-probe',
  onState: (state) => {
    if (state.status === 'connected') connectedResolve();
    if (state.status === 'degraded') connectedReject(new Error(state.message));
  },
});

try {
  gateway.connect();
  await Promise.race([connected, new Promise((_, reject) => setTimeout(() => reject(new Error('OKX 私有 WS 登录超时')), 10_000))]);
  const before = await gateway.privateGet('/api/v5/trade/orders-pending');
  let exchangeCode = null;
  let exchangeMessage = null;
  let rejected = false;
  try {
    const ack = await gateway.placeOrder({ id: `PROBE-${Date.now()}`, instId: instrument.instId, side: 'buy', orderType: 'limit', size: 0, price, reduceOnly: false });
    const row = ack?.data?.[0] || {};
    exchangeCode = row.sCode || ack?.code || null;
    exchangeMessage = row.sMsg || ack?.msg || null;
    rejected = exchangeCode !== '0' && !row.ordId;
  } catch (error) {
    exchangeCode = error.code || 'transport-rejection';
    exchangeMessage = error.message;
    rejected = true;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = await gateway.privateGet('/api/v5/trade/orders-pending');
  const unchanged = after.length === before.length;
  if (!rejected || !unchanged) throw new Error('拒单探针未满足零资金风险验收条件');
  process.stdout.write(`${JSON.stringify({ passed: true, authenticated: true, instrument: instrument.instId, probe: 'zero-size-order-rejected', exchangeCode, exchangeMessage, pendingBefore: before.length, pendingAfter: after.length, createdOrder: false }, null, 2)}\n`);
} finally {
  gateway.close();
}
