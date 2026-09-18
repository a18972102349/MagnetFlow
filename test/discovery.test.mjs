import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import bencode from 'bencode';
import parseTorrent from 'parse-torrent';
import DHT from 'bittorrent-dht';
import { normalizeMagnet, normalizePeer, normalizeTracker, chooseTrackers, PUBLIC_TRACKERS, MetadataCache, saveDhtState, loadDhtState, resolveDhtBootstrap } from '../src/discovery.mjs';

const HASH = 'a'.repeat(40);
const MAGNET = `magnet:?xt=urn:btih:${HASH}`;
function fixture(name = 'sample.txt', privateFlag) {
  const data = Buffer.from('A real hash-verified metadata fixture.');
  const info = { name, length: data.length, 'piece length': 16384, pieces: createHash('sha1').update(data).digest() };
  if (privateFlag !== undefined) info.private = privateFlag;
  return Buffer.from(bencode.encode({ info, announce: 'https://private.example/secret/announce' }));
}
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magnetflow-discovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('DHT bootstrap explicitly requests all IPv4 answers and ignores IPv6-first resolver output', async () => {
  const calls = [];
  const result = await resolveDhtBootstrap({ bootstrap: ['router.example:6881', '192.0.2.4:6882'], lookup: async (host, options) => {
    calls.push({ host, options });
    return [{ address: '2001:db8::1', family: 6 }, { address: '192.0.2.1', family: 4 }, { address: '192.0.2.2', family: 4 }];
  } });
  assert.deepEqual(calls, [{ host: 'router.example', options: { family: 4, all: true } }]);
  assert.deepEqual(result, [{ host: '192.0.2.1', port: 6881 }, { host: '192.0.2.2', port: 6881 }, { host: '192.0.2.4', port: 6882 }]);
});

test('DHT bootstrap tolerates DNS failure and returns successful answers within a shared deadline', async () => {
  const started = Date.now();
  const result = await resolveDhtBootstrap({ bootstrap: ['missing.example:6881', 'slow.example:6881', 'good.example:6881', '192.0.2.8:6881'], timeoutMs: 30, lookup: async host => {
    if (host.startsWith('missing')) throw new Error('ENOTFOUND');
    if (host.startsWith('slow')) return new Promise(() => {});
    return [{ address: '192.0.2.9', family: 4 }];
  } });
  assert.deepEqual(result, [{ host: '192.0.2.9', port: 6881 }, { host: '192.0.2.8', port: 6881 }]);
  assert.ok(Date.now() - started < 500, 'an unresolved name cannot block initialization');
});

test('DHT bootstrap validates ports, deduplicates nodes, and bounds DNS fanout/results', async () => {
  const calls = [];
  const result = await resolveDhtBootstrap({ bootstrap: [
    '[2001:db8::1]:6881', { host: '2001:db8::1', port: 6881 }, 'bad.example:0', 'bad.example:65536',
    { host: 'bad.example', port: '6881' }, 'bad/name:6881', 'same.example:6881', 'SAME.EXAMPLE:6881',
    ...Array.from({ length: 40 }, (_, i) => `router${i}.example:6881`)
  ], lookup: async host => {
    calls.push(host);
    return Array.from({ length: 30 }, (_, i) => ({ address: `192.0.${calls.length}.${i + 1}`, family: 4 }));
  } });
  assert.equal(calls.length, 8);
  assert.equal(result.length, 32);
  assert.equal(new Set(result.map(node => `${node.host}:${node.port}`)).size, result.length);
  const duplicates = await resolveDhtBootstrap({ bootstrap: ['192.0.2.1:6881', 'a.example:6881', 'b.example:6882'], lookup: async () => [{ address: '192.0.2.1', family: 4 }, { address: '192.0.2.1', family: 4 }] });
  assert.deepEqual(duplicates, [{ host: '192.0.2.1', port: 6881 }, { host: '192.0.2.1', port: 6882 }]);
});

test('normalizes hash, escaped magnet, base32, hybrid and magnet thunder wrapper', async () => {
  assert.equal(normalizeMagnet(` ${HASH.toUpperCase()} `), MAGNET);
  assert.equal(normalizeMagnet('A'.repeat(32)), 'magnet:?xt=urn:btih:' + '0'.repeat(40));
  assert.equal(normalizeMagnet(encodeURIComponent(encodeURIComponent(MAGNET))), MAGNET);
  assert.equal(normalizeMagnet(`&quot;${MAGNET}&amp;dn=video%20demo&amp;tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&quot;`), MAGNET + '&dn=video%20demo&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce');
  assert.equal(normalizeMagnet('thunder://' + Buffer.from(`AA${MAGNET}ZZ`).toString('base64')), MAGNET);
  assert.equal(normalizeMagnet(`MAGNET:?xt=URN:BTIH:${HASH.toUpperCase()}`), MAGNET);
  const hybrid = normalizeMagnet(`${MAGNET}&xt=urn:btmh:1220${'b'.repeat(64)}`);
  assert.equal((await parseTorrent(hybrid)).infoHash, HASH);
  assert.equal((await parseTorrent(hybrid)).infoHashV2, 'b'.repeat(64));
});

test('percent-encoded x.pe becomes a usable peer with installed parse-torrent', async () => {
  const parsed = await parseTorrent(normalizeMagnet(`${MAGNET}&x.pe=127.0.0.1%3A12345&x.pe=%5B%3A%3A1%5D%3A12345&x.pe=127.0.0.1:12345&x.pe=bad%3A99999&dn=demo%3Dname`));
  assert.deepEqual(parsed.peerAddresses, ['127.0.0.1:12345', '[::1]:12345']);
  assert.equal(parsed.name, 'demo=name');
  assert.equal(normalizePeer('LOCALHOST:04000'), 'localhost:4000');
  assert.equal(normalizePeer('evil/path:80'), null);
  assert.equal(normalizePeer('127.0.0.1:0'), null);
});

test('rejects conflicting or malformed hashes and nonmagnet thunder downloads', () => {
  for (const value of [null, '', 'https://example.com/video', 'magnet:?xt=urn:btmh:1220' + 'a'.repeat(64), 'magnet:?xt=urn:btih:broken', `${MAGNET}&xt=urn:btih:${'b'.repeat(40)}`, 'thunder://' + Buffer.from('AAhttps://example.com/videoZZ').toString('base64'), 'thunder://garbage', 'magnet%3A%ZZ']) assert.throws(() => normalizeMagnet(value));
  assert.equal(normalizeMagnet(`${MAGNET}&xt=urn:btih:${HASH.toUpperCase()}`), MAGNET);
});

test('bounds tracker, peer and BEP53 hint work before invoking the parser', async () => {
  const input = MAGNET + Array.from({ length: 200 }, (_, i) => `&tr=udp%3A%2F%2Ftracker${i}.example%3A80&x.pe=127.0.0.1%3A${4000 + i}`).join('');
  const parsed = await parseTorrent(normalizeMagnet(input + '&so=0-999999999999'));
  assert.equal(parsed.announce.length, 40);
  assert.equal(parsed.peerAddresses.length, 128);
  assert.equal(parsed.so, undefined);
  assert.deepEqual((await parseTorrent(normalizeMagnet(MAGNET + '&so=1-3,8'))).so, [1, 2, 3, 8]);
});

test('tracker validation retains auth path, deduplicates, limits, and guards private torrents', async () => {
  assert.equal(normalizeTracker('UDP://TRACKER.EXAMPLE:80/announce'), 'udp://tracker.example:80/announce');
  for (const value of ['file:///c:/file', 'udp://example.com/announce', 'https://user:password@example.com/a', 'javascript:hello', 'http://a.test/#fragment']) assert.equal(normalizeTracker(value), null);
  const privateTorrent = await parseTorrent(fixture('private.txt', 1));
  assert.deepEqual(chooseTrackers(privateTorrent, { extra: ['udp://external.example:80/announce'] }), ['https://private.example/secret/announce']);
  assert.deepEqual(chooseTrackers(privateTorrent, { enabled: false }), []);
  assert.deepEqual(chooseTrackers({ announce: [] }), PUBLIC_TRACKERS);
  assert.deepEqual(chooseTrackers({ announce: ['https://private.example/secret/announce'] }), ['https://private.example/secret/announce']);
  const publicTorrent = await parseTorrent(fixture('public.txt', 0));
  assert.deepEqual(chooseTrackers(publicTorrent), ['https://private.example/secret/announce', ...PUBLIC_TRACKERS]);
  assert.deepEqual(chooseTrackers({ announce: ['udp://TRACKER.EXAMPLE:80/announce', 'udp://tracker.example:80/announce'] }, { useDefaults: false }), ['udp://tracker.example:80/announce']);
  assert.equal(chooseTrackers({ private: false, announce: Array.from({ length: 80 }, (_, i) => `udp://tracker${i}.example:80`) }).length, 40);
});

test('metadata cache persists, validates exact hash on both write/read, and discards corruption', async t => {
  const root = await temporary(t);
  const cache = new MetadataCache(root);
  const bytes = fixture(), parsed = await parseTorrent(bytes);
  assert.equal(await cache.get(parsed.infoHash), null);
  assert.equal(await cache.put(parsed.infoHash, bytes), true);
  assert.deepEqual(await new MetadataCache(root).get(parsed.infoHash), bytes);
  await assert.rejects(cache.put(HASH, bytes), /哈希不匹配/);
  await assert.rejects(cache.put(parsed.infoHash, Buffer.from('bad bencode')));
  assert.throws(() => cache.get('../outside'));
  const wrongPath = path.join(root, 'metadata-cache', `${HASH}.torrent`);
  await fs.writeFile(wrongPath, bytes);
  assert.equal(await cache.get(HASH), null);
  await assert.rejects(fs.stat(wrongPath), { code: 'ENOENT' });
  const cachePath = path.join(root, 'metadata-cache', `${parsed.infoHash}.torrent`);
  await fs.writeFile(cachePath, 'corrupt metadata');
  assert.equal(await cache.get(parsed.infoHash), null);
  await assert.rejects(fs.stat(cachePath), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.join(root, 'metadata-cache')), []);
});

test('metadata cache enforces age, total bytes and entry cap under parallel writes', async t => {
  const root = await temporary(t);
  const cache = new MetadataCache(root, { maxEntries: 2 });
  const samples = await Promise.all(['one.txt', 'two.txt', 'three.txt'].map(async name => {
    const bytes = fixture(name);
    return { bytes, hash: (await parseTorrent(bytes)).infoHash };
  }));
  await Promise.all(samples.map(sample => cache.put(sample.hash, sample.bytes)));
  assert.equal((await fs.readdir(path.join(root, 'metadata-cache'))).length, 2);
  const newest = samples[2];
  const file = path.join(root, 'metadata-cache', `${newest.hash}.torrent`);
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await fs.utimes(file, old, old);
  assert.equal(await cache.get(newest.hash), null);
  const bytesCache = new MetadataCache(path.join(root, 'size'), { maxBytes: 1024 });
  for (let i = 0; i < 10; i++) {
    const bytes = fixture(`file-${i}.txt`);
    await bytesCache.put((await parseTorrent(bytes)).infoHash, bytes);
  }
  const names = await fs.readdir(bytesCache.directory);
  const sizes = await Promise.all(names.map(name => fs.stat(path.join(bytesCache.directory, name))));
  assert.ok(sizes.reduce((sum, stat) => sum + stat.size, 0) <= 1024);
  assert.ok(names.every(name => name.endsWith('.torrent')), 'no incomplete atomic writes remain');
});

test('DHT cache restores verified local UDP nodes through public APIs and ignores stale/corrupt cache', { timeout: 10000 }, async t => {
  const root = await temporary(t);
  const first = new DHT({ bootstrap: false }), second = new DHT({ bootstrap: false }), restored = new DHT({ bootstrap: false });
  t.after(async () => Promise.all([first, second, restored].map(dht => new Promise(resolve => dht.destroy(resolve)))));
  await Promise.all([first, second, restored].map(dht => new Promise(resolve => dht.listen(0, '127.0.0.1', resolve))));
  const learned = new Promise(resolve => second.once('node', resolve));
  second.addNode({ host: '127.0.0.1', port: first.address().port });
  await learned;
  assert.equal(await saveDhtState(root, second), 1);
  const relearned = new Promise(resolve => restored.once('node', resolve));
  assert.equal(await loadDhtState(root, restored), 1);
  await relearned;
  assert.equal(restored.toJSON().nodes[0].port, first.address().port);
  assert.equal(await loadDhtState(root, false), 0);
  assert.equal(await saveDhtState(root, false), 0);
  const file = path.join(root, 'dht-nodes.json');
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(data.nodes[0]).sort(), ['host', 'port'], 'never trusts cached node IDs without ping');
  data.savedAt = 0;
  await fs.writeFile(file, JSON.stringify(data));
  assert.equal(await loadDhtState(root, restored), 0);
  await fs.writeFile(file, 'broken json');
  assert.equal(await loadDhtState(root, restored), 0);
});
