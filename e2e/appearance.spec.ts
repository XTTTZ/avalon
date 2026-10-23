import { test, expect } from '@playwright/test';

test('system appearance updates live, explicit choice persists, and settings stay compact', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '外观与安装', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '外观与安装' });
  await expect(dialog.getByRole('button', { name: '跟随系统' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dialog.getByRole('button', { name: '浅色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('avalon.theme'))).toBe('light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: '外观与安装', exact: true }).click();
  await dialog.getByRole('button', { name: '跟随系统' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  for (const button of await dialog.getByRole('button').all()) {
    const box = await button.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
});

test('early theme bootstrap works before React and without local storage', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
  });
  await page.route('**/src/main.tsx', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.locator('html').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    'rgb(16, 26, 21)',
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#101a15');
});

test('install offer is retained before opening settings and installed mode is recognized', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '外观与安装' })).toBeVisible();
  await page.evaluate(() => {
    const offer = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(offer, {
      prompt: async () => {
        window.dispatchEvent(new Event('appinstalled'));
        return { outcome: 'accepted' };
      },
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });
    window.dispatchEvent(offer);
  });
  await page.getByRole('button', { name: '外观与安装' }).click();
  await page.getByRole('button', { name: '安装应用', exact: true }).click();
  await expect(page.getByText('已在应用模式中打开')).toBeVisible();
  await expect(page.getByRole('button', { name: '安装应用', exact: true })).toHaveCount(0);
});

test('dark room header fits 320px and QR stays on a light background', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await page.getByLabel('你的公开名字').fill('外观测试');
  await page.getByRole('button', { name: '创建房间', exact: true }).click();
  await expect(page.locator('.room-badge')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.getByRole('button', { name: '外观与安装' }).click();
  await expect(page.getByRole('dialog', { name: '外观与安装' })).toBeVisible();
  await page.getByRole('button', { name: '关闭外观设置' }).click();
  await page.locator('.room-badge').click();
  await expect(page.getByRole('dialog', { name: '邀请好友' })).toBeVisible();
  expect(
    await page.locator('.qr-frame').evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe('rgb(255, 254, 249)');
  await page.getByRole('button', { name: '关闭弹窗' }).click();
  await page.getByRole('button', { name: '我的身份', exact: true }).click();
  await expect(page.getByRole('heading', { name: '尚未发身份' })).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-dark-identity.png' });
});
