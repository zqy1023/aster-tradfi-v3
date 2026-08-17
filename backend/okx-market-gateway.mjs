import WebSocket from 'ws';

const DEFAULT_URL = 'wss://ws.okx.com:8443/ws/v5/public';

export class OKXMarketGateway {
  constructor({ url = DEFAULT_URL, onMessage = () => {}, onState = () => {}, WebSocketImpl = WebSocket } = {}) {
    this.url = url;
    this.onMessage = onMessage;
    this.onState = onState;
    this.WebSocketImpl = WebSocketImpl;
    this.socket = null;
    this.subscriptions = new Set();
    this.reconnects = 0;
    this.lastMessageAt = null;
    this.sequence = new Map();
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.closed = false;
  }

  connect() {
    if (!this.WebSocketImpl) throw new Error('当前 Node 运行时没有 WebSocket 实现');
    this.closed = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.onState({ status: 'connecting', message: '正在连接 OKX 公共 WebSocket' });
    this.socket = new this.WebSocketImpl(this.url);
    this.socket.addEventListener('open', () => {
      this.onState({ status: 'connected', message: 'OKX 公共 WebSocket 已连接' });
      if (this.subscriptions.size) this.subscribe([...this.subscriptions].map((item) => JSON.parse(item)));
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (this.socket?.readyState === 1) this.socket.send('ping');
      }, 20_000);
    });
    this.socket.addEventListener('message', (event) => this.handleMessage(event.data));
    this.socket.addEventListener('error', () => this.onState({ status: 'degraded', message: 'OKX 公共 WebSocket 发生错误' }));
    this.socket.addEventListener('close', () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.onState({ status: 'disconnected', message: 'OKX 公共 WebSocket 已断开' });
      this.reconnects += 1;
      if (!this.closed) this.reconnectTimer = setTimeout(() => this.connect(), Math.min(30_000, 1_000 * Math.max(1, this.reconnects)));
    });
    return this;
  }

  subscribe(args) {
    const list = args.map((item) => typeof item === 'string' ? (item.startsWith('{') ? JSON.parse(item) : { channel: item }) : item);
    list.forEach((item) => this.subscriptions.add(JSON.stringify(item)));
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify({ op: 'subscribe', args: list }));
  }

  unsubscribe(args) {
    const list = args.map((item) => typeof item === 'string' ? { channel: item } : item);
    list.forEach((item) => this.subscriptions.delete(JSON.stringify(item)));
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify({ op: 'unsubscribe', args: list }));
  }

  handleMessage(raw) {
    let payload;
    try { payload = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch { return; }
    const receivedAt = Date.now();
    this.lastMessageAt = new Date(receivedAt).toISOString();
    if (payload.event) { this.onMessage({ type: 'control', payload, receivedAt }); return; }
    const arg = payload.arg || {};
    const data = Array.isArray(payload.data) ? payload.data : [];
    const key = `${arg.channel || 'unknown'}:${arg.instId || ''}`;
    const previous = this.sequence.get(key);
    const sequence = Number(data[0]?.seqId || data[0]?.seq || 0);
    // books5 is a fresh top-five snapshot; only incremental book channels can indicate a gap.
    const incrementalBook = ['books', 'books-l2-tbt', 'books50-l2-tbt'].includes(String(arg.channel || ''));
    const gap = incrementalBook && previous && sequence && sequence > previous + 1;
    if (sequence) this.sequence.set(key, sequence);
    this.onMessage({ type: arg.channel || 'unknown', instId: arg.instId || null, data, sourceTs: data[0]?.ts ?? data[0]?.[0] ?? null, recvTs: new Date(receivedAt).toISOString(), sequence, gap, raw: payload });
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
