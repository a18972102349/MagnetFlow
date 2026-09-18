import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { once } from 'node:events';
import bencode from 'bencode';
import parseTorrent from 'parse-torrent';
import { SearchService } from '../src/search-service.mjs';
import { PAGE_SIZE, endpointURL, fetchBytes, parseFeed } from '../src/search-providers.mjs';

const DAY = 86400000;
const hash = value => createHash('sha1').update(value).digest('hex');
const escape = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlResponse = body => new Response(body, { headers: { 'content-type': 'application/rss+xml' } });
const jsonResponse = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function torrentFixture(name = 'Original sample.txt') {
  const payload = Buffer.from('Original deterministic fixture for search metadata validation.');
  const info = { name, length: payload.length, 'piece length': 16384, pieces: createHash('sha1').update(payload).digest(), private: 1 };
  return { infoHash: hash(bencode.encode(info)), buffer: Buffer.from(bencode.encode({ info, announce: 'https://tracker.example/authorized/announce', 'url-list': ['https://data.example/original/'], comment: 'Retain original metadata' })) };
}
function feed(items, { total = items.length, offset = 0 } = {}) {
  return `<?xml version="1.0"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><torznab:response offset="${offset}" total="${total}"/>${items.join('')}</channel></rss>`;
}
function entry({ title = 'Original Dataset', infoHash = hash('first'), url, seeders = 4, size = 1234 } = {}) {
  return `<item><title>${escape(title)}</title><description><![CDATA[<b>Original</b> public fixture]]></description><torznab:attr name="infohash" value="${infoHash}"/><torznab:attr name="seeders" value="${seeders}"/><torznab:attr name="size" value="${size}"/>${url ? `<enclosure url="${escape(url)}" length="${size}" type="application/x-bittorrent"/>` : ''}</item>`;
}
function encryption() {
  const key = randomBytes(32);
  return {
    encrypt: async text => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    },
    decrypt: async text => {
      const value = Buffer.from(text, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
    }
  };
}
async function service(t, options = {}) {
  const stateDir = options.stateDir || await fs.mkdtemp(path.join(os.tmpdir(), 'magnetflow-search-'));
  const instance = await new SearchService({ stateDir, catalog: [], ...options }).init();
  t.after(async () => { await instance.close(); if (!options.stateDir) await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return instance;
}
async function localServer(t, handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function addSource(instance, input = {}) {
  const settings = await instance.saveSource({ name: 'Local index', url: 'https://index.example/api', ...input });
  return settings.sources.at(-1);
}

test('real local Torznab keeps an encrypted API key private and resolves original torrent metadata after restart', async t => {
  const fixture = torrentFixture(), apiKey = 'fixture-key-&-do-not-echo', requests = [];
  const origin = await localServer(t, (req, res) => {
    const url = new URL(req.url, origin); requests.push(url);
    if (url.searchParams.get('t') === 'search') {
      res.setHeader('content-type', 'application/rss+xml');
      res.end(feed([entry({ title: 'Original & Dataset', infoHash: fixture.infoHash.toUpperCase(), url: `${origin}/api?t=get&id=one&apikey=${encodeURIComponent(apiKey)}` })]));
    } else { res.setHeader('content-type', 'application/x-bittorrent'); res.end(fixture.buffer); }
  });
  const crypto = encryption(), first = await service(t, crypto);
  const source = await addSource(first, { name: 'Local encrypted index', url: `${origin}/api`, apiKey });
  assert.equal(source.hasApiKey, true);
  assert.equal(JSON.stringify(first.settings()).includes(apiKey), false);
  assert.equal('key' in source, false);
  const saved = await fs.readFile(path.join(first.stateDir, 'search-settings.json'), 'utf8');
  assert.equal(saved.includes(apiKey), false);
  assert.notEqual(JSON.parse(saved).sources.at(-1).key, '');
  await first.close();
  const instance = await service(t, { stateDir: first.stateDir, ...crypto });
  const result = await instance.search({ query: 'Original', sourceIds: [source.id], requestId: 'local' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, 'Original & Dataset');
  assert.equal(JSON.stringify(result).includes(apiKey), false);
  const resolved = await instance.resolve(result.items[0].id);
  assert.equal(resolved.fromFile, true);
  assert.deepEqual(resolved.input, fixture.buffer, 'the full source torrent survives, including private flag, tracker and web seed');
  const parsed = await parseTorrent(resolved.input);
  assert.equal(parsed.infoHash, fixture.infoHash);
  assert.equal(parsed.private, true);
  assert.deepEqual(parsed.urlList, ['https://data.example/original/']);
  assert.deepEqual(parsed.announce, ['https://tracker.example/authorized/announce']);
  assert.ok(requests.length >= 2 && requests.every(url => url.searchParams.get('apikey') === apiKey));
});

test('RSS text/entities and Torznab attributes merge equal hashes across sources without exposing download URLs', async t => {
  const fixtureHash = hash('shared'), requests = [];
  const instance = await service(t, { fetchImpl: async input => {
    const url = new URL(input); requests.push(url);
    const first = url.hostname === 'one.example';
    const magnet = `magnet:?xt=urn:btih:${fixtureHash}&dn=Fish%20%26%20Chips`;
    return xmlResponse(feed([`<item><title>Fish &amp; Chips &#x96EA;</title><description><![CDATA[<b>Creative</b> sample]]></description><torznab:attr name="magneturl" value="${escape(magnet)}"/><torznab:attr name="seeders" value="${first ? 2 : 9}"/><enclosure url="${escape(`https://${url.hostname}/download?id=one&token=private-token`)}" length="456" type="application/x-bittorrent"/></item>`, '<item><title>Cross origin only</title><enclosure url="https://untrusted.example/torrent"/></item>']));
  } });
  const one = await addSource(instance, { name: 'One', url: 'https://one.example/api' });
  const two = await addSource(instance, { name: 'Two', url: 'https://two.example/api' });
  const result = await instance.search({ query: 'Fish', sourceIds: [one.id, two.id], requestId: 'merge' });
  assert.equal(requests.length, 2);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, 'Fish & Chips 雪');
  assert.equal(result.items[0].description, 'Creative sample');
  assert.equal(result.items[0].size, 456);
  assert.equal(result.items[0].seeders, 9);
  assert.deepEqual(result.items[0].sources.sort(), ['One', 'Two']);
  assert.equal(JSON.stringify(result).includes('private-token'), false);
});

test('Torznab pagination sends the requested offset and stops a source that repeats its first page', async t => {
  let repeat = false; const requests = [];
  const instance = await service(t, { fetchImpl: async input => {
    const url = new URL(input); requests.push(url);
    return xmlResponse(feed([entry()], { total: 100, offset: repeat ? 0 : PAGE_SIZE }));
  } });
  const source = await addSource(instance);
  const result = await instance.search({ query: 'Dataset', page: 2, sourceIds: [source.id], requestId: 'page-two' });
  assert.equal(requests[0].searchParams.get('offset'), String(PAGE_SIZE));
  assert.equal(requests[0].searchParams.get('limit'), String(PAGE_SIZE));
  assert.equal(result.items.length, 1); assert.equal(result.hasMore, true);
  repeat = true;
  const repeated = await instance.search({ query: 'Dataset', page: 2, sourceIds: [source.id], requestId: 'repeat' });
  assert.equal(repeated.items.length, 0); assert.equal(repeated.hasMore, false);
  assert.match(repeated.sources[0].message, /翻页/);
});

test('fast results arrive progressively while a failed source and a slow source remain isolated', async t => {
  const gate = deferred(); t.after(() => gate.resolve(xmlResponse(feed([]))));
  const instance = await service(t, { catalog: [{ title: 'Original Example', infoHash: hash('example'), magnet: `magnet:?xt=urn:btih:${hash('example')}` }], fetchImpl: async input => {
    if (new URL(input).hostname === 'failed.example') throw new Error('fetch failed https://failed.example/api?apikey=do-not-echo');
    return gate.promise;
  } });
  const failed = await addSource(instance, { name: 'Failed', url: 'https://failed.example/api' });
  const slow = await addSource(instance, { name: 'Slow', url: 'https://slow.example/api' });
  const progress = []; instance.on('progress', event => progress.push(event));
  const firstProgress = once(instance, 'progress');
  const pending = instance.search({ query: 'Original', sourceIds: ['openmedia', failed.id, slow.id], requestId: 'partial' });
  const [first] = await firstProgress;
  assert.equal(first.items.length, 1); assert.ok(first.pending > 0);
  gate.resolve(xmlResponse(feed([])));
  const result = await pending;
  assert.equal(result.items.length, 1);
  assert.equal(result.sources.find(source => source.id === failed.id).status, 'error');
  assert.equal(result.sources.find(source => source.id === slow.id).status, 'ok');
  assert.equal(JSON.stringify({ result, progress }).includes('do-not-echo'), false);
  assert.equal(progress.at(-1).pending, 0);
});

test('a new query cancels the old one and ignores its late response without mixing progress or results', async t => {
  const oldStarted = deferred(), newStarted = deferred(), oldResponse = deferred(), newResponse = deferred();
  t.after(() => { oldResponse.resolve(xmlResponse(feed([]))); newResponse.resolve(xmlResponse(feed([]))); });
  const instance = await service(t, { fetchImpl: async input => {
    const query = new URL(input).searchParams.get('q');
    if (query === 'old') { oldStarted.resolve(); return oldResponse.promise; }
    newStarted.resolve(); return newResponse.promise;
  } });
  const source = await addSource(instance), progress = [];
  instance.on('progress', event => progress.push(event));
  const oldSearch = instance.search({ query: 'old', sourceIds: [source.id], requestId: 'old-request' });
  await oldStarted.promise;
  const newSearch = instance.search({ query: 'new', sourceIds: [source.id], requestId: 'new-request' });
  await newStarted.promise;
  instance.cancel('old-request');
  newResponse.resolve(xmlResponse(feed([entry({ title: 'New result', infoHash: hash('new') })])));
  const latest = await newSearch;
  oldResponse.resolve(xmlResponse(feed([entry({ title: 'Old result', infoHash: hash('old') })])));
  const old = await oldSearch;
  assert.equal(old.cancelled, true); assert.deepEqual(old.items, []);
  assert.equal(latest.cancelled, undefined); assert.equal(latest.items[0].title, 'New result');
  assert.ok(progress.length > 0 && progress.every(event => event.requestId === 'new-request'));
  assert.equal([...instance.results.values()].some(result => result.item.title === 'Old result'), false);
});

test('response limits cancel oversized bodies and unsafe XML is rejected before it can become search results', async () => {
  const source = { id: 'custom', url: 'https://index.example/api' };
  let declaredCancelled = false, streamedCancelled = false;
  await assert.rejects(fetchBytes(source.url, { source, maxBytes: 8, fetchImpl: async () => new Response(new ReadableStream({ cancel() { declaredCancelled = true; } }), { headers: { 'content-length': '9' } }) }), /大小/);
  assert.equal(declaredCancelled, true);
  let chunks = 0;
  await assert.rejects(fetchBytes(source.url, { source, maxBytes: 8, fetchImpl: async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(5)); chunks++; }, cancel() { streamedCancelled = true; } })) }), /大小/);
  assert.equal(streamedCancelled, true); assert.ok(chunks <= 4, 'the stream is stopped once the cap is exceeded');
  assert.throws(() => parseFeed('<!DOCTYPE rss [<!ENTITY leak SYSTEM "file:///secret">]><rss><channel><item><title>&leak;</title></item></channel></rss>'), /声明/);
  assert.throws(() => parseFeed('<rss>' + '<nested>'.repeat(33) + '</nested>'.repeat(33) + '</rss>'), /层级/);
  assert.throws(() => parseFeed('<error code="100" description="secret API key do-not-echo"/>'), error => /API Key/.test(error.message) && !error.message.includes('do-not-echo'));
});

test('a malicious cross-origin redirect never receives the configured API key', async t => {
  let targetRequests = 0, sourceKey;
  const target = await localServer(t, (_req, res) => { targetRequests++; res.end(feed([])); });
  const origin = await localServer(t, (req, res) => {
    sourceKey = new URL(req.url, origin).searchParams.get('apikey');
    res.writeHead(302, { location: `${target}/collect?apikey=${encodeURIComponent(sourceKey)}` }); res.end();
  });
  const instance = await service(t, encryption()), apiKey = 'redirect-secret';
  const source = await addSource(instance, { url: `${origin}/api`, apiKey });
  const result = await instance.search({ query: 'Original', sourceIds: [source.id], requestId: 'redirect' });
  assert.equal(sourceKey, apiKey); assert.equal(targetRequests, 0);
  assert.equal(result.sources[0].status, 'error'); assert.match(result.sources[0].message, /跨站/);
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test('Internet Archive uses paged JSON search and the metadata file list to resolve the actual torrent', async t => {
  const fixture = torrentFixture('Archive original.txt'), requests = [];
  const filename = 'Real source name_archive.torrent';
  const instance = await service(t, { fetchImpl: async (input, options) => {
    const url = new URL(input); requests.push(url); assert.equal(options.redirect, 'manual');
    if (url.pathname === '/advancedsearch.php') {
      assert.equal(url.searchParams.get('page'), '2'); assert.equal(url.searchParams.get('rows'), String(PAGE_SIZE));
      assert.match(url.searchParams.get('q'), /format:"Archive BitTorrent"/);
      assert.ok(url.searchParams.getAll('fl[]').includes('identifier'));
      return jsonResponse({ responseHeader: { status: 0 }, response: { numFound: 90, start: PAGE_SIZE, docs: [{ identifier: 'Original_Archive', title: 'Original Archive', item_size: '2048', description: ['Original', 'Public'], date: '2024-01-01' }, { identifier: '../escape', title: 'Invalid identifier' }] } });
    }
    if (url.pathname === '/metadata/Original_Archive') return jsonResponse({ metadata: { identifier: 'Original_Archive', title: 'Original Archive', licenseurl: 'https://creativecommons.org/licenses/by/3.0/' }, files: [{ name: 'sample.txt', format: 'Text' }, { name: filename, format: 'Archive BitTorrent', size: String(fixture.buffer.length) }] });
    assert.equal(url.pathname, '/download/Original_Archive/' + encodeURIComponent(filename));
    return new Response(fixture.buffer, { headers: { 'content-type': 'application/x-bittorrent' } });
  } });
  const result = await instance.search({ query: 'Original Archive', sourceIds: ['archive'], page: 2, requestId: 'archive' });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].size, 2048); assert.equal(result.hasMore, true);
  const resolved = await instance.resolve(result.items[0].id);
  assert.deepEqual(resolved.input, fixture.buffer); assert.equal(resolved.fromFile, true); assert.equal(requests.length, 3);
});

test('Academic Torrents caches its database locally and serves an expired index during an offline refresh', async t => {
  let now = Date.UTC(2026, 0, 1), fetches = 0;
  const database = '<?xml version="1.0"?><rss xmlns:academictorrents="http://academictorrents.com" version="2.0"><channel><title>Academic Torrents</title>' + [1, 2].map(n => `<item><title>Original Dataset ${n}</title><category>Dataset</category><infohash>${hash(String(n))}</infohash><guid>https://academictorrents.com/details/${hash(String(n))}</guid><link>https://academictorrents.com/details/${hash(String(n))}</link><description>Research &amp; reproducibility</description><size>${n * 1000}</size></item>`).join('') + '</channel></rss>';
  const first = await service(t, { now: () => now, fetchImpl: async input => { fetches++; assert.equal(input, 'https://academictorrents.com/database.xml'); return xmlResponse(database); } });
  const one = await first.search({ query: 'Original Dataset', sourceIds: ['academic'], requestId: 'academic-first' });
  assert.equal(one.items.length, 2); assert.equal(one.items[1].size, 2000);
  await first.search({ query: 'Research', sourceIds: ['academic'], requestId: 'academic-memory' });
  assert.equal(fetches, 1);
  const cache = JSON.parse(await fs.readFile(path.join(first.stateDir, 'academic-search-cache.json'), 'utf8'));
  assert.equal(cache.items.length, 2);
  await first.close();
  now += DAY + 1;
  const reloaded = await service(t, { stateDir: first.stateDir, now: () => now, fetchImpl: async () => { fetches++; throw new Error('offline'); } });
  const stale = await reloaded.search({ query: 'Dataset', sourceIds: ['academic'], requestId: 'academic-offline' });
  assert.equal(fetches, 2); assert.equal(stale.items.length, 2); assert.equal(stale.sources[0].status, 'ok');
  assert.match(stale.sources[0].message, /已有索引/);
  assert.deepEqual(stale.items.map(item => item.id), one.items.map(item => item.id));
});

test('result resolution rejects a mismatched torrent hash and expired result without accepting replacement content', async t => {
  const intended = torrentFixture('Intended original.txt'), wrong = torrentFixture('Different original.txt');
  let calls = 0, now = Date.UTC(2026, 0, 1);
  const instance = await service(t, { now: () => now, catalog: [{ title: 'Original', infoHash: intended.infoHash, torrentUrl: 'https://webtorrent.io/torrents/original.torrent' }], fetchImpl: async () => { calls++; return new Response(wrong.buffer); } });
  const result = await instance.search({ query: 'Original', sourceIds: ['openmedia'], requestId: 'wrong-torrent' });
  await assert.rejects(instance.resolve(result.items[0].id), /哈希不一致/);
  now += 46 * 60000;
  await assert.rejects(instance.resolve(result.items[0].id), /过期/);
  assert.equal(calls, 1, 'expired results are rejected before another request');
  assert.equal(instance.resolving.size, 0);
});

test('HTTP source exceptions apply only to actual local addresses and secret-bearing endpoint URLs are rejected', async t => {
  for (const url of ['http://127.0.0.1:9117/api', 'http://localhost:9117/api', 'http://[::1]:9117/api', 'http://192.168.1.2/api', 'http://10.1.2.3/api', 'http://172.16.0.2/api']) assert.equal(endpointURL(url), new URL(url).href);
  for (const url of ['http://public.example/api', 'http://127.attacker.example/api', 'http://10.example.com/api', 'http://192.168.example.com/api', 'https://index.example/api?apikey=secret', 'https://user:secret@index.example/api']) assert.throws(() => endpointURL(url), undefined, url);
  const instance = await service(t);
  await assert.rejects(addSource(instance, { apiKey: 'must-not-store-in-plaintext' }), /安全保存/);
});

test('a real response body timeout closes the stream and service shutdown cancels an in-flight search', { timeout: 5000 }, async t => {
  let requests = 0;
  const firstClosed = deferred(), secondStarted = deferred(), secondClosed = deferred();
  const origin = await localServer(t, (_req, res) => {
    const index = ++requests;
    res.once('close', () => (index === 1 ? firstClosed : secondClosed).resolve());
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.write('<?xml version="1.0"?><rss><channel>');
    if (index === 2) secondStarted.resolve();
    // Deliberately keep the response body open; native fetch must interrupt it.
  });
  const endpoint = `${origin}/api`, source = { id: 'local-timeout', url: endpoint };
  await assert.rejects(fetchBytes(endpoint, { source, timeoutMs: 100 }), /超时/);
  await firstClosed.promise;
  const instance = await service(t, { timeoutMs: 3000 });
  const saved = await addSource(instance, { url: endpoint });
  const progress = []; instance.on('progress', event => progress.push(event));
  const pending = instance.search({ query: 'Original', sourceIds: [saved.id], requestId: 'close-pending' });
  await secondStarted.promise;
  await instance.close();
  const result = await pending;
  await secondClosed.promise;
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.items, []); assert.deepEqual(progress, []);
  assert.equal(instance.active, null); assert.equal(instance.results.size, 0);
});

test('merging a later bare magnet preserves discovery hints from an earlier result with the same hash', async t => {
  const sharedHash = hash('rich magnet'), bare = `magnet:?xt=urn:btih:${sharedHash}`;
  const tracker = 'https://tracker.example/public/announce', webseed = 'https://data.example/original/';
  const rich = `${bare}&tr=${encodeURIComponent(tracker)}&ws=${encodeURIComponent(webseed)}`;
  const later = deferred(); t.after(() => later.resolve(xmlResponse(feed([]))));
  const instance = await service(t, { fetchImpl: async input => new URL(input).hostname === 'first.example'
    ? xmlResponse(feed([`<item><title>Original rich magnet</title><torznab:attr name="magneturl" value="${escape(rich)}"/></item>`]))
    : later.promise });
  const first = await addSource(instance, { name: 'First', url: 'https://first.example/api' });
  const second = await addSource(instance, { name: 'Second', url: 'https://second.example/api' });
  const progress = once(instance, 'progress');
  const pending = instance.search({ query: 'Original', sourceIds: [first.id, second.id], requestId: 'rich-merge' });
  const [partial] = await progress;
  assert.equal(partial.items.length, 1); assert.equal(partial.pending, 1);
  later.resolve(xmlResponse(feed([`<item><title>Original bare magnet</title><torznab:attr name="magneturl" value="${bare}"/></item>`])));
  const result = await pending;
  assert.equal(result.items.length, 1);
  const resolved = await instance.resolve(result.items[0].id);
  assert.equal(resolved.fromFile, false);
  const parsed = await parseTorrent(resolved.input);
  assert.equal(parsed.infoHash, sharedHash);
  assert.ok(parsed.announce.includes(tracker), 'deduplication retains the discovered tracker');
  assert.ok(parsed.urlList.includes(webseed), 'deduplication retains the available web seed');
});

test('an expired torrent result cannot revive its old source or token URL when a fresh magnet matches the hash', async t => {
  let now = Date.UTC(2026, 0, 1), oldDownloads = 0;
  const sharedHash = hash('expired previous source');
  const instance = await service(t, { now: () => now, fetchImpl: async input => {
    const url = new URL(input);
    if (url.pathname === '/old.torrent') { oldDownloads++; throw new Error('Expired private URL must not be requested'); }
    return xmlResponse(feed([entry({ infoHash: sharedHash, url: url.hostname === 'first.example' ? 'https://first.example/old.torrent?token=expired' : undefined })]));
  } });
  const first = await addSource(instance, { name: 'First', url: 'https://first.example/api' });
  const second = await addSource(instance, { name: 'Second', url: 'https://second.example/api' });
  await instance.search({ query: 'Original', sourceIds: [first.id], requestId: 'old-source' });
  now += 46 * 60000;
  const fresh = await instance.search({ query: 'Original', sourceIds: [second.id], requestId: 'new-source' });
  assert.deepEqual(fresh.items[0].sources, ['Second']);
  const resolved = await instance.resolve(fresh.items[0].id);
  assert.equal(resolved.fromFile, false);
  assert.equal((await parseTorrent(resolved.input)).infoHash, sharedHash);
  assert.equal(oldDownloads, 0);
});

test('a same-origin RSS link-only torrent resolves while a cross-origin link is excluded', async t => {
  const fixture = torrentFixture('Link-only original.txt'), requests = [];
  const instance = await service(t, { fetchImpl: async input => {
    const url = new URL(input); requests.push(url);
    if (url.pathname === '/api') return xmlResponse(feed([
      '<item><title>Original link-only torrent</title><link>https://index.example/download?t=get&amp;id=one&amp;apikey=hidden-link-key</link></item>',
      '<item><title>Untrusted external link</title><link>https://outside.example/download.torrent</link></item>'
    ]));
    assert.equal(url.origin, 'https://index.example'); assert.equal(url.pathname, '/download');
    return new Response(fixture.buffer);
  } });
  const source = await addSource(instance);
  const result = await instance.search({ query: 'Original', sourceIds: [source.id], requestId: 'link-only' });
  assert.equal(result.items.length, 1);
  assert.equal(JSON.stringify(result).includes('hidden-link-key'), false);
  const resolved = await instance.resolve(result.items[0].id);
  assert.deepEqual(resolved.input, fixture.buffer);
  assert.equal(resolved.fromFile, true); assert.equal(requests.length, 2);
});

test('RSS detail-page links do not override a valid infohash or explicit magnet without a torrent enclosure', async t => {
  const infoHash = hash('hash with detail link'), magnetHash = hash('magnet with detail link');
  const tracker = 'https://tracker.example/announce', requests = [];
  const magnet = `magnet:?xt=urn:btih:${magnetHash}&tr=${encodeURIComponent(tracker)}`;
  const instance = await service(t, { fetchImpl: async input => {
    const url = new URL(input); requests.push(url);
    assert.equal(url.pathname, '/api', 'HTML detail pages must not be requested as torrents');
    return xmlResponse(feed([
      `<item><title>Original hash result</title><torznab:attr name="infohash" value="${infoHash.toUpperCase()}"/><link>https://index.example/details/hash-result</link></item>`,
      `<item><title>Original magnet result</title><torznab:attr name="magneturl" value="${escape(magnet)}"/><link>https://index.example/details/magnet-result</link></item>`
    ]));
  } });
  const source = await addSource(instance);
  const result = await instance.search({ query: 'Original', sourceIds: [source.id], requestId: 'detail-links' });
  assert.equal(result.items.length, 2);
  const hashes = [];
  for (const item of result.items) {
    assert.equal(item.kind, 'magnet');
    const resolved = await instance.resolve(item.id);
    assert.equal(resolved.fromFile, false);
    const parsed = await parseTorrent(resolved.input); hashes.push(parsed.infoHash);
    if (parsed.infoHash === magnetHash) assert.ok(parsed.announce.includes(tracker));
  }
  assert.deepEqual(hashes.sort(), [infoHash, magnetHash].sort());
  assert.equal(requests.length, 1);
});

test('later pages preserve rich candidates, while changing the query or source filter starts a fresh resolution context', async t => {
  const sharedHash = hash('shared paged result'), bare = `magnet:?xt=urn:btih:${sharedHash}`;
  const tracker = 'https://tracker.example/page/announce', webseed = 'https://data.example/paged/';
  const rich = `${bare}&tr=${encodeURIComponent(tracker)}&ws=${encodeURIComponent(webseed)}`;
  let oldTorrentRequests = 0, useTorrent = false;
  const instance = await service(t, { fetchImpl: async input => {
    const url = new URL(input), offset = Number(url.searchParams.get('offset'));
    if (url.pathname === '/old.torrent') { oldTorrentRequests++; throw new Error('Wrong source selected'); }
    if (url.hostname === 'first.example' && offset === 0 && url.searchParams.get('q') === 'Original') {
      return xmlResponse(feed([useTorrent ? entry({ infoHash: sharedHash, url: 'https://first.example/old.torrent?token=old-provider' }) : `<item><title>Original rich candidate</title><torznab:attr name="magneturl" value="${escape(rich)}"/></item>`], { total: 60, offset }));
    }
    if (url.hostname === 'second.example' && offset === PAGE_SIZE) return xmlResponse(feed([`<item><title>Original bare candidate</title><torznab:attr name="magneturl" value="${bare}"/></item>`], { total: PAGE_SIZE + 1, offset }));
    return xmlResponse(feed([], { total: 0, offset }));
  } });
  const first = await addSource(instance, { name: 'First', url: 'https://first.example/api' });
  const second = await addSource(instance, { name: 'Second', url: 'https://second.example/api' });
  const sourceIds = [first.id, second.id];
  const pageOne = await instance.search({ query: 'Original', sourceIds, requestId: 'context-page-one' });
  const pageTwo = await instance.search({ query: 'Original', sourceIds, page: 2, requestId: 'context-page-two' });
  assert.equal(pageOne.items[0].id, pageTwo.items[0].id);
  const richResolved = await parseTorrent((await instance.resolve(pageTwo.items[0].id)).input);
  assert.ok(richResolved.announce.includes(tracker)); assert.ok(richResolved.urlList.includes(webseed));
  assert.deepEqual(pageTwo.items[0].sources.sort(), ['First', 'Second']);
  const different = await instance.search({ query: 'Different', sourceIds, page: 2, requestId: 'context-different-query' });
  const differentResolved = await instance.resolve(different.items[0].id);
  assert.equal(new URL(differentResolved.input).searchParams.has('tr'), false);
  assert.deepEqual(different.items[0].sources, ['Second']);
  // The first source is still enabled and its result is fresh. Selecting only
  // the second source must nevertheless exclude the first source's token URL.
  useTorrent = true;
  await instance.search({ query: 'Original', sourceIds, requestId: 'context-fresh-torrent' });
  const restricted = await instance.search({ query: 'Original', sourceIds: [second.id], page: 2, requestId: 'context-source-filter' });
  const restrictedResolved = await instance.resolve(restricted.items[0].id);
  assert.equal(restrictedResolved.fromFile, false);
  assert.equal((await parseTorrent(restrictedResolved.input)).infoHash, sharedHash);
  assert.deepEqual(restricted.items[0].sources, ['Second']); assert.equal(oldTorrentRequests, 0);
});
