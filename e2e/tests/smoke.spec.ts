import { test, expect } from '@playwright/test';

test('home page loads with a 200 and shows the Hubble logo', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page.getByText('Hubble', { exact: true })).toBeVisible();
});
