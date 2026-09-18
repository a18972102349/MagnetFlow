import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebTorrent from 'webtorrent';
import { DownloadEngine } from '../src/core.mjs';
import { StreamServer } from '../src/stream-server.mjs';
import { resolveMediaBinary } from '../src/media-transcoder.mjs';

const isolated = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false };
const MiB = 1024 * 1024;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await delay(25); }
  throw new Error(`Timeout: ${label}`);
}
async function fixture(t, videoLength) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magnetflow-performance-'));
  const seeder = new WebTorrent(isolated);
  const omitted = path.join(root, 'a-unselected.bin'), video = path.join(root, 'b-video.webm');
  await fs.writeFile(omitted, randomBytes(128 * 1024));
  if (videoLength === null) {
    await promisify(execFile)(resolveMediaBinary(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '6', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '2M', '-y', video], { windowsHide: true });
  } else await fs.writeFile(video, randomBytes(videoLength));
  const payload = await fs.readFile(video);
  const seed = await new Promise(resolve => seeder.seed([omitted, video], { name: 'OriginalPerformanceFixture', announce: [], pieceLength: 16384 }, resolve));
  const engine = await new DownloadEngine({ stateDir: path.join(root, 'state'), downloadDir: path.join(root, 'downloads'), clientOptions: isolated }).init();
  const servers = [];
  t.after(async () => {
    for (const server of servers) await server.close();
    await engine.close(); await new Promise(resolve => seeder.destroy(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const { id } = await engine.add(`magnet:?xt=urn:btih:${seed.infoHash}&x.pe=127.0.0.1:${seeder.torrentPort}`);
  const torrent = engine.active.get(id);
  await until(() => torrent.ready && torrent.numPeers > 0, 'local metadata exchange');
  const index = torrent.files.findIndex(file => file.name === 'b-video.webm');
  return { engine, torrent, id, index, seed, payload, servers };
}

test('speed diagnosis distinguishes connected-but-choked peers, unavailable selected pieces and actual payload senders', { timeout: 15000 }, async t => {
  const f = await fixture(t, 512 * 1024);
  const { engine, torrent, id, index, seed } = f;
  let diagnosis = engine.snapshot().tasks[0].speedDiagnosis;
  assert.equal(diagnosis.code, 'awaiting_selection');
  assert.equal(diagnosis.metrics.selectedAvailability, null);
  const remote = seed.wires.find(wire => !wire.destroyed);
  remote.choke();
  await until(() => torrent.wires[0].peerChoking, 'remote choke arrived');
  await engine.updateSettings({ downloadLimit: 64 });
  await engine.selectFiles(id, [index]);
  await until(() => engine.snapshot().tasks[0].speedDiagnosis.code === 'peer_choked', 'choked peer reported without claiming data');
  diagnosis = engine.snapshot().tasks[0].speedDiagnosis;
  assert.equal(diagnosis.metrics.connectedPeers, 1);
  assert.equal(diagnosis.metrics.activeDataPeers, 0);
  assert.equal(diagnosis.metrics.downloadLimitBps, 64 * 1024);
  assert.equal(torrent.downloaded, 0);

  // Advertise only the omitted file using an actual protocol message. A wire
  // with pieces is not necessarily useful for the user's selected files.
  const bitfield = Buffer.alloc(Math.ceil(torrent.pieces.length / 8));
  const startPiece = torrent.files[index].offset / torrent.pieceLength;
  for (let piece = 0; piece < startPiece; piece++) bitfield[piece >> 3] |= 128 >> (piece & 7);
  remote.bitfield(bitfield);
  remote.unchoke();
  await until(() => engine.snapshot().tasks[0].speedDiagnosis.code === 'missing_pieces', 'selected piece availability differs from total peer count');
  diagnosis = engine.snapshot().tasks[0].speedDiagnosis;
  assert.equal(diagnosis.metrics.selectedAvailability.known, true);
  assert.equal(diagnosis.metrics.selectedAvailability.complete, true);
  assert.equal(diagnosis.metrics.selectedAvailability.missingPieces, 32);
  assert.equal(diagnosis.metrics.selectedAvailability.availableMissingPieces, 0);
  assert.equal(diagnosis.metrics.selectedAvailability.swarmAvailability, null, 'connected-peer observations never claim full swarm knowledge');
  remote.bitfield(Buffer.alloc(bitfield.length, 255));
  await until(() => engine.snapshot().tasks[0].speedDiagnosis.metrics.activeDataPeers > 0, 'real content bytes arrived');
  diagnosis = engine.snapshot().tasks[0].speedDiagnosis;
  assert.ok(diagnosis.metrics.payloadSpeedBps > 0);
  assert.ok(['receiving', 'download_limit'].includes(diagnosis.code));
  await engine.updateSettings({ downloadLimit: 0 });
  await until(() => torrent.files[index].done, 'selected original bytes finish');
  assert.deepEqual(await fs.readFile(path.join(engine.get(id).path, torrent.files[index].path)), f.payload);
  assert.equal(engine.snapshot().tasks[0].speedDiagnosis.code, 'complete');
  await engine.pause(id);
  assert.equal(engine.snapshot().tasks[0].speedDiagnosis.code, 'paused');
});

test('media HEAD is scheduling-neutral and actual playback reuses its bounded sequential window until cancellation', { timeout: 20000 }, async t => {
  const f = await fixture(t, 12 * MiB);
  const { engine, torrent, id, index } = f;
  await engine.updateSettings({ downloadLimit: 32 });
  await engine.selectFiles(id, [index]);
  const server = await new StreamServer(engine).listen(); f.servers.push(server);
  const before = { critical: [...torrent._critical], selections: [...torrent._selections].map(item => ({ from: item.from, to: item.to, stream: item.isStreamSelection })) };
  const response = await fetch(server.url(id, index), { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(torrent.strategy, 'rarest', 'HEAD does not force whole-torrent sequential scheduling');
  assert.deepEqual(torrent._critical, before.critical, 'HEAD does not add irrelevant head/tail critical pieces');
  assert.deepEqual([...torrent._selections].map(item => ({ from: item.from, to: item.to, stream: item.isStreamSelection })), before.selections);
  await engine.preparePlayback(id, index, 0);
  const initial = engine.prefetch.get(id);
  assert.equal(initial.totalTarget, 8 * MiB + 256 * 1024);
  assert.equal(initial.streams.size, 2);
  assert.ok([...torrent._selections].some(item => item.isStreamSelection && item.priority > 0), 'actual FileIterator reads prioritize playback ranges');
  assert.ok([...torrent._selections].filter(item => item.isStreamSelection).every(item => item.to - item.from + 1 <= 4), 'initial playback priority covers the next 64 KiB, not a whole rarest-first window');
  assert.equal(torrent.strategy, 'sequential', 'a whole-file HTTP reader must not request arbitrary rare pieces ahead of its read cursor');
  await engine.preparePlayback(id, index, 3 * MiB);
  assert.equal(engine.prefetch.get(id), initial, 'progress within the buffered window does not reopen overlapping disk streams');
  await engine.preparePlayback(id, index, 7 * MiB);
  assert.notEqual(engine.prefetch.get(id), initial);
  await until(() => [...initial.streams].every(stream => stream.destroyed), 'seek releases old range readers');
  assert.ok(engine.prefetch.get(id).totalTarget <= 8 * MiB + 256 * 1024);
  const availability = engine.snapshot().tasks[0].speedDiagnosis.metrics.selectedAvailability;
  assert.equal(availability.checkedPieces, 256, 'large torrent diagnostics have bounded work');
  assert.equal(availability.complete, false, 'sample is identified rather than presented as full availability');
  engine.cancelPrefetch(id);
  await delay(50);
  assert.equal(engine.prefetch.has(id), false);
  assert.equal(torrent.strategy, 'rarest');
  assert.ok(![...torrent._selections].some(item => item.isStreamSelection), 'cancellation preserves only regular selected-file downloads');
  await engine.updateSettings({ downloadLimit: 128 });
  const playback = await fetch(server.url(id, index), { headers: { Range: 'bytes=0-' }, signal: AbortSignal.timeout(12000) });
  const reader = playback.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.deepEqual(Buffer.from(first.value), f.payload.subarray(0, first.value.length));
  assert.ok(torrent.files[index].downloaded < torrent.files[index].length, 'open-ended video request emits correct initial bytes before the selected video downloads');
  await reader.cancel();
});

test('a real WebM below 8 MiB prioritizes header and tail pieces in parallel without overlapping prefetch reads', { timeout: 20000 }, async t => {
  const { engine, torrent, id, index, seed, payload } = await fixture(t, null);
  assert.ok(payload.length > 512 * 1024 && payload.length <= 8 * MiB, 'the original six-second WebM exercises the small-video path');
  const remote = seed.wires.find(wire => !wire.destroyed);
  remote.choke();
  await until(() => torrent.wires[0].peerChoking, 'remote choke arrived');
  await engine.updateSettings({ downloadLimit: 128 });
  await engine.selectFiles(id, [index]);
  const file = torrent.files[index], reads = [], requested = new Set();
  let downloadedAtBothRequests = null;
  const createReadStream = file.createReadStream.bind(file);
  file.createReadStream = options => { reads.push({ ...options }); return createReadStream(options); };
  await engine.preparePlayback(id, index);
  const work = engine.prefetch.get(id), tailStart = file.length - 256 * 1024;
  const firstPiece = Math.floor(file.offset / torrent.pieceLength);
  const lastPiece = Math.floor((file.offset + file.length - 1) / torrent.pieceLength);
  remote.on('request', piece => {
    requested.add(piece);
    if (downloadedAtBothRequests === null && requested.has(firstPiece) && requested.has(lastPiece)) downloadedAtBothRequests = file.downloaded;
  });
  assert.equal(work.streams.size, 2, 'headers and container tail have independent active readers even below 8 MiB');
  assert.equal(work.totalTarget, file.length, 'overlapping forward and tail windows count each file byte once');
  assert.equal(reads[0].start, 0);
  assert.equal(reads[1].start, tailStart);
  assert.equal(torrent._critical[firstPiece], true);
  assert.equal(torrent._critical[lastPiece], true, 'the final container/index piece is critical at the real play action');
  assert.equal(torrent.strategy, 'sequential');
  assert.ok([...torrent._selections].some(item => item.isStreamSelection && item.priority > 0 && item.from === Math.floor((file.offset + tailStart) / torrent.pieceLength)));
  remote.unchoke();
  await until(() => downloadedAtBothRequests !== null, 'actual TCP requests reach both the header and final index piece');
  assert.ok(downloadedAtBothRequests < file.length, 'both ends are requested while the selected video itself is still incomplete');
  await engine.updateSettings({ downloadLimit: 0 });
  await until(() => work.bytes === work.totalTarget && work.streams.size === 0, 'the bounded original video reads complete');
  const sorted = reads.toSorted((a, b) => a.start - b.start);
  assert.equal(sorted[0].start, 0);
  for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i].start, sorted[i - 1].end + 1, 'each prefetch range starts after the preceding range, with no duplicate bytes');
  assert.equal(sorted.at(-1).end, file.length - 1);
  assert.equal(sorted.reduce((sum, range) => sum + range.end - range.start + 1, 0), file.length);
  assert.equal(engine.snapshot().tasks[0].speedDiagnosis.metrics.playbackPrioritized, true);
  engine.cancelPrefetch(id);
  assert.equal(torrent.strategy, 'rarest', 'cancelling playback restores normal download scheduling');
  assert.equal(engine.snapshot().tasks[0].speedDiagnosis.metrics.playbackPrioritized, false);
});
