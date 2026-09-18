import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import WebTorrent from 'webtorrent';
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
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const work = process.env.MAGNET_FLOW_TEST_OUTPUT || path.resolve(root, 'work');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'magnetflow-ui-'));
const executablePath = process.env.MAGNET_FLOW_EXE || require('electron');
const client = new WebTorrent({ dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false });
let application;
try {
  await fs.mkdir(work, { recursive: true });
  const env = { ...process.env, MAGNET_FLOW_HOME: path.join(temporary, 'profile'), MAGNET_FLOW_TEST_NETWORK: 'isolated' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath, args: ['--disable-gpu', ...(process.env.MAGNET_FLOW_EXE ? [] : [root])], env, timeout: 30000 });
  application.process().stderr.on('data', data => { const text = data.toString(); if (/uncaught|exception|error/i.test(text)) process.stderr.write(text); });
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.locator('#empty-add').waitFor();
  await page.screenshot({ path: path.join(work, 'ui-empty.png') });
  await page.locator('#new-task').click();
  await page.locator('#magnet-input').fill('https://invalid.example/video');
  await page.locator('#submit-add').click();
  await page.locator('#add-error').filter({ hasText: /磁力|哈希/ }).waitFor();
  await page.locator('#cancel-add').click();
  await page.locator('[data-nav="settings"]').click();
  await page.locator('#download-limit').fill('24');
  await page.locator('#save-limits').click();
  await page.locator('#toast').filter({ hasText: '限速已保存' }).waitFor();
  await page.locator('[data-nav="all"]').click();
  console.log('PASS: desktop starts, validation and settings IPC work');
  // Produce an original playable VP8 video; no downloaded sample or copyright dependency.
  const videoBytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d');
    const recorder = new MediaRecorder(canvas.captureStream(24), { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 2200000 });
    const parts = []; recorder.ondataavailable = event => parts.push(event.data);
    const done = new Promise(resolve => recorder.onstop = resolve);
    let frame = 0;
    const draw = setInterval(() => {
      ctx.fillStyle = '#15243e'; ctx.fillRect(0, 0, 640, 360);
      for (let n = 0; n < 75; n++) { ctx.fillStyle = `hsl(${(frame * 4 + n * 7) % 360} 60% 55%)`; ctx.fillRect((n * 79 + frame * 8) % 640, (n * 43 + frame * 2) % 360, 25, 25); }
      ctx.fillStyle = '#ffffff'; ctx.font = 'bold 32px sans-serif'; ctx.fillText('MAGNET FLOW', 175, 180); frame++;
    }, 1000 / 24);
    recorder.start(); await new Promise(resolve => setTimeout(resolve, 6000)); recorder.stop(); clearInterval(draw); await done;
    return Array.from(new Uint8Array(await new Blob(parts, { type: 'video/webm' }).arrayBuffer()));
  });
  const fixture = path.join(temporary, 'MagnetFlow-Demo.webm');
  await fs.writeFile(fixture, Buffer.from(videoBytes));
  const extra = path.join(temporary, '00-Extra-NotSelected.bin');
  // Put the unchecked file first and end it on a piece boundary. Otherwise a
  // video-boundary piece could legitimately contain bytes from an adjacent file.
  await fs.writeFile(extra, randomBytes(2 * 1024 * 1024));
  const seeded = await new Promise((resolve, reject) => { client.once('error', reject); client.seed([extra, fixture], { name: 'MagnetFlow-Selection-Demo', announce: [], pieceLength: 16384 }, resolve); });
  const seededVideo = seeded.files.find(file => file.name === path.basename(fixture));
  const seededExtra = seeded.files.find(file => file.name === path.basename(extra));
  assert.equal(seededExtra.offset, 0);
  assert.equal(seededVideo.offset % seeded.pieceLength, 0, 'test files share no boundary piece');
  const magnet = seeded.magnetURI + '&x.pe=' + encodeURIComponent(`127.0.0.1:${client.torrentPort}`);
  await page.locator('#new-task').click();
  await page.locator('#magnet-input').fill(magnet);
  await page.locator('#auto-play').check();
  await page.locator('#submit-add').click();
  await page.locator('.task-card').waitFor();
  await waitForAsyncState(page, async id => {
    const task = (await window.magnetFlow.state()).tasks.find(task => task.id === id);
    return task?.ready && task.awaitingSelection === true && task.status === 'selecting' && task.files.length === 2;
  }, seeded.infoHash, { timeout: 20000 });
  await page.locator('#save-selection').filter({ hasText: '下载所选文件' }).waitFor();
  assert.equal(await page.locator('#files input[data-file]').count(), 2);
  assert.equal(await page.locator('#files input[data-file]:checked').count(), 0, 'file list initially selects nothing');
  assert.equal(await page.locator('#save-selection').isDisabled(), true, 'empty selection cannot be confirmed');
  assert.match(await page.locator('#selection-summary').innerText(), /^已选 0 \/ 2 个文件/);
  await page.locator('[data-command="play"]').click();
  await page.locator('#toast').filter({ hasText: '请先勾选需要的文件' }).waitFor();
  // Observe a full 800 ms renderer-update cycle: queued autoplay must not start
  // a payload transfer, even when the task's play button is clicked.
  await new Promise(resolve => setTimeout(resolve, 900));
  const beforeSelection = await page.evaluate(async id => (await window.magnetFlow.state()).tasks.find(task => task.id === id), seeded.infoHash);
  assert.equal(beforeSelection.ready, true);
  assert.equal(beforeSelection.awaitingSelection, true);
  assert.equal(beforeSelection.status, 'selecting');
  assert.equal(beforeSelection.downloaded, 0);
  assert.ok(beforeSelection.files.every(file => !file.selected && file.downloaded === 0), 'metadata resolution downloads no file contents');
  assert.equal(await page.locator('#video').getAttribute('src'), null, 'autoplay waits for selection confirmation');
  await page.screenshot({ path: path.join(work, 'ui-selection.png') });
  const videoIndex = beforeSelection.files.find(file => file.name === path.basename(fixture)).index;
  const extraIndex = beforeSelection.files.find(file => file.name === path.basename(extra)).index;
  assert.equal(await page.locator(`[data-play-file="${videoIndex}"]`).isDisabled(), true, 'file play also waits for confirmation');
  await page.locator('#select-all-files').click();
  assert.equal(await page.locator('#files input[data-file]:checked').count(), 2);
  assert.match(await page.locator('#selection-summary').innerText(), /^已选 2 \/ 2 个文件/);
  assert.equal(await page.locator('#save-selection').isEnabled(), true);
  await page.locator('#clear-files').click();
  assert.equal(await page.locator('#files input[data-file]:checked').count(), 0);
  assert.match(await page.locator('#selection-summary').innerText(), /^已选 0 \/ 2 个文件/);
  assert.equal(await page.locator('#save-selection').isDisabled(), true);
  await page.locator(`[data-file="${videoIndex}"]`).check();
  assert.equal(await page.locator(`[data-file="${extraIndex}"]`).isChecked(), false);
  assert.match(await page.locator('#selection-summary').innerText(), /^已选 1 \/ 2 个文件/);
  await page.locator('#selection-autoplay').uncheck();
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(await page.locator(`[data-file="${videoIndex}"]`).isChecked(), true, 'heartbeat preserves the unconfirmed draft');
  assert.equal(await page.locator(`[data-file="${extraIndex}"]`).isChecked(), false);
  assert.equal(await page.locator('#selection-autoplay').isChecked(), false, 'heartbeat preserves canceled autoplay');
  const draftOnly = await page.evaluate(async id => (await window.magnetFlow.state()).tasks.find(task => task.id === id), seeded.infoHash);
  assert.ok(draftOnly.files.every(file => !file.selected && file.downloaded === 0), 'draft edits do not start downloads');
  // First confirmation means start downloading, including a task paused while
  // its file list was being reviewed. Playback is a separate opt-in choice.
  await page.locator('[data-command="toggle"]').click();
  await page.locator('.status-pill').filter({ hasText: '已暂停' }).waitFor();
  assert.equal(await page.locator(`[data-file="${videoIndex}"]`).isChecked(), true, 'pause preserves the selection draft');
  await page.locator('#save-selection').click();
  // Confirmation may restart the torrent. Query the persisted task id rather
  // than retaining an old engine/torrent object across the transition.
  await waitForAsyncState(page, async ({ id, index }) => {
    const task = (await window.magnetFlow.state()).tasks.find(task => task.id === id);
    return task?.ready && task.awaitingSelection === false && task.status !== 'paused' && task.files.filter(file => file.selected).length === 1 && task.files[index].selected;
  }, { id: seeded.infoHash, index: videoIndex }, { timeout: 20000 });
  const confirmed = await page.evaluate(async id => (await window.magnetFlow.state()).tasks.find(task => task.id === id), seeded.infoHash);
  assert.equal(confirmed.ready, true);
  assert.equal(confirmed.awaitingSelection, false);
  assert.notEqual(confirmed.status, 'paused');
  assert.deepEqual(confirmed.files.filter(file => file.selected).map(file => file.index), [videoIndex]);
  // This route cancels the initial autoplay choice; smoke-compat keeps the
  // default automatic playback route covered with a real MKV conversion.
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(await page.locator('#video').getAttribute('src'), null, 'canceling autoplay leaves the player idle after confirmation');
  await page.locator(`[data-play-file="${videoIndex}"]`).click();
  await page.waitForFunction(() => document.querySelector('#video').currentTime > 0.2, null, { timeout: 30000 });
  const playing = await page.evaluate(async id => {
    const task = (await window.magnetFlow.state()).tasks.find(task => task.id === id);
    return { time: document.querySelector('#video').currentTime, progress: task.progress, width: document.querySelector('#video').videoWidth, length: task.length, files: task.files };
  }, seeded.infoHash);
  assert.ok(playing.time > 0 && playing.width === 640, 'real VP8 video decodes');
  assert.ok(playing.progress < 1, 'video plays while file remains incomplete');
  assert.equal(playing.length, seededVideo.length, 'task progress uses the selected video only');
  assert.deepEqual(playing.files.filter(file => file.selected).map(file => file.index), [videoIndex]);
  assert.equal(playing.files[extraIndex].downloaded, 0, 'unchecked extra file receives no payload');
  await page.locator('#external-player').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(work, 'ui-playing.png') });
  const playingSource = await page.locator('#video').evaluate(video => video.currentSrc);
  await page.locator('#fullscreen-player').click();
  await page.waitForFunction(() => {
    const video = document.querySelector('#video');
    const rect = video.getBoundingClientRect();
    // Windows display scaling can leave fractional CSS pixels at the edges.
    return document.fullscreenElement === video && Math.abs(rect.width - window.innerWidth) <= 1 && Math.abs(rect.height - window.innerHeight) <= 1;
  }, null, { timeout: 10000 });
  const fullscreenSize = await page.locator('#video').evaluate(video => {
    const rect = video.getBoundingClientRect();
    return { width: rect.width, height: rect.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
  });
  assert.ok(Math.abs(fullscreenSize.width - fullscreenSize.viewportWidth) <= 1, 'original player layout fills the fullscreen width within one CSS pixel');
  assert.ok(Math.abs(fullscreenSize.height - fullscreenSize.viewportHeight) <= 1, 'original player layout fills the fullscreen height within one CSS pixel');
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), true);
  await page.screenshot({ path: path.join(work, 'ui-playing-fullscreen.png') });
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  });
  await page.waitForFunction(() => document.fullscreenElement === null, null, { timeout: 10000 });
  const afterFullscreen = await page.locator('#video').evaluate(video => ({ source: video.currentSrc, paused: video.paused }));
  assert.equal(afterFullscreen.source, playingSource, 'Escape keeps the same video source');
  assert.equal(afterFullscreen.paused, false, 'Escape leaves the video playing');
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), false);
  await page.locator('[data-command="toggle"]').click();
  await page.locator('.status-pill').filter({ hasText: '已暂停' }).waitFor();
  const paused = await page.evaluate(async () => (await window.magnetFlow.state()).tasks[0]);
  assert.equal(paused.status, 'paused');
  await page.locator('[data-command="toggle"]').click();
  await page.waitForFunction(() => document.querySelector('.status-pill')?.textContent.includes('下载中'), null, { timeout: 20000 });
  const resumed = await page.evaluate(async id => (await window.magnetFlow.state()).tasks.find(task => task.id === id), seeded.infoHash);
  assert.deepEqual(resumed.files.filter(file => file.selected).map(file => file.index), [videoIndex]);
  assert.equal(resumed.files[extraIndex].downloaded, 0, 'selection is preserved after pause/resume');
  await page.locator('#save-selection').filter({ hasText: '应用文件选择' }).waitFor();
  assert.equal(await page.locator('#save-selection').isDisabled(), true, 'unchanged selection needs no update');
  await page.locator(`[data-file="${extraIndex}"]`).check();
  assert.equal(await page.locator('#save-selection').isEnabled(), true, 'an existing task accepts a new selection draft');
  await page.locator(`[data-file="${extraIndex}"]`).uncheck();
  assert.equal(await page.locator('#save-selection').isDisabled(), true, 'restoring the current selection discards the draft change');
  assert.deepEqual(errors, []);
  console.log('PASS: local multifile metadata has zero payload; unconfirmed play blocked; empty/select-all/clear controls and heartbeat drafts; paused confirmation resumes; canceled autoplay stays idle; manual video plays before completion; original player layout fills DOM/native fullscreen and Escape preserves playback; unchecked file remains at 0 bytes; pause/resume and existing-task draft controls; no renderer errors');
  console.log(JSON.stringify({ metadataOnlyBytes: beforeSelection.files.reduce((sum, file) => sum + file.downloaded, 0), time: playing.time, progress: playing.progress, width: playing.width, selectedFiles: playing.files.filter(file => file.selected).map(file => file.name), uncheckedBytes: playing.files[extraIndex].downloaded, fullscreenSize }));
} catch (error) {
  console.error(error);
  if (application) {
    const page = await application.firstWindow();
    console.error('UI state:', JSON.stringify(await page.evaluate(async () => {
      const video = document.querySelector('#video');
      const rect = video.getBoundingClientRect();
      return {
        state: await window.magnetFlow.state(), detailHidden: document.querySelector('#detail').hidden, error: document.querySelector('#add-error').textContent,
        fullscreen: { element: document.fullscreenElement?.id || null, enabled: document.fullscreenEnabled, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewport: { width: window.innerWidth, height: window.innerHeight }, devicePixelRatio: window.devicePixelRatio }
      };
    })));
    console.error('Native fullscreen:', await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFullScreen()));
    await page.screenshot({ path: path.join(work, 'ui-failure.png') });
  }
  process.exitCode = 1;
} finally {
  await application?.close();
  await new Promise(resolve => client.destroy(resolve));
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }).catch(error => console.error('Temporary cleanup:', error.message));
}
