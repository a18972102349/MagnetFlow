import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import WebTorrent from 'webtorrent';
import { DownloadEngine } from '../src/core.mjs';
import { StreamServer } from '../src/stream-server.mjs';

const isolated = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(25); }
  throw new Error(`Timeout: ${label}`);
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magnetflow-selection-'));
  const seeder = new WebTorrent(isolated);
  const engines = [], servers = [], requests = [];
  t.after(async () => {
    for (const server of servers) await server.close();
    for (const engine of engines) await engine.close();
    await new Promise(resolve => seeder.destroy(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const files = ['a-unselected.bin', 'b-selected.webm'];
  const contents = files.map(() => randomBytes(128 * 1024));
  await Promise.all(files.map((name, index) => fs.writeFile(path.join(root, name), contents[index])));
  const seed = await new Promise((resolve, reject) => {
    seeder.once('error', reject);
    seeder.seed(files.map(name => path.join(root, name)), { name: 'OriginalSelectionFixture', announce: [], pieceLength: 16384 }, resolve);
  });
  seed.on('wire', wire => wire.on('request', (piece, offset, length) => requests.push({ piece, offset, length })));
  const config = { stateDir: path.join(root, 'state'), downloadDir: path.join(root, 'downloads'), clientOptions: isolated };
  async function makeEngine() { const engine = await new DownloadEngine(config).init(); engines.push(engine); return engine; }
  return { root, seed, seeder, requests, config, makeEngine, servers, contents };
}

test('new magnet and restored pending task exchange metadata but request no content until file confirmation', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  let engine = await f.makeEngine();
  // BEP 53 is an input hint, not authorization to start its selected file.
  const { id } = await engine.add(`magnet:?xt=urn:btih:${f.seed.infoHash}&so=0&x.pe=127.0.0.1:${f.seeder.torrentPort}`);
  let torrent = engine.active.get(id);
  await until(() => torrent.ready && torrent.numPeers > 0, 'real metadata wire');
  await delay(300);
  let snapshot = engine.snapshot().tasks[0];
  assert.equal(snapshot.awaitingSelection, true);
  assert.equal(snapshot.status, 'selecting');
  assert.equal(snapshot.connection.stage, 'awaiting_selection');
  assert.equal(snapshot.files.length, 2);
  assert.equal(snapshot.length, 256 * 1024, 'pending task exposes full file-list size');
  assert.equal(snapshot.files.filter(file => file.selected).length, 0);
  assert.equal(torrent.downloaded, 0);
  assert.equal(f.requests.length, 0, 'no BitTorrent content requests, including during metadata/ready transition');
  const selectedIndex = torrent.files.findIndex(file => file.name === 'b-selected.webm');
  await assert.rejects(engine.mediaFile(id, selectedIndex), /确认下载/);
  await assert.rejects(engine.preparePlayback(id, selectedIndex), /确认下载/);
  await assert.rejects(engine.selectFiles(id, []), /至少选择/);
  assert.equal(engine.get(id).awaitingSelection, true);
  const server = await new StreamServer(engine).listen(); f.servers.push(server);
  const blocked = await fetch(server.url(id, selectedIndex), { headers: { Range: 'bytes=0-100' } });
  assert.ok(blocked.status >= 400, 'direct media HTTP request cannot start downloading before confirmation');
  await blocked.text();
  assert.equal(f.requests.length, 0);
  await engine.close();
  const saved = JSON.parse(await fs.readFile(path.join(f.config.stateDir, 'session.json'), 'utf8'));
  assert.equal(saved.tasks[0].awaitingSelection, true);
  assert.deepEqual(saved.tasks[0].selectedFiles, []);

  engine = await f.makeEngine();
  torrent = engine.active.get(id);
  await until(() => torrent.ready && torrent.numPeers > 0, 'unconfirmed task restored with cached metadata and peer hints');
  await delay(300);
  assert.equal(engine.snapshot().tasks[0].status, 'selecting');
  assert.equal(f.requests.length, 0, 'restart must not silently select content');
  const selectedFile = torrent.files[selectedIndex];
  const firstPiece = selectedFile.offset / torrent.pieceLength;
  const endPiece = (selectedFile.offset + selectedFile.length) / torrent.pieceLength;
  await engine.selectFiles(id, [selectedIndex]);
  assert.equal(engine.active.get(id), torrent, 'first confirmation preserves established metadata peers');
  await until(() => selectedFile.done, 'confirmed file downloaded');
  assert.ok(f.requests.length > 0);
  assert.ok(f.requests.every(request => request.piece >= firstPiece && request.piece < endPiece), 'piece-aligned unselected file is never requested');
  assert.equal(torrent.files.find(file => file.name === 'a-unselected.bin').downloaded, 0);
  assert.deepEqual(await fs.readFile(path.join(engine.get(id).path, selectedFile.path)), f.contents[1]);
  snapshot = engine.snapshot().tasks[0];
  assert.equal(snapshot.awaitingSelection, false);
  assert.equal(snapshot.status, 'complete');
  assert.equal(snapshot.files.filter(file => file.selected).length, 1);
  const completedRequestCount = f.requests.length;
  await engine.close();
  engine = await f.makeEngine();
  await until(() => engine.active.get(id)?.ready, 'confirmed subset restored');
  await delay(300);
  assert.equal(engine.get(id).awaitingSelection, false);
  assert.deepEqual(engine.get(id).selectedFiles, [selectedIndex]);
  assert.equal(engine.snapshot().tasks[0].status, 'complete');
  assert.equal(f.requests.length, completedRequestCount, 'confirmed restart does not briefly select the omitted file');
});

test('new torrent-file tasks also await confirmation; old sessions retain previously authorized downloads', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  let engine = await f.makeEngine();
  const { id } = await engine.add(f.seed.torrentFile, true);
  const pending = engine.active.get(id);
  pending.addPeer(`127.0.0.1:${f.seeder.torrentPort}`);
  await until(() => pending.ready && pending.numPeers > 0, 'torrent file connected');
  await delay(300);
  assert.equal(engine.snapshot().tasks[0].awaitingSelection, true);
  assert.equal(f.requests.length, 0, 'immediate torrent metadata has no default content selection');
  await engine.close();
  // Reproduce the actual old persisted format, where missing awaitingSelection
  // and selectedFiles:null meant an already authorized download of all files.
  const sessionFile = path.join(f.config.stateDir, 'session.json');
  const session = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
  delete session.tasks[0].awaitingSelection;
  session.tasks[0].selectedFiles = null;
  await fs.writeFile(sessionFile, JSON.stringify(session));
  engine = await f.makeEngine();
  const restored = engine.active.get(id);
  restored.addPeer(`127.0.0.1:${f.seeder.torrentPort}`);
  await until(() => restored.done, 'legacy confirmed task downloads without new confirmation');
  assert.equal(engine.snapshot().tasks[0].awaitingSelection, false);
  assert.equal(engine.snapshot().tasks[0].status, 'complete');
  assert.equal(restored.downloaded, 256 * 1024);
});

test('first confirmation starts a paused metadata-only task while later file changes preserve pause', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const engine = await f.makeEngine();
  const { id } = await engine.add(`magnet:?xt=urn:btih:${f.seed.infoHash}&x.pe=127.0.0.1:${f.seeder.torrentPort}`);
  await until(() => engine.active.get(id)?.ready, 'metadata received before pause');
  await engine.pause(id);
  assert.equal(engine.get(id).awaitingSelection, true);
  assert.equal(engine.get(id).paused, true);
  assert.equal(f.requests.length, 0);
  const selectedIndex = engine.get(id).files.findIndex(file => file.name === 'b-selected.webm');
  await engine.selectFiles(id, [selectedIndex]);
  assert.equal(engine.get(id).paused, false, 'first confirmation explicitly starts downloading');
  assert.equal(engine.get(id).awaitingSelection, false);
  assert.ok(engine.active.has(id));
  await until(() => engine.active.get(id)?.files[selectedIndex]?.done, 'confirmed paused task starts transferring');
  assert.ok(f.requests.length > 0);
  await engine.pause(id);
  const requestsBeforeChange = f.requests.length;
  await engine.selectFiles(id, [selectedIndex === 0 ? 1 : 0]);
  assert.equal(engine.get(id).paused, true, 'later file changes preserve an intentional download pause');
  assert.equal(engine.active.has(id), false);
  await delay(100);
  assert.equal(f.requests.length, requestsBeforeChange);
});
