import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebTorrent from 'webtorrent';
import parseTorrent, { toTorrentFile, toMagnetURI } from 'parse-torrent';
import { normalizeMagnet, chooseTrackers, MetadataCache, loadDhtState, saveDhtState, resolveDhtBootstrap } from './discovery.mjs';
import { installTrackerCompatibility } from './tracker-compat.mjs';

export const MEDIA = /\.(mp4|m4v|webm|ogv|ogg|mp3|wav|m4a|flac|mkv|avi|mov|ts|m2ts|mpg|mpeg|wmv|asf|flv|rm|rmvb|aac)$/i;
export function validateMagnet(input) {
  return normalizeMagnet(input);
}

export function validateFiles(files, root) {
  if (!Array.isArray(files) || !files.length) throw new Error('种子中没有文件。');
  const names = new Set();
  for (const file of files) {
    const name = file.path || file.name;
    if (typeof name !== 'string' || !name || /[\x00-\x1f:]/.test(name) || /(^|[\\/])\.\.([\\/]|$)/.test(name) || /^[\\/]/.test(name)) throw new Error('种子包含不安全的文件路径。');
    const target = path.resolve(root, name);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('文件路径超出下载目录。');
    const key = target.toLowerCase();
    if (names.has(key)) throw new Error('种子包含重复的文件路径。');
    names.add(key);
  }
}

const safeRate = value => {
  if (!Number.isInteger(value) || value < 0 || value > 1048576) throw new Error('限速应为 0 至 1048576 之间的整数，单位 KB/s。');
  return value;
};

const knownPeerAvailability = new WeakSet();
const positiveRate = value => Number.isFinite(value) ? Math.max(0, value) : 0;

function selectedAvailability(record, torrent, wires) {
  if (!torrent?.ready || record.awaitingSelection || !torrent.pieceLength) return null;
  const ranges = [];
  for (const [index, file] of torrent.files.entries()) {
    if (!file.length || (record.selectedFiles !== null && !record.selectedFiles?.includes(index))) continue;
    const from = Math.floor(file.offset / torrent.pieceLength);
    const to = Math.floor((file.offset + file.length - 1) / torrent.pieceLength);
    const previous = ranges.at(-1);
    if (previous && from <= previous.to + 1) previous.to = Math.max(previous.to, to);
    else ranges.push({ from, to });
  }
  const selectedPieces = ranges.reduce((sum, range) => sum + range.to - range.from + 1, 0);
  // Diagnostics must not scan millions of pieces times hundreds of peers on
  // every UI update. Sample evenly across selected ranges, with explicit scope.
  const checkedPieces = Math.min(selectedPieces, 256);
  let rangeIndex = 0, rangeOffset = 0, missingPieces = 0, availableMissingPieces = 0;
  for (let sample = 0; sample < checkedPieces; sample++) {
    const ordinal = Math.floor(sample * selectedPieces / checkedPieces);
    while (ordinal >= rangeOffset + ranges[rangeIndex].to - ranges[rangeIndex].from + 1) {
      rangeOffset += ranges[rangeIndex].to - ranges[rangeIndex].from + 1;
      rangeIndex++;
    }
    const piece = ranges[rangeIndex].from + ordinal - rangeOffset;
    if (torrent.bitfield.get(piece)) continue;
    missingPieces++;
    if (wires.some(wire => wire.peerPieces?.get(piece))) availableMissingPieces++;
  }
  return {
    scope: 'connected_peers', selectedPieces, checkedPieces,
    complete: checkedPieces === selectedPieces,
    known: wires.length > 0 && wires.every(wire => knownPeerAvailability.has(wire) || wire.isSeeder || wire.type === 'webSeed'),
    missingPieces, availableMissingPieces,
    swarmAvailability: null
  };
}

function restrictPrivateDiscovery(engine, record, torrent, runtime, sourceHints, attachDiscovery) {
  if (runtime.privateRestricted || torrent.destroyed) return;
  runtime.privateRestricted = true;
  runtime.lookupAbort?.();
  runtime.lookupAbort = null;
  runtime.lookupPending = false;
  runtime.lookupToken = null;
  runtime.needsDhtRetry = false;
  record.peerHints = [];

  const disablePublicWireDiscovery = wire => {
    // Existing wires negotiated PEX while the magnet's private bit was unknown.
    // Keep the data connection but remove both incoming PEX handlers and its timer.
    const pex = wire.ut_pex;
    if (pex) {
      pex.reset();
      pex.removeAllListeners('peer');
      pex.removeAllListeners('dropped');
      pex.onMessage = () => {};
      if (!wire.destroyed && wire.peerExtensions.extended) wire.extended(0, { m: { ut_pex: 0 } });
    }
    wire.removeAllListeners('port');
    wire.peerExtensions.dht = false;
  };
  torrent.wires.forEach(disablePublicWireDiscovery);
  torrent.on('wire', disablePublicWireDiscovery);

  const previous = torrent.discovery;
  previous?.removeAllListeners('peer');
  previous?.tracker?.removeAllListeners('update');
  previous?.destroy(() => {});

  // WebTorrent 3.0.21 has no public method for changing a live torrent's discovery
  // privacy. Its pinned _startDiscovery only changes discovery; it leaves the
  // file store, piece selections and connected transfer wires in place. Clear
  // its previous noPeers timer because restarting would otherwise orphan it.
  clearInterval(torrent._noPeersIntervalId);
  torrent._noPeersIntervalId = null;
  torrent.discovery = null;
  torrent.announce = chooseTrackers({ private: true, announce: sourceHints.announce || [] }, { enabled: engine.clientOptions.tracker !== false });
  torrent.peerAddresses = [];
  torrent.urlList = [];
  // Pending pre-metadata connections cannot be attributed to an individual
  // tracker. Drop them and let the original tracker refill the queue. The
  // pinned version exposes pending peers only through _peers.
  for (const peer of [...torrent._peers.values()]) {
    if (peer.type === 'webSeed' || !peer.connected) torrent.removePeer(peer.id);
  }
  torrent.torrentFile = toTorrentFile(torrent);
  torrent.metadata = torrent.torrentFile;
  torrent.magnetURI = toMagnetURI({ infoHash: torrent.infoHash, name: torrent.name, announce: torrent.announce });
  record.metadata = Buffer.from(torrent.torrentFile).toString('base64');
  runtime.trackers = new Map(torrent.announce.map(url => [url, { url, status: 'waiting' }]));
  runtime.discoveryAttached = false;
  // _startDiscovery constructs LSD synchronously and does not gate it on the
  // private bit. Suppress that one construction, restoring the shared setting
  // in the same call stack before any other torrent or I/O callback can run.
  const previousLsd = engine.client.lsd;
  engine.client.lsd = false;
  try { torrent._startDiscovery(); } finally { engine.client.lsd = previousLsd; }
  attachDiscovery();
}

export class DownloadEngine extends EventEmitter {
  constructor({ stateDir, downloadDir, clientOptions = {}, resolveBootstrap = resolveDhtBootstrap }) {
    super();
    this.stateDir = stateDir;
    this.stateFile = path.join(stateDir, 'session.json');
    this.settings = { downloadDir, downloadLimit: 0, uploadLimit: 1024, playerPath: '', extraTrackers: [], usePublicTrackers: true, maxConns: 160 };
    this.clientOptions = clientOptions;
    this.resolveBootstrap = resolveBootstrap;
    this.bootstrapResolved = 0;
    this.lastBootstrapAttempt = 0;
    this.bootstrapPending = false;
    this.autoBootstrap = clientOptions.dht !== false && !(clientOptions.dht && Object.hasOwn(clientOptions.dht, 'bootstrap'));
    this.metadataCache = new MetadataCache(stateDir);
    this.runtime = new Map();
    this.prefetch = new Map();
    this.records = new Map();
    this.active = new Map();
    this.queue = Promise.resolve();
    this.writes = Promise.resolve();
    this.closing = false;
    this.client = null;
  }
  async init() {
    await fs.mkdir(this.stateDir, { recursive: true });
    try {
      const data = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.tasks)) throw new Error('不支持的会话格式');
      this.settings = { ...this.settings, ...data.settings };
      for (const record of data.tasks) {
        if (!/^[a-f0-9]{40}$/.test(record.id) || !path.isAbsolute(record.path)) continue;
        // Old sessions already represented confirmed downloads. Only the new
        // explicit flag opts a task into metadata-only startup.
        record.awaitingSelection = record.awaitingSelection === true;
        record.selectedFiles = record.awaitingSelection ? [] : record.selectedFiles ?? null;
        this.records.set(record.id, record);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Preserve an unreadable session instead of silently overwriting it.
        await fs.copyFile(this.stateFile, `${this.stateFile}.backup-${Date.now()}`).catch(() => {});
        this.emit('notice', '旧的任务记录读取失败，已保留备份。');
      }
    }
    const options = { maxConns: this.settings.maxConns, natUpnp: true, natPmp: true, lsd: false, utp: true, secure: 1, ...this.clientOptions };
    if (this.autoBootstrap) {
      this.lastBootstrapAttempt = Date.now();
      const nodes = await this.resolveBootstrap().catch(() => []);
      this.bootstrapResolved = nodes.length;
      // k-rpc-socket uses UDP4 but dns.lookup defaults to either address family.
      // Supply numeric IPv4 endpoints before any query, avoiding IPv6 EINVAL.
      options.dht = { ...(options.dht || {}), bootstrap: nodes.length ? nodes : false };
    }
    await installTrackerCompatibility();
    this.client = new WebTorrent(options);
    this.client.on('error', err => {
      this.fatal = `下载引擎异常：${err.message}，请重启应用。`;
      this.emit('notice', this.fatal);
    });
    this.applyLimits();
    this.client.maxConns = this.settings.maxConns;
    this.restoredDhtNodes = await loadDhtState(this.stateDir, this.client.dht).catch(() => 0);
    await this.metadataCache.prune().catch(() => {});
    for (const record of this.records.values()) {
      if (!record.paused && !record.error) {
        try { await this.start(record); } catch (err) { record.error = err.message; }
      }
    }
    this.timer = setInterval(() => { this.recoverReadyDht(); this.emit('update', this.snapshot()); }, 800);
    this.timer.unref();
    this.saveTimer = setInterval(() => this.persist().catch(err => this.emit('notice', err.message)), 10000);
    this.saveTimer.unref();
    this.recoveryTimer = setInterval(() => this.recoverStalled(), 10000);
    this.recoveryTimer.unref();
    return this;
  }
  serial(action) {
    const result = this.queue.then(() => {
      if (this.closing) throw new Error('应用正在关闭。');
      if (this.fatal) throw new Error(this.fatal);
      return action();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  add(input, fromFile = false) {
    return this.serial(async () => {
      if (!fromFile) input = validateMagnet(input);
      else if (!(input instanceof Uint8Array) || input.length > 16 * 1024 * 1024) throw new Error('种子文件无效或大于 16 MB。');
      let parsed;
      try { parsed = await parseTorrent(input); } catch { throw new Error('无法解析此磁力链接或种子文件。'); }
      if (!/^[a-f0-9]{40}$/.test(parsed.infoHash)) throw new Error('此版本支持 BitTorrent v1 和含 v1 的混合种子。');
      if (this.records.has(parsed.infoHash)) return { id: parsed.infoHash, duplicate: true };
      const destination = path.join(this.settings.downloadDir, parsed.infoHash);
      if (parsed.files) validateFiles(parsed.files, destination);
      const cached = !fromFile ? await this.metadataCache.get(parsed.infoHash) : null;
      const record = {
        id: parsed.infoHash, source: fromFile ? null : input,
        metadata: fromFile ? Buffer.from(input).toString('base64') : cached?.toString('base64') || null,
        metadataSource: fromFile ? 'torrent' : cached ? 'cache' : 'network',
        name: parsed.name || `磁力任务 ${parsed.infoHash.slice(0, 8)}`,
        path: destination, addedAt: Date.now(), paused: false, error: '',
        awaitingSelection: true, selectedFiles: [], files: [], downloaded: 0, length: 0, uploaded: 0
      };
      this.records.set(record.id, record);
      try { await this.start(record); } catch (err) { record.error = err.message; }
      await this.persist();
      this.emit('update', this.snapshot());
      return { id: record.id, duplicate: false };
    });
  }
  async start(record) {
    await fs.mkdir(record.path, { recursive: true });
    record.error = '';
    const input = record.metadata ? Buffer.from(record.metadata, 'base64') : record.source;
    const sourceHints = record.source ? await parseTorrent(record.source) : {};
    const metadata = record.metadata ? await parseTorrent(input) : null;
    if (metadata && metadata.infoHash !== record.id) throw new Error('已保存的种子信息与任务哈希不一致，请移除任务后重新添加磁力链接。');
    const trackerInput = metadata ? { ...metadata, announce: metadata.private ? metadata.announce : [...(metadata.announce || []), ...(sourceHints.announce || [])] } : sourceHints;
    const announce = chooseTrackers(trackerInput, { enabled: this.clientOptions.tracker !== false, useDefaults: this.settings.usePublicTrackers, extra: this.settings.extraTrackers });
    const runtime = { startedAt: Date.now(), lastProgressAt: Date.now(), lastDownloaded: 0, attempts: 0, lastAnnounce: 0, sources: {}, metadataSource: metadata ? (record.metadataSource === 'torrent' ? 'torrent' : 'cache') : 'network', trackers: new Map(announce.map(url => [url, { url, status: 'waiting' }])) };
    runtime.needsDhtRetry = Boolean(this.client.dht && !metadata?.private && !this.client.dht.nodes.count());
    runtime.lastDhtLookup = 0;
    runtime.dhtLookups = 0;
    this.runtime.set(record.id, runtime);
    const urlList = metadata?.private ? metadata.urlList || [] : [...new Set([...(metadata?.urlList || []), ...(sourceHints.urlList || [])])];
    const torrentInput = { ...(metadata || sourceHints), announce, urlList, peerAddresses: metadata?.private ? [] : sourceHints.peerAddresses || [] };
    // WebTorrent selects pieces before it emits metadata, including BEP 53
    // selections embedded in magnets. Disable that initial selection in the
    // constructor; clearing it in a later event would permit content requests.
    const torrent = this.client.add(torrentInput, { path: record.path, strategy: 'rarest', deselect: record.awaitingSelection === true || Array.isArray(record.selectedFiles), destroyStoreOnDestroy: false, announce, urlList, noPeersIntervalTime: 20 });
    this.active.set(record.id, torrent);
    torrent.once('infoHash', () => {
      if (metadata?.private) return;
      const cachedPeers = (record.peerHints || []).filter(peer => Date.now() - peer.seen < 24 * 60 * 60 * 1000).map(peer => peer.address).slice(0, 32);
      const peers = [...new Set([...(sourceHints.peerAddresses || []), ...cachedPeers])];
      for (const peer of peers) { try { torrent.addPeer(peer); } catch {} }
      runtime.sources.cache = cachedPeers.length;
    });
    const attachDiscovery = () => {
      const discovery = torrent.discovery;
      if (!discovery || runtime.discoveryAttached) return;
      runtime.discoveryAttached = true;
      discovery.on('peer', (_peer, source) => { runtime.sources[source || 'other'] = (runtime.sources[source || 'other'] || 0) + 1; });
      discovery.tracker?.on('update', update => {
        if (update.announce) runtime.trackers.set(update.announce, { url: update.announce, status: 'ok', seeds: update.complete, peers: update.incomplete, updatedAt: Date.now() });
      });
      discovery.tracker?.on('warning', error => {
        for (const [url, entry] of runtime.trackers) if (error.message.includes(new URL(url).hostname)) runtime.trackers.set(url, { ...entry, status: 'error' });
      });
    };
    torrent.on('wire', wire => {
      // A connected wire alone does not tell us its available content.
      const markAvailability = () => knownPeerAvailability.add(wire);
      wire.on('bitfield', markAvailability);
      wire.on('have-all', markAvailability);
      wire.on('have-none', markAvailability);
      attachDiscovery();
      if (!torrent.private && wire.remoteAddress && wire.remotePort && ['tcpOutgoing', 'utpOutgoing'].includes(wire.type)) {
        const address = wire.remoteAddress.includes(':') ? `[${wire.remoteAddress}]:${wire.remotePort}` : `${wire.remoteAddress}:${wire.remotePort}`;
        record.peerHints = [{ address, seen: Date.now() }, ...(record.peerHints || []).filter(peer => peer.address !== address)].slice(0, 32);
      }
    });
    torrent.once('infoHash', () => { queueMicrotask(attachDiscovery); setTimeout(attachDiscovery, 100).unref(); });
    torrent.on('error', err => {
      if (this.active.get(record.id) !== torrent) return;
      runtime.lookupAbort?.();
      this.active.delete(record.id);
      record.error = err.message;
      this.emit('invalidate', record.id);
      this.emit('update', this.snapshot());
      this.persist().catch(err => this.emit('notice', err.message));
    });
    torrent.on('warning', err => {
      record.warning = String(err.message).slice(0, 300);
      if (record.warning === 'No nodes to query' && !torrent.private && this.client.dht) runtime.needsDhtRetry = true;
    });
    torrent.on('noPeers', () => { record.warning = '暂未发现可用节点。正在通过 DHT 和 Tracker 继续寻找。'; });
    torrent.on('metadata', () => {
      try { validateFiles(torrent.files, record.path); } catch (err) { torrent.destroy(err); }
      if (!torrent.destroyed && !metadata && torrent.private) {
        try { restrictPrivateDiscovery(this, record, torrent, runtime, sourceHints, attachDiscovery); }
        catch (err) { torrent.destroy(err); }
      }
      runtime.metadataMs = Date.now() - runtime.startedAt;
      record.metadataMs = runtime.metadataMs;
      record.metadataSource ||= record.metadata ? 'cache' : 'network';
      if (!torrent.destroyed) this.metadataCache.put(record.id, torrent.torrentFile).catch(() => {});
    });
    torrent.on('ready', () => {
      record.metadata = Buffer.from(torrent.torrentFile).toString('base64');
      record.name = torrent.name;
      record.warning = '';
      attachDiscovery();
      this.applySelection(record, torrent);
      this.capture(record, torrent);
      this.persist().catch(err => this.emit('notice', err.message));
      this.emit('update', this.snapshot());
    });
    torrent.on('done', () => { this.capture(record, torrent); this.emit('update', this.snapshot()); });
    return torrent;
  }
  applySelection(record, torrent) {
    if (!record.awaitingSelection && record.selectedFiles === null) return;
    torrent.deselect(0, torrent.pieces.length - 1, 0);
    if (!record.awaitingSelection) torrent.files.forEach((file, index) => { if (record.selectedFiles.includes(index)) file.select(); });
  }
  capture(record, torrent) {
    if (!torrent?.ready) return;
    record.name = torrent.name;
    record.length = torrent.length;
    record.downloaded = torrent.downloaded;
    record.uploaded = torrent.uploaded;
    record.files = torrent.files.map((file, index) => ({ index, name: file.name, path: file.path, length: file.length, downloaded: file.done ? file.length : file.downloaded, progress: file.done ? 1 : file.progress, media: MEDIA.test(file.name) }));
  }
  get(id) {
    const record = this.records.get(id);
    if (!record) throw new Error('任务不存在。');
    return record;
  }
  pause(id) {
    return this.serial(async () => {
      const record = this.get(id);
      this.capture(record, this.active.get(id));
      record.paused = true;
      this.emit('invalidate', id);
      await this.stop(id);
      await this.persist();
      this.emit('update', this.snapshot());
    });
  }
  resume(id) {
    return this.serial(async () => {
      const record = this.get(id);
      if (!this.active.has(id)) {
        record.paused = false;
        try { await this.start(record); } catch (err) { record.error = err.message; }
        await this.persist();
      }
      this.emit('update', this.snapshot());
    });
  }
  async stop(id) {
    this.cancelPrefetch(id);
    this.runtime.get(id)?.lookupAbort?.();
    if (this.runtime.has(id)) {
      this.runtime.get(id).lookupPending = false;
      this.runtime.get(id).lookupToken = null;
      this.runtime.get(id).needsDhtRetry = false;
    }
    const torrent = this.active.get(id);
    if (!torrent) return;
    this.active.delete(id);
    if (!torrent.destroyed) await new Promise((resolve, reject) => torrent.destroy({ destroyStore: false }, err => err ? reject(err) : resolve()));
  }
  remove(id) {
    return this.serial(async () => {
      this.get(id);
      this.emit('invalidate', id);
      await this.stop(id);
      this.records.delete(id);
      this.runtime.delete(id);
      await this.persist();
      this.emit('update', this.snapshot());
    });
  }
  selectFiles(id, indexes) {
    return this.serial(async () => {
      const record = this.get(id);
      if (!record.files.length || !Array.isArray(indexes) || !indexes.length || indexes.some(i => !Number.isInteger(i) || i < 0 || i >= record.files.length)) throw new Error('请至少选择一个有效文件。');
      const firstConfirmation = record.awaitingSelection === true;
      record.selectedFiles = [...new Set(indexes)];
      record.awaitingSelection = false;
      // First confirmation is the explicit "download selected files" action,
      // including a task paused while its metadata was being inspected.
      if (firstConfirmation) record.paused = false;
      this.emit('invalidate', id);
      const torrent = this.active.get(id);
      if (firstConfirmation && !record.paused && torrent?.ready && !torrent.destroyed) {
        // Metadata-only tasks have no content/stream selections to discard.
        // Preserve their established peers when the user confirms the files.
        this.applySelection(record, torrent);
      } else {
        // Later changes recreate selections, including streaming priorities.
        await this.stop(id);
        if (!record.paused) await this.start(record);
      }
      await this.persist();
      this.emit('update', this.snapshot());
    });
  }
  async mediaFile(id, index) {
    const record = this.get(id);
    if (record.awaitingSelection) throw new Error('请先选择文件并确认下载，再播放视频。');
    if (record.paused) throw new Error('请先继续下载，再播放视频。');
    const torrent = this.active.get(id);
    if (!torrent?.ready) throw new Error('正在获取种子信息或校验文件，请稍候。');
    const file = torrent.files[index];
    if (!Number.isInteger(index) || !file || !MEDIA.test(file.name)) throw new Error('该文件不支持作为媒体流打开。');
    if (record.selectedFiles && !record.selectedFiles.includes(index)) throw new Error('请先在文件列表中勾选这个文件。');
    // This also validates HEAD requests; validation must not change scheduling.
    // Playback scheduling starts only in preparePlayback, after an actual GET
    // or explicit play action. Ordinary downloads keep rarest-first scheduling.
    return file;
  }
  cancelPrefetch(id, resetStrategy = true) {
    if (resetStrategy && this.active.get(id)?.ready) this.active.get(id).strategy = 'rarest';
    const work = this.prefetch.get(id);
    if (!work) return;
    work.cancelled = true;
    for (const stream of work.streams) stream.destroy();
    clearTimeout(work.timer);
    this.prefetch.delete(id);
  }
  async preparePlayback(id, index, offset = 0) {
    const file = await this.mediaFile(id, index);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= file.length) return;
    const torrent = this.active.get(id);
    // An HTTP video reader can select the whole remaining file at priority 1.
    // With rarest-first that competes with its own current read cursor; critical
    // only enables request hotswapping in WebTorrent, it does not order pieces.
    // Keep this playing task sequential until playback is explicitly cancelled.
    torrent.strategy = 'sequential';
    const existing = this.prefetch.get(id);
    // Keep a bounded forward buffer instead of restarting it for each chunk.
    // Reuse most of the 8 MiB window. Rebuilding it every 2 MiB repeatedly read
    // the same 6 MiB from disk and churned overlapping stream selections.
    if (existing?.index === index && offset >= existing.offset && offset < existing.offset + Math.max(2 * 1024 * 1024, existing.target - 2 * 1024 * 1024)) return;
    this.cancelPrefetch(id, false);
    const work = { index, offset, streams: new Set(), bytes: 0, target: Math.min(file.length - offset, 8 * 1024 * 1024) };
    this.prefetch.set(id, work);
    const forwardEnd = Math.min(file.length - 1, offset + work.target - 1);
    // Read container headers and the tail/index concurrently, including files
    // smaller than the forward window. Split overlapping ranges so a small
    // video is never read twice in full just to prioritize its tail.
    const tailStart = offset === 0 ? Math.max(Math.min(file.length, 64 * 1024), file.length - 256 * 1024) : file.length;
    const ranges = [[offset, Math.min(forwardEnd, tailStart - 1)]];
    if (offset === 0 && tailStart < file.length) ranges.push([tailStart, file.length - 1]);
    if (offset === 0) {
      const critical = (start, end) => torrent.critical(Math.floor((file.offset + start) / torrent.pieceLength), Math.floor((file.offset + end) / torrent.pieceLength));
      critical(0, Math.min(file.length - 1, 64 * 1024 - 1));
      if (tailStart < file.length) critical(tailStart, file.length - 1);
    }
    work.totalTarget = ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0);
    // Keep playback priority close to the read cursor. Selecting an entire
    // 8 MiB window at once churns overlapping selections and disk readers.
    const readRange = async (start, end) => {
      let cursor = start;
      while (!work.cancelled && cursor <= end) {
        const chunkLength = Math.max(this.active.get(id)?.pieceLength || 0, cursor === start ? 64 * 1024 : 256 * 1024);
        const chunkEnd = Math.min(end, cursor + chunkLength - 1);
        const finished = await new Promise(resolve => {
          if (work.cancelled) return resolve(false);
          const stream = file.createReadStream({ start: cursor, end: Math.max(chunkEnd, 1) });
          work.streams.add(stream);
          let settled = false;
          const finish = complete => { if (settled) return; settled = true; work.streams.delete(stream); resolve(complete); };
          stream.on('data', chunk => { work.bytes += chunk.length; });
          stream.once('end', () => finish(true));
          stream.once('error', () => finish(false));
          stream.once('close', () => finish(false));
          stream.resume();
        });
        if (!finished) break;
        cursor = chunkEnd + 1;
      }
    };
    for (const [start, end] of ranges) readRange(start, end).catch(() => {});
    work.timer = setTimeout(() => { if (this.prefetch.get(id) === work) this.cancelPrefetch(id, false); }, 60000);
    work.timer.unref();
  }
  lookupDht(id) {
    const record = this.records.get(id), torrent = this.active.get(id), runtime = this.runtime.get(id);
    const dht = this.client?.dht;
    if (this.closing || !dht || dht.destroyed || !record || record.paused || !torrent || torrent.destroyed || torrent.private || torrent.discovery?.dht !== dht || !runtime || runtime.lookupPending) return false;
    if (Date.now() - runtime.lastDhtLookup < 10000) return false;
    if (!dht.nodes.count()) { runtime.needsDhtRetry = true; return false; }
    if ([...this.runtime.values()].filter(item => item.lookupPending).length >= 4) return false;
    const token = Symbol('dht-lookup');
    runtime.lookupToken = token;
    runtime.lookupPending = true;
    runtime.needsDhtRetry = false;
    runtime.lastDhtLookup = Date.now();
    runtime.dhtLookups++;
    let abort, timer;
    const finish = (error, respondingNodes = 0) => {
      if (runtime.lookupToken !== token) return;
      clearTimeout(timer);
      runtime.lookupToken = null;
      runtime.lookupPending = false;
      runtime.lookupAbort = null;
      if (this.runtime.get(id) !== runtime || this.active.get(id) !== torrent || this.closing || record.paused || torrent.private) return;
      if (error || !respondingNodes) runtime.needsDhtRetry = true;
      else if (record.warning === 'No nodes to query') record.warning = '';
    };
    runtime.lookupAbort = () => {
      abort?.();
      if (runtime.lookupToken !== token) return;
      clearTimeout(timer);
      runtime.lookupToken = null;
      runtime.lookupPending = false;
      runtime.lookupAbort = null;
    };
    timer = setTimeout(() => { abort?.(); finish(new Error('DHT lookup deadline')); }, 30000);
    timer.unref();
    try {
      abort = dht.lookup(id, finish);
    } catch (error) { finish(error); }
    return true;
  }
  recoverReadyDht() {
    if (this.closing || !this.client?.dht || this.client.destroyed || !this.client.dht.nodes.count()) return;
    // DHT.ready only means the first bootstrap attempt ended, even with zero
    // routes. Check verified routes on the existing heartbeat instead. This
    // also handles asynchronous addNode pings from the persisted route cache.
    for (const [id, torrent] of this.active) {
      if (this.records.get(id)?.awaitingSelection && torrent.ready) continue;
      if (this.runtime.get(id)?.needsDhtRetry && !torrent.done && (!torrent.ready || !torrent.numPeers)) this.lookupDht(id);
    }
  }
  reannounce(id, automatic = false) {
    const record = this.get(id), torrent = this.active.get(id), runtime = this.runtime.get(id);
    if (!torrent || torrent.destroyed || record.paused) return { requested: false, message: '请先继续任务。' };
    const interval = automatic ? Math.min(5 * 60000, 30000 * 2 ** Math.min(runtime.attempts, 4)) : 30000;
    if (Date.now() - runtime.lastAnnounce < interval) return { requested: false, message: '正在寻找节点，请稍候。' };
    runtime.lastAnnounce = Date.now(); runtime.attempts++;
    if (torrent.discovery?.tracker) torrent.discovery.tracker.update({ numwant: 80 });
    this.lookupDht(id);
    for (const hint of torrent.private ? [] : record.peerHints || []) {
      if (Date.now() - hint.seen < 24 * 3600000) { try { torrent.addPeer(hint.address); } catch {} }
    }
    record.warning = '已重新查询可用节点，正在等待响应。';
    return { requested: true, message: '已重新查询 Tracker 和可用节点。' };
  }
  recoverStalled() {
    if (this.closing || this.client.destroyed) return;
    // Retry DNS after a transient offline launch. Numeric addNode uses public
    // DHT APIs, pings before accepting nodes, and keeps existing tasks intact.
    if (this.autoBootstrap && this.client.dht && !this.client.dht.nodes.count() && !this.bootstrapPending && Date.now() - this.lastBootstrapAttempt >= 60000) {
      this.bootstrapPending = true;
      this.lastBootstrapAttempt = Date.now();
      this.resolveBootstrap().then(nodes => {
        if (this.closing || this.client.destroyed) return;
        this.bootstrapResolved = nodes.length;
        for (const node of nodes) this.client.dht.addNode(node);
      }).catch(() => {}).finally(() => { this.bootstrapPending = false; });
    }
    for (const [id, torrent] of this.active) {
      const runtime = this.runtime.get(id);
      if (!runtime || torrent.destroyed || torrent.done) continue;
      if (this.records.get(id)?.awaitingSelection && torrent.ready) continue;
      if (torrent.downloaded > runtime.lastDownloaded) {
        runtime.lastProgressAt = Date.now(); runtime.lastDownloaded = torrent.downloaded; runtime.attempts = 0;
      }
      if (Date.now() - runtime.lastProgressAt > 30000) this.reannounce(id, true);
    }
  }
  updateSettings(updates) {
    return this.serial(async () => {
      if ('downloadLimit' in updates) updates.downloadLimit = safeRate(updates.downloadLimit);
      if ('uploadLimit' in updates) updates.uploadLimit = safeRate(updates.uploadLimit);
      if ('maxConns' in updates && (!Number.isInteger(updates.maxConns) || updates.maxConns < 20 || updates.maxConns > 300)) throw new Error('每个任务连接数应为 20～300。');
      if ('extraTrackers' in updates) {
        if (!Array.isArray(updates.extraTrackers) || updates.extraTrackers.length > 40) throw new Error('最多添加 40 个 Tracker。');
        const valid = chooseTrackers({ announce: updates.extraTrackers, private: true });
        if (valid.length !== new Set(updates.extraTrackers.filter(Boolean)).size) throw new Error('Tracker 地址无效，请使用 udp/http/https 地址，每行一条。');
        updates.extraTrackers = valid;
      }
      if ('usePublicTrackers' in updates && typeof updates.usePublicTrackers !== 'boolean') throw new Error('公共 Tracker 设置无效。');
      this.settings = { ...this.settings, ...updates };
      this.applyLimits();
      this.client.maxConns = this.settings.maxConns;
      await this.persist();
      this.emit('update', this.snapshot());
      return this.settings;
    });
  }
  applyLimits() {
    this.client.throttleDownload(this.settings.downloadLimit ? this.settings.downloadLimit * 1024 : -1);
    this.client.throttleUpload(this.settings.uploadLimit ? this.settings.uploadLimit * 1024 : -1);
  }
  speedDiagnosis(record, torrent, status) {
    const wires = (torrent?.wires || []).filter(wire => !wire.destroyed);
    const rates = wires.map(wire => positiveRate(typeof wire.downloadSpeed === 'function' ? wire.downloadSpeed() : 0));
    const metrics = {
      downloadLimitBps: this.settings.downloadLimit * 1024,
      totalDownloadSpeedBps: positiveRate(this.client?.downloadSpeed),
      payloadSpeedBps: rates.reduce((sum, rate) => sum + rate, 0),
      connectedPeers: wires.length,
      activeDataPeers: rates.filter(rate => rate > 0).length,
      unchokedPeers: wires.filter(wire => wire.peerChoking === false).length,
      chokedPeers: wires.filter(wire => wire.peerChoking === true).length,
      pendingRequests: wires.reduce((sum, wire) => sum + (wire.requests?.length || 0), 0),
      selectedAvailability: selectedAvailability(record, torrent, wires),
      playbackPrioritized: torrent?.strategy === 'sequential' || Boolean(this.prefetch.get(record.id)?.streams.size)
    };
    const result = (code, title, message) => ({ code, title, message, metrics });
    if (status === 'paused') return result('paused', '任务已暂停', '继续任务后才会接收文件数据。');
    if (status === 'error') return result('error', '任务发生错误', record.error);
    if (status === 'complete') return result('complete', '所选文件已完成', '当前无需继续下载所选文件。');
    if (record.awaitingSelection && torrent?.ready) return result('awaiting_selection', '等待选择文件', '已获取文件列表；确认所选文件前不会请求文件内容。');
    if (!torrent?.ready) return result('metadata', status === 'checking' ? '正在校验本地文件' : '正在解析文件列表', '文件内容下载尚未开始，此阶段不能据传输速度判断文件下载能力。');
    if (metrics.downloadLimitBps > 0 && metrics.payloadSpeedBps > 0 && metrics.totalDownloadSpeedBps >= metrics.downloadLimitBps * 0.9) {
      return result('download_limit', '接近设置的下载限速', `全部任务共享 ${this.settings.downloadLimit} KB/s 下载上限；当前总速度已接近该设置。`);
    }
    if (!wires.length) return result('no_peers', '尚无可用连接', '正在寻找并连接提供内容的节点；这不代表资源一定失效。');
    if (metrics.activeDataPeers > 0) return result('receiving', '正在接收文件数据', `${metrics.activeDataPeers} 个节点最近发送了文件数据；对端限速、网络和磁盘是否限制速度尚无法确定。`);
    if (metrics.pendingRequests > 0) return result('waiting_data', '已请求片段，等待响应', `已有 ${metrics.pendingRequests} 个片段请求尚未收到响应；响应延迟的具体原因未知。`);
    if (!metrics.unchokedPeers && metrics.chokedPeers > 0) return result('peer_choked', '节点暂未开放传输', '已连接节点暂未允许常规数据请求；引擎会继续等待可用传输机会。');
    const availability = metrics.selectedAvailability;
    if (availability?.known && availability.complete && availability.missingPieces > 0 && !availability.availableMissingPieces) {
      return result('missing_pieces', '当前节点未提供所需片段', '已连接节点声明的内容中未发现所选文件的缺失片段；其他节点是否持有这些片段未知。');
    }
    return result('unknown', '等待可下载的数据', '当前信息不足以确定慢速原因；节点连接数不等于实际提供数据的节点数。');
  }
  snapshot() {
    const dhtNodes = this.client.dht?.nodes?.count?.() || 0;
    const tasks = [...this.records.values()].map(record => {
      const torrent = this.active.get(record.id);
      const runtime = this.runtime.get(record.id);
      this.capture(record, torrent);
      const awaitingSelection = record.awaitingSelection === true;
      const files = record.files.map(file => ({ ...file, selected: !awaitingSelection && (record.selectedFiles === null || record.selectedFiles.includes(file.index)) }));
      const selected = files.filter(file => file.selected);
      const length = (awaitingSelection ? files : selected).reduce((sum, file) => sum + file.length, 0);
      const downloaded = selected.reduce((sum, file) => sum + file.downloaded, 0);
      const progress = length ? Math.min(downloaded / length, 1) : 0;
      const speed = awaitingSelection ? 0 : torrent?.downloadSpeed || 0;
      let status = record.paused ? 'paused' : record.error ? 'error' : !torrent?.ready ? (record.metadata ? 'checking' : 'metadata') : awaitingSelection ? 'selecting' : progress >= 1 ? 'complete' : 'downloading';
      const elapsedSeconds = Math.floor((Date.now() - (runtime?.startedAt || record.addedAt)) / 1000);
      const peers = torrent?.numPeers || 0;
      const discoveredPeers = runtime ? Object.values(runtime.sources).reduce((sum, count) => sum + count, 0) : 0;
      let connection;
      if (record.paused) connection = { stage: 'paused', message: '任务已暂停，继续后重新连接节点。', retryable: false };
      else if (record.error) connection = { stage: 'error', message: record.error, retryable: false };
      else if (status === 'selecting') connection = { stage: 'awaiting_selection', message: '文件列表已解析，请选择要下载的文件并确认开始。', retryable: false };
      else if (status === 'complete') connection = { stage: 'complete', message: '所选文件已下载完成。', retryable: false };
      else if (status === 'checking') connection = { stage: 'fetching_metadata', message: '已有文件列表，正在校验本地片段。', retryable: false };
      else if (speed > 0 && torrent?.ready) connection = { stage: 'downloading', message: '正在接收并校验文件片段。', retryable: true };
      else if (!torrent?.ready && peers) connection = { stage: 'fetching_metadata', message: `已连接 ${peers} 个节点，等待其中可提供文件列表的节点。`, retryable: true };
      else if (torrent?.ready && peers) connection = { stage: 'fetching_pieces', message: '已有文件列表，等待节点提供所需片段。', retryable: true };
      else if (discoveredPeers) connection = { stage: 'connecting_peers', message: elapsedSeconds >= 20 ? '已发现节点线索，但尚未建立可用连接；正在重试，暂不能确定资源是否有效。' : '已发现节点线索，正在尝试连接。', retryable: true };
      else if (this.client.dht && !torrent?.private && !dhtNodes) connection = { stage: 'preparing_network', message: elapsedSeconds >= 15 ? 'DHT 尚无可用路由节点；Tracker 查询仍在继续，请检查网络或稍后重试。' : '正在建立 DHT 路由并查询 Tracker。', retryable: true };
      else connection = { stage: 'finding_peers', message: torrent?.ready ? '文件列表已获取，正在寻找可提供内容的节点。' : '节点发现网络可用，正在寻找此资源的节点和文件列表。', retryable: true };
      return { id: record.id, name: record.name, path: record.path, addedAt: record.addedAt, files, length, downloaded, progress, status, awaitingSelection,
        downloadSpeed: speed, uploadSpeed: torrent?.uploadSpeed || 0, peers: torrent?.numPeers || 0,
        eta: speed > 0 ? Math.max(0, (length - downloaded) / speed) : null,
        warning: record.error || ((!torrent?.numPeers && !speed) ? record.warning === 'No nodes to query' ? '最近一次 DHT 查询未获得可用路由，正在自动恢复。' : record.warning || '' : ''), ready: Boolean(torrent?.ready),
        metadataMs: runtime?.metadataMs ?? record.metadataMs ?? null, metadataSource: runtime?.metadataSource || record.metadataSource || (record.metadata ? 'cache' : 'network'),
        elapsedSeconds, connection, speedDiagnosis: this.speedDiagnosis(record, torrent, status),
        sources: runtime?.sources || {}, discoveryAttempts: runtime?.attempts || 0, dhtLookups: runtime?.dhtLookups || 0,
        trackers: [...(runtime?.trackers.values() || [])], private: Boolean(torrent?.private),
        prebuffer: this.prefetch.has(record.id) ? { bytes: this.prefetch.get(record.id).bytes, target: this.prefetch.get(record.id).totalTarget } : null };
    }).sort((a, b) => b.addedAt - a.addedAt);
    return { tasks, settings: { ...this.settings }, downloadSpeed: this.client.downloadSpeed || 0, uploadSpeed: this.client.uploadSpeed || 0, fatal: this.fatal || '',
      network: { dhtNodes, restoredDhtNodes: this.restoredDhtNodes || 0, dhtEnabled: Boolean(this.client.dht), bootstrapResolved: this.bootstrapResolved, bootstrapPending: this.bootstrapPending,
        peers: tasks.reduce((sum, task) => sum + task.peers, 0), utp: Boolean(this.client.utp), nat: Boolean(this.client.natTraversal),
        lsd: this.client.lsd, port: this.client.torrentPort, maxConns: this.client.maxConns } };
  }
  persist() {
    for (const record of this.records.values()) this.capture(record, this.active.get(record.id));
    const json = JSON.stringify({ version: 1, settings: this.settings, tasks: [...this.records.values()] }, null, 2);
    const result = this.writes.then(async () => {
      const temp = this.stateFile + '.tmp';
      await fs.writeFile(temp, json);
      await fs.rename(temp, this.stateFile);
      await saveDhtState(this.stateDir, this.client.dht).catch(() => {});
    });
    this.writes = result.catch(() => {});
    return result;
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.timer);
    clearInterval(this.saveTimer);
    clearInterval(this.recoveryTimer);
    await this.queue;
    try { await this.persist(); }
    finally {
      for (const id of this.records.keys()) this.emit('invalidate', id);
      for (const id of this.prefetch.keys()) this.cancelPrefetch(id);
      for (const runtime of this.runtime.values()) runtime.lookupAbort?.();
      if (this.client && !this.client.destroyed) await new Promise(resolve => this.client.destroy(resolve));
    }
  }
}
