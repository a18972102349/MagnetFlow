import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import createTorrent from 'create-torrent';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const output = process.env.MAGNET_FLOW_TEST_OUTPUT || path.resolve(root, 'work');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'magnetflow-search-ui-'));
const secret = 'local-fixture-secret';
const metadata = await new Promise((resolve, reject) => createTorrent(Buffer.from('Original local search test payload.'), { name: 'Search-selection-fixture.txt', announceList: [] }, (error, bytes) => error ? reject(error) : resolve(Buffer.from(bytes))));
let origin, delayedCancelled = 0, application, page;
let markSlowStarted;
const slowStarted = new Promise(resolve => { markSlowStarted = resolve; });
// waitForFunction treats an async predicate's Promise as truthy in this
// Playwright version. Await IPC reads in Node before deciding to stop polling.
async function waitForValue(read, matches, label) {
  const deadline = Date.now() + 15000;
  let observed;
  do {
    observed = await read();
    if (matches(observed)) return observed;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`${label}; last observed value: ${JSON.stringify(observed)}`);
}
const xml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
const fixture = http.createServer((req, res) => {
  const url = new URL(req.url, origin || 'http://127.0.0.1');
  if (url.searchParams.get('apikey') !== secret) { res.writeHead(403); res.end(); return; }
  if (url.pathname.startsWith('/torrent/')) { res.writeHead(200, { 'Content-Type': 'application/x-bittorrent' }); res.end(metadata); return; }
  if (url.pathname === '/error') { res.writeHead(503); res.end(); return; }
  if (url.pathname === '/delayed-error') {
    const timer = setTimeout(() => { res.writeHead(503); res.end(); }, 2500);
    res.once('close', () => clearTimeout(timer)); return;
  }
  const query = url.searchParams.get('q') || '';
  if (query === 'slow') {
    markSlowStarted();
    const timer = setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/xml' }); res.end('<rss><channel></channel></rss>'); }, 5000);
    res.once('close', () => { clearTimeout(timer); delayedCancelled++; }); return;
  }
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const count = offset ? 1 : 30;
  const items = Array.from({ length: count }, (_, index) => {
    const number = offset + index;
    return `<item><title>${xml(`${query === 'replacement' ? 'Replacement ' : ''}Fixture result ${number + 1}`)}</title><guid>fixture-${number}</guid><description>Original fixture for the search UI regression.</description><enclosure url="${xml(`${origin}/torrent/${number}.torrent?apikey=${secret}`)}" type="application/x-bittorrent"/>${number ? '<torznab:attr name="seeders" value="3"/><torznab:attr name="size" value="2048"/>' : ''}</item>`;
  }).join('');
  res.writeHead(200, { 'Content-Type': 'application/xml' });
  res.end(`<?xml version="1.0"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><torznab:response offset="${offset}" total="31"/>${items}</channel></rss>`);
});

try {
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${fixture.address().port}`;
  const env = { ...process.env, MAGNET_FLOW_HOME: path.join(temporary, 'profile'), MAGNET_FLOW_TEST_NETWORK: 'isolated' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.MAGNET_FLOW_EXE || require('electron'), args: ['--disable-gpu', ...(process.env.MAGNET_FLOW_EXE ? [] : [root])], env, timeout: 30000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('#empty-add').waitFor();
  await page.locator('[data-nav="settings"]').click();
  await page.locator('#download-limit').fill('32'); await page.locator('#upload-limit').fill('64'); await page.locator('#save-limits').click();
  await page.locator('#toast').filter({ hasText: '限速已保存' }).waitFor();
  const limitedState = await page.evaluate(() => window.magnetFlow.state());
  assert.equal(limitedState.settings.downloadLimit, 32); assert.equal(limitedState.settings.uploadLimit, 64);
  await page.locator('[data-nav="resource-search"]').click();
  await page.locator('#search-source-settings [data-search-source-toggle]').first().waitFor({ state: 'attached' });
  await page.locator('#manage-search-sources').click();
  await page.locator('#search-source-name').fill('Local regression source');
  await page.locator('#search-source-url').fill(`${origin}/api`);
  await page.locator('#search-source-token').fill(secret);
  await page.locator('#save-search-source').click();
  await page.locator('#search-source-settings').filter({ hasText: 'Local regression source' }).waitFor();
  assert.equal(await page.locator('#search-source-token').inputValue(), '');
  const settings = await page.evaluate(() => window.magnetFlow.searchSettings());
  assert.ok(!JSON.stringify(settings).includes(secret), 'public settings must not expose saved credentials');
  const source = settings.sources.find(item => item.name === 'Local regression source');
  assert.equal(source.hasApiKey, true);
  await page.locator('#resource-source').selectOption(source.id);
  await page.locator('#resource-query').fill('fixture');
  await page.locator('#submit-resource-search').click();
  await page.waitForFunction(() => document.querySelectorAll('.resource-result').length === 30);
  const first = page.locator('.resource-result').first();
  assert.match(await first.textContent(), /大小未知/); assert.match(await first.textContent(), /做种数未知/);
  assert.ok(!(await page.locator('#resource-search-page').innerHTML()).includes(secret));
  await page.locator('#load-more-results').click();
  await page.waitForFunction(() => document.querySelectorAll('.resource-result').length === 31);
  await page.evaluate(() => { document.querySelector('#resource-search-page').scrollTop = 0; });
  await page.screenshot({ path: path.join(output, 'ui-search.png') });
  await first.locator('[data-resolve-result]').click();
  await page.locator('#selection-note').filter({ hasText: '解析完成' }).waitFor();
  const task = (await page.evaluate(() => window.magnetFlow.state())).tasks[0];
  assert.equal(task.awaitingSelection, true); assert.equal(task.downloaded, 0);
  assert.ok(task.files.every(file => !file.selected));
  assert.equal(await page.locator('#save-selection').isDisabled(), true);
  await page.locator('#speed-diagnosis').filter({ hasText: '32.0 KB/s' }).waitFor();
  await page.locator('#remove-download-limit').click();
  const unlimitedState = await waitForValue(() => page.evaluate(() => window.magnetFlow.state()),
    snapshot => snapshot.settings.downloadLimit === 0 && snapshot.tasks[0]?.speedDiagnosis?.metrics.downloadLimitBps === 0,
    'Cancel download limit must update both persisted settings and task diagnosis');
  assert.equal(unlimitedState.settings.uploadLimit, 64, 'cancel download limit preserves the upload limit');
  await page.locator('#remove-download-limit').waitFor({ state: 'detached' });
  await page.locator('#speed-diagnosis').filter({ hasText: '不限速' }).waitFor();
  const uploadOnly = await page.evaluate(() => window.magnetFlow.limits({ uploadLimit: 48 }));
  assert.equal(uploadOnly.downloadLimit, 0); assert.equal(uploadOnly.uploadLimit, 48, 'upload-only updates preserve the download limit');
  await assert.rejects(() => page.evaluate(() => window.magnetFlow.limits({ downloadLimit: -1 })), /限速应为/);
  const afterInvalid = await page.evaluate(() => window.magnetFlow.state());
  assert.equal(afterInvalid.settings.downloadLimit, 0); assert.equal(afterInvalid.settings.uploadLimit, 48);
  const networkOnly = await page.evaluate(() => window.magnetFlow.networkSettings({ maxConns: 80 }));
  assert.equal(networkOnly.maxConns, 80);
  assert.equal(networkOnly.usePublicTrackers, afterInvalid.settings.usePublicTrackers);
  assert.deepEqual(networkOnly.extraTrackers, afterInvalid.settings.extraTrackers);
  await page.locator('[data-nav="resource-search"]').click();
  assert.equal(await page.locator('.resource-result').count(), 31, 'navigation retains results');
  await page.locator('#resource-query').fill('slow'); await page.locator('#submit-resource-search').click();
  let startTimer;
  try { await Promise.race([slowStarted, new Promise((_, reject) => { startTimer = setTimeout(() => reject(new Error('Slow provider request did not start')), 5000); })]); }
  finally { clearTimeout(startTimer); }
  await page.locator('#cancel-resource-search').click();
  await page.locator('#resource-search-status').filter({ hasText: '已取消' }).waitFor();
  await page.locator('#resource-query').fill('replacement'); await page.locator('#submit-resource-search').click();
  await page.locator('.resource-result h2').first().filter({ hasText: 'Replacement Fixture result' }).waitFor();
  assert.ok(delayedCancelled > 0, 'cancel aborts the in-flight provider HTTP request');
  await page.locator('#manage-search-sources').click();
  await page.locator(`[data-search-source-toggle="${source.id}"]`).uncheck();
  await page.waitForFunction(id => !Array.from(document.querySelector('#resource-source').options).some(option => option.value === id), source.id);
  await page.locator(`[data-search-source-toggle="${source.id}"]`).check();
  await page.waitForFunction(id => Array.from(document.querySelector('#resource-source').options).some(option => option.value === id), source.id);
  for (const builtin of settings.sources.filter(item => item.type === 'builtin')) {
    await page.locator(`[data-search-source-toggle="${builtin.id}"]`).uncheck();
    await waitForValue(() => page.evaluate(() => window.magnetFlow.searchSettings()),
      current => current.sources.find(item => item.id === builtin.id)?.enabled === false,
      `Disabling ${builtin.id} must reach saved source settings`);
  }
  await page.locator('#search-source-name').fill('Slow failure fixture');
  await page.locator('#search-source-url').fill(`${origin}/delayed-error`);
  await page.locator('#search-source-token').fill(secret); await page.locator('#save-search-source').click();
  await page.locator('#search-source-settings').filter({ hasText: 'Slow failure fixture' }).waitFor();
  const secondSource = (await page.evaluate(() => window.magnetFlow.searchSettings())).sources.find(item => item.name === 'Slow failure fixture');
  await page.locator('#resource-source').selectOption(''); await page.locator('#resource-query').fill('partial');
  await page.locator('#submit-resource-search').click();
  await page.waitForFunction(() => document.querySelectorAll('.resource-result').length === 30);
  assert.equal(await page.locator('#cancel-resource-search').isVisible(), true, 'fast source results are visible while another source is still pending');
  await page.locator('#resource-source-notices').filter({ hasText: 'Slow failure fixture' }).waitFor();
  await page.locator('#cancel-resource-search').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.resource-result').count(), 30, 'a failing source does not discard successful results');
  await page.locator('#manage-search-sources').click();
  await page.locator(`[data-remove-search-source="${secondSource.id}"]`).click();
  await page.locator(`[data-remove-search-source="${secondSource.id}"]`).waitFor({ state: 'detached' });
  await page.locator(`[data-remove-search-source="${source.id}"]`).click();
  await page.locator(`[data-remove-search-source="${source.id}"]`).waitFor({ state: 'detached' });
  await page.locator('[data-search-source-toggle="openmedia"]').check();
  await page.waitForFunction(() => Array.from(document.querySelector('#resource-source').options).some(option => option.value === 'openmedia'));
  await page.locator('#resource-source').selectOption('openmedia'); await page.locator('#resource-query').fill('Sintel');
  await page.locator('#submit-resource-search').click();
  await page.locator('#resource-source-notices').filter({ hasText: '示例' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: actual Torznab search, unknown metadata, pagination, cancellation, progressive multi-source results/error isolation, source notices, parse-before-selection, explicit limit removal, toggles/removal and secret redaction');
} catch (error) {
  console.error(error);
  if (page) {
    console.error(await page.locator('#resource-search-status').textContent());
    console.error(await page.locator('#search-source-error').textContent());
    console.error(await page.evaluate(async () => {
      const snapshot = await window.magnetFlow.state();
      return { settings: snapshot.settings, diagnoses: snapshot.tasks.map(task => task.speedDiagnosis),
        speedPanel: document.querySelector('#speed-diagnosis')?.textContent, toast: document.querySelector('#toast')?.textContent };
    }).catch(() => 'Could not retrieve failure diagnostics'));
    await page.screenshot({ path: path.join(output, 'ui-search-failure.png') }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await application?.close(); fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }).catch(() => {});
}
