import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import bencode from 'bencode';
import TrackerClient from 'bittorrent-tracker/client';
import { createTrackerRequest, installTrackerCompatibility } from '../src/tracker-compat.mjs';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const valid = Buffer.from(bencode.encode({ interval: 600, complete: 1, incomplete: 2, peers: Buffer.from([127, 0, 0, 1, 0x1a, 0xe1]) }));
async function fixture(t, handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const clients = [];
  t.after(async () => {
    for (const client of clients) if (!client.destroyed) await new Promise(resolve => client.destroy(resolve));
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/announce`;
  return {
    url, server,
    client(options, overrides = {}) {
      const client = new TrackerClient({ infoHash: randomBytes(20), peerId: randomBytes(20), port: 6881, announce: [url], wrtc: false, ...overrides });
      clients.push(client);
      client.setInterval(0);
      if (options) client._trackers[0]._request = createTrackerRequest(options);
      return client;
    }
  };
}

test('adapter installs idempotently and real HTTP announce keeps binary query bytes and emits peers', { timeout: 5000 }, async t => {
  const result = await installTrackerCompatibility();
  assert.deepEqual(result, await installTrackerCompatibility());
  assert.equal(result.version, '11.2.3');
  let received;
  const local = await fixture(t, (request, response) => {
    received = request.url;
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end(valid);
  });
  const client = local.client();
  const warnings = [];
  client.on('warning', error => warnings.push(error));
  const update = once(client, 'update'), peer = once(client, 'peer');
  client.start({ left: 1 });
  assert.equal((await update)[0].complete, 1);
  assert.equal((await peer)[0], '127.0.0.1:6881');
  const rawHash = received.match(/[?&]info_hash=([^&]*)/)[1];
  const actualHash = Buffer.from(rawHash.replace(/%([a-f0-9]{2})/gi, (_, byte) => String.fromCharCode(Number.parseInt(byte, 16))), 'latin1');
  assert.deepEqual(actualHash, Buffer.from(client._infoHashBuffer));
  assert.equal(client._trackers[0].cleanupFns.length, 0);
  assert.deepEqual(warnings, []);
});

test('real HTTP scrape retains compatible bencoded statistics response', { timeout: 5000 }, async t => {
  await installTrackerCompatibility();
  let received;
  const local = await fixture(t, (request, response) => {
    received = request.url;
    response.end(Buffer.from(bencode.encode({ files: { ['A'.repeat(20)]: { complete: 2, incomplete: 3, downloaded: 4 } } })));
  });
  const client = local.client(undefined, { infoHash: Buffer.alloc(20, 65) });
  const scraped = once(client, 'scrape');
  client.scrape();
  const [result] = await scraped;
  assert.ok(received.startsWith('/scrape?'));
  assert.equal(result.infoHash, '41'.repeat(20));
  assert.equal(result.complete, 2);
  assert.equal(result.incomplete, 3);
  assert.equal(result.downloaded, 4);
  assert.equal(client._trackers[0].cleanupFns.length, 0);
});

test('headers followed by a truncated body produce one warning and release request cleanup', { timeout: 5000 }, async t => {
  await installTrackerCompatibility();
  const local = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Length': valid.length + 200 });
    response.flushHeaders();
    response.write(valid.subarray(0, 5));
    setTimeout(() => response.destroy(), 20);
  });
  const client = local.client({ timeoutMs: 500 });
  const warnings = [];
  client.on('warning', error => warnings.push(error));
  const warned = once(client, 'warning');
  client.start({ left: 1 });
  await warned;
  await delay(30);
  assert.equal(warnings.length, 1);
  assert.equal(client._trackers[0].cleanupFns.length, 0);
});

test('concurrent close during streamed HTTP bodies aborts cleanly without late callbacks or rejections', { timeout: 6000 }, async t => {
  await installTrackerCompatibility();
  let received = 0;
  const local = await fixture(t, (_request, response) => {
    received++;
    response.writeHead(200, { 'Content-Length': 4096 });
    response.flushHeaders();
    response.write('d5:peers');
  });
  const client = local.client({ timeoutMs: 4000 });
  const tracker = client._trackers[0];
  const warnings = [];
  client.on('warning', error => warnings.push(error));
  client.start({ left: 1 });
  client.update({ left: 1 });
  const deadline = Date.now() + 2000;
  while (received !== 2 && Date.now() < deadline) await delay(10);
  assert.equal(received, 2);
  await new Promise(resolve => client.destroy(resolve));
  await delay(50);
  assert.equal(tracker.cleanupFns.length, 0);
  assert.equal(tracker.maybeDestroyCleanup, null);
  assert.deepEqual(warnings, [], 'teardown aborts do not reach the closed client');
  // node:test fails this test/process automatically for unhandled promise
  // rejections; no process-level swallowing or rejection listener is installed.
});

test('tracker response deadline and both declared/chunked size caps clean up once', { timeout: 5000 }, async t => {
  await installTrackerCompatibility();
  let mode = 'timeout';
  const local = await fixture(t, (_request, response) => {
    if (mode === 'declared') {
      response.writeHead(200, { 'Content-Length': 4096 });
      response.flushHeaders();
    } else if (mode === 'chunked') {
      response.writeHead(200);
      response.end(Buffer.alloc(2048));
    } else {
      response.writeHead(200);
      response.flushHeaders();
      response.write('d5:peers');
    }
  });
  const client = local.client({ timeoutMs: 60, maxResponseBytes: 1024 });
  const tracker = client._trackers[0];
  for (const [selected, code] of [['timeout', 'ERR_TRACKER_TIMEOUT'], ['declared', 'ERR_TRACKER_BODY_LIMIT'], ['chunked', 'ERR_TRACKER_BODY_LIMIT']]) {
    mode = selected;
    let count = 0, failure;
    await tracker._request(local.url, { left: 1 }, error => { count++; failure = error; });
    assert.equal(count, 1);
    assert.equal(failure.code, code);
    assert.equal(tracker.cleanupFns.length, 0);
  }
});

test('HTTP failures and malformed bencode return one callback without retaining cleanup', { timeout: 5000 }, async t => {
  await installTrackerCompatibility();
  let mode = 'status';
  const local = await fixture(t, (_request, response) => {
    if (mode === 'status') { response.writeHead(503); response.end('Unavailable'); }
    else response.end('invalid bencode');
  });
  const client = local.client({ timeoutMs: 500 });
  const tracker = client._trackers[0];
  for (mode of ['status', 'bencode']) {
    let calls = 0;
    await tracker._request(local.url, {}, error => { calls++; assert.ok(error instanceof Error); });
    assert.equal(calls, 1);
    assert.equal(tracker.cleanupFns.length, 0);
  }
});
