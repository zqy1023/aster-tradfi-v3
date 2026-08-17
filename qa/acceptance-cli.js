async (page) => {
  const outputDir = 'C:/Users/Administrator/Documents/Codex/2026-08-16/opx/work/v2/output/playwright';
  const pages = [
    { id: 'overview', nav: '今日工作', heading: '今日工作' },
    { id: 'markets', nav: '行情交易', heading: '行情交易' },
    { id: 'research', nav: 'AI 策略研究', heading: 'AI 策略研究' },
    { id: 'runs', nav: '运行中心', heading: '运行中心' },
    { id: 'orders', nav: '订单持仓', heading: '订单持仓' },
    { id: 'risk', nav: '风控中心', heading: '风控中心' },
    { id: 'reviews', nav: '交易复盘', heading: '交易复盘' },
    { id: 'accounts', nav: '账户权限', heading: '账户权限' },
  ];
  const viewports = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ];
  const results = [];
  const failures = [];
  const httpErrors = [];
  const pageErrors = [];

  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().includes('/stream')) {
      httpErrors.push({ status: response.status(), url: response.url() });
    }
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const assert = (condition, message) => {
    if (!condition) failures.push(message);
  };

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '今日工作', exact: true }).waitFor({ state: 'visible' });

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    for (const item of pages) {
      await page.locator('nav.sidebar').getByRole('button', { name: item.nav, exact: true }).click();
      await page.getByRole('heading', { name: item.heading, exact: true }).waitFor({ state: 'visible' });
      await page.waitForTimeout(item.id === 'markets' || item.id === 'orders' ? 1200 : 350);
      if (item.id === 'overview') {
        await page.locator('#overview-kpis .kpi').first().waitFor({ state: 'visible' });
        await page.locator('#overview-connection').getByText('OKX WS', { exact: false }).waitFor({ state: 'visible' });
      }

      const layout = await page.evaluate((viewId) => {
        const root = document.documentElement;
        const view = document.querySelector(`#view-${viewId}`);
        return {
          clientWidth: root.clientWidth,
          scrollWidth: root.scrollWidth,
          visible: Boolean(view && !view.hidden),
          heading: view?.querySelector('h1')?.textContent?.trim() || '',
        };
      }, item.id);

      assert(layout.visible, `${viewport.name}/${item.id}: 页面未显示`);
      assert(layout.heading === item.heading, `${viewport.name}/${item.id}: 标题异常`);
      assert(layout.scrollWidth <= layout.clientWidth + 1, `${viewport.name}/${item.id}: 页面横向溢出 ${layout.scrollWidth - layout.clientWidth}px`);

      const details = {};
      if (item.id === 'overview') {
        details.kpis = await page.locator('#overview-kpis .kpi').count();
        details.marketConnection = (await page.locator('#overview-connection').innerText()).trim();
        assert(details.kpis === 4, `${viewport.name}/overview: KPI 数量异常`);
        assert(details.marketConnection.includes('OKX WS'), `${viewport.name}/overview: OKX 连接状态异常`);
      }

      if (item.id === 'markets') {
        details.instruments = await page.locator('#instrument-list .instrument').count();
        details.bids = await page.locator('#bids .book-row').count();
        details.asks = await page.locator('#asks .book-row').count();
        details.source = (await page.locator('#market-source').innerText()).trim();
        details.quote = (await page.locator('#quote-strip').innerText()).replace(/\s+/g, ' ').trim();
        details.canvasPixels = await page.locator('#candle-chart').evaluate((canvas) => {
          const context = canvas.getContext('2d');
          const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let count = 0;
          for (let index = 3; index < data.length; index += 4) {
            if (data[index] !== 0) count += 1;
          }
          return count;
        });
        assert(details.instruments > 100, `${viewport.name}/markets: 合约目录未加载`);
        assert(details.bids === 5 && details.asks === 5, `${viewport.name}/markets: 五档盘口不完整`);
        assert(details.source.includes('OKX'), `${viewport.name}/markets: 数据源未显示 OKX`);
        assert(!details.quote.includes('待行情'), `${viewport.name}/markets: 实时报价缺失`);
        assert(details.canvasPixels > 5000, `${viewport.name}/markets: K 线画布为空`);
      }

      if (item.id === 'research') {
        details.objectiveEnabled = await page.locator('#objective').isEnabled();
        details.scopeCount = await page.locator('.scope input').count();
        details.startEnabled = await page.locator('#start-research').isEnabled();
        assert(details.objectiveEnabled && details.startEnabled, `${viewport.name}/research: 研究表单不可用`);
        assert(details.scopeCount >= 6, `${viewport.name}/research: 合约范围不完整`);
      }

      if (item.id === 'runs') {
        await page.locator('#new-run').click();
        await page.locator('#run-form-panel').waitFor({ state: 'visible' });
        details.instrumentOptions = await page.locator('#run-inst option').count();
        details.runTypes = await page.locator('#run-type option').count();
        assert(details.instrumentOptions > 100, `${viewport.name}/runs: 运行合约未加载`);
        assert(details.runTypes === 2, `${viewport.name}/runs: 运行类型异常`);
        await page.locator('#cancel-run').click();
        assert(await page.locator('#run-form-panel').isHidden(), `${viewport.name}/runs: 取消操作失效`);
      }

      if (item.id === 'orders') {
        details.privateSource = (await page.locator('#private-source').innerText()).trim();
        details.accountOptions = await page.locator('#order-account option').count();
        details.fillRows = await page.locator('#exchange-fills-table tbody tr').count();
        assert(details.privateSource.includes('OKX 私有 WS'), `${viewport.name}/orders: 私有 WS 状态异常`);
        assert(details.accountOptions >= 1, `${viewport.name}/orders: 账户隔离选项未加载`);
        assert(details.fillRows > 0, `${viewport.name}/orders: 真实成交未加载`);
        if (viewport.name === 'desktop') {
          await page.locator('#precheck').click();
          await page.locator('#risk-check strong').waitFor({ state: 'visible' });
          details.precheck = (await page.locator('#risk-check').innerText()).replace(/\s+/g, ' ').trim();
          assert(details.precheck.includes('预检查'), 'desktop/orders: 风险预检查无结果');
        }
      }

      if (item.id === 'risk') {
        details.kpis = await page.locator('#risk-summary .kpi').count();
        details.limits = await page.locator('#risk-limits .limit-bar').count();
        details.status = (await page.locator('#risk-status').innerText()).trim();
        assert(details.kpis === 4, `${viewport.name}/risk: 风控 KPI 数量异常`);
        assert(details.limits > 0, `${viewport.name}/risk: 风控限制项未加载`);
      }

      if (item.id === 'reviews') {
        const dailyVisible = await page.locator('#daily-review').isVisible();
        await page.getByRole('button', { name: '单笔复盘', exact: true }).click();
        await page.locator('#trade-review').waitFor({ state: 'visible' });
        const tradeVisible = await page.locator('#trade-review').isVisible();
        await page.getByRole('button', { name: '单日复盘', exact: true }).click();
        details.tabs = { dailyVisible, tradeVisible };
        assert(dailyVisible && tradeVisible, `${viewport.name}/reviews: 单日/单笔切换失效`);
      }

      if (item.id === 'accounts') {
        details.accounts = await page.locator('#accounts-list .list-row').count();
        details.accountText = (await page.locator('#accounts-list').innerText()).replace(/\s+/g, ' ').trim();
        details.liveFieldsHidden = await page.locator('#live-credentials').isHidden();
        assert(details.accounts >= 1, `${viewport.name}/accounts: 已绑定账户未加载`);
        assert(details.liveFieldsHidden, `${viewport.name}/accounts: 实盘密钥字段默认未隐藏`);
      }

      await page.screenshot({
        path: `${outputDir}/acceptance-${viewport.name}-${item.id}.png`,
        fullPage: false,
      });

      results.push({ viewport: viewport.name, page: item.id, layout, details });
    }
  }

  return {
    passed: failures.length === 0 && pageErrors.length === 0 && httpErrors.length === 0,
    checked: results.length,
    failures,
    pageErrors,
    httpErrors,
    results,
  };
}
