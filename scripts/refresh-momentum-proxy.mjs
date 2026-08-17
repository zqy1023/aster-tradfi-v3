// 每日刷新现货代理数据（Yahoo 5年日线 → data/equity-daily-proxy.json）
// 用法: node scripts/refresh-momentum-proxy.mjs
// 成功: 输出空(静默); 失败: 输出错误 + exit 1(告警)
import { EquityMomentumSource } from '../backend/equity-momentum-source.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
try {
  const src = new EquityMomentumSource();
  const out = await src.refresh();
  const count = Object.keys(out || {}).length;
  if (!count) { console.error('[momentum-proxy] 刷新失败：未获取到任何标的'); process.exit(1); }
  // 刷新后验证排名可用
  const ranks = src.rankMomentum();
  if (!ranks.size) { console.error('[momentum-proxy] 刷新后排名为空'); process.exit(1); }
  const top = [...ranks.entries()].sort((a, b) => a[1].rank - b[1].rank)[0];
  console.log(`[momentum-proxy] 已刷新 ${count} 个标的，Top1=${top[0]} +${(top[1].return12m * 100).toFixed(1)}%`);
} catch (error) {
  console.error('[momentum-proxy] 刷新异常:', error?.message || error);
  process.exit(1);
}
