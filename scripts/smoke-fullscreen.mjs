import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const output = process.env.MAGNET_FLOW_TEST_OUTPUT || path.resolve(root, 'work');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'magnetflow-fullscreen-'));
let application, page;
try {
  const env = { ...process.env, MAGNET_FLOW_HOME: path.join(temporary, 'profile'), MAGNET_FLOW_TEST_NETWORK: 'isolated' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.MAGNET_FLOW_EXE || require('electron'), args: ['--disable-gpu', ...(process.env.MAGNET_FLOW_EXE ? [] : [root])], env, timeout: 30000 });
  page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#empty-add').waitFor();
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
  const originalBounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());

  // Original generated fixture, no torrent, external URL, camera or microphone.
  // Move the real app video into view without creating a fake download task.
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d');
    const capture = canvas.captureStream(12);
    const recorder = new MediaRecorder(capture, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const finished = new Promise(resolve => { recorder.onstop = resolve; });
    let frame = 0;
    const draw = setInterval(() => {
      ctx.fillStyle = '#14233a'; ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#6889ff'; ctx.fillRect((frame++ * 14) % 560, 210, 80, 20);
      ctx.fillStyle = '#ffffff'; ctx.font = '32px sans-serif'; ctx.fillText('MagnetFlow fullscreen test', 80, 160);
    }, 1000 / 12);
    recorder.start(); await new Promise(resolve => setTimeout(resolve, 1400)); recorder.stop(); await finished;
    clearInterval(draw); capture.getTracks().forEach(track => track.stop());
    const video = document.querySelector('#video');
    const fullscreenButton = document.querySelector('#fullscreen-player');
    if (fullscreenButton) {
      document.body.append(fullscreenButton);
      Object.assign(fullscreenButton.style, { position: 'fixed', left: '300px', top: '140px', zIndex: '9999' });
    }
    document.body.append(video);
    Object.assign(video.style, { position: 'fixed', left: '300px', top: '180px', width: '640px', height: '360px', zIndex: '9999', background: '#14233a' });
    video.controls = true; video.loop = true; video.muted = true;
    video.src = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
    await video.play();
  });
  await page.waitForFunction(() => document.querySelector('#video').currentTime > 0.1);
  const cdp = await page.context().newCDPSession(page);
  const pressEscape = () => application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.focus();
    // CDP keyboard dispatch can bypass Electron's native browser shortcut path.
    // Use the documented native input API for the OS-level fullscreen escape.
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  });
  async function clickNativeFullscreen() {
    await page.locator('#video').hover();
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    let fullscreen;
    for (const node of nodes) {
      if (!/full.?screen|全屏/i.test(node.name?.value || '') || !node.backendDOMNodeId || !['button', 'togglebutton'].includes(node.role?.value)) continue;
      const { node: dom } = await cdp.send('DOM.describeNode', { backendNodeId: node.backendDOMNodeId });
      const attributes = Object.fromEntries(Array.from({ length: (dom.attributes?.length || 0) / 2 }, (_, index) => [dom.attributes[index * 2], dom.attributes[index * 2 + 1]]));
      if (attributes.pseudo === '-webkit-media-controls-fullscreen-button') { fullscreen = node; break; }
    }
    assert.ok(fullscreen, `Chromium fullscreen control must be available: ${nodes.filter(node => node.role?.value === 'button').map(node => node.name?.value).join(', ')}`);
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: fullscreen.backendDOMNodeId });
    const x = (model.content[0] + model.content[2] + model.content[4] + model.content[6]) / 4;
    const y = (model.content[1] + model.content[3] + model.content[5] + model.content[7]) / 4;
    await page.mouse.click(x, y);
  }
  await clickNativeFullscreen();
  await page.waitForFunction(() => document.fullscreenElement === document.querySelector('#video'), null, { timeout: 10000 });
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), true);
  await page.screenshot({ path: path.join(output, 'ui-fullscreen.png') });
  await pressEscape();
  await page.waitForFunction(() => document.fullscreenElement === null, null, { timeout: 10000 });
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), false);
  assert.deepEqual(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()), originalBounds);
  await page.waitForFunction(() => !document.querySelector('#video').paused && document.querySelector('#video').readyState >= 2);
  // Enter a second time and use the native exit button to catch stale window state.
  await clickNativeFullscreen();
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  await clickNativeFullscreen();
  await page.waitForFunction(() => document.fullscreenElement === null);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), false);
  // The app's visible explicit button uses the same DOM permission path.
  await page.locator('#fullscreen-player').click();
  await page.waitForFunction(() => document.fullscreenElement === document.querySelector('#video'));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), true);
  await page.waitForFunction(() => document.querySelector('#fullscreen-player').textContent === '退出全屏');
  await pressEscape();
  await page.waitForFunction(() => document.fullscreenElement === null);
  await page.waitForFunction(() => document.querySelector('#fullscreen-player').textContent === '全屏');
  assert.deepEqual(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()), originalBounds);
  assert.equal(await page.evaluate(() => Notification.requestPermission()), 'denied');
  assert.equal(await page.evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' })).state), 'denied');
  assert.deepEqual(errors, []);
  console.log('PASS: Chromium native and app fullscreen buttons enter DOM + BrowserWindow fullscreen; Esc restores bounds/playback; repeated/native exit works; notification/geolocation permissions remain denied');
} catch (error) {
  console.error(error);
  if (page) {
    console.error(await page.evaluate(() => ({ fullscreen: document.fullscreenElement?.id, enabled: document.fullscreenEnabled, button: document.querySelector('#fullscreen-player')?.textContent, video: { width: document.querySelector('#video').videoWidth, time: document.querySelector('#video').currentTime }, url: location.href })));
    await page.screenshot({ path: path.join(output, 'ui-fullscreen-failure.png') }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await application?.close();
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }).catch(() => {});
}
