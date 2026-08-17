import { chromium } from '../../npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright-core/index.mjs';

const baseUrl = process.env.ASTER_QA_URL || 'https://wydwlh.icu';
const username = process.env.ASTER_QA_USERNAME;
const password = process.env.ASTER_QA_PASSWORD;
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

if (!username || !password) throw new Error('缺少只读验收登录凭证');

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '进入交易员工作台', exact: true }).waitFor({ state: 'visible' });
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '机会雷达', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  const result = await page.evaluate(async () => {
    const get = async (url) => {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error(`${url} 返回 ${response.status}`);
      return response.json();
    };
    const [health, accountsPayload, orders, workstation] = await Promise.all([
      get('/api/v3/health'),
      get('/api/v3/accounts'),
      get('/api/v3/orders'),
      get('/api/v3/workstation'),
    ]);
    const accounts = accountsPayload.accounts || [];
    return {
      liveTrading: health.liveTrading,
      publicWs: health.marketGateway?.status,
      businessWs: health.marketGateway?.businessStatus,
      privateSource: orders.source,
      connectedAccounts: accounts.filter((account) => account.status === 'connected').length,
      fillCount: (orders.fills || []).length,
      opportunityIds: (workstation.opportunities || []).map((item) => item.instId),
    };
  });
  const passed = result.liveTrading === true
    && result.publicWs === 'connected'
    && result.businessWs === 'connected'
    && result.privateSource === 'okx-private-ws'
    && result.connectedAccounts > 0
    && result.opportunityIds.length > 0
    && result.opportunityIds.every((instId) => instId.endsWith('-USDT-SWAP'))
    && pageErrors.length === 0;
  process.stdout.write(`${JSON.stringify({ passed, pageErrors, ...result }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
} finally {
  await browser.close();
}
