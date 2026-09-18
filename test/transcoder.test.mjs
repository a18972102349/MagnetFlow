import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { MediaTranscoder, validateTranscodeInput, validateStartSeconds, transcodeArguments, resolveMediaBinary } from '../src/media-transcoder.mjs';

const run = promisify(execFile);
const token = 'a'.repeat(64);
const hash = 'b'.repeat(40);
const pathname = `/stream/${token}/${hash}/0`;
const input = `http://127.0.0.1:54321${pathname}`;
const exists = new MediaTranscoder().availability().available;

test('transcoder accepts only canonical authorized loopback media routes', () => {
  assert.equal(validateTranscodeInput(input).href, input);
  for (const value of [
    'file:///C:/Windows/system.ini', 'https://example.com/video.mp4',
    `http://localhost:54321${pathname}`, `http://127.1:54321${pathname}`,
    `http://2130706433:54321${pathname}`, `${input}?x=1`, `${input}#secret`,
    `http://user:pass@127.0.0.1:54321${pathname}`, `http://127.0.0.1:54321/other${pathname}`,
    `${input}/../0`, `concat:${input}|file:///secret`, '', null
  ]) assert.throws(() => validateTranscodeInput(value));
  assert.throws(() => validateTranscodeInput(input, { expectedOrigin: 'http://127.0.0.1:12345' }));
  assert.throws(() => validateTranscodeInput(input, { expectedToken: 'c'.repeat(64) }));
  for (const value of [-1, Infinity, NaN, '1; echo unsafe', null, 604801]) assert.throws(() => validateStartSeconds(value));
  assert.equal(validateStartSeconds(12.3456), 12.346);
  const args = transcodeArguments(input, 12.5);
  assert.equal(args[args.indexOf('-i') + 1], input);
  assert.equal(args[args.indexOf('-ss') + 1], '12.5');
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'http,tcp');
  assert.ok(!args[args.indexOf('-format_whitelist') + 1].includes('hls'));
});

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

test('missing compatibility runtime returns a useful 503 without spawning', async () => {
  const media = new MediaTranscoder({ binaryPath: path.join(os.tmpdir(), 'magnetflow-missing-ffmpeg.exe') });
  const server = http.createServer((req, res) => media.serve(req, res, { inputUrl: input }));
  const base = await listen(server);
  try { const response = await fetch(base); assert.equal(response.status, 503); await response.text(); }
  finally { media.close(); await close(server); }
});

test('bundled FFmpeg transcodes an incompatible file and restarts at a requested time', { skip: !exists, timeout: 40000 }, async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'magnetflow-transcode-'));
  const media = new MediaTranscoder({ startupTimeoutMs: 10000 });
  const fixture = path.join(scratch, 'mpeg4-ac3.mkv');
  await run(media.binaryPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'mpeg4', '-c:a', 'ac3', '-y', fixture], { windowsHide: true });
  const bytes = await readFile(fixture);
  let rangeRequests = 0;
  const source = http.createServer((req, res) => {
    if (req.url !== pathname) { res.writeHead(404); return res.end(); }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    if (range) rangeRequests++;
    const headers = { 'Content-Type': 'video/x-matroska', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`;
    res.writeHead(range ? 206 : 200, headers); res.end(bytes.subarray(start, end + 1));
  });
  const origin = await listen(source);
  const server = http.createServer((req, res) => media.serve(req, res, { inputUrl: origin + pathname, startSeconds: Number(new URL(req.url, 'http://local').searchParams.get('start') || 0), expectedOrigin: origin, expectedToken: token, key: hash }));
  const base = await listen(server);
  try {
    for (const start of [0, 1.5]) {
      const response = await fetch(`${base}?start=${start}`, { headers: { Range: 'bytes=0-' } });
      assert.equal(response.status, 200, await (!response.ok ? response.text() : Promise.resolve('')));
      assert.equal(response.headers.get('content-type'), 'video/mp4');
      const output = Buffer.from(await response.arrayBuffer());
      assert.equal(output.subarray(4, 8).toString(), 'ftyp');
      assert.ok(output.includes(Buffer.from('moof')), 'fragmented MP4 is emitted');
      const filename = path.join(scratch, `output-${start}.mp4`);
      await writeFile(filename, output);
      const { stdout } = await run(resolveMediaBinary('ffprobe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename], { windowsHide: true });
      const probe = JSON.parse(stdout);
      assert.ok(probe.streams.some(stream => stream.codec_name === 'h264'));
      assert.ok(probe.streams.some(stream => stream.codec_name === 'aac'));
      assert.ok(Number(probe.format.duration) > 4 - start - 0.5);
      assert.ok(Number(probe.format.duration) < 4 - start + 0.5);
    }
    assert.ok(rangeRequests > 0, 'FFmpeg reads through HTTP Range');
    assert.equal(media.jobs.size, 0);
  } finally { media.close(); await close(server); await close(source); await rm(scratch, { recursive: true, force: true }); }
});

test('media decoder errors do not leak private tokens or open nested playlist URLs', { skip: !exists, timeout: 15000 }, async () => {
  const media = new MediaTranscoder({ startupTimeoutMs: 5000 });
  let nestedRequests = 0;
  let origin;
  const source = http.createServer((req, res) => {
    if (req.url === '/secret') { nestedRequests++; return res.end('secret'); }
    const playlist = `#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\n${origin}/secret\n#EXT-X-ENDLIST\n`;
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': Buffer.byteLength(playlist) }); res.end(playlist);
  });
  origin = await listen(source);
  const server = http.createServer((req, res) => media.serve(req, res, { inputUrl: origin + pathname }));
  const base = await listen(server);
  try {
    const response = await fetch(base);
    assert.equal(response.status, 422);
    assert.ok(!(await response.text()).includes(token));
    assert.equal(nestedRequests, 0);
    assert.equal(media.jobs.size, 0);
  } finally { media.close(); await close(server); await close(source); }
});

test('compatibility playback emits MP4 before a throttled source finishes downloading', { skip: !exists, timeout: 30000 }, async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'magnetflow-partial-media-'));
  const media = new MediaTranscoder({ startupTimeoutMs: 15000 });
  const fixture = path.join(scratch, 'partial.mkv');
  await run(media.binaryPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-t', '20', '-c:v', 'mpeg4', '-q:v', '2', '-y', fixture], { windowsHide: true });
  const bytes = await readFile(fixture);
  let delivered = 0;
  const source = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    let position = match ? Number(match[1]) : 0;
    const end = match && match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    const headers = { 'Content-Type': 'video/x-matroska', 'Content-Length': end - position + 1, 'Accept-Ranges': 'bytes' };
    if (match) headers['Content-Range'] = `bytes ${position}-${end}/${bytes.length}`;
    res.writeHead(match ? 206 : 200, headers);
    const timer = setInterval(() => {
      const chunk = bytes.subarray(position, Math.min(end + 1, position + 8192));
      delivered += chunk.length; position += chunk.length; res.write(chunk);
      if (position > end) { clearInterval(timer); res.end(); }
    }, 15);
    res.once('close', () => clearInterval(timer));
  });
  const origin = await listen(source);
  const server = http.createServer((req, res) => media.serve(req, res, { inputUrl: origin + pathname, key: hash }));
  const base = await listen(server);
  const abort = new AbortController();
  try {
    const response = await fetch(base, { signal: abort.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let output = Buffer.alloc(0);
    while (!output.includes(Buffer.from('moof'))) {
      const { value, done } = await reader.read();
      if (done) break;
      output = Buffer.concat([output, value]);
    }
    assert.ok(output.includes(Buffer.from('moof')), 'at least one playable fragment was emitted');
    assert.ok(delivered < bytes.length, `first fragment after ${delivered}/${bytes.length} source bytes`);
    abort.abort();
    for (let count = 0; count < 100 && media.jobs.size; count++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(media.jobs.size, 0);
  } finally { abort.abort(); media.close(); await close(server); await close(source); await rm(scratch, { recursive: true, force: true }); }
});

test('concurrency is bounded and cancelling playback releases the process slot', { skip: !exists, timeout: 15000 }, async () => {
  const media = new MediaTranscoder({ maxProcesses: 1, startupTimeoutMs: 10000 });
  const source = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Content-Length': 10000000 }); res.flushHeaders(); });
  const origin = await listen(source);
  const server = http.createServer((req, res) => media.serve(req, res, { inputUrl: origin + pathname, key: req.url }));
  const base = await listen(server);
  const abort = new AbortController();
  const first = fetch(`${base}/one`, { signal: abort.signal }).catch(() => null);
  try {
    for (let count = 0; count < 100 && !media.jobs.size; count++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(media.jobs.size, 1);
    const second = await fetch(`${base}/two`); assert.equal(second.status, 429); await second.text();
    abort.abort(); await first;
    for (let count = 0; count < 100 && media.jobs.size; count++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(media.jobs.size, 0);
    const seeks = new AbortController();
    const replacements = Array.from({ length: 4 }, () => fetch(`${base}/seek`, { signal: seeks.signal }).then(async response => { await response.text(); return response.status; }).catch(() => null));
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.ok(media.jobs.size <= 1);
    seeks.abort();
    const statuses = await Promise.all(replacements);
    assert.ok(!statuses.includes(429), 'rapid same-key seeks replace each other without exhausting the process slot');
    for (let count = 0; count < 100 && media.jobs.size; count++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(media.jobs.size, 0);
  } finally { abort.abort(); media.close(); await close(server); await close(source); }
});
