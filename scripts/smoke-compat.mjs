import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebTorrent from 'webtorrent';
import { resolveMediaBinary } from '../src/media-transcoder.mjs';
// This Playwright build does not await async waitForFunction predicates.
// Evaluate IPC-backed state in Node and test the resolved value instead.
async function waitForAsyncState(page, predicate, arg, { timeout }) {
  const deadline = Date.now() + timeout;
  const timedOut = () => new Error(`Async state condition timed out after ${timeout} ms`);
  while (Date.now() < deadline) {
    let timer;
    try {
      const value = await Promise.race([
        page.evaluate(predicate, arg),
        new Promise((_, reject) => { timer = setTimeout(() => reject(timedOut()), Math.max(1, deadline - Date.now())); })
      ]);
      if (value) return value;
    } finally { clearTimeout(timer); }
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
  throw timedOut();
}
const run = promisify(execFile), require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const output = process.env.MAGNET_FLOW_TEST_OUTPUT || path.resolve(root, 'work');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'magnetflow-compat-ui-'));
const client = new WebTorrent({ dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false });
let application, page;
try {
  await fs.mkdir(output, { recursive: true });
  const fixture = path.join(temp, 'Compatibility-MPEG4-AC3.mkv');
  await run(resolveMediaBinary(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '40', '-c:v', 'mpeg4', '-q:v', '2', '-c:a', 'ac3', '-y', fixture], { windowsHide: true, maxBuffer: 1024 * 1024 });
  const seeded = await new Promise((resolve, reject) => { client.once('error', reject); client.seed(fixture, { announce: [], pieceLength: 32768 }, resolve); });
  const env = { ...process.env, MAGNET_FLOW_HOME: path.join(temp, 'profile'), MAGNET_FLOW_TEST_NETWORK: 'isolated' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.MAGNET_FLOW_EXE || require('electron'), args: ['--disable-gpu', ...(process.env.MAGNET_FLOW_EXE ? [] : [root])], env });
  page = await application.firstWindow();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('#empty-add').waitFor();
  await page.locator('[data-nav="settings"]').click();
  await page.locator('#download-limit').fill('256');
  await page.locator('#save-limits').click();
  await page.locator('#toast').filter({ hasText: '限速已保存' }).waitFor();
  await page.locator('[data-nav="all"]').click();
  await page.locator('#new-task').click();
  await page.locator('#magnet-input').fill(seeded.magnetURI + '&x.pe=' + encodeURIComponent(`127.0.0.1:${client.torrentPort}`));
  await page.locator('#auto-play').check();
  await page.locator('#submit-add').click();
  await waitForAsyncState(page, async id => {
    const task = (await window.magnetFlow.state()).tasks.find(task => task.id === id);
    return task?.ready && task.awaitingSelection === true && task.status === 'selecting' && task.files.length === 1;
  }, seeded.infoHash, { timeout: 20000 });
  await page.locator('#save-selection').filter({ hasText: '下载所选文件' }).waitFor();
  assert.equal(await page.locator('#files input[data-file]:checked').count(), 0);
  await new Promise(resolve => setTimeout(resolve, 900));
  const beforeSelection = await page.evaluate(async id => (await window.magnetFlow.state()).tasks.find(task => task.id === id), seeded.infoHash);
  assert.equal(beforeSelection.ready, true);
  assert.equal(beforeSelection.awaitingSelection, true);
  assert.equal(beforeSelection.status, 'selecting');
  assert.ok(beforeSelection.files.every(file => !file.selected && file.downloaded === 0), 'compatibility playback does not fetch payload before confirmation');
  assert.equal(await page.locator('#video').getAttribute('src'), null);
  const videoIndex = beforeSelection.files.find(file => file.name === path.basename(fixture)).index;
  await page.locator(`[data-file="${videoIndex}"]`).check();
  await page.locator('#save-selection').click();
  await waitForAsyncState(page, async ({ id, index }) => {
    const task = (await window.magnetFlow.state()).tasks.find(task => task.id === id);
    return task?.ready && task.awaitingSelection === false && task.files[index].selected;
  }, { id: seeded.infoHash, index: videoIndex }, { timeout: 20000 });
  const confirmed = await page.evaluate(async id => (await window.magnetFlow.state()).tasks.find(task => task.id === id), seeded.infoHash);
  assert.equal(confirmed.ready, true);
  assert.equal(confirmed.awaitingSelection, false);
  assert.deepEqual(confirmed.files.filter(file => file.selected).map(file => file.index), [videoIndex]);
  await page.waitForFunction(() => document.querySelector('#video').currentTime > 0.2 && document.querySelector('#video').videoWidth === 640, null, { timeout: 45000 });
  const observed = await page.evaluate(async () => ({ progress: (await window.magnetFlow.state()).tasks[0].progress, src: document.querySelector('#video').src, width: document.querySelector('#video').videoWidth }));
  assert.ok(observed.src.includes('/transcode/'), 'MKV uses automatic built-in compatibility playback');
  assert.ok(observed.progress < 1, 'MKV plays before the complete torrent is available');
  await page.locator('#jump-player').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'ui-compat.png') });
  await page.locator('#seek-seconds').fill('12');
  await page.locator('#jump-player').click();
  await page.waitForFunction(() => document.querySelector('#video').src.includes('start=12') && document.querySelector('#video').currentTime > 0.2, null, { timeout: 45000 });
  assert.match(await page.locator('#play-clock').textContent(), /^00:1[2-9]/);
  // Seeking again exercises immediate replacement and cancellation of the old encoder.
  await page.locator('#seek-seconds').fill('4'); await page.locator('#jump-player').click();
  await page.waitForFunction(() => document.querySelector('#video').src.includes('start=4') && document.querySelector('#video').currentTime > 0.2, null, { timeout: 30000 });
  assert.deepEqual(errors, []);
  console.log('PASS: actual Electron waits for file selection, automatically converts selected MPEG4/AC3 MKV, plays before download completion, seeks 12s then4s, no renderer errors');
  console.log(JSON.stringify({ metadataOnlyBytes: beforeSelection.files.reduce((sum, file) => sum + file.downloaded, 0), progressAtPlayback: observed.progress, width: observed.width }));
} catch (error) {
  console.error(error);
  if (page) {
    console.error(JSON.stringify(await page.evaluate(async () => ({ state: await window.magnetFlow.state(), playerStatus: document.querySelector('#player-status').textContent, hint: document.querySelector('#player-hint').textContent, videoError: document.querySelector('#video').error?.message }))));
    await page.screenshot({ path: path.join(output, 'ui-compat-failure.png') });
  }
  process.exitCode = 1;
} finally {
  await application?.close();
  await new Promise(resolve => client.destroy(resolve));
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }).catch(() => {});
}
