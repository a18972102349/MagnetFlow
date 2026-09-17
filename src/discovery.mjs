import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import parseTorrent from 'parse-torrent';

const HASH = /^[a-f0-9]{40}$/i;
const MAX_TORRENT_BYTES = 16 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

// Small, owner-documented bootstrap set; no remote tracker-list subscription.
// https://opentrackr.org/ ; https://www.torrent.eu.org/ ; https://tracker.zhuqiy.com/
export const PUBLIC_TRACKERS = Object.freeze([
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.torrent.eu.org:451',
  'https://tracker.zhuqiy.com/announce'
]);
// https://github.com/webtorrent/bittorrent-dht#dht--new-dhtopts
export const DHT_BOOTSTRAP = Object.freeze([
  'router.bittorrent.com:6881', 'router.utorrent.com:6881', 'dht.transmissionbt.com:6881'
]);

/** Resolve stock bootstrap names for the engine's IPv4 UDP socket before use. */
export async function resolveDhtBootstrap({ bootstrap = DHT_BOOTSTRAP, lookup = dnsLookup, timeoutMs = 2500 } = {}) {
  const entries = [], seen = new Set();
  for (const value of (Array.isArray(bootstrap) ? bootstrap : []).slice(0, 32)) {
    let host, port;
    if (typeof value === 'string') {
      const match = value.match(/^([^:\s]+):(\d{1,5})$/);
      if (!match) continue;
      host = match[1]; port = Number(match[2]);
    } else if (value && typeof value === 'object') {
      host = value.host; port = value.port;
    }
    if (typeof host !== 'string' || host.length > 253 || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    host = host.toLowerCase();
    if (isIP(host) === 6 || (!isIP(host) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host))) continue;
    const key = `${host}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ host, port });
    if (entries.length === 8) break;
  }
  const answers = entries.map(({ host, port }) => isIP(host) === 4 ? [{ host, port }] : []);
  let accepting = true;
  const pending = entries.map(async ({ host, port }, index) => {
    if (isIP(host) === 4) return;
    try {
      // k-rpc uses udp4; accepting an AAAA answer first makes its send fail.
      // Request every A answer so a dead address need not stall bootstrap.
      const addresses = await lookup(host, { family: 4, all: true });
      if (!accepting) return;
      answers[index] = (Array.isArray(addresses) ? addresses : [addresses])
        .slice(0, 16).filter(value => value && isIP(value.address) === 4)
        .slice(0, 8).map(value => ({ host: value.address, port }));
    } catch { /* Other bootstrap names and persisted nodes remain usable. */ }
  });
  const limit = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(2500, timeoutMs)) : 2500;
  let timer;
  try {
    await Promise.race([Promise.allSettled(pending), new Promise(resolve => { timer = setTimeout(resolve, limit); })]);
  } finally { accepting = false; clearTimeout(timer); }
  const result = new Map();
  for (const node of answers.flat()) {
    result.set(`${node.host}:${node.port}`, node);
    if (result.size === 32) break;
  }
  return [...result.values()];
}

function decodeEntities(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#0*38|#x0*26);/gi, entity => ({
    '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>'
  })[entity.toLowerCase()] || '&');
}

function hashToHex(hash) {
  if (HASH.test(hash)) return hash.toLowerCase();
  if (!/^[a-z2-7]{32}$/i.test(hash)) return null;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const bytes = [];
  for (const character of hash.toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  return Buffer.from(bytes).toString('hex');
}

export function normalizePeer(value) {
  if (typeof value !== 'string' || value.length > 300 || /[\s\x00-\x1f]/.test(value)) return null;
  const match = value.match(/^(\[[^\]]+\]|[^:]+):(\d{1,5})$/);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return null;
  let host = match[1].toLowerCase();
  if (host.startsWith('[')) {
    if (isIP(host.slice(1, -1)) !== 6) return null;
  } else if (!isIP(host) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) return null;
  return `${host}:${Number(match[2])}`;
}

export function normalizeTracker(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20]/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['udp:', 'http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) return null;
  if (url.protocol === 'udp:' && (!url.port || Number(url.port) < 1)) return null;
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) return null;
  // WHATWG treats udp as a non-special scheme, so normalize its host explicitly.
  url.hostname = url.hostname.toLowerCase();
  return url.href;
}

function distinctTrackers(values) {
  const result = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const tracker = normalizeTracker(value);
    if (tracker) result.add(tracker);
    if (result.size === 40) break;
  }
  return [...result];
}

function validSelection(value) {
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value)) return false;
  let count = 0;
  for (const range of value.split(',')) {
    const [start, end = start] = range.split('-').map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end > 1000000) return false;
    count += end - start + 1;
    if (count > 10000) return false;
  }
  return true;
}

/** Preserve original private tracker membership, including passkeys in URL paths. */
export function chooseTrackers(parsed = {}, { enabled = true, useDefaults = true, extra = [] } = {}) {
  if (!enabled) return [];
  const original = distinctTrackers(parsed.announce);
  if (parsed.private) return original;
  // A magnet does not carry the BEP 27 private bit. Until metadata arrives, do
  // not broadcast a magnet with supplied trackers to unrelated public trackers.
  const knownPublic = !!parsed.info || parsed.private === false;
  const defaults = useDefaults && (knownPublic || !original.length) ? PUBLIC_TRACKERS : [];
  return distinctTrackers([...original, ...extra, ...defaults]);
}

/** Returns a canonical magnet compatible with this installed magnet-uri parser. */
export function normalizeMagnet(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 65536) throw new Error('磁力链接格式不正确。');
  let value = decodeEntities(input.trim());
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")) || (value.startsWith('<') && value.endsWith('>'))) value = value.slice(1, -1).trim();
  // Decode only a whole escaped URI, never blindly decode '&' inside values.
  for (let attempt = 0; attempt < 2 && /^(?:magnet|thunder)%/i.test(value); attempt++) {
    try { value = decodeEntities(decodeURIComponent(value)); } catch { throw new Error('磁力链接中含有无效的百分号编码。'); }
  }
  if (/^thunder:\/\//i.test(value)) {
    const encoded = value.slice('thunder://'.length).replace(/\/$/, '');
    if (!/^[a-z0-9+/]+={0,2}$/i.test(encoded)) throw new Error('迅雷链接编码无效。');
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    if (!decoded.startsWith('AA') || !decoded.endsWith('ZZ')) throw new Error('迅雷链接编码无效。');
    value = decodeEntities(decoded.slice(2, -2).trim());
    if (!/^magnet:\?/i.test(value)) throw new Error('此迅雷链接不是磁力链接，暂不支持 HTTP/FTP 迅雷下载。');
  }
  const bareHash = hashToHex(value);
  if (bareHash) return `magnet:?xt=urn:btih:${bareHash}`;
  if (!/^magnet:\?/i.test(value) || /[\x00-\x1f]/.test(value)) throw new Error('请粘贴 magnet:? 磁力链接或 40 位/32 位 BT 哈希。');
  let url;
  try { url = new URL(value); } catch { throw new Error('磁力链接格式不正确。'); }
  const params = url.searchParams;
  const hashes = new Set();
  for (const xt of params.getAll('xt')) {
    if (!/^urn:btih:/i.test(xt)) continue;
    const hash = hashToHex(xt.slice(9));
    if (!hash) throw new Error('磁力链接中的 BTIH 哈希无效。');
    hashes.add(hash);
  }
  if (hashes.size !== 1) throw new Error(hashes.size ? '磁力链接包含不同的 BTIH 哈希，无法确定下载目标。' : '需要有效 BTIH 哈希；暂不支持仅含 BT v2 的链接。');
  const pairs = [`xt=urn:btih:${[...hashes][0]}`];
  const seen = new Set(pairs);
  let trackerCount = 0, peerCount = 0;
  for (const [key, raw] of params) {
    if (key === 'xt') {
      if (/^urn:btmh:1220[a-f0-9]{64}$/i.test(raw)) {
        const pair = `xt=${raw.toLowerCase()}`;
        if (!seen.has(pair)) { pairs.push(pair); seen.add(pair); }
      }
      continue;
    }
    if (!['dn', 'tr', 'x.pe', 'ws', 'as', 'xs', 'kt', 'so'].includes(key) || /[\x00-\x1f]/.test(raw)) continue;
    let val = raw;
    if (key === 'tr') { val = normalizeTracker(raw); if (!val) continue; }
    if (key === 'x.pe') { val = normalizePeer(raw); if (!val) continue; }
    if (['ws', 'as', 'xs'].includes(key)) {
      try { if (!['http:', 'https:'].includes(new URL(val).protocol)) continue; } catch { continue; }
    }
    if (key === 'so' && !validSelection(val)) continue;
    // magnet-uri 7 does not decode x.pe or xt. Its decoder also treats a
    // literal '=' as a new field, so all remaining values must be escaped.
    const pair = `${key}=${key === 'x.pe' ? val : encodeURIComponent(val)}`;
    if (!seen.has(pair)) {
      if (key === 'tr' && trackerCount++ >= 40) continue;
      if (key === 'x.pe' && peerCount++ >= 128) continue;
      pairs.push(pair); seen.add(pair);
    }
  }
  return `magnet:?${pairs.join('&')}`;
}

async function readBounded(file, limit) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('缓存文件超过允许大小。');
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new Error('缓存文件不完整。');
      offset += bytesRead;
    }
    return { buffer, stat };
  } finally { await handle.close(); }
}

async function atomicWrite(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

function validHash(infoHash) {
  if (typeof infoHash !== 'string' || !HASH.test(infoHash)) throw new Error('元数据缓存哈希无效。');
  return infoHash.toLowerCase();
}

export class MetadataCache {
  constructor(stateDir, { maxEntries = 256, maxBytes = 64 * 1024 * 1024, ttlMs = 30 * DAY } = {}) {
    this.directory = path.join(stateDir, 'metadata-cache');
    this.maxEntries = Math.max(1, Math.min(1024, Number(maxEntries) || 256));
    this.maxBytes = Math.max(1024, Math.min(256 * 1024 * 1024, Number(maxBytes) || 64 * 1024 * 1024));
    this.ttlMs = Math.max(1, Math.min(365 * DAY, Number(ttlMs) || 30 * DAY));
    this.pending = Promise.resolve();
  }
  serial(action) {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }
  get(infoHash) {
    const hash = validHash(infoHash);
    return this.serial(async () => {
      const file = path.join(this.directory, `${hash}.torrent`);
      try {
        const { buffer, stat } = await readBounded(file, Math.min(MAX_TORRENT_BYTES, this.maxBytes));
        if (Date.now() - stat.mtimeMs > this.ttlMs || stat.mtimeMs > Date.now() + DAY) throw new Error('元数据缓存已过期。');
        const parsed = await parseTorrent(buffer);
        if (parsed.infoHash !== hash || !parsed.info || !parsed.files?.length) throw new Error('元数据缓存校验失败。');
        const now = new Date();
        await fs.utimes(file, now, now).catch(() => {});
        return buffer;
      } catch (err) {
        if (err.code !== 'ENOENT') await fs.rm(file, { force: true }).catch(() => {});
        return null;
      }
    });
  }
  put(infoHash, bytes) {
    const hash = validHash(infoHash);
    // Copy before queuing so callers cannot mutate an already validated entry.
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > Math.min(MAX_TORRENT_BYTES, this.maxBytes)) return Promise.reject(new Error('元数据缓存大小无效。'));
    const buffer = Buffer.from(bytes);
    return this.serial(async () => {
      const parsed = await parseTorrent(buffer);
      if (parsed.infoHash !== hash || !parsed.info || !parsed.files?.length) throw new Error('元数据与磁力链接哈希不匹配。');
      await atomicWrite(path.join(this.directory, `${hash}.torrent`), buffer);
      await this._prune();
      return true;
    });
  }
  prune() { return this.serial(() => this._prune()); }
  async _prune() {
    await fs.mkdir(this.directory, { recursive: true });
    const names = await fs.readdir(this.directory);
    const entries = [];
    for (const name of names) {
      if (!/^[a-f0-9]{40}\.torrent$/.test(name)) continue;
      const file = path.join(this.directory, name);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) continue;
      if (Date.now() - stat.mtimeMs > this.ttlMs || stat.mtimeMs > Date.now() + DAY || stat.size > Math.min(MAX_TORRENT_BYTES, this.maxBytes)) {
        await fs.rm(file, { force: true });
      } else entries.push({ file, size: stat.size, accessed: stat.mtimeMs });
    }
    entries.sort((a, b) => b.accessed - a.accessed);
    let total = 0, count = 0;
    for (const entry of entries) {
      total += entry.size;
      if (++count > this.maxEntries || total > this.maxBytes) await fs.rm(entry.file, { force: true });
    }
  }
}

function dhtNodes(nodes, maxNodes) {
  const selected = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || isIP(node.host) !== 4 || !Number.isInteger(node.port) || node.port < 1 || node.port > 65535) continue;
    const first = Number(node.host.split('.')[0]);
    if (first === 0 || first >= 224) continue;
    selected.set(`${node.host}:${node.port}`, { host: node.host, port: node.port });
    if (selected.size >= maxNodes) break;
  }
  return [...selected.values()];
}

/** Restoration uses public addNode: stale nodes are pinged before admission. */
export async function loadDhtState(stateDir, dht, { ttlMs = 7 * DAY, maxNodes = 128 } = {}) {
  if (!dht || dht.destroyed || typeof dht.addNode !== 'function') return 0;
  try {
    const { buffer } = await readBounded(path.join(stateDir, 'dht-nodes.json'), 128 * 1024);
    const data = JSON.parse(buffer.toString('utf8'));
    const age = Date.now() - data.savedAt;
    if (data.version !== 1 || !Number.isFinite(data.savedAt) || age < -60000 || age > ttlMs) return 0;
    const nodes = dhtNodes(data.nodes, Math.max(1, Math.min(256, maxNodes)));
    for (const node of nodes) {
      if (dht.destroyed) break;
      dht.addNode(node);
    }
    return nodes.length;
  } catch { return 0; }
}

export async function saveDhtState(stateDir, dht, { maxNodes = 128 } = {}) {
  if (!dht || dht.destroyed || typeof dht.toJSON !== 'function') return 0;
  const nodes = dhtNodes(dht.toJSON().nodes, Math.max(1, Math.min(256, maxNodes)));
  // A brief offline session must not replace a useful previous routing cache.
  if (!nodes.length) return 0;
  await atomicWrite(path.join(stateDir, 'dht-nodes.json'), JSON.stringify({ version: 1, savedAt: Date.now(), nodes }));
  return nodes.length;
}
