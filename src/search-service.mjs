import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import parseTorrent from 'parse-torrent';
import { normalizeMagnet } from './discovery.mjs';
import { BUILTINS, PAGE_SIZE, endpointURL, trustedURL, fetchBytes, parseFeed, feedItems, textValue, numberValue, validHash } from './search-providers.mjs';

const DAY = 86400000;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const keyOf = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const resolutionRank = entry => {
  if (entry.torrentUrl) return 4;
  if (entry.archiveId) return 3;
  if (!entry.magnet) return 0;
  const params = new URL(entry.magnet).searchParams;
  return params.has('tr') ? 2 : params.has('xs') || params.has('ws') || params.has('x.pe') ? 1.5 : 1;
};

export class SearchService extends EventEmitter {
  constructor({ stateDir, fetchImpl = fetch, encrypt, decrypt, now = Date.now, timeoutMs = 18000, catalog = null } = {}) {
    super();
    this.stateDir = stateDir; this.fetchImpl = fetchImpl; this.encrypt = encrypt; this.decrypt = decrypt;
    this.now = now; this.timeoutMs = timeoutMs; this.catalog = catalog;
    this.sources = BUILTINS.map(source => ({ ...source, enabled: true }));
    this.results = new Map(); this.active = null; this.searchContext = null; this.resolving = new Set(); this.academic = null; this.queue = Promise.resolve();
  }
  async init() {
    await fs.mkdir(this.stateDir, { recursive: true });
    try {
      const file = path.join(this.stateDir, 'search-settings.json');
      if ((await fs.stat(file)).size > 128 * 1024) throw new Error('size');
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Array.isArray(saved.sources)) throw new Error('shape');
      for (const source of saved.sources.slice(0, 11)) {
        const builtin = this.sources.find(item => item.id === source.id);
        if (builtin) { builtin.enabled = source.enabled !== false; continue; }
        if (source.type !== 'torznab' || !/^[a-f\d-]{36}$/i.test(source.id) || typeof source.name !== 'string') continue;
        try { this.sources.push({ id: source.id, name: textValue(source.name, 60), type: 'torznab', enabled: source.enabled !== false, url: endpointURL(source.url), key: typeof source.key === 'string' && source.key.length < 16384 ? source.key : '' }); } catch {}
      }
    } catch { /* A corrupt search config does not affect downloads or sessions. */ }
    if (!this.catalog) this.catalog = JSON.parse(await fs.readFile(new URL('./search-catalog.json', import.meta.url), 'utf8'));
    return this;
  }
  settings() {
    return { sources: this.sources.map(({ key, ...source }) => ({ ...source, hasApiKey: Boolean(key) })) };
  }
  async persist() {
    const file = path.join(this.stateDir, 'search-settings.json'), temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ version: 1, sources: this.sources }), { mode: 0o600 });
    await fs.rename(temporary, file);
  }
  serial(fn) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  saveSource(input) {
    return this.serial(async () => {
      if (!input || typeof input !== 'object') throw new Error('搜索源参数无效。');
      let source = input.id && this.sources.find(item => item.id === input.id);
      if (input.id && !source) throw new Error('搜索源不存在。');
      const original = source;
      if (!source && this.sources.filter(item => item.type === 'torznab').length >= 8) throw new Error('最多添加 8 个自定义搜索源。');
      source = { ...(source || { id: randomUUID(), type: 'torznab', enabled: true, key: '' }) };
      if ('enabled' in input) { if (typeof input.enabled !== 'boolean') throw new Error('启用状态无效。'); source.enabled = input.enabled; }
      if (source.type === 'torznab') {
        if ('name' in input) source.name = textValue(input.name, 60);
        if ('url' in input) source.url = endpointURL(input.url);
        if (!source.name || !source.url) throw new Error('请填写搜索源名称和完整 API 地址。');
        if ('apiKey' in input) {
          if (typeof input.apiKey !== 'string' || input.apiKey.length > 2048 || /[\r\n]/.test(input.apiKey)) throw new Error('API Key 无效。');
          if (input.apiKey && !this.encrypt) throw new Error('当前系统无法安全保存 API Key。');
          source.key = input.apiKey ? await this.encrypt(input.apiKey) : '';
        }
      }
      const previous = this.sources;
      this.sources = original ? this.sources.map(item => item.id === source.id ? source : item) : [...this.sources, source];
      try { await this.persist(); } catch { this.sources = previous; throw new Error('搜索源保存失败，请检查配置目录。'); }
      this.cancel(); this.results.clear(); this.searchContext = null;
      return this.settings();
    });
  }
  removeSource(id) {
    return this.serial(async () => {
      if (!this.sources.some(item => item.id === id && item.type === 'torznab')) throw new Error('只能删除自定义搜索源。');
      const previous = this.sources; this.sources = this.sources.filter(item => item.id !== id);
      try { await this.persist(); } catch { this.sources = previous; throw new Error('搜索源保存失败。'); }
      this.cancel(); this.results.clear(); this.searchContext = null; return this.settings();
    });
  }
  cancel(requestId) { if (this.active && (!requestId || this.active.id === requestId)) this.active.controller.abort(); return true; }
  async bytes(url, source, signal, maxBytes, timeoutMs) {
    return fetchBytes(url, { source, signal, maxBytes, timeoutMs: timeoutMs || this.timeoutMs, fetchImpl: this.fetchImpl });
  }
  register(raw, source, currentResults = new Map()) {
    let magnet = null, hash = validHash(raw.infoHash) ? raw.infoHash.toLowerCase() : null;
    if (raw.magnet) {
      try {
        magnet = normalizeMagnet(raw.magnet);
        const magnetHash = new URL(magnet).searchParams.get('xt')?.match(/^urn:btih:([a-f\d]{40})$/i)?.[1]?.toLowerCase();
        if (hash && magnetHash && hash !== magnetHash) return null;
        hash = magnetHash || hash;
      } catch {}
    }
    const torrentUrl = trustedURL(raw.torrentUrl || '', source);
    if (!magnet && !torrentUrl && !raw.archiveId) return null;
    const id = keyOf(hash ? `hash:${hash}` : `${source.id}:${raw.archiveId || torrentUrl || magnet}`);
    const item = { id, title: textValue(raw.title) || '未命名资源', size: numberValue(raw.size), seeders: numberValue(raw.seeders),
      sources: [source.name], date: textValue(raw.date, 64) || null, kind: torrentUrl || raw.archiveId ? 'torrent' : 'magnet', description: textValue(raw.description, 400), license: textValue(raw.license, 160) || null };
    const entry = { ...raw, torrentUrl, magnet, infoHash: hash, sourceId: source.id, expires: this.now() + 45 * 60000 };
    // Merge only among sources participating in this request. A later search
    // restricted to another source must not resolve using an older provider.
    const candidate = currentResults.get(id);
    const previous = candidate?.expires > this.now() ? candidate : null;
    if (previous && previous.expires > this.now()) {
      item.sources = [...new Set([...previous.item.sources, source.name])];
      item.seeders = item.seeders === null ? previous.item.seeders : previous.item.seeders === null ? item.seeders : Math.max(item.seeders, previous.item.seeders);
      item.size ??= previous.item.size;
    }
    // Prefer metadata downloads over a hash-only magnet, preserving original
    // tracker membership and web seeds. Keep actual URLs in the main process.
    const resolved = previous && resolutionRank(previous) > resolutionRank(entry) ? { ...previous, expires: entry.expires } : entry;
    const registered = { ...resolved, item };
    currentResults.set(id, registered); this.results.set(id, registered);
    while (currentResults.size > 5000) currentResults.delete(currentResults.keys().next().value);
    while (this.results.size > 5000) this.results.delete(this.results.keys().next().value);
    return item;
  }
  async search({ query, sourceIds = [], page = 1, requestId } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 160) throw new Error('请输入 1～160 个字符的搜索关键词。');
    if (!Number.isInteger(page) || page < 1 || page > 100) throw new Error('搜索页码应为 1～100。');
    if (typeof requestId !== 'string' || !requestId || requestId.length > 100) throw new Error('搜索请求标识无效。');
    if (!Array.isArray(sourceIds) || sourceIds.length > 11 || sourceIds.some(id => typeof id !== 'string')) throw new Error('搜索源选择无效。');
    query = query.trim();
    const sources = this.sources.filter(source => source.enabled && (!sourceIds.length || sourceIds.includes(source.id)));
    if (!sources.length) throw new Error('请至少启用并选择一个搜索源。');
    this.cancel();
    const operation = { id: requestId, controller: new AbortController() }; this.active = operation;
    const { signal } = operation.controller;
    const contextKey = keyOf(JSON.stringify({ query, sources: sources.map(source => source.id).sort() }));
    if (page === 1 || this.searchContext?.key !== contextKey) this.searchContext = { key: contextKey, results: new Map() };
    // Keep rich discovery information when later pages repeat a previous hash,
    // while isolating a new keyword/source selection from old provider handles.
    const completed = [], currentResults = this.searchContext.results;
    const settled = await Promise.all(sources.map(async source => {
      let batch;
      try {
        const result = await this.searchSource(source, query, page, signal);
        if (signal.aborted) return { items: [], hasMore: false, source: { id: source.id, name: source.name, status: 'error', count: 0, message: '搜索已取消。' } };
        const items = result.items.map(item => this.register(item, source, currentResults)).filter(Boolean);
        batch = { items, hasMore: result.hasMore, source: { id: source.id, name: source.name, status: 'ok', count: items.length, message: result.message || '' } };
      } catch (error) {
        batch = { items: [], hasMore: false, source: { id: source.id, name: source.name, status: 'error', count: 0, message: /^(来源|搜索|当前系统)/.test(error.message) ? error.message : '来源暂时不可用，请稍后重试。' } };
      }
      completed.push(batch);
      if (!signal.aborted && this.active === operation) {
        const partial = new Map();
        for (const item of completed.flatMap(value => value.items)) partial.set(item.id, this.results.get(item.id)?.item || item);
        this.emit('progress', { requestId, query, page, items: [...partial.values()], sources: completed.map(value => value.source), pending: sources.length - completed.length });
      }
      return batch;
    }));
    if (this.active === operation) this.active = null;
    if (signal.aborted) return { query, page, items: [], hasMore: false, sources: [], cancelled: true };
    const merged = new Map();
    for (const item of settled.flatMap(result => result.items)) merged.set(item.id, this.results.get(item.id)?.item || item);
    return { query, page, items: [...merged.values()], hasMore: page < 100 && settled.some(result => result.hasMore), sources: settled.map(result => result.source) };
  }
  async searchSource(source, query, page, signal) {
    const offset = (page - 1) * PAGE_SIZE;
    if (source.id === 'openmedia') {
      const words = query.toLocaleLowerCase().split(/\s+/);
      const found = this.catalog.filter(item => words.every(word => `${item.title} ${item.aliases || ''} ${item.description || ''}`.toLocaleLowerCase().includes(word)));
      return { items: found.slice(offset, offset + PAGE_SIZE), hasMore: found.length > offset + PAGE_SIZE, message: '官方开放影片示例库，非全网索引。' };
    }
    if (source.id === 'academic') {
      const cache = await this.academicCatalog(source, signal);
      const words = query.toLocaleLowerCase().split(/\s+/);
      const found = cache.items.filter(item => words.every(word => `${item.title} ${item.description}`.toLocaleLowerCase().includes(word)));
      return { items: found.slice(offset, offset + PAGE_SIZE), hasMore: found.length > offset + PAGE_SIZE, message: `${cache.stale ? '来源暂不可用，使用已有索引。' : ''}已索引 ${cache.items.length} 条公开记录，更新时间 ${new Date(cache.updatedAt).toLocaleDateString('zh-CN')}。` };
    }
    if (source.id === 'archive') {
      const literal = query.split(/\s+/).map(word => `"${word.replace(/[\\"]/g, '\\$&')}"`).join(' AND ');
      const url = new URL('https://archive.org/advancedsearch.php');
      url.search = new URLSearchParams({ q: `(${literal}) AND format:"Archive BitTorrent" AND -mediatype:collection`, output: 'json', rows: String(PAGE_SIZE), page: String(page) });
      for (const field of ['identifier', 'title', 'description', 'item_size', 'date']) url.searchParams.append('fl[]', field);
      const data = JSON.parse((await this.bytes(url.href, source, signal)).toString('utf8'));
      if (!Array.isArray(data.response?.docs)) throw new Error('来源未返回有效搜索结果。');
      return { items: data.response.docs.slice(0, PAGE_SIZE).filter(item => /^[a-zA-Z\d_.-]{1,200}$/.test(item.identifier)).map(item => ({ title: item.title, archiveId: item.identifier, size: numberValue(item.item_size), description: item.description, date: item.date, seeders: null })), hasMore: numberValue(data.response.numFound) > offset + data.response.docs.length };
    }
    const url = new URL(source.url);
    url.searchParams.set('t', 'search'); url.searchParams.set('q', query); url.searchParams.set('offset', String(offset)); url.searchParams.set('limit', String(PAGE_SIZE)); url.searchParams.set('extended', '1');
    if (source.key) {
      try { url.searchParams.set('apikey', await this.decrypt(source.key)); } catch { throw new Error('当前系统无法解密此 API Key，请重新保存搜索源。'); }
    }
    const feed = parseFeed(await this.bytes(url.href, source, signal), { maxItems: 1000 });
    const actualOffset = feed.offset ?? offset;
    if (feed.offset !== null && actualOffset < offset) return { items: [], hasMore: false, message: '来源未按请求翻页，已停止重复获取。' };
    return { items: feedItems(feed, source).slice(0, PAGE_SIZE), hasMore: feed.total !== null ? feed.total > actualOffset + Math.min(feed.items.length, PAGE_SIZE) && feed.items.length > 0 : feed.items.length >= PAGE_SIZE };
  }
  async academicCatalog(source, signal) {
    const file = path.join(this.stateDir, 'academic-search-cache.json');
    if (!this.academic) {
      try {
        if ((await fs.stat(file)).size > MAX_CACHE_BYTES) throw new Error('size');
        const saved = JSON.parse(await fs.readFile(file, 'utf8'));
        if (saved.version === 1 && Number.isFinite(saved.updatedAt) && Array.isArray(saved.items) && saved.items.length <= 30000) this.academic = { updatedAt: saved.updatedAt, items: saved.items.filter(item => validHash(item.infoHash)).map(item => ({ title: textValue(item.title), description: textValue(item.description, 400), infoHash: item.infoHash, size: numberValue(item.size), date: textValue(item.date, 64) || null, magnet: `magnet:?xt=urn:btih:${item.infoHash}`, torrentUrl: `https://academictorrents.com/download/${item.infoHash}.torrent` })) };
      } catch {}
    }
    if (this.academic && this.now() - this.academic.updatedAt < DAY && this.now() >= this.academic.updatedAt) return this.academic;
    try {
      const feed = parseFeed(await this.bytes('https://academictorrents.com/database.xml', source, signal, MAX_CACHE_BYTES, Math.max(this.timeoutMs, 30000)));
      const items = feedItems(feed, source).filter(item => validHash(item.infoHash)).map(item => ({ ...item, torrentUrl: `https://academictorrents.com/download/${item.infoHash}.torrent` }));
      if (!items.length) throw new Error('来源的公开索引为空。');
      const fresh = { version: 1, updatedAt: this.now(), items };
      if (signal.aborted) throw new Error('搜索已取消。');
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify(fresh)); await fs.rename(temporary, file); } catch { await fs.rm(temporary, { force: true }).catch(() => {}); }
      this.academic = fresh; return fresh;
    } catch (error) {
      if (signal.aborted || !this.academic) throw error;
      return { ...this.academic, stale: true };
    }
  }
  async resolve(resultId) {
    const result = this.results.get(resultId), source = result && this.sources.find(item => item.id === result.sourceId && item.enabled);
    if (!result || !source || result.expires < this.now()) throw new Error('搜索结果已过期或来源已关闭，请重新搜索。');
    if (this.resolving.size >= 2) throw new Error('正在解析其他结果，请稍候。');
    const controller = new AbortController(); this.resolving.add(controller);
    try {
      let url = result.torrentUrl;
      if (result.archiveId) {
        const metadata = JSON.parse((await this.bytes(`https://archive.org/metadata/${encodeURIComponent(result.archiveId)}`, source, controller.signal, 8 * 1024 * 1024)).toString('utf8'));
        const torrent = metadata.files?.find(file => file.format === 'Archive BitTorrent' && typeof file.name === 'string' && file.name.endsWith('.torrent'));
        if (!torrent || torrent.private === 'true') throw new Error('来源当前没有可下载的种子文件。');
        url = `https://archive.org/download/${encodeURIComponent(result.archiveId)}/${encodeURIComponent(torrent.name)}`;
      }
      if (url) {
        const buffer = await this.bytes(url, source, controller.signal, 16 * 1024 * 1024);
        let parsed;
        try { parsed = await parseTorrent(buffer); } catch { throw new Error('来源返回的种子文件无效。'); }
        if (!validHash(parsed.infoHash)) throw new Error('此结果不是当前支持的 BitTorrent v1 或混合种子。');
        if (result.infoHash && parsed.infoHash.toLowerCase() !== result.infoHash.toLowerCase()) throw new Error('来源返回的种子与搜索结果哈希不一致。');
        return { input: buffer, fromFile: true };
      }
      return { input: normalizeMagnet(result.magnet), fromFile: false };
    } finally { this.resolving.delete(controller); }
  }
  close() { this.cancel(); for (const controller of this.resolving) controller.abort(); this.results.clear(); this.searchContext = null; return this.queue; }
}
