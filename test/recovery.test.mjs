import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import WebTorrent from 'webtorrent';
import TrackerServer from 'bittorrent-tracker/server';
import bencode from 'bencode';
import parseTorrent from 'parse-torrent';
import string2compact from 'string2compact';
import DHT from 'bittorrent-dht';
import { DownloadEngine } from '../src/core.mjs';

const isolated = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const cleanups = new WeakMap();
const cleanup = (t, fn) => cleanups.get(t).push(fn);
async function until(predicate, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await predicate();
    if (result) return result;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`Timeout: ${message}`);
}
async function rootDirectory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magnetflow-recovery-'));
  cleanups.set(t, []);
  t.after(async () => {
    const errors = [];
    for (const action of cleanups.get(t).reverse()) { try { await action(); } catch (error) { errors.push(error); } }
    await fs.rm(root, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, 'Test resource cleanup failed');
  });
  return root;
}
async function tracker(t) {
  const server = new TrackerServer({ udp: false, ws: false, stats: false, interval: 10 * 60 * 1000 });
  const requests = [];
  server.http.on('request', request => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const rawHash = request.url.match(/[?&]info_hash=([^&]+)/)?.[1] || '';
    const infoHash = Buffer.from(rawHash.replace(/%([a-f0-9]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))), 'latin1').toString('hex');
    if (url.pathname === '/announce') requests.push({ port: Number(url.searchParams.get('port')), event: url.searchParams.get('event') || 'update', infoHash });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  cleanup(t, () => new Promise(resolve => server.close(resolve)));
  return { server, requests, url: `http://127.0.0.1:${server.http.address().port}/announce` };
}
async function engineAt(t, root, clientOptions = isolated) {
  const engine = await new DownloadEngine({ stateDir: path.join(root, 'state'), downloadDir: path.join(root, 'downloads'), clientOptions }).init();
  cleanup(t, () => engine.close());
  await engine.updateSettings({ usePublicTrackers: false });
  return engine;
}
async function seed(t, root, announce = []) {
  const seeder = new WebTorrent({ ...isolated, tracker: announce.length ? {} : false });
  cleanup(t, () => seeder.destroyed ? undefined : new Promise(resolve => seeder.destroy(resolve)));
  const payload = randomBytes(256 * 1024 + 19);
  const file = path.join(root, 'fixture.webm');
  await fs.writeFile(file, payload);
  const torrent = await new Promise((resolve, reject) => { seeder.once('error', reject); seeder.seed(file, { announce, pieceLength: 16384 }, resolve); });
  return { seeder, torrent, payload };
}

test('resolved IPv4 bootstrap alone discovers real DHT peers and transfers data', { timeout: 15000 }, async t => {
  const root = await rootDirectory(t);
  const router = new DHT({ bootstrap: false });
  cleanup(t, () => new Promise(resolve => router.destroy(resolve)));
  await new Promise(resolve => router.listen(0, '127.0.0.1', resolve));
  const bootstrap = [{ host: '127.0.0.1', port: router.address().port }];
  const seeder = new WebTorrent({ ...isolated, dht: { bootstrap } });
  cleanup(t, () => new Promise(resolve => seeder.destroy(resolve)));
  const payload = randomBytes(128 * 1024 + 37);
  const file = path.join(root, 'dht-bootstrap.webm');
  await fs.writeFile(file, payload);
  let announced = false;
  router.on('announce', () => { announced = true; });
  const seeded = await new Promise(resolve => seeder.seed(file, { announce: [], pieceLength: 16384 }, resolve));
  await until(() => announced, 'seeder announced itself to local DHT');
  let resolved = 0;
  const engine = await new DownloadEngine({
    stateDir: path.join(root, 'state'), downloadDir: path.join(root, 'downloads'),
    clientOptions: { ...isolated, dht: {} },
    resolveBootstrap: async () => { resolved++; return bootstrap; }
  }).init();
  cleanup(t, () => engine.close());
  const { id } = await engine.add(`magnet:?xt=urn:btih:${seeded.infoHash}`);
  const torrent = engine.active.get(id);
  await until(() => torrent.ready, 'DHT-only magnet metadata');
  await engine.selectFiles(id, [0]);
  await until(() => torrent.done, 'DHT-only magnet transfer');
  const snapshot = engine.snapshot();
  assert.equal(resolved, 1);
  assert.equal(snapshot.network.bootstrapResolved, 1);
  assert.ok(snapshot.network.dhtNodes > 0);
  assert.ok(snapshot.tasks[0].sources.dht > 0);
  assert.equal(snapshot.tasks[0].connection.stage, 'complete');
  assert.deepEqual(await fs.readFile(path.join(engine.get(id).path, torrent.files[0].path)), payload);
});

test('late verified DHT route resumes failed lookup without manual retry and skips paused/private tasks', { timeout: 15000 }, async t => {
  const root = await rootDirectory(t);
  const router = new DHT({ bootstrap: false });
  cleanup(t, () => new Promise(resolve => router.destroy(resolve)));
  await new Promise(resolve => router.listen(0, '127.0.0.1', resolve));
  const bootstrap = [{ host: '127.0.0.1', port: router.address().port }];
  const queries = [];
  router.on('get_peers', hash => queries.push(hash.toString('hex')));
  const seeder = new WebTorrent({ ...isolated, dht: { bootstrap } });
  cleanup(t, () => new Promise(resolve => seeder.destroy(resolve)));
  const payload = randomBytes(128 * 1024 + 29);
  const file = path.join(root, 'late-bootstrap.webm');
  await fs.writeFile(file, payload);
  let announced = false;
  router.on('announce', () => { announced = true; });
  const seeded = await new Promise(resolve => seeder.seed(file, { announce: [], pieceLength: 16384 }, resolve));
  await until(() => announced, 'seeder present on local DHT');
  const engine = await engineAt(t, root, { ...isolated, dht: { bootstrap: false } });
  const { id } = await engine.add(`magnet:?xt=urn:btih:${seeded.infoHash}`);
  const torrent = engine.active.get(id);
  await until(() => engine.get(id).warning === 'No nodes to query', 'initial lookup failed before a route exists');
  assert.equal(torrent.ready, false);
  assert.equal(engine.client.dht.nodes.count(), 0);
  const pausedId = (await engine.add(`magnet:?xt=urn:btih:${'e'.repeat(40)}`)).id;
  await engine.pause(pausedId);
  const privateBytes = Buffer.from(bencode.encode({ info: {
    name: 'private-test.txt', private: 1, length: 1, 'piece length': 16384,
    pieces: createHash('sha1').update('p').digest()
  } }));
  const privateId = (await engine.add(privateBytes, true)).id;
  await until(() => engine.active.get(privateId)?.ready, 'private fixture metadata');
  const routeAdded = Date.now();
  engine.client.dht.addNode(bootstrap[0]);
  // No explicit lookup, reannounce or torrent.addPeer: the engine's ordinary
  // heartbeat must recover the pending magnet from a later validated route.
  await until(() => torrent.ready, 'automatic DHT-route metadata recovery', 5000);
  await engine.selectFiles(id, [0]);
  await until(() => torrent.done, 'automatic DHT-route recovery transfer', 5000);
  const runtime = engine.runtime.get(id);
  assert.ok(Date.now() - routeAdded < 5000, 'does not wait for 30-second recovery timer');
  assert.equal(runtime.dhtLookups, 1);
  for (let i = 0; i < 10; i++) engine.recoverReadyDht();
  assert.equal(runtime.dhtLookups, 1, 'additional ticks do not flood DHT');
  assert.ok(queries.includes(id));
  assert.ok(!queries.includes(pausedId));
  assert.ok(!queries.includes(privateId));
  assert.deepEqual(await fs.readFile(path.join(engine.get(id).path, torrent.files[0].path)), payload);
});

test('real HTTP tracker alone discovers peers, transfers verified data, reannounces and stops cleanly', { timeout: 20000 }, async t => {
  const root = await rootDirectory(t);
  const local = await tracker(t);
  const { seeder, torrent: seeded, payload } = await seed(t, root, [local.url]);
  await until(() => local.requests.some(request => request.port === seeder.torrentPort), 'seeder registered with tracker');
  const engine = await engineAt(t, root, { ...isolated, tracker: {} });
  const { id } = await engine.add(`magnet:?xt=urn:btih:${seeded.infoHash}&tr=${encodeURIComponent(local.url)}`);
  const download = engine.active.get(id);
  // No addPeer, x.pe, DHT or webseed: this transfer requires the real tracker.
  await until(() => download.ready, 'tracker-discovered metadata');
  await engine.selectFiles(id, [0]);
  await until(() => download.done, 'tracker-discovered TCP transfer');
  assert.deepEqual(await fs.readFile(path.join(engine.get(id).path, download.files[0].path)), payload);
  assert.deepEqual(download.announce, [local.url]);
  const initialUpdates = local.requests.filter(request => request.port === engine.client.torrentPort && request.event === 'update').length;
  assert.equal(engine.reannounce(id).requested, true);
  assert.equal(engine.reannounce(id).requested, false, 'manual retries are rate limited');
  await until(() => local.requests.filter(request => request.port === engine.client.torrentPort && request.event === 'update').length > initialUpdates, 'manual tracker update');
  await until(() => engine.snapshot().tasks[0].trackers.some(entry => entry.status === 'ok'), 'tracker response reflected in status');
  const stoppedPort = engine.client.torrentPort;
  await engine.pause(id);
  assert.ok(download.destroyed);
  assert.equal(engine.active.has(id), false);
  assert.equal(engine.client.torrents.length, 0);
  assert.equal(engine.reannounce(id).requested, false);
  await until(() => local.requests.some(request => request.port === stoppedPort && request.event === 'stopped'), 'tracker stopped message');
  const countAfterStop = local.requests.length;
  engine.recoverStalled();
  await delay(100);
  assert.equal(local.requests.length, countAfterStop, 'stopped task sends no recovery requests');
  await engine.remove(id);
  assert.equal(engine.runtime.has(id), false, 'removed task releases diagnostics state');
});

test('removed magnet reuses hash-verified metadata without any online seeder or downloaded data', { timeout: 15000 }, async t => {
  const root = await rootDirectory(t);
  const { seeder, torrent: seeded } = await seed(t, root);
  const engine = await engineAt(t, root);
  await engine.updateSettings({ downloadLimit: 64 });
  const magnet = `magnet:?xt=urn:btih:${seeded.infoHash}&x.pe=127.0.0.1%3A${seeder.torrentPort}`;
  const { id } = await engine.add(magnet);
  await until(() => engine.active.get(id)?.ready, 'original metadata from encoded explicit peer');
  assert.ok(await engine.metadataCache.get(id), 'valid metadata persisted before removing task');
  await engine.remove(id);
  await new Promise(resolve => seeder.destroy(resolve));
  await engine.updateSettings({ downloadDir: path.join(root, 'empty-downloads') });
  const started = Date.now();
  await engine.add(`magnet:?xt=urn:btih:${id}`);
  await until(() => engine.active.get(id)?.ready, 'offline cached metadata', 3000);
  const task = engine.snapshot().tasks[0];
  assert.equal(task.metadataSource, 'cache');
  assert.equal(task.files.length, 1);
  assert.equal(task.downloaded, 0);
  assert.equal(task.peers, 0);
  assert.ok(Date.now() - started < 3000, 'metadata resolution does not wait for unavailable peers');
});

test('cached private metadata keeps original tracker membership and avoids DHT during recovery', { timeout: 15000 }, async t => {
  const root = await rootDirectory(t);
  const original = await tracker(t), unrelated = await tracker(t);
  const engine = await engineAt(t, root, { ...isolated, tracker: {}, dht: { bootstrap: false } });
  const payload = Buffer.from('Private tracker isolation fixture');
  const bytes = Buffer.from(bencode.encode({ announce: original.url, info: {
    name: 'private.txt', private: 1, length: payload.length, 'piece length': 16384,
    pieces: createHash('sha1').update(payload).digest()
  } }));
  const parsed = await parseTorrent(bytes);
  await engine.metadataCache.put(parsed.infoHash, bytes);
  let unrelatedConnections = 0;
  const peerTrap = createServer(socket => { unrelatedConnections++; socket.destroy(); });
  await new Promise(resolve => peerTrap.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => new Promise(resolve => peerTrap.close(resolve)));
  const peerAddress = `127.0.0.1:${peerTrap.address().port}`;
  const { id } = await engine.add(`magnet:?xt=urn:btih:${parsed.infoHash}&tr=${encodeURIComponent(unrelated.url)}&x.pe=${encodeURIComponent(peerAddress)}`);
  await until(() => engine.active.get(id)?.ready, 'private cached metadata');
  const torrent = engine.active.get(id);
  assert.equal(torrent.private, true);
  assert.deepEqual(torrent.announce, [original.url]);
  assert.equal(torrent.discovery.dht, null);
  assert.equal(engine.client.dht.listenerCount('peer'), 0);
  engine.get(id).peerHints = [{ address: peerAddress, seen: Date.now() }];
  assert.equal(engine.reannounce(id).requested, true);
  await until(() => original.requests.length > 0, 'private tracker announcement');
  await delay(100);
  assert.equal(unrelated.requests.length, 0, 'private hash never sent to unrelated magnet tracker');
  assert.equal(unrelatedConnections, 0, 'private torrent never contacts unrelated explicit or cached peers');
  assert.equal(engine.runtime.get(id).lookupPending || false, false);
  await engine.pause(id);
  assert.equal(engine.client.dht.listenerCount('peer'), 0);
});

test('restoring mismatched session metadata fails before adding the wrong torrent', { timeout: 10000 }, async t => {
  const root = await rootDirectory(t);
  const wrongHash = 'd'.repeat(40);
  const bytes = Buffer.from(bencode.encode({ info: {
    name: 'wrong.txt', length: 1, 'piece length': 16384, pieces: createHash('sha1').update('x').digest()
  } }));
  const stateDir = path.join(root, 'state');
  await fs.mkdir(stateDir);
  await fs.writeFile(path.join(stateDir, 'session.json'), JSON.stringify({ version: 1, settings: {}, tasks: [{
    id: wrongHash, source: `magnet:?xt=urn:btih:${wrongHash}`, metadata: bytes.toString('base64'),
    path: path.join(root, 'downloads', wrongHash), name: 'corrupt record', addedAt: Date.now(),
    paused: false, error: '', files: [], selectedFiles: null, length: 0, downloaded: 0, uploaded: 0
  }] }));
  const engine = await engineAt(t, root);
  assert.equal(engine.active.size, 0);
  assert.equal(engine.client.torrents.length, 0);
  assert.match(engine.get(wrongHash).error, /哈希/);
  assert.equal(engine.snapshot().tasks[0].status, 'error');
});

test('private bit learned over a real metadata wire replaces public discovery without interrupting transfer or shared DHT', { timeout: 20000 }, async t => {
  const root = await rootDirectory(t);
  const original = await tracker(t), fallback = await tracker(t);
  const engine = await engineAt(t, root, { ...isolated, tracker: {}, dht: { bootstrap: false } });
  await engine.updateSettings({ extraTrackers: [fallback.url], downloadLimit: 512 });
  const publicBytes = Buffer.from(bencode.encode({ info: {
    name: 'public.txt', length: 1, 'piece length': 16384, pieces: createHash('sha1').update('p').digest()
  } }));
  const publicResult = await engine.add(publicBytes, true);
  await until(() => engine.active.get(publicResult.id)?.ready, 'unrelated public task');
  const publicTorrent = engine.active.get(publicResult.id);
  const publicDiscovery = publicTorrent.discovery;
  const sharedDht = engine.client.dht;
  const publicDhtListeners = sharedDht.listenerCount('peer');
  assert.ok(publicDhtListeners > 0);

  // Keep the seeder off trackers so listener attachment precedes metadata arrival.
  const seeder = new WebTorrent(isolated);
  cleanup(t, () => new Promise(resolve => seeder.destroy(resolve)));
  const payload = randomBytes(1024 * 1024 + 113);
  const file = path.join(root, 'private-transition.webm');
  await fs.writeFile(file, payload);
  const seeded = await new Promise(resolve => seeder.seed(file, { private: true, announce: [original.url], pieceLength: 16384 }, resolve));
  const result = await engine.add(`magnet:?xt=urn:btih:${seeded.infoHash}&tr=${encodeURIComponent(original.url)}`);
  const torrent = engine.active.get(result.id);
  await until(() => torrent.discovery, 'initial magnet discovery');
  const oldDiscovery = torrent.discovery;
  assert.equal(oldDiscovery.dht, sharedDht);
  assert.ok(torrent.announce.includes(fallback.url));
  let transferWire;
  torrent.once('wire', wire => {
    transferWire = wire;
    assert.ok(wire.ut_pex, 'unknown magnet initially negotiated PEX');
    wire.ut_pex.start();
  });
  torrent.addPeer(`127.0.0.1:${seeder.torrentPort}`);
  await until(() => torrent.ready, 'private metadata fetched from original data wire');
  assert.equal(engine.active.get(result.id), torrent, 'torrent instance and store survive transition');
  assert.equal(torrent.private, true);
  assert.ok(oldDiscovery.destroyed);
  assert.notEqual(torrent.discovery, oldDiscovery);
  assert.equal(torrent.discovery.dht, null);
  assert.deepEqual(torrent.announce, [original.url]);
  assert.equal(transferWire.destroyed, false);
  assert.equal(transferWire.ut_pex._intervalId, null);
  assert.equal(transferWire.ut_pex.listenerCount('peer'), 0);
  assert.equal(transferWire.ut_pex.listenerCount('dropped'), 0);
  assert.equal(sharedDht.destroyed, false);
  assert.equal(sharedDht.listenerCount('peer'), publicDhtListeners);
  assert.equal(publicTorrent.discovery, publicDiscovery);
  assert.equal(publicDiscovery.destroyed, false);
  assert.equal((await parseTorrent(await engine.metadataCache.get(result.id))).private, true);
  assert.deepEqual((await parseTorrent(await engine.metadataCache.get(result.id))).announce, [original.url], 'cache does not persist appended fallback tracker');

  let trapConnections = 0;
  const peerTrap = createServer(socket => { trapConnections++; socket.destroy(); });
  await new Promise(resolve => peerTrap.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => new Promise(resolve => peerTrap.close(resolve)));
  const extensionId = Number(Object.entries(transferWire.extendedMapping).find(([, name]) => name === 'ut_pex')[0]);
  const remoteWire = seeded.wires.find(wire => !wire.destroyed);
  // A peer ignoring our PEX-disable handshake still cannot add arbitrary peers.
  remoteWire.extended(extensionId, { added: string2compact(`127.0.0.1:${peerTrap.address().port}`) });
  assert.equal(engine.reannounce(result.id).requested, true);
  const privateFallbackRequests = () => fallback.requests.filter(request => request.infoHash === result.id && request.event !== 'stopped').length;
  await delay(100); // settle already-dispatched pre-metadata HTTP requests
  const count = privateFallbackRequests();
  await engine.selectFiles(result.id, [0]);
  await until(() => torrent.done, 'original data wire continues downloading after private switch');
  assert.deepEqual(await fs.readFile(path.join(engine.get(result.id).path, torrent.files[0].path)), payload);
  assert.equal(trapConnections, 0);
  assert.equal(privateFallbackRequests(), count, 'no further fallback announces after privacy transition');
  assert.equal(engine.active.get(publicResult.id), publicTorrent);
  assert.equal(sharedDht.destroyed, false);
});
