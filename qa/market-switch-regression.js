async (page) => {
  const available = await page.locator('.instrument').evaluateAll((nodes) =>
    [...new Set(nodes.map((node) => node.dataset.inst).filter(Boolean))].slice(0, 3),
  );
  if (available.length < 3) throw new Error('行情目录少于 3 个可测合约');
  const sequence = [...available, available[0]];
  const expected = sequence.at(-1);

  for (const instId of sequence) {
    await page.locator(`[data-inst="${instId}"]`).click();
    await page.waitForTimeout(25);
  }

  const samples = [];
  for (let index = 0; index < 24; index += 1) {
    samples.push({
      elapsedMs: index * 100,
      title: await page.locator('#market-title').innerText(),
      meta: await page.locator('#market-meta').innerText(),
      active: await page.locator('.instrument.active').getAttribute('data-inst'),
      last: await page.locator('#quote-strip strong').first().innerText(),
    });
    await page.waitForTimeout(100);
  }

  const mismatches = samples.filter((sample) =>
    sample.active !== expected || !sample.meta.startsWith(expected),
  );

  return {
    passed: mismatches.length === 0,
    expected,
    sequence,
    mismatches,
    samples,
  };
}
