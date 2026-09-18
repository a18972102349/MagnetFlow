import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, '..');
const output = process.env.MAGNET_FLOW_TEST_OUTPUT || path.resolve(root, 'work');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'magnetflow-public-search-'));
let application;
try {
  const env = { ...process.env, MAGNET_FLOW_HOME: path.join(temporary, 'profile'), MAGNET_FLOW_TEST_NETWORK: 'isolated' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.MAGNET_FLOW_EXE || require('electron'), args: ['--disable-gpu', ...(process.env.MAGNET_FLOW_EXE ? [] : [root])], env, timeout: 30000 });
  const page = await application.firstWindow();
  await page.locator('#empty-add').waitFor();
  await page.locator('[data-nav="resource-search"]').click();
  await page.locator('#resource-query').fill('Sintel');
  const searchStarted = await page.evaluate(() => performance.now());
  await page.locator('#submit-resource-search').click();
  await page.locator('.resource-result h2').filter({ hasText: /^Sintel$/ }).first().waitFor({ timeout: 10000 });
  const firstResultMs = (await page.evaluate(() => performance.now())) - searchStarted;
  await page.waitForFunction(() => document.querySelector('#cancel-resource-search').hidden, null, { timeout: 45000 });
  await page.locator('#resource-search-form').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'ui-search-public.png') });
  const observation = await page.evaluate(() => ({ status: document.querySelector('#resource-search-status').textContent, sources: document.querySelector('#resource-source-notices').textContent, resultCount: document.querySelectorAll('.resource-result').length }));
  // Resolve only the exact official CC movie example, and never confirm its
  // content download. Other providers' health is reported, not assumed.
  const row = page.locator('.resource-result').filter({ has: page.locator('h2', { hasText: /^Sintel$/ }) }).filter({ hasText: '开放影片示例' }).first();
  await row.locator('[data-resolve-result]').click();
  let task;
  const deadline = Date.now() + 25000;
  do {
    task = await page.evaluate(async () => (await window.magnetFlow.state()).tasks.find(task => task.id === '08ada5a7a6183aae1e09d831df6748d566095a10'));
    if (task?.ready) break;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  assert.equal(task?.ready, true, 'official metadata resolves before the deadline');
  assert.equal(task.awaitingSelection, true);
  assert.ok(task.files.length > 0);
  assert.ok(task.files.every(file => !file.selected && file.downloaded === 0));
  console.log(JSON.stringify({ ...observation, firstResultMs, officialMetadataResolved: true, contentBytes: task.downloaded }));
} finally {
  await application?.close();
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }).catch(() => {});
}
