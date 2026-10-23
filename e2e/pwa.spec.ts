import { test, expect } from '@playwright/test';

test('production PWA installs its worker, stays network-only and recovers from offline entry', async ({
  page,
  context,
  request,
}) => {
  const origin = 'http://127.0.0.1:4174';
  await page.goto(origin);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
  const manifestResponse = await request.get(`${origin}/manifest.webmanifest`);
  const manifest = await manifestResponse.json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/');
  expect(manifest.icons).toHaveLength(3);
  for (const icon of manifest.icons) {
    const response = await request.get(`${origin}${icon.src}`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('image/png');
  }
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: '暂时离线' })).toBeVisible();
  expect(
    await page.evaluate(async () => {
      try {
        await fetch('/api', {
          method: 'POST',
          body: JSON.stringify({ action: 'get', code: '1234' }),
        });
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: '创建房间', exact: true })).toBeVisible();
});
