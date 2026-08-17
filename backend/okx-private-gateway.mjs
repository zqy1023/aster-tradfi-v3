import { createHmac } from 'node:crypto';

import WebSocket from 'ws';

const PRIVATE_URL = 'wss://ws.okx.com:8443/ws/v5/private';
const REST_URL = 'https://www.okx.com';

export class OKXPrivateGateway {
  constructor({ credentials, accountId, url = PRIVATE_URL, restUrl = REST_URL, WebSocketImpl = WebSocket, fetchImpl = fetch, onState = () => {}, onEvent = () => {} } = {}) {
    this.credentials = credentials;
    this.accountId = accountId;
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.fetchImpl = fetchImpl;
    this.restUrl = restUrl;
    this.onState = onState;
    this.onEvent = onEvent;
    this.socket = null;
    this.status = 'disconnected';
    this.pending = new Map();
    this.reconnects = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.reconcileTimer = null;
    this.closed = false;
    this.accountConfig = null;
    this.lastMessageAt = null;
    this.lastPingAt = null;
  }

  loginArgs() {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sign = createHmac('sha256', this.credentials.secretKey).update(`${timestamp}GET/users/self/verify`).digest('base64');
    return { apiKey: this.credentials.apiKey, passphrase: this.credentials.passphrase, timestamp, sign };
  }

  connect() {
    if (!this.WebSocketImpl) throw new Error('当前 Node 运行时没有 WebSocket 实现');
    this.closed = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.status = 'connecting'; this.onState({ status: this.status, message: '正在连接 OKX 私有 WebSocket' });
    this.socket = new this.WebSocketImpl(this.url);
    this.socket.addEventListener('open', () => this.socket.send(JSON.stringify({ op: 'login', args: [this.loginArgs()] })));
    this.socket.addEventListener('message', (event) => this.handleMessage(event.data));
    this.socket.addEventListener('error', () => { this.status = 'degraded'; this.onState({ status: this.status, message: 'OKX 私有 WebSocket 错误' }); });
    this.socket.addEventListener('close', () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      for (const pending of this.pending.values()) pending.reject(new Error('OKX 私有 WebSocket 已断开'));
      this.pending.clear();
      this.status = 'disconnected'; this.onState({ status: this.status, message: 'OKX 私有 WebSocket 已断开，正在重连' });
      this.reconnects += 1;
      if (!this.closed) this.reconnectTimer = setTimeout(() => this.connect(), Math.min(30_000, Math.max(1, this.reconnects) * 1000));
    });
    return this;
  }

  handleMessage(raw) {
    if (String(raw) === 'pong') { this.lastMessageAt = Date.now(); return; }
    this.lastMessageAt = Date.now();
    let payload;
    try { payload = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch { return; }
    if (payload.event === 'login') {
      if (payload.code === '0') {
        this.status = 'connected';
        this.reconnects = 0;
        this.onState({ status: this.status, message: 'OKX 私有 WebSocket 登录成功', lastSyncAt: new Date().toISOString() });
        this.subscribe();
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          if (this.socket?.readyState === 1) {
            this.lastPingAt = Date.now();
            this.socket.send('ping');
          }
          // 半开连接检测：发 ping 后 40s 内无任何消息则强制断开重连
          if (this.lastMessageAt && this.lastPingAt && Date.now() - this.lastMessageAt > 40_000) {
            this.onState({ status: 'degraded', message: 'OKX 私有 WebSocket 心跳无响应，强制重连' });
            this.socket?.terminate?.();
          }
        }, 20_000);
        this.reconcile().catch(() => this.onState({ status: this.status, message: 'OKX 私有 WS 已连接，初始历史对账稍后重试' }));
      } else {
        this.status = 'degraded'; this.onState({ status: this.status, message: `OKX 登录失败：${payload.msg || payload.code}` });
      }
      return;
    }
    if (payload.id && this.pending.has(payload.id)) {
      const pending = this.pending.get(payload.id); this.pending.delete(payload.id);
      if (payload.code === '0') pending.resolve(payload);
      else {
        const error = new Error(payload.msg || `OKX 返回 ${payload.code}`);
        error.code = payload.code;
        error.payload = payload;
        pending.reject(error);
      }
    }
    this.onEvent({ accountId: this.accountId, recvTs: new Date().toISOString(), payload });
  }

  subscribe() {
    if (this.status !== 'connected') return;
    this.socket.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'account' }, { channel: 'positions', instType: 'ANY' }, { channel: 'orders', instType: 'ANY' }, { channel: 'fills', instType: 'ANY' }] }));
  }

  async privateGet(path) {
    const timestamp = new Date().toISOString();
    const sign = createHmac('sha256', this.credentials.secretKey).update(`${timestamp}GET${path}`).digest('base64');
    const response = await this.fetchImpl(`${this.restUrl}${path}`, {
      headers: { 'OK-ACCESS-KEY': this.credentials.apiKey, 'OK-ACCESS-SIGN': sign, 'OK-ACCESS-TIMESTAMP': timestamp, 'OK-ACCESS-PASSPHRASE': this.credentials.passphrase, 'content-type': 'application/json', 'user-agent': 'aster-tradfi-v3' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`OKX 私有数据对账失败：HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.code !== '0') throw new Error(`OKX 私有数据对账失败：${payload.msg || payload.code}`);
    return payload.data || [];
  }

  async reconcile() {
    const recvTs = new Date().toISOString();
    const [accountConfig, account, positions, pendingOrders, swapFills, futureFills] = await Promise.all([
      this.privateGet('/api/v5/account/config'),
      this.privateGet('/api/v5/account/balance'),
      this.privateGet('/api/v5/account/positions'),
      this.privateGet('/api/v5/trade/orders-pending'),
      this.privateGet('/api/v5/trade/fills-history?instType=SWAP&limit=100'),
      this.privateGet('/api/v5/trade/fills-history?instType=FUTURES&limit=100'),
    ]);
    this.accountConfig = accountConfig[0] || null;
    const emit = (channel, data) => this.onEvent({ accountId: this.accountId, source: 'okx-rest-reconcile', recvTs, payload: { arg: { channel }, data } });
    emit('account', account);
    emit('positions', positions);
    emit('orders', pendingOrders);
    // REST fills 带真实 fillPnl（WS fills 事件的 fillPnl 恒为 0），用于修正已实现盈亏
    emit('fills', [...swapFills, ...futureFills]);
    this.onState({ status: this.status, message: 'OKX 私有 WS 实时连接，订单与成交历史已对账', lastSyncAt: recvTs });
    // 每 5 分钟重新对账一次，修正 WS 填充的 0 pnl（已实现盈亏实时性靠 WS，真值靠 REST 覆盖）
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => this.reconcile().catch(() => undefined), 5 * 60 * 1000);
    return recvTs;
  }

  request(op, args, requestId) {
    if (this.status !== 'connected') return Promise.reject(new Error('OKX 私有 WebSocket 尚未连接'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('OKX WebSocket 请求超时')); }, 8000);
      this.pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.socket.send(JSON.stringify({ id: requestId, op, args }));
    });
  }

  async placeOrder(intent) {
    // clOrdId 必须 ≤32 字符、仅字母数字（OKX 51000 错误：连字符/下划线非法）
    const clOrdId = intent.id.replaceAll('-', '').replaceAll('_', '').slice(0, 32) || `AUTO${Date.now()}`;
    const order = { instId: intent.instId, tdMode: 'cross', side: intent.side, ordType: intent.orderType, sz: String(intent.size), clOrdId, reduceOnly: intent.reduceOnly };
    if (this.accountConfig?.posMode === 'long_short_mode') {
      order.posSide = intent.reduceOnly ? (intent.side === 'buy' ? 'short' : 'long') : (intent.side === 'buy' ? 'long' : 'short');
    }
    if (intent.orderType === 'limit') order.px = String(intent.price);
    if (!intent.reduceOnly && (intent.stopLossPrice || intent.takeProfitPrice)) {
      const protection = {};
      if (intent.stopLossPrice) Object.assign(protection, { slTriggerPx: String(intent.stopLossPrice), slOrdPx: '-1' });
      if (intent.takeProfitPrice) Object.assign(protection, { tpTriggerPx: String(intent.takeProfitPrice), tpOrdPx: '-1' });
      order.attachAlgoOrds = [protection];
    }
    // 用 REST 下单（可靠、同步返回 ordId），WS order op 响应不可靠
    const body = JSON.stringify(order);
    const timestamp = new Date().toISOString();
    const sign = createHmac('sha256', this.credentials.secretKey).update(`${timestamp}POST/api/v5/trade/order${body}`).digest('base64');
    const response = await this.fetchImpl(`${this.restUrl}/api/v5/trade/order`, {
      method: 'POST',
      headers: {
        'OK-ACCESS-KEY': this.credentials.apiKey,
        'OK-ACCESS-SIGN': sign,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': this.credentials.passphrase,
        'content-type': 'application/json',
        'user-agent': 'aster-tradfi-v3',
      },
      body,
      signal: AbortSignal.timeout(12_000),
    });
    const payload = await response.json();
    if (payload.code !== '0') {
      const detail = (payload.data || []).map((d) => `${d.sCode}:${d.sMsg}`).join(';');
      throw new Error(`OKX 下单失败：${payload.msg || payload.code} [${detail}] body=${body}`);
    }
    return payload.data || [];
  }

  // OKX 原生移动止损（追踪止损）：价格创新高后按回撤比例触发，只减仓
  async listPendingAlgos(instType = 'SWAP') {
    // 只查用到的两种（conditional=硬止损/动态止损, move_order_stop=旧原生追踪），减少限流风险
    const types = ['conditional', 'move_order_stop'];
    const rows = await Promise.all(types.map((ordType) => this.privateGet(`/api/v5/trade/orders-algo-pending?ordType=${ordType}&instType=${encodeURIComponent(instType)}`).catch(() => [])));
    return rows.flat();
  }

  async listAlgoHistory(instType = 'SWAP') {
    return this.privateGet(`/api/v5/trade/orders-algo-history?ordType=move_order_stop&state=effective&instType=${encodeURIComponent(instType)}`);
  }

  // 取消算法单（动态止损/条件单）— OKX 端点是 cancel-algos（复数）
  async cancelAlgo({ instId, algoId } = {}) {
    if (!instId || !algoId) throw new Error('取消算法单缺少 instId/algoId');
    const body = JSON.stringify([{ instId, algoId }]);
    const timestamp = new Date().toISOString();
    const sign = createHmac('sha256', this.credentials.secretKey).update(`${timestamp}POST/api/v5/trade/cancel-algos${body}`).digest('base64');
    const response = await this.fetchImpl(`${this.restUrl}/api/v5/trade/cancel-algos`, {
      method: 'POST',
      headers: {
        'OK-ACCESS-KEY': this.credentials.apiKey,
        'OK-ACCESS-SIGN': sign,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': this.credentials.passphrase,
        'content-type': 'application/json',
        'user-agent': 'aster-tradfi-v3',
      },
      body,
    });
    const payload = await response.json();
    if (payload.code !== '0') throw new Error(`OKX 取消算法单失败：${payload.msg || payload.code}`);
    const rejected = (payload.data || []).find((x) => x.sCode && x.sCode !== '0');
    if (rejected) throw new Error(`OKX 取消算法单失败：${rejected.sMsg || rejected.sCode}`);
    return payload.data || [];
  }

  async setTrailingStop({ instId, side = 'sell', size, callbackRatio = 0.01, activePx = null, posSide = 'net' } = {}) {
    if (!instId || !(Number(size) > 0)) throw new Error('移动止损缺少标的或数量');
    const algo = {
      instId,
      tdMode: 'cross',
      side,
      posSide,
      ordType: 'move_order_stop',
      sz: String(size),
      callbackRatio: String(callbackRatio),
      reduceOnly: true,
    };
    if (activePx) algo.activePx = String(activePx);
    const timestamp = new Date().toISOString();
    const body = JSON.stringify(algo);
    const sign = createHmac('sha256', this.credentials.secretKey).update(`${timestamp}POST/api/v5/trade/order-algo${body}`).digest('base64');
    const response = await this.fetchImpl(`${this.restUrl}/api/v5/trade/order-algo`, {
      method: 'POST',
      headers: {
        'OK-ACCESS-KEY': this.credentials.apiKey,
        'OK-ACCESS-SIGN': sign,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': this.credentials.passphrase,
        'content-type': 'application/json',
        'user-agent': 'aster-tradfi-v3',
      },
      body,
    });
    const payload = await response.json();
    if (payload.code !== '0') throw new Error(`OKX 移动止损失败：${payload.msg || payload.code}`);
    const rejected = (payload.data || []).find((x) => x.sCode && x.sCode !== '0');
    if (rejected) throw new Error(`OKX 移动止损失败：${rejected.sMsg || rejected.sCode}`);
    return payload.data || [];
  }

  cancelOrder(intent) {
    return this.request('cancel-order', [{ instId: intent.instId, clOrdId: intent.id.replaceAll('-', '').slice(0, 32) }], `C-${intent.id}`.slice(0, 32));
  }

  // 为已有持仓挂止损/止盈（OKX order-algo 接口）— 保护性操作，不改变仓位大小
  // params: { instId, side(当前持仓方向 buy=sell保护? 按OKX: 多单挂SL用sell), slTriggerPx?, tpTriggerPx?, closeFraction=1 }
  async setPositionProtection({ instId, side = 'sell', slTriggerPx = null, tpTriggerPx = null, closeFraction = 1 } = {}) {
    if (!slTriggerPx && !tpTriggerPx) throw new Error('至少提供一个止损或止盈价');
    const algo = { instId, tdMode: 'cross', side, ordType: 'conditional', sz: String(closeFraction), triggerPxType: 'last' };
    if (slTriggerPx) Object.assign(algo, { slTriggerPx: String(slTriggerPx), slOrdPx: '-1' });
    if (tpTriggerPx) Object.assign(algo, { tpTriggerPx: String(tpTriggerPx), tpOrdPx: '-1' });
    // 调用 REST: POST /api/v5/trade/order-algo
    const timestamp = new Date().toISOString();
    const body = JSON.stringify(algo);
    const sign = createHmac('sha256', this.credentials.secretKey).update(`${timestamp}POST/api/v5/trade/order-algo${body}`).digest('base64');
    const response = await this.fetchImpl(`${this.restUrl}/api/v5/trade/order-algo`, {
      method: 'POST',
      headers: {
        'OK-ACCESS-KEY': this.credentials.apiKey,
        'OK-ACCESS-SIGN': sign,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': this.credentials.passphrase,
        'content-type': 'application/json',
        'user-agent': 'aster-tradfi-v3',
      },
      body,
    });
    const payload = await response.json();
    if (payload.code !== '0') throw new Error(`OKX 挂保护单失败：${payload.msg || payload.code}`);
    return payload.data || [];
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.socket?.close();
    this.socket = null;
  }
}
