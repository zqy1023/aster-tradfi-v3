import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '../../npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright-core/index.mjs';

const baseUrl = process.env.ASTER_QA_URL || 'http://127.0.0.1:4330';
const username = process.env.ASTER_QA_USERNAME || 'demo';
const password = process.env.ASTER_QA_PASSWORD || 'demo';
const expectedLiveTrading = process.env.ASTER_QA_EXPECT_LIVE === 'true';
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const outputDir = resolve('output/playwright');

await mkdir(outputDir, { recursive: true });

const report = {
  startedAt: new Date().toISOString(), baseUrl, checks: [], failures: [], warnings: [],
  pageErrors: [], httpErrors: [], viewports: [],
};

function record(name, passed, detail = '') {
  report.checks.push({ name, passed, detail });
  if (!passed) report.failures.push(`${name}${detail ? `：${detail}` : ''}`);
}

async function screenshot(page, viewport, view) {
  await page.screenshot({ path: resolve(outputDir, `v3-${viewport}-${view}.png`), fullPage: false });
}

async function checkLayout(page, viewport, view) {
  const layout = await page.evaluate((viewName) => {
    const root = document.documentElement;
    const section = document.querySelector(`#view-${viewName}`);
    return { client: root.clientWidth, scroll: root.scrollWidth, visible: Boolean(section && !section.hidden) };
  }, view);
  record(`${viewport}/${view}/页面显示`, layout.visible, JSON.stringify(layout));
  record(`${viewport}/${view}/页面无横向溢出`, layout.scroll <= layout.client + 1, `${layout.scroll}/${layout.client}`);
}

async function openView(page, view, heading) {
  await page.locator(`.nav-btn[data-view="${view}"]`).click();
  await page.locator(`#view-${view}`).waitFor({ state: 'visible' });
  await page.getByRole('heading', { name: heading, exact: true }).waitFor({ state: 'visible' });
  record(`${view}/地址同步`, new URL(page.url()).hash === `#${view}`, page.url());
}

async function login(page, viewport) {
  await page.route('**/api/v3/auth/session', async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: '需要登录' }) });
  }, { times: 1 });
  const navigation = page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'attached' });
  const checking = await page.evaluate(() => ({
    auth: document.body.dataset.auth,
    loginHidden: document.querySelector('#login')?.hidden,
    appHidden: document.querySelector('#app')?.hidden,
  }));
  record(`${viewport}/登录/认证完成前不闪工作台`, checking.appHidden === true, JSON.stringify(checking));
  await navigation;
  await page.getByRole('heading', { name: '进入交易员工作台', exact: true }).waitFor({ state: 'visible' });
  record(`${viewport}/登录/独立登录页`, await page.locator('#login').isVisible());
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '机会雷达', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  record(`${viewport}/登录/账号登录成功`, await page.locator('#app').isVisible());
}

async function testOpportunities(page, viewport) {
  await openView(page, 'opportunities', '机会雷达');
  await page.locator('#market-state .metric').first().waitFor({ state: 'visible', timeout: 20_000 });
  const opportunityCount = await page.locator('#opportunity-list .opp').count();
  const signalCount = await page.locator('#decision-panel .signal').count();
  const plan = (await page.locator('#decision-panel').innerText()).replace(/\s+/g, ' ').trim();
  record(`${viewport}/机会/市场状态`, await page.locator('#market-state .metric').count() === 4);
  record(`${viewport}/机会/Top5候选`, opportunityCount > 0 && opportunityCount <= 5, String(opportunityCount));
  const opportunityFacts = await page.evaluate(async () => {
    const response = await fetch('/api/v3/workstation', { credentials: 'include' });
    const payload = await response.json();
    return {
      opportunities: (payload.opportunities || []).map((item) => ({
        instId: item.instId,
        assetClass: item.assetClass,
        scoreLabel: item.scoreLabel,
        scoreBasis: item.scoreBasis,
        trigger: item.trigger,
        arbitration: item.arbitration,
      })),
      marketState: payload.marketState || {},
    };
  });
  record(
    `${viewport}/机会/仅股票相关合约`,
    opportunityFacts.opportunities.length > 0 && opportunityFacts.opportunities.length <= 5 && opportunityFacts.opportunities.every((item) => item.assetClass === 'equity' && item.instId.endsWith('-USDT-SWAP')),
    JSON.stringify(opportunityFacts.opportunities.map(({ instId, assetClass }) => ({ instId, assetClass }))),
  );
  record(
    `${viewport}/机会/触发距离和阻塞原因`,
    opportunityFacts.opportunities.every((item) => item.trigger && typeof item.trigger.label === 'string' && Array.isArray(item.trigger.blockers)),
    JSON.stringify(opportunityFacts.opportunities.map((item) => ({ instId: item.instId, trigger: item.trigger }))),
  );
  record(
    `${viewport}/机会/分数依据且非胜率`,
    opportunityFacts.opportunities.every((item) => item.scoreLabel === '规则接近度' && item.scoreBasis?.length >= 3 && item.scoreBasis.some((basis) => /不是预测胜率/.test(basis))),
    JSON.stringify(opportunityFacts.opportunities.map((item) => ({ instId: item.instId, scoreLabel: item.scoreLabel, scoreBasis: item.scoreBasis }))),
  );
  record(
    `${viewport}/机会/市场与仲裁百分比有依据`,
    /证据完整度/.test(opportunityFacts.marketState.confidenceLabel || '')
      && opportunityFacts.marketState.confidenceBasis?.length >= 3
      && opportunityFacts.opportunities.every((item) => /证据完整度/.test(item.arbitration?.confidenceLabel || '') && item.arbitration?.confidenceBasis?.length >= 3),
    JSON.stringify({ confidenceLabel: opportunityFacts.marketState.confidenceLabel, confidenceBasis: opportunityFacts.marketState.confidenceBasis }),
  );
  const eventCosts = opportunityFacts.marketState.macro || [];
  record(
    `${viewport}/机会/事件与资金成本已接入`,
    eventCosts.length === 3
      && eventCosts.some((item) => item.name === 'CPI / 非农 / FOMC')
      && eventCosts.some((item) => item.name === '财报日历')
      && eventCosts.some((item) => item.name === 'OKX 资金费')
      && eventCosts.every((item) => !/未接入自动日历|待接入公司事件源|等待 OKX 资金费字段/.test(item.action || '')),
    JSON.stringify(eventCosts),
  );
  record(`${viewport}/机会/策略仲裁`, signalCount >= 1 && /最终做多|最终做空|关注|观望/.test(plan), plan.slice(0, 180));
  record(`${viewport}/机会/完整计划票据`, /入场区/.test(plan) && /止损/.test(plan) && /目标1/.test(plan) && /R倍数/.test(plan) && /失效条件/.test(plan), plan.slice(0, 220));
  const aiProvider = (await page.locator('#ai-provider-state').innerText()).trim();
  const aiWarning = (await page.locator('#research-error').innerText()).trim();
  record(`${viewport}/机会/AI研究入口可用`, await page.locator('#research-form').isVisible());
  record(
    `${viewport}/机会/AI模式诚实标识`,
    aiProvider === '研究模板模式' ? /演示研究输出|只能进入模拟验证/.test(aiWarning) : /^模型\s/.test(aiProvider),
    `${aiProvider}/${aiWarning}`,
  );
  if (opportunityCount > 1) {
    const before = (await page.locator('#decision-panel h3').first().innerText()).trim();
    await page.locator('#opportunity-list .opp').nth(1).click();
    await page.waitForTimeout(250);
    const after = (await page.locator('#decision-panel h3').first().innerText()).trim();
    record(`${viewport}/机会/候选联动计划`, before !== after, `${before} -> ${after}`);
  }
  await page.getByRole('button', { name: '打开K线', exact: true }).click();
  await page.getByRole('heading', { name: '行情驾驶舱', exact: true }).waitFor({ state: 'visible' });
  record(`${viewport}/机会/打开K线`, new URL(page.url()).hash === '#cockpit', page.url());
  await openView(page, 'opportunities', '机会雷达');
  await checkLayout(page, viewport, 'opportunities');
  await screenshot(page, viewport, 'opportunities');
}

async function canvasStats(page) {
  return page.locator('#kline-chart').evaluate((root) => {
    const canvases = [...root.querySelectorAll('canvas')];
    let colored = 0;
    for (const canvas of canvases) {
      const context = canvas.getContext('2d');
      if (!context || !canvas.width || !canvas.height) continue;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 3; index < pixels.length; index += 16) if (pixels[index] !== 0) colored += 1;
    }
    return { canvases: canvases.length, colored };
  });
}

async function testCockpit(page, viewport) {
  await openView(page, 'cockpit', '行情驾驶舱');
  await page.locator('#instrument-list .instrument').first().waitFor({ state: 'visible', timeout: 20_000 });
  const instruments = await page.locator('#instrument-list .instrument').count();
  record(`${viewport}/驾驶舱/股票合约池`, instruments > 0, String(instruments));
  const testCount = Math.min(3, instruments);
  const titles = [];
  const prices = [];
  for (let index = 0; index < testCount; index += 1) {
    const instrument = page.locator('#instrument-list .instrument').nth(index);
    const instId = await instrument.getAttribute('data-inst');
    await instrument.click();
    await page.waitForFunction((expected) => document.querySelector('#chart-meta')?.textContent?.startsWith(expected), instId, { timeout: 15_000 });
    titles.push((await page.locator('#chart-title').innerText()).trim());
    prices.push((await page.locator('#quote-strip .quote strong').first().innerText()).trim());
  }
  record(`${viewport}/驾驶舱/切换标的联动`, new Set(titles).size === testCount, titles.join(' / '));
  record(`${viewport}/驾驶舱/切换价格联动`, new Set(prices).size >= Math.min(2, testCount), prices.join(' / '));
  const rememberedInstId = await page.locator('#instrument-list .instrument').nth(Math.max(0, testCount - 1)).getAttribute('data-inst');
  await page.locator('#instrument-search').fill(rememberedInstId || '');
  record(`${viewport}/驾驶舱/合约搜索`, await page.locator('#instrument-list .instrument').count() === 1, rememberedInstId || '');
  await page.locator('#instrument-search').fill('');
  await page.locator('.nav-btn[data-view="live"]').click();
  await page.locator('#order-inst option').first().waitFor({ state: 'attached', timeout: 15_000 });
  record(`${viewport}/驾驶舱/跨页记忆标的`, await page.locator('#order-inst').inputValue() === rememberedInstId, `${await page.locator('#order-inst').inputValue()}/${rememberedInstId}`);
  await openView(page, 'cockpit', '行情驾驶舱');
  for (const timeframe of ['1m', '5m', '15m', '1H', '4H', '1D', '1W']) {
    await page.locator(`#timeframes button[data-bar="${timeframe}"]`).click();
    await page.waitForFunction((bar) => document.querySelector('#chart-meta')?.textContent?.includes(`· ${bar} ·`), timeframe, { timeout: 15_000 });
    const active = await page.locator(`#timeframes button[data-bar="${timeframe}"]`).getAttribute('class');
    const maskHidden = await page.locator('#chart-mask').evaluate((node) => node.hidden);
    record(`${viewport}/驾驶舱/K线周期-${timeframe}`, active?.includes('active') && maskHidden, `${active}/${maskHidden}`);
  }
  const pixels = await canvasStats(page);
  record(`${viewport}/驾驶舱/KLineChart画布非空`, pixels.canvases > 0 && pixels.colored > 500, JSON.stringify(pixels));
  record(`${viewport}/驾驶舱/五档盘口`, await page.locator('#bids .book-row').count() === 5 && await page.locator('#asks .book-row').count() === 5);
  const activeInstId = await page.evaluate(async () => {
    const response = await fetch('/api/v3/workstation', { credentials: 'include' });
    return (await response.json()).opportunities?.[0]?.instId || '';
  });
  const activeInstrument = page.locator(`#instrument-list .instrument[data-inst="${activeInstId}"]`);
  if (activeInstId && await activeInstrument.count()) {
    await activeInstrument.click();
    await page.waitForFunction((expected) => document.querySelector('#chart-meta')?.textContent?.startsWith(expected), activeInstId, { timeout: 15_000 });
    await page.locator('#trades .trade-row').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
  }
  const tradeCount = await page.locator('#trades .trade-row').count();
  const tradeState = (await page.locator('#trades').innerText()).trim();
  const marketSource = (await page.locator('#market-source').innerText()).trim();
  record(`${viewport}/驾驶舱/逐笔通道`, tradeCount > 0 || (/等待 trades/.test(tradeState) && /OKX 实时行情/.test(marketSource)), `${activeInstId}/${tradeCount}/${tradeState}`);
  if (tradeCount === 0) report.warnings.push(`${viewport}/驾驶舱：OKX 行情通道在线，${activeInstId} 在验收窗口内没有新逐笔成交。`);
  const timing = (await page.locator('#market-times').innerText()).replace(/\s+/g, ' ');
  record(`${viewport}/驾驶舱/数据源和时间`, /盘口源/.test(timing) && /K线源/.test(timing) && /订阅/.test(timing), timing);
  await checkLayout(page, viewport, 'cockpit');
  await screenshot(page, viewport, 'cockpit');
}

async function testLive(page, viewport) {
  await openView(page, 'live', '实盘工作区');
  const runtime = await page.evaluate(async () => (await fetch('/api/v3/health', { credentials: 'include' })).json());
  const liveModeCopy = (await page.locator('#live-mode-copy').innerText()).trim();
  record(`${viewport}/实盘/开关状态诚实显示`, runtime.liveTrading === expectedLiveTrading && (runtime.liveTrading ? /发送到 OKX 实盘/.test(liveModeCopy) : /只允许预检/.test(liveModeCopy)), `${runtime.liveTrading}/${liveModeCopy}`);
  await page.locator('#order-account option').first().waitFor({ state: 'attached', timeout: 15_000 });
  record(`${viewport}/实盘/隔离账户可选`, await page.locator('#order-account option').count() >= 1);
  record(`${viewport}/实盘/TradFi合约可选`, await page.locator('#order-inst option').count() > 0);
  const accountFacts = await page.evaluate(async () => {
    const response = await fetch('/api/v3/accounts', { credentials: 'include' });
    return (await response.json()).accounts || [];
  });
  const connectedAccount = accountFacts.find((account) => account.status === 'connected');
  if (connectedAccount) await page.locator('#order-account').selectOption(connectedAccount.id);
  const orderSetup = await page.evaluate(async () => {
    const [workstationResponse, instrumentsResponse] = await Promise.all([
      fetch('/api/v3/workstation', { credentials: 'include' }),
      fetch('/api/v3/markets/instruments?assetClass=equity', { credentials: 'include' }),
    ]);
    const workstation = await workstationResponse.json();
    const instruments = (await instrumentsResponse.json()).instruments || [];
    const candidate = (workstation.opportunities || []).find((item) => item.plan?.direction === 'long' || item.plan?.direction === 'short') || workstation.opportunities?.[0];
    const instrument = instruments.find((item) => item.instId === candidate?.instId);
    if (!candidate) return null;
    const tickSize = Math.max(Number(instrument?.tickSize || 0.01), 0.000001);
    const precision = Math.min(10, Math.max(0, String(tickSize).split('.')[1]?.length || 0));
    const align = (value) => Number((Math.round(value / tickSize) * tickSize).toFixed(precision));
    const side = candidate.plan?.direction === 'short' ? 'sell' : 'buy';
    const price = align(candidate.plan?.entryZone?.[0] || candidate.price);
    return {
      instId: candidate.instId,
      side,
      price,
      stop: candidate.plan?.stop || align(price * (side === 'sell' ? 1.05 : 0.95)),
      target: candidate.plan?.target1 || align(price * (side === 'sell' ? 0.95 : 1.05)),
      lotSize: Number(instrument?.lotSize || 1),
    };
  });
  if (orderSetup) {
    await page.locator('#order-inst').selectOption(orderSetup.instId);
    await page.locator('#order-side').selectOption(orderSetup.side);
    await page.locator('#order-size').fill(String(Math.max(orderSetup.lotSize, 1)));
    await page.locator('#order-price').fill(String(orderSetup.price || ''));
    await page.locator('#order-stop').fill('');
    await page.locator('#order-target').fill('');
  }
  const privateFacts = await page.evaluate(async () => {
    const response = await fetch('/api/v3/orders', { credentials: 'include' });
    const payload = await response.json();
    return {
      source: payload.source,
      orders: (payload.exchangeOrders || []).map((item) => item.source),
      fills: (payload.fills || []).map((item) => item.source),
      positions: (payload.positions || []).map((item) => item.source),
    };
  });
  record(
    `${viewport}/实盘/私有数据源诚实`,
    expectedLiveTrading ? privateFacts.source === 'okx-private-ws' : ['waiting-okx-account', 'okx-private-ws'].includes(privateFacts.source),
    JSON.stringify(privateFacts),
  );
  record(
    `${viewport}/实盘/私有事实来源可审计`,
    [...privateFacts.orders, ...privateFacts.fills, ...privateFacts.positions].every((source) => String(source).startsWith('okx-')),
    JSON.stringify(privateFacts),
  );
  const firstRiskResponse = page.waitForResponse((response) => response.url().includes('/api/v3/risk/check') && response.request().method() === 'POST');
  await page.locator('#precheck').click();
  await firstRiskResponse;
  await page.waitForFunction(() => /预检通过|预检拒绝/.test(document.querySelector('#risk-check')?.textContent || ''), null, { timeout: 10_000 });
  const precheck = (await page.locator('#risk-check').innerText()).replace(/\s+/g, ' ').trim();
  record(`${viewport}/实盘/风控硬门禁`, /数据健康/.test(precheck) && /账户状态/.test(precheck) && /点差与滑点/.test(precheck) && /手续费预算/.test(precheck) && /资金费预算/.test(precheck) && /保证金占用/.test(precheck) && /总敞口/.test(precheck), precheck.slice(0, 260));
  record(`${viewport}/实盘/新开仓无止损必拒绝`, /预检拒绝/.test(precheck) && /保护价格/.test(precheck) && await page.locator('#order-submit').isDisabled(), precheck.slice(0, 320));
  record(`${viewport}/实盘/风险断路器`, await page.locator('#risk-breakers .breaker').count() >= 3);
  const key = `qa-v3-${viewport}-${Date.now()}`;
  await page.locator('#order-key').fill(key);
  if (orderSetup?.stop) await page.locator('#order-stop').fill(String(orderSetup.stop));
  if (orderSetup?.target) await page.locator('#order-target').fill(String(orderSetup.target));
  const finalRiskResponse = page.waitForResponse((response) => response.url().includes('/api/v3/risk/check') && response.request().method() === 'POST');
  await page.locator('#precheck').click();
  await finalRiskResponse;
  await page.waitForFunction(() => /预检通过|预检拒绝/.test(document.querySelector('#risk-check')?.textContent || ''), null, { timeout: 10_000 });
  const finalPrecheck = (await page.locator('#risk-check').innerText()).replace(/\s+/g, ' ').trim();
  if (/预检通过/.test(finalPrecheck)) {
    await page.locator('#order-form button[type="submit"]').click();
    await page.locator('#order-confirm-dialog').waitFor({ state: 'visible' });
    record(`${viewport}/实盘/二次确认`, (await page.locator('#confirm-facts').innerText()).includes(await page.locator('#order-inst').inputValue()));
    if (runtime.liveTrading) {
      const confirmCopy = (await page.locator('#confirm-mode-copy').innerText()).trim();
      record(`${viewport}/实盘/实盘最终警示`, /最终实盘确认/.test(confirmCopy) && /发送到当前绑定的 OKX 实盘账户/.test(confirmCopy), confirmCopy);
      await page.locator('#cancel-order-intent').click();
      report.warnings.push(`${viewport}/实盘：实盘开关已开启，验收只验证二次确认，不发送测试订单。`);
    } else {
      await page.locator('#confirm-order-intent').click();
      await page.locator('#toast').waitFor({ state: 'visible' });
      const firstToast = (await page.locator('#toast').innerText()).trim();
      await page.locator('#order-form button[type="submit"]').click();
      await page.locator('#order-confirm-dialog').waitFor({ state: 'visible' });
      await page.locator('#confirm-order-intent').click();
      await page.waitForTimeout(250);
      const secondToast = (await page.locator('#toast').innerText()).trim();
      record(`${viewport}/实盘/订单意图`, /订单意图已写入/.test(firstToast), firstToast);
      record(`${viewport}/实盘/幂等防重复`, /重复幂等键/.test(secondToast), secondToast);
    }
  } else {
    const rejectedChecks = await page.locator('#risk-check .list-row').evaluateAll((nodes) => nodes.filter((node) => node.textContent.includes('拒绝')).map((node) => node.textContent.replace(/\s+/g, ' ').trim()));
    record(`${viewport}/实盘/拒绝原因明确`, rejectedChecks.length > 0, JSON.stringify(rejectedChecks));
    record(`${viewport}/实盘/拒绝后阻断提交`, await page.locator('#order-submit').isDisabled() && await page.locator('#order-confirm-dialog').isHidden(), `disabled=${await page.locator('#order-submit').isDisabled()}`);
    report.warnings.push(`${viewport}/实盘：真实账户风控预检未通过，未写入订单意图。${rejectedChecks.join('；')}`);
  }
  const health = await page.evaluate(async () => (await fetch('/api/v3/health')).json());
  record(`${viewport}/实盘/交易总开关符合预期`, health.liveTrading === expectedLiveTrading, JSON.stringify(health));
  await checkLayout(page, viewport, 'live');
  await screenshot(page, viewport, 'live');
}

async function testReview(page, viewport) {
  await openView(page, 'review', '复盘中心');
  const summary = (await page.locator('#review-summary').innerText()).replace(/\s+/g, ' ').trim();
  const detail = (await page.locator('#review-detail').innerText()).replace(/\s+/g, ' ').trim();
  for (const field of ['R倍数', 'MFE', 'MAE', 'VWAP滑点', 'Implementation Shortfall', '计划偏差', '纪律标签']) record(`${viewport}/复盘/单笔字段-${field}`, summary.includes(field));
  for (const field of ['净利', '胜率', '盈亏比', '期望', '回撤', '资金曲线', '策略贡献', '标的贡献']) record(`${viewport}/复盘/单日字段-${field}`, summary.includes(field));
  const reviewFacts = await page.evaluate(async () => {
    const response = await fetch('/api/v3/workstation', { credentials: 'include' });
    const review = (await response.json()).review || {};
    return { state: review.state, reconciled: review.reconciled, reconciliation: review.reconciliation, summary: review.summary || {} };
  });
  const pairedCount = Number(reviewFacts.summary.pairedTradeCount || 0);
  const reviewIsHonest = reviewFacts.reconciled === false
    && reviewFacts.summary.netPnl === null
    && (pairedCount > 0
      ? reviewFacts.state === 'estimated_unreconciled' && Number.isFinite(Number(reviewFacts.summary.estimatedNetPnl)) && /尚未与账单和资金费逐笔对平/.test(reviewFacts.reconciliation || '')
      : ['waiting_fills', 'waiting_pairing'].includes(reviewFacts.state) && reviewFacts.summary.estimatedNetPnl === null);
  record(`${viewport}/复盘/真实成交约束`, reviewIsHonest, JSON.stringify(reviewFacts));
  record(`${viewport}/复盘/未对平不显示正式净盈亏`, reviewFacts.summary.netPnl === null && /账单和资金费未逐笔对平前/.test(summary), summary.slice(0, 260));
  await checkLayout(page, viewport, 'review');
  await screenshot(page, viewport, 'review');
}

async function testSettings(page, viewport) {
  await openView(page, 'settings', '账户与设置');
  await page.locator('#accounts-list').waitFor({ state: 'visible' });
  record(`${viewport}/设置/已绑定隔离账户`, await page.locator('#accounts-list .list-row').count() >= 1);
  record(`${viewport}/设置/密钥默认隐藏`, await page.locator('#live-credentials').isHidden());
  await page.locator('#account-env').selectOption('live');
  record(`${viewport}/设置/实盘凭证字段`, await page.locator('#live-credentials').isVisible());
  const secretType = await page.locator('#account-secret-key').getAttribute('type');
  const passphraseType = await page.locator('#account-passphrase').getAttribute('type');
  record(`${viewport}/设置/敏感字段遮罩`, secretType === 'password' && passphraseType === 'password', `${secretType}/${passphraseType}`);
  await page.locator('#account-env').selectOption('demo');
  record(`${viewport}/设置/模拟账户隐藏凭证`, await page.locator('#live-credentials').isHidden());
  await checkLayout(page, viewport, 'settings');
  await screenshot(page, viewport, 'settings');
}

async function checkMobileControls(page, viewport) {
  if (!viewport.includes('mobile')) return;
  const controls = await page.locator('.sidebar .nav-btn').evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return { text: node.textContent.trim(), width: rect.width, height: rect.height };
  }));
  const undersized = controls.filter((item) => item.width < 44 || item.height < 44);
  record(`${viewport}/移动端/底栏五项`, controls.length === 5, JSON.stringify(controls));
  record(`${viewport}/移动端/主导航触控不小于44px`, undersized.length === 0, JSON.stringify(undersized));
}

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }, { name: 'small-mobile', width: 375, height: 812 }]) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    const page = await context.newPage();
    page.on('pageerror', (error) => report.pageErrors.push(`${viewport.name}: ${error.message}`));
    page.on('response', (response) => {
      if (response.status() < 400) return;
      const url = response.url();
      if (response.status() === 401 && url.includes('/api/v3/auth/session')) return;
      if (url.includes('/stream')) return;
      report.httpErrors.push(`${viewport.name}: ${response.status()} ${url}`);
    });
    await login(page, viewport.name);
    await testOpportunities(page, viewport.name);
    await testCockpit(page, viewport.name);
    await testLive(page, viewport.name);
    await testReview(page, viewport.name);
    await testSettings(page, viewport.name);
    await checkMobileControls(page, viewport.name);
    await page.getByRole('button', { name: '退出', exact: true }).click();
    await page.getByRole('heading', { name: '进入交易员工作台', exact: true }).waitFor({ state: 'visible' });
    record(`${viewport.name}/登录/退出登录`, await page.locator('#app').isHidden());
    report.viewports.push(viewport);
    await context.close();
  }
} finally {
  await browser.close();
}

report.completedAt = new Date().toISOString();
report.passed = report.failures.length === 0 && report.pageErrors.length === 0 && report.httpErrors.length === 0;
await writeFile(resolve(outputDir, 'v3-acceptance-report.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.passed ? 0 : 1;
