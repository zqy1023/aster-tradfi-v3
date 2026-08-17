async (page) => {
  await page.route('**/api/v3/auth/session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: 'demo-user',
          username: 'demo',
          displayName: '本地验收',
          role: 'admin',
          tenantId: 'demo-tenant',
        },
      }),
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '今日工作', exact: true }).waitFor();
  return await page.getByRole('heading', { name: '今日工作', exact: true }).innerText();
}
