import sax from 'sax';
import { isIP } from 'node:net';

export const PAGE_SIZE = 30;
export const BUILTINS = [
  { id: 'openmedia', name: '开放影片示例', type: 'builtin', description: 'WebTorrent 官方提供的少量开放影片示例，可离线搜索名称。' },
  { id: 'archive', name: 'Internet Archive', type: 'builtin', description: '搜索带 BitTorrent 下载的归档条目；可用性由来源决定。' },
  { id: 'academic', name: 'Academic Torrents', type: 'builtin', description: '科研数据与课程。首次搜索获取公开索引，之后在本地搜索，每日刷新。' }
];

export const textValue = (value, limit = 500) => String(Array.isArray(value) ? value.join(', ') : value ?? '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
export const numberValue = value => value !== '' && value !== null && value !== undefined && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
export const validHash = value => typeof value === 'string' && /^[a-f\d]{40}$/i.test(value);

export function endpointURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入完整的 Torznab API 地址。'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host === '::1' || (isIP(host) === 4 && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('公网接口须使用 HTTPS；本机和内网 IP 可使用 HTTP。');
  if (url.username || url.password || url.hash || url.search || url.href.length > 2048) throw new Error('接口地址不要包含账号、密钥或查询参数，API Key 请单独填写。');
  return url.href;
}

// Results are untrusted. Only a configured origin (or Archive's own HTTPS
// storage hosts) may serve a torrent; redirects do not expand that authority.
export function trustedURL(value, source) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password || url.href.length > 8192) return null;
  if (source.id === 'archive') return url.protocol === 'https:' && (url.hostname === 'archive.org' || url.hostname.endsWith('.archive.org')) ? url.href : null;
  if (source.id === 'academic') return url.protocol === 'https:' && url.hostname === 'academictorrents.com' ? url.href : null;
  if (source.id === 'openmedia') return url.protocol === 'https:' && url.hostname === 'webtorrent.io' ? url.href : null;
  return source.url && url.origin === new URL(source.url).origin && ['http:', 'https:'].includes(url.protocol) ? url.href : null;
}

export async function fetchBytes(input, { source, signal, fetchImpl = fetch, maxBytes = 4 * 1024 * 1024, timeoutMs = 18000 } = {}) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  let url = trustedURL(input, source);
  try {
    if (!url) throw new Error('来源返回了不受支持的跨站地址。');
    for (let hop = 0; hop < 4; hop++) {
      if (combined.aborted) throw new Error('请求已取消。');
      const response = await fetchImpl(url, { signal: combined, redirect: 'manual', credentials: 'omit', headers: { Accept: 'application/json, application/rss+xml, application/xml, application/x-bittorrent, */*', 'User-Agent': 'MagnetFlow/0.4.0 (desktop resource search)' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const next = response.headers.get('location');
        url = next && trustedURL(new URL(next, url).href, source);
        if (!url) throw new Error('来源返回了不受支持的跨站跳转。');
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 429 ? '来源请求过于频繁，请稍后重试。' : response.status === 401 || response.status === 403 ? '来源拒绝访问，请检查接口权限或 API Key。' : `来源服务暂时不可用（HTTP ${response.status}）。`); }
      if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('来源响应超过允许的大小。'); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('来源没有返回内容。');
      let size = 0; const chunks = [];
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Error('来源响应超过允许的大小。');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return Buffer.concat(chunks, size);
    }
    throw new Error('来源跳转次数过多。');
  } catch (error) {
    if (signal?.aborted) throw new Error('搜索已取消。');
    if (timeout.signal.aborted) throw new Error('来源响应超时，请稍后重试。');
    // Native network exceptions may contain the request URL and API key.
    if (!/^(来源|请求|搜索)/.test(error.message)) throw new Error('来源连接失败，请检查网络或接口地址。');
    throw error;
  } finally { clearTimeout(timer); }
}

export function parseFeed(buffer, { maxItems = 30000 } = {}) {
  const input = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : buffer;
  if (/<!DOCTYPE|<!ENTITY/i.test(input)) throw new Error('来源 XML 包含不支持的文档声明。');
  const items = [], stack = []; let item = null, total = null, offset = null, errorCode = null;
  const parser = sax.parser(true, { trim: true, normalize: false, lowercase: false, strictEntities: true });
  parser.onopentag = node => {
    const name = node.name.toLowerCase().split(':').pop();
    stack.push(name);
    if (stack.length > 32) throw new Error('来源 XML 层级过深。');
    if (name === 'item') item = { attrs: {} };
    if (name === 'error') errorCode = String(node.attributes.code || '');
    if (name === 'response') { total = numberValue(node.attributes.total); offset = numberValue(node.attributes.offset); }
    if (!item) return;
    if (name === 'attr') {
      const key = String(node.attributes.name || '').toLowerCase();
      if (['infohash', 'magneturl', 'size', 'seeders', 'peers'].includes(key)) item.attrs[key] = String(node.attributes.value || '').slice(0, 8192);
    }
    if (name === 'enclosure') { item.enclosure = String(node.attributes.url || '').slice(0, 8192); item.size = numberValue(node.attributes.length); }
  };
  const append = value => {
    if (!item) return;
    const name = stack.at(-1);
    if (['title', 'link', 'guid', 'infohash', 'pubdate', 'description', 'size', 'category'].includes(name)) item[name] = ((item[name] || '') + value).slice(0, name === 'description' ? 1200 : 8192);
  };
  parser.ontext = append; parser.oncdata = append;
  parser.onclosetag = () => {
    if (stack.pop() === 'item' && item) {
      if (items.length >= maxItems) throw new Error('来源 XML 条目过多。');
      items.push(item); item = null;
    }
  };
  try { parser.write(input).close(); } catch (error) { if (error.message.startsWith('来源')) throw error; throw new Error('来源返回的 XML 无法解析。'); }
  if (errorCode !== null) throw new Error(['100', '101', '102'].includes(errorCode) ? '来源 API Key 无效或权限不足。' : `来源接口返回错误（${/^\d{1,4}$/.test(errorCode) ? errorCode : '未知'}）。`);
  if (!/^\s*(?:<\?xml[^>]*>\s*)?<rss[\s>]/i.test(input)) throw new Error('来源未返回有效 RSS 搜索结果。');
  return { items, total, offset };
}

export function feedItems(feed, source) {
  return feed.items.map(raw => {
    const hash = String(raw.attrs.infohash || raw.infohash || (validHash(raw.guid) ? raw.guid : '')).toLowerCase();
    const explicitMagnet = [raw.attrs.magneturl, raw.enclosure, raw.link].find(value => typeof value === 'string' && value.startsWith('magnet:?'));
    const magnet = explicitMagnet || (validHash(hash) ? `magnet:?xt=urn:btih:${hash}` : null);
    // RSS links can point to HTML detail pages. Prefer a usable magnet/hash
    // unless an enclosure explicitly supplies the downloadable torrent.
    const torrentUrl = trustedURL(raw.enclosure || '', source) || (!magnet ? trustedURL(raw.link || '', source) : null);
    if (!magnet && !torrentUrl) return null;
    return { title: textValue(raw.title) || '未命名资源', infoHash: validHash(hash) ? hash : null, magnet,
      torrentUrl, size: numberValue(raw.attrs.size) ?? numberValue(raw.size), seeders: numberValue(raw.attrs.seeders),
      description: textValue(raw.description, 400), date: textValue(raw.pubdate, 64) || null };
  }).filter(Boolean);
}
