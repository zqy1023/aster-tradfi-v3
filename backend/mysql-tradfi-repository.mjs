function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

const date = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const input = typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : value;
  const parsed = input instanceof Date ? input : new Date(input);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const iso = (value) => value ? new Date(value).toISOString() : null;

export class MySQLTradFiRepository {
  constructor(pool) { this.pool = pool; }

  async upsertInstrument(instrument) {
    await this.pool.execute(
      `INSERT INTO instruments (inst_id,inst_type,asset_class,underlying,contract_size,quote_ccy,settle_ccy,tick_size,lot_size,trading_hours,state,source_channel,source_ts,recv_ts,raw_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE asset_class=VALUES(asset_class),underlying=VALUES(underlying),contract_size=VALUES(contract_size),quote_ccy=VALUES(quote_ccy),settle_ccy=VALUES(settle_ccy),tick_size=VALUES(tick_size),lot_size=VALUES(lot_size),trading_hours=VALUES(trading_hours),state=VALUES(state),source_ts=VALUES(source_ts),recv_ts=VALUES(recv_ts),raw_json=VALUES(raw_json)`,
      [instrument.instId, instrument.raw?.instType || 'SWAP', instrument.assetClass, instrument.underlying, instrument.contractSize, instrument.quoteCcy, instrument.settleCcy || null, instrument.tickSize, instrument.lotSize, JSON.stringify(instrument.tradingHours || ''), instrument.state, 'instruments', date(instrument.sourceTs), date(instrument.recvTs || new Date()), JSON.stringify(instrument.raw || {})],
    );
  }

  async upsertTickerSnapshot(snapshot) {
    await this.pool.execute(
      `INSERT INTO market_ticker_snapshots (inst_id,last_price,bid_price,ask_price,bid_size,ask_size,volume_24h,change_24h,source_ts,recv_ts,sequence_no,raw_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE last_price=VALUES(last_price),bid_price=VALUES(bid_price),ask_price=VALUES(ask_price),bid_size=VALUES(bid_size),ask_size=VALUES(ask_size),volume_24h=VALUES(volume_24h),change_24h=VALUES(change_24h),source_ts=VALUES(source_ts),recv_ts=VALUES(recv_ts),sequence_no=VALUES(sequence_no),raw_json=VALUES(raw_json)`,
      [snapshot.instId, snapshot.last, snapshot.bid, snapshot.ask, snapshot.bidSize, snapshot.askSize, snapshot.volume24h, snapshot.change24h, date(snapshot.sourceTs), date(snapshot.recvTs || new Date()), snapshot.sequence || null, JSON.stringify(snapshot.raw || {})],
    );
  }

  async upsertFundingRate(item) {
    await this.pool.execute(
      `INSERT INTO market_funding_rates (inst_id,funding_time,funding_rate,next_funding_time,source_ts,recv_ts,raw_json)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE funding_rate=VALUES(funding_rate),next_funding_time=VALUES(next_funding_time),source_ts=VALUES(source_ts),recv_ts=VALUES(recv_ts),raw_json=VALUES(raw_json)`,
      [item.instId, date(item.fundingTime || item.sourceTs), item.fundingRate, date(item.nextFundingTime), date(item.sourceTs), date(item.recvTs || new Date()), JSON.stringify(item.raw || {})],
    );
  }

  async saveMarketEvents(events) {
    for (const event of events) {
      await this.pool.execute(
        `INSERT INTO market_events (event_key,event_type,symbol,title,event_time,impact,forecast_value,previous_value,source,recv_ts,raw_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE title=VALUES(title),event_time=VALUES(event_time),impact=VALUES(impact),forecast_value=VALUES(forecast_value),previous_value=VALUES(previous_value),recv_ts=VALUES(recv_ts),raw_json=VALUES(raw_json)`,
        [event.key, event.type, event.symbol || null, event.title, date(event.time), event.impact || null, event.forecast || null, event.previous || null, event.source, date(event.recvTs || new Date()), JSON.stringify(event.raw || {})],
      );
    }
  }

  async saveOrderBookSnapshot(instId, book) {
    await this.pool.execute(
      `INSERT INTO market_orderbook_snapshots (inst_id,bids_json,asks_json,source_ts,recv_ts,sequence_no,gap_detected,raw_json)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE bids_json=VALUES(bids_json),asks_json=VALUES(asks_json),source_ts=VALUES(source_ts),recv_ts=VALUES(recv_ts),sequence_no=VALUES(sequence_no),gap_detected=VALUES(gap_detected),raw_json=VALUES(raw_json)`,
      [instId, JSON.stringify(book.bids || []), JSON.stringify(book.asks || []), date(book.sourceTs), date(book.recvTs || new Date()), book.sequence || null, Boolean(book.gap), JSON.stringify(book.raw || {})],
    );
  }

  async saveMarketTrades(instId, trades) {
    if (!trades.length) return;
    const values = trades.map((trade) => [instId, trade.tradeId, trade.price, trade.size, trade.side, date(trade.sourceTs || trade.ts), date(trade.recvTs || new Date()), JSON.stringify(trade.raw || {})]);
    const placeholders = values.map(() => '(?,?,?,?,?,?,?,?)').join(',');
    await this.pool.execute(
      `INSERT INTO market_trades (inst_id,trade_id,price,size,side,source_ts,recv_ts,raw_json)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE price=VALUES(price),size=VALUES(size),side=VALUES(side),source_ts=VALUES(source_ts),recv_ts=VALUES(recv_ts),raw_json=VALUES(raw_json)`,
      values.flat(),
    );
  }

  async upsertMarketCandles(instId, timeframe, candles) {
    for (const candle of candles) {
      await this.pool.execute(
        `INSERT INTO market_candles (inst_id,timeframe,open_time,open_price,high_price,low_price,close_price,volume,confirmed,source_ts,recv_ts,raw_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE open_price=VALUES(open_price),high_price=VALUES(high_price),low_price=VALUES(low_price),close_price=VALUES(close_price),volume=VALUES(volume),confirmed=VALUES(confirmed),source_ts=VALUES(source_ts),recv_ts=VALUES(recv_ts),raw_json=VALUES(raw_json)`,
        [instId, timeframe, date(candle.ts), candle.open, candle.high, candle.low, candle.close, candle.volume, Boolean(candle.confirm), date(candle.sourceTs || candle.ts), date(candle.recvTs || new Date()), JSON.stringify(candle.raw || {})],
      );
    }
  }

  async loadMarketCandles(instId, timeframe, limit = 1000) {
    const safeLimit = Math.max(1, Math.min(5000, Math.trunc(Number(limit) || 1000)));
    const [rows] = await this.pool.execute(`SELECT * FROM market_candles WHERE inst_id=? AND timeframe=? ORDER BY open_time DESC LIMIT ${safeLimit}`, [instId, timeframe]);
    return rows.reverse().map((row) => ({ ts: date(row.open_time)?.getTime(), open: Number(row.open_price), high: Number(row.high_price), low: Number(row.low_price), close: Number(row.close_price), volume: Number(row.volume), confirm: Boolean(row.confirmed), source: 'mysql-okx-history', sourceTs: iso(row.source_ts), recvTs: iso(row.recv_ts), raw: parseJson(row.raw_json, {}) }));
  }

  async saveAccount(account) {
    await this.pool.execute(
      `INSERT INTO exchange_accounts (id,tenant_id,owner_user_id,name,exchange,environment,credential_cipher,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE name=VALUES(name),credential_cipher=VALUES(credential_cipher),status=VALUES(status)`,
      [account.id, account.tenantId, account.ownerUserId, account.name, account.exchange, account.environment, account.credentialCipher || '', account.status, date(account.createdAt || new Date())],
    );
  }

  async updateAccount(account) {
    await this.pool.execute('UPDATE exchange_accounts SET status=? WHERE id=? AND tenant_id=?', [account.status, account.id, account.tenantId]);
  }

  async listAccounts({ tenantId, userId, role }) {
    const values = [tenantId];
    let sql = 'SELECT * FROM exchange_accounts WHERE tenant_id=?';
    if (role !== 'admin') { sql += ' AND owner_user_id=?'; values.push(userId); }
    sql += ' ORDER BY created_at DESC';
    const [rows] = await this.pool.execute(sql, values);
    return rows.map((row) => ({ id: row.id, tenantId: String(row.tenant_id), ownerUserId: String(row.owner_user_id), name: row.name, exchange: row.exchange, environment: row.environment, credentialCipher: row.credential_cipher || null, status: row.status, lastSyncAt: null, permissions: row.status === 'connected' ? ['读取', row.environment === 'live' ? '交易' : '交易（模拟）'] : ['等待 OKX 验证'], credentialMasked: row.environment === 'live' ? '凭证已由 AES-256-GCM 加密 · 页面永不回显' : '模拟环境无需实盘凭证', createdAt: iso(row.created_at) }));
  }

  async listAllLiveAccounts() {
    const [rows] = await this.pool.execute("SELECT * FROM exchange_accounts WHERE environment='live' AND status<>'disabled' ORDER BY created_at");
    return rows.map((row) => ({ id: row.id, tenantId: String(row.tenant_id), ownerUserId: String(row.owner_user_id), name: row.name, exchange: row.exchange, environment: row.environment, credentialCipher: row.credential_cipher || null, status: row.status, createdAt: iso(row.created_at) }));
  }

  async updateAccountCredentials(accountId, tenantId, credentialCipher) {
    await this.pool.execute("UPDATE exchange_accounts SET credential_cipher=?,status='pending' WHERE id=? AND tenant_id=?", [credentialCipher, accountId, tenantId]);
  }

  async saveRun(run) {
    await this.pool.execute(
      `INSERT INTO strategy_runs (id,tenant_id,run_type,inst_id,timeframe,status,progress,metrics_json,created_by,created_at,finished_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE status=VALUES(status),progress=VALUES(progress),metrics_json=VALUES(metrics_json),finished_at=VALUES(finished_at)`,
      [run.id, Number(run.tenantId), run.type, run.instId, run.timeframe, run.status, run.progress, JSON.stringify(run.metrics || {}), Number(run.createdBy || 1), date(run.createdAt || new Date()), date(run.finishedAt)],
    );
  }

  async listStrategies(tenantId) {
    const [rows] = await this.pool.execute(
      'SELECT id,name,style,asset_class,primary_timeframe,confirmation_timeframe,hypothesis,status,updated_at FROM strategy_definitions WHERE tenant_id=? ORDER BY updated_at DESC',
      [Number(tenantId || 1)],
    );
    return rows.map((row) => ({
      key: row.id,
      name: row.name,
      style: row.style,
      assetClass: row.asset_class,
      primaryTimeframe: row.primary_timeframe,
      confirmationTimeframe: row.confirmation_timeframe,
      hypothesis: row.hypothesis,
      status: row.status,
      updatedAt: iso(row.updated_at),
    }));
  }

  async upsertStrategy(strategy) {
    await this.pool.execute(
      `INSERT INTO strategy_definitions (id,tenant_id,name,style,asset_class,primary_timeframe,confirmation_timeframe,hypothesis,status,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE name=VALUES(name),style=VALUES(style),asset_class=VALUES(asset_class),primary_timeframe=VALUES(primary_timeframe),confirmation_timeframe=VALUES(confirmation_timeframe),hypothesis=VALUES(hypothesis),status=VALUES(status),updated_at=UTC_TIMESTAMP(3)`,
      [strategy.key, Number(strategy.tenantId || 1), strategy.name, strategy.style, strategy.assetClass || 'equity', strategy.primaryTimeframe, strategy.confirmationTimeframe, strategy.hypothesis, strategy.status, Number(strategy.createdBy || 1)],
    );
    return { key: strategy.key, status: strategy.status };
  }

  async listRuns(tenantId) {
    const [rows] = await this.pool.execute('SELECT * FROM strategy_runs WHERE tenant_id=? ORDER BY created_at DESC LIMIT 500', [tenantId]);
    return rows.map((row) => ({ id: row.id, tenantId: String(row.tenant_id), createdBy: String(row.created_by), type: row.run_type, strategyName: `策略运行 ${row.id}`, instId: row.inst_id, timeframe: row.timeframe, status: row.status, progress: row.progress, metrics: parseJson(row.metrics_json, null), createdAt: iso(row.created_at), finishedAt: iso(row.finished_at), notes: 'MySQL 持久化运行记录' }));
  }

  async saveOrderIntent(intent) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO order_intents (id,tenant_id,exchange_account_id,requested_by,idempotency_key,inst_id,side,order_type,size,price,reduce_only,stop_loss_price,take_profit_price,risk_snapshot_json,status,exchange_order_id,filled_size,avg_fill_price,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [intent.id, intent.tenantId, intent.accountId, intent.requestedBy, intent.idempotencyKey, intent.instId, intent.side, intent.orderType, intent.size, intent.price, intent.reduceOnly, intent.stopLossPrice, intent.takeProfitPrice, JSON.stringify(intent.risk), intent.status, intent.exchangeOrderId, intent.filledSize, intent.avgFillPrice, date(intent.createdAt), date(intent.updatedAt)],
      );
      if (intent.status === 'outbox_pending') {
        await connection.execute(
          `INSERT INTO order_outbox (intent_id,tenant_id,event_type,payload_json,status,attempts,next_attempt_at,created_at)
           VALUES (?,?, 'submit', ?, 'pending', 0, ?, ?)`,
          [intent.id, intent.tenantId, JSON.stringify({ intentId: intent.id, accountId: intent.accountId, instId: intent.instId, side: intent.side, orderType: intent.orderType, size: intent.size, price: intent.price, reduceOnly: intent.reduceOnly, stopLossPrice: intent.stopLossPrice, takeProfitPrice: intent.takeProfitPrice }), date(intent.createdAt), date(intent.createdAt)],
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  async updateOrderIntent(intent) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        'UPDATE order_intents SET status=?,exchange_order_id=?,filled_size=?,avg_fill_price=?,updated_at=? WHERE id=? AND tenant_id=?',
        [intent.status, intent.exchangeOrderId, intent.filledSize, intent.avgFillPrice, date(intent.updatedAt), intent.id, intent.tenantId],
      );
      const outboxStatus = ['sent', 'confirmed', 'partially_filled', 'filled'].includes(intent.status) ? 'confirmed' : intent.status === 'unknown' ? 'failed' : null;
      if (outboxStatus) await connection.execute('UPDATE order_outbox SET status=?,last_error=? WHERE intent_id=? AND event_type=\'submit\' AND status NOT IN (\'confirmed\',\'dead_letter\')', [outboxStatus, intent.status === 'unknown' ? '交易所确认状态未知，等待对账' : null, intent.id]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  async listOrders(tenantId) {
    const [rows] = await this.pool.execute('SELECT * FROM order_intents WHERE tenant_id=? ORDER BY created_at DESC LIMIT 1000', [tenantId]);
    return rows.map((row) => ({ id: row.id, tenantId: String(row.tenant_id), accountId: row.exchange_account_id, requestedBy: String(row.requested_by), idempotencyKey: row.idempotency_key, instId: row.inst_id, side: row.side, orderType: row.order_type, size: Number(row.size), price: row.price === null ? null : Number(row.price), reduceOnly: Boolean(row.reduce_only), stopLossPrice: row.stop_loss_price === null ? null : Number(row.stop_loss_price), takeProfitPrice: row.take_profit_price === null ? null : Number(row.take_profit_price), risk: parseJson(row.risk_snapshot_json, {}), status: row.status, exchangeOrderId: row.exchange_order_id, filledSize: Number(row.filled_size || 0), avgFillPrice: row.avg_fill_price === null ? null : Number(row.avg_fill_price), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), source: 'mysql' }));
  }

  async saveFill(fill) {
    await this.pool.execute(
      `INSERT INTO fills (id,tenant_id,order_intent_id,exchange_order_id,inst_id,side,size,price,fee,source_ts,recv_ts,raw_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE size=VALUES(size),price=VALUES(price),fee=VALUES(fee),source_ts=VALUES(source_ts),recv_ts=VALUES(recv_ts),raw_json=VALUES(raw_json)`,
      [fill.id, fill.tenantId, fill.orderId, fill.exchangeOrderId || null, fill.instId, fill.side, fill.size, fill.price, fill.fee, date(fill.sourceTs), date(fill.recvTs), JSON.stringify(fill.raw || { source: 'internal' })],
    );
  }

  async saveAccountSnapshot(snapshot) {
    await this.pool.execute(
      `INSERT INTO exchange_account_snapshots (tenant_id,exchange_account_id,equity,available,daily_pnl,source,source_ts,recv_ts,raw_json)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [snapshot.tenantId, snapshot.accountId, snapshot.equity, snapshot.available, snapshot.todayPnl, snapshot.source, date(snapshot.sourceTs), date(snapshot.updatedAt || new Date()), JSON.stringify(snapshot.raw || {})],
    );
  }

  async saveRiskSnapshot(snapshot) {
    await this.pool.execute(
      `INSERT INTO risk_snapshots (tenant_id,exchange_account_id,state,equity,available,daily_pnl,drawdown_pct,limits_json,source_ts,recv_ts)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [snapshot.tenantId, snapshot.accountId, 'normal', snapshot.equity || 0, snapshot.available || 0, snapshot.todayPnl || 0, snapshot.drawdownPct || 0, JSON.stringify({ openPositions: snapshot.openPositions || 0, grossExposure: snapshot.grossExposure || 0 }), date(snapshot.sourceTs), date(snapshot.updatedAt || new Date())],
    );
  }

  async upsertExchangeOrder(order) {
    await this.pool.execute(
      `INSERT INTO exchange_orders (tenant_id,exchange_account_id,exchange_order_id,client_order_id,inst_id,side,position_side,order_type,state,price,size,filled_size,avg_fill_price,last_fill_price,last_fill_size,fee,fee_currency,pnl,reduce_only,source,source_ts,recv_ts,raw_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE client_order_id=VALUES(client_order_id),state=VALUES(state),price=VALUES(price),size=VALUES(size),filled_size=VALUES(filled_size),avg_fill_price=VALUES(avg_fill_price),last_fill_price=VALUES(last_fill_price),last_fill_size=VALUES(last_fill_size),fee=VALUES(fee),fee_currency=VALUES(fee_currency),pnl=VALUES(pnl),source=VALUES(source),source_ts=VALUES(source_ts),recv_ts=VALUES(recv_ts),raw_json=VALUES(raw_json)`,
      [order.tenantId, order.accountId, order.exchangeOrderId, order.clientOrderId || null, order.instId, order.side, order.positionSide, order.orderType, order.state, order.price, order.size, order.filledSize, order.avgFillPrice, order.lastFillPrice, order.lastFillSize, order.fee, order.feeCurrency || null, order.pnl, order.reduceOnly, order.source, date(order.sourceTs), date(order.recvTs), JSON.stringify(order.raw || {})],
    );
  }

  async saveExchangeFill(fill) {
    await this.pool.execute(
      `INSERT INTO exchange_fills (id,tenant_id,exchange_account_id,exchange_order_id,client_order_id,trade_id,inst_id,side,size,price,fee,fee_currency,pnl,source,source_ts,recv_ts,raw_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE size=VALUES(size),price=VALUES(price),fee=VALUES(fee),fee_currency=VALUES(fee_currency),pnl=VALUES(pnl),source=VALUES(source),source_ts=VALUES(source_ts),recv_ts=VALUES(recv_ts),raw_json=VALUES(raw_json)`,
      [fill.id, fill.tenantId, fill.accountId, fill.exchangeOrderId, fill.clientOrderId || null, fill.tradeId, fill.instId, fill.side, fill.size, fill.price, fill.fee, fill.feeCurrency || null, fill.pnl, fill.source, date(fill.sourceTs), date(fill.recvTs), JSON.stringify(fill.raw || {})],
    );
  }

  async upsertExchangePosition(position) {
    await this.pool.execute(
      `INSERT INTO exchange_positions (tenant_id,exchange_account_id,inst_id,position_side,side,quantity,available_quantity,avg_entry_price,mark_price,unrealized_pnl,realized_pnl,margin,notional_usd,leverage,liquidation_price,source,source_ts,recv_ts,raw_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE side=VALUES(side),quantity=VALUES(quantity),available_quantity=VALUES(available_quantity),avg_entry_price=VALUES(avg_entry_price),mark_price=VALUES(mark_price),unrealized_pnl=VALUES(unrealized_pnl),realized_pnl=VALUES(realized_pnl),margin=VALUES(margin),notional_usd=VALUES(notional_usd),leverage=VALUES(leverage),liquidation_price=VALUES(liquidation_price),source=VALUES(source),source_ts=VALUES(source_ts),recv_ts=VALUES(recv_ts),raw_json=VALUES(raw_json)`,
      [position.tenantId, position.accountId, position.instId, position.posSide, position.side, position.quantity, position.availableQuantity, position.avgEntryPrice, position.markPrice, position.unrealizedPnl, position.realizedPnl, position.margin, position.notionalUsd, position.leverage, position.liquidationPrice, position.source, date(position.sourceTs), date(position.recvTs), JSON.stringify(position.raw || {})],
    );
  }

  async listExchangeOrders(tenantId) {
    const [rows] = await this.pool.execute('SELECT * FROM exchange_orders WHERE tenant_id=? ORDER BY COALESCE(source_ts,recv_ts) DESC LIMIT 1000', [tenantId]);
    return rows.map((row) => ({ tenantId: String(row.tenant_id), accountId: row.exchange_account_id, exchangeOrderId: row.exchange_order_id, clientOrderId: row.client_order_id || '', instId: row.inst_id, side: row.side, positionSide: row.position_side, orderType: row.order_type, state: row.state, price: row.price === null ? null : Number(row.price), size: Number(row.size), filledSize: Number(row.filled_size), avgFillPrice: row.avg_fill_price === null ? null : Number(row.avg_fill_price), lastFillPrice: row.last_fill_price === null ? null : Number(row.last_fill_price), lastFillSize: Number(row.last_fill_size), fee: Number(row.fee), feeCurrency: row.fee_currency || '', pnl: Number(row.pnl), reduceOnly: Boolean(row.reduce_only), source: row.source, sourceTs: iso(row.source_ts), recvTs: iso(row.recv_ts), raw: parseJson(row.raw_json, {}) }));
  }

  async listExchangeFills(tenantId) {
    const [rows] = await this.pool.execute('SELECT * FROM exchange_fills WHERE tenant_id=? ORDER BY COALESCE(source_ts,recv_ts) DESC LIMIT 1000', [tenantId]);
    return rows.map((row) => ({ id: row.id, tenantId: String(row.tenant_id), accountId: row.exchange_account_id, exchangeOrderId: row.exchange_order_id, clientOrderId: row.client_order_id || '', tradeId: row.trade_id, instId: row.inst_id, side: row.side, size: Number(row.size), price: Number(row.price), fee: Number(row.fee), feeCurrency: row.fee_currency || '', pnl: Number(row.pnl), source: row.source, sourceTs: iso(row.source_ts), recvTs: iso(row.recv_ts), raw: parseJson(row.raw_json, {}) }));
  }

  async listExchangePositions(tenantId) {
    const [rows] = await this.pool.execute('SELECT * FROM exchange_positions WHERE tenant_id=? AND quantity<>0 ORDER BY inst_id,position_side', [tenantId]);
    return rows.map((row) => ({ tenantId: String(row.tenant_id), accountId: row.exchange_account_id, instId: row.inst_id, posSide: row.position_side, side: row.side, quantity: Number(row.quantity), availableQuantity: Number(row.available_quantity), avgEntryPrice: row.avg_entry_price === null ? null : Number(row.avg_entry_price), markPrice: row.mark_price === null ? null : Number(row.mark_price), unrealizedPnl: Number(row.unrealized_pnl), realizedPnl: Number(row.realized_pnl), margin: Number(row.margin), notionalUsd: Number(row.notional_usd), leverage: row.leverage === null ? null : Number(row.leverage), liquidationPrice: row.liquidation_price === null ? null : Number(row.liquidation_price), source: row.source, sourceTs: iso(row.source_ts), recvTs: iso(row.recv_ts), raw: parseJson(row.raw_json, {}) }));
  }

  async saveAudit(event) {
    await this.pool.execute('INSERT INTO audit_events (id,tenant_id,actor_user_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?,?)', [event.id, event.tenantId, event.actor, event.type, JSON.stringify(event.detail || {}), date(event.createdAt)]);
  }

  async listAudit(tenantId) {
    const [rows] = await this.pool.execute('SELECT * FROM audit_events WHERE tenant_id=? ORDER BY created_at DESC LIMIT 100', [tenantId]);
    return rows.map((row) => ({ id: row.id, tenantId: String(row.tenant_id), actor: String(row.actor_user_id), type: row.event_type, detail: parseJson(row.detail_json, {}), createdAt: iso(row.created_at) }));
  }

  async saveDailyReview(review) {
    await this.pool.execute(
      `INSERT INTO daily_reviews (id,tenant_id,review_date,summary_json,attribution_json,incidents_json,next_actions_json,generated_at)
       VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE summary_json=VALUES(summary_json),attribution_json=VALUES(attribution_json),incidents_json=VALUES(incidents_json),next_actions_json=VALUES(next_actions_json),generated_at=VALUES(generated_at)`,
      [review.id, review.tenantId, review.date, JSON.stringify(review.summary), JSON.stringify(review.attribution), JSON.stringify(review.incidents), JSON.stringify(review.nextActions), new Date()],
    );
  }
}
