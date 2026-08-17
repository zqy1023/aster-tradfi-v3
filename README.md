# ASTER TradFi V3

全中文的 OKX TradFi 合约量化工作台。AI 负责策略研究，交易员提供目标、风险边界和审批。

## 本地演示

```powershell
npm test
npm run start:demo
```

默认地址为 `http://127.0.0.1:4310`。演示模式使用明确标注的样例行情和账户快照，实盘交易关闭。

V3 一级任务流固定为：机会、驾驶舱、实盘、复盘、设置。K 线使用本地 KLineChart v10，生产行情由 OKX Public/Business WebSocket 分离接入。

## 生产前置条件

1. 对 `aster_quant` 依次执行 `db/001-v2-core.sql`、`db/002-okx-realtime-history.sql`、`db/003-v3-workstation.sql`。三个脚本均使用 `CREATE TABLE IF NOT EXISTS`，可幂等执行。
2. 安装依赖并按 `.env.example` 配置 MySQL、代理认证、凭证加密主密钥和 AI 提供方。
3. 打通服务器到 OKX 公共/私有 WebSocket 的网络。
4. 先保持 `OKX_TRADING_ENABLED=false`，完成行情、账户、订单、成交、撤单和断线对账验收。
5. 实盘账户凭证只通过账户绑定接口提交，页面和日志不得回显。

## 安全默认值

- 非演示环境不信任客户端自报身份，只有配置代理认证密钥后才接受租户/用户头。
- 实盘凭证没有加密主密钥时拒绝保存。
- 订单意图和 Outbox 在同一 MySQL 事务提交。
- 模拟成交接口只在演示模式开放。
- 未形成回测、前向滚动和压力测试证据时拒绝实盘准入。
