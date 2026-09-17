import { app, BrowserWindow, ipcMain, dialog, shell, Menu, net, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { DownloadEngine } from './core.mjs';
import { StreamServer } from './stream-server.mjs';
import { MediaTranscoder, validateStartSeconds } from './media-transcoder.mjs';
import { SearchService } from './search-service.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = pathToFileURL(path.join(here, 'ui/index.html')).href;
const portableHome = process.env.MAGNET_FLOW_HOME;
if (portableHome) {
  await fs.mkdir(portableHome, { recursive: true });
  app.setPath('userData', portableHome);
  app.setPath('sessionData', path.join(portableHome, 'browser'));
}
app.setName('MagnetFlow');
let window, engine, streaming, transcoder, searching, exiting = false;
const startupNotices = [];
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.restore(); window?.focus(); });
  // Electron defers its ready event until the ESM entry has finished evaluating.
  // Register a callback instead of awaiting readiness at module scope.
  app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  engine = new DownloadEngine({
    stateDir: app.getPath('userData'),
    downloadDir: portableHome ? path.join(portableHome, 'downloads') : path.join(app.getPath('downloads'), 'MagnetFlow'),
    clientOptions: process.env.MAGNET_FLOW_TEST_NETWORK === 'isolated' ? { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false } : {}
  });
  engine.on('notice', message => {
    if (window && !window.isDestroyed()) window.webContents.send('notice', message);
    else startupNotices.push(message);
  });
  await engine.init();
  searching = await new SearchService({
    stateDir: app.getPath('userData'), fetchImpl: (...args) => net.fetch(...args),
    encrypt: key => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法安全保存 API Key。');
      return safeStorage.encryptString(key).toString('base64');
    },
    decrypt: key => safeStorage.decryptString(Buffer.from(key, 'base64'))
  }).init();
  transcoder = new MediaTranscoder();
  streaming = await new StreamServer(engine, { transcoder }).listen();
  window = new BrowserWindow({
    width: 1380, height: 900, minWidth: 1080, minHeight: 720,
    title: '磁流 · MagnetFlow', backgroundColor: '#f5f7fb', show: false,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#f5f7fb', symbolColor: '#536078', height: 42 },
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== page) event.preventDefault(); });
  // Chromium's native video fullscreen control requests this permission too.
  // Grant only user-triggered fullscreen from our exact main document; sharing
  // the file:// origin is not sufficient for another frame or window.
  const allowFullscreen = (contents, permission, details) => Boolean(
    permission === 'fullscreen' && window && !window.isDestroyed() &&
    contents === window.webContents && !contents.isDestroyed() &&
    details?.isMainFrame === true && details.requestingUrl === page &&
    contents.mainFrame.url === page
  );
  window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) => allowFullscreen(contents, permission, details));
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowFullscreen(contents, permission, details)));
  const handle = (name, fn) => ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) throw new Error('无效请求来源。');
    try { return { ok: true, value: await fn(...args) }; } catch (err) { return { ok: false, error: err.message || '操作失败。' }; }
  });
  const snapshot = state => ({ ...(state || engine.snapshot()), media: { available: transcoder.availability().available }, notices: startupNotices.splice(0) });
  handle('state', () => snapshot());
  handle('add', magnet => engine.add(magnet));
  handle('search-settings', () => searching.settings());
  handle('save-search-source', input => searching.saveSource(input));
  handle('remove-search-source', id => searching.removeSource(id));
  handle('search-resources', input => searching.search(input));
  handle('cancel-resource-search', id => searching.cancel(id));
  handle('add-search-result', async id => { const result = await searching.resolve(id); return engine.add(result.input, result.fromFile); });
  searching.on('progress', result => { if (!window.isDestroyed()) window.webContents.send('search-progress', result); });
  handle('import', async () => {
    const selected = await dialog.showOpenDialog(window, { title: '添加种子文件', filters: [{ name: 'BitTorrent 种子', extensions: ['torrent'] }], properties: ['openFile'] });
    if (selected.canceled) return null;
    const stat = await fs.stat(selected.filePaths[0]);
    if (stat.size > 16 * 1024 * 1024) throw new Error('种子文件不能大于 16 MB。');
    return engine.add(await fs.readFile(selected.filePaths[0]), true);
  });
  handle('pause', id => engine.pause(id));
  handle('resume', id => engine.resume(id));
  handle('remove', id => engine.remove(id));
  handle('select', (id, indexes) => engine.selectFiles(id, indexes));
  handle('folder', async id => {
    const folder = id ? engine.get(id).path : engine.settings.downloadDir;
    await fs.mkdir(folder, { recursive: true });
    const error = await shell.openPath(folder);
    if (error) throw new Error(error);
  });
  handle('choose-directory', async () => {
    const selected = await dialog.showOpenDialog(window, { title: '选择新任务的下载目录', defaultPath: engine.settings.downloadDir, properties: ['openDirectory', 'createDirectory'] });
    if (!selected.canceled) await engine.updateSettings({ downloadDir: selected.filePaths[0] });
    return engine.settings;
  });
  const settingsPatch = (updates, allowed) => {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new Error('设置参数无效。');
    // Preserve partial updates: absent fields must not become undefined values
    // that fail validation or overwrite an unrelated setting.
    return Object.fromEntries(allowed.filter(key => Object.hasOwn(updates, key)).map(key => [key, updates[key]]));
  };
  handle('limits', updates => engine.updateSettings(settingsPatch(updates, ['downloadLimit', 'uploadLimit'])));
  handle('network-settings', updates => engine.updateSettings(settingsPatch(updates, ['extraTrackers', 'usePublicTrackers', 'maxConns'])));
  handle('reannounce', id => engine.reannounce(id));
  handle('cancel-playback', id => { engine.cancelPrefetch(id); transcoder.cancel(id); });
  handle('choose-player', async () => {
    const selected = await dialog.showOpenDialog(window, { title: '选择 VLC 或 mpv 播放器程序', filters: [{ name: '播放器', extensions: ['exe'] }], properties: ['openFile'] });
    if (selected.canceled) return engine.settings;
    if (!/^(vlc|mpv)\.exe$/i.test(path.basename(selected.filePaths[0]))) throw new Error('请选择 vlc.exe 或 mpv.exe。');
    return engine.updateSettings({ playerPath: selected.filePaths[0] });
  });
  handle('stream', async (id, index, options = {}) => {
    const file = await engine.mediaFile(id, index);
    if (!['auto', 'direct', 'compat', undefined].includes(options.mode)) throw new Error('播放模式无效。');
    const start = validateStartSeconds(options.startSeconds ?? 0);
    const mode = options.mode === 'compat' || (options.mode !== 'direct' && transcoder.availability().available && /\.(mkv|avi|ts|m2ts|wmv|asf|flv|rm|rmvb|mpg|mpeg)$/i.test(file.name)) ? 'compat' : 'direct';
    if (mode === 'compat' && !transcoder.availability().available) throw new Error('未找到内置 FFmpeg，请完整解压包含 ffmpeg 目录的程序包。');
    if (!start) await engine.preparePlayback(id, index);
    return { url: mode === 'compat' ? streaming.compatUrl(id, index, start) : streaming.url(id, index), name: file.name, length: file.length, mode };
  });
  handle('external-player', async (id, index) => {
    await engine.mediaFile(id, index);
    let executable = engine.settings.playerPath;
    if (!executable) {
      const candidates = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map(folder => path.join(folder, 'VideoLAN', 'VLC', 'vlc.exe'));
      for (const candidate of candidates) { try { await fs.access(candidate); executable = candidate; break; } catch {} }
    }
    if (!executable) throw new Error('未找到 VLC。请在设置中选择已安装的 VLC 或 mpv。');
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [streaming.url(id, index)], { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    return true;
  });
  engine.on('update', state => { if (!window.isDestroyed()) window.webContents.send('update', snapshot(state)); });
  engine.on('invalidate', id => { if (!window.isDestroyed()) window.webContents.send('invalidate', id); });
  window.once('ready-to-show', () => window.show());
  await window.loadURL(page);
  app.on('activate', () => window?.show());
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (exiting) return;
    event.preventDefault();
    exiting = true;
    (async () => {
      try { await searching.close(); await streaming.close(); await engine.close(); }
      catch (err) { await dialog.showMessageBox({ type: 'error', message: '保存任务时发生错误', detail: err.message }); }
      finally { app.quit(); }
    })();
  });
  }).catch(error => {
    dialog.showErrorBox('磁流启动失败', error.message);
    app.exit(1);
  });
}
