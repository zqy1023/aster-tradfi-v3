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
    const response = await this.fetchImpl(`${this.restUrl}${path}`, { headers: { 'OK-ACCESS-KEY': this.credentials.apiKey, 'OK-ACCESS-SIGN': sign, 'OK-ACCESS-TIMESTAMP': timestamp, 'OK-ACCESS-PASSPHRASE': this.credentials.passphrase, 'content-type': 'application/json', 'user-agent': 'aster-tradfi-v3' } });
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

  placeOrder(intent) {
    const order = { instId: intent.instId, tdMode: 'cross', side: intent.side, ordType: intent.orderType, sz: String(intent.size), clOrdId: intent.id.replaceAll('-', '').slice(0, 32), reduceOnly: intent.reduceOnly };
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
    return this.request('order', [order], intent.id);
  }

  cancelOrder(intent) {
    return this.request('cancel-order', [{ instId: intent.instId, clOrdId: intent.id.replaceAll('-', '').slice(0, 32) }], `C-${intent.id}`.slice(0, 32));
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
