import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRange } from '../src/stream-server.mjs';
import { validateMagnet, validateFiles } from '../src/core.mjs';
import path from 'node:path';

test('HTTP Range supports seeking, suffixes and rejects malformed requests', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange('bytes=0-0', 100), { start: 0, end: 0 });
  assert.deepEqual(parseRange('bytes=40-', 100), { start: 40, end: 99 });
  assert.deepEqual(parseRange('bytes=90-200', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-20', 100), { start: 80, end: 99 });
  assert.deepEqual(parseRange('bytes=-200', 100), { start: 0, end: 99 });
  for (const value of ['bytes=100-', 'bytes=50-40', 'bytes=0-1,5-9', 'bytes=-0', 'bytes=-', 'bytes=999999999999999999-', 'garbage']) assert.throws(() => parseRange(value, 100));
  assert.throws(() => parseRange('bytes=0-', 0));
});
test('magnet validation handles supported hashes and rejects paths, URLs and v2 only', () => {
  const valid = 'magnet:?xt=urn:btih:' + 'a'.repeat(40);
  assert.equal(validateMagnet('  ' + valid + '  '), valid);
  assert.ok(validateMagnet('magnet:?xt=urn:btih:' + 'A'.repeat(32)));
  for (const value of ['https://example.com/video', 'C:/file.torrent', 'magnet:?xt=urn:btmh:1220abc', 'magnet:?xt=urn:btih:bad', null]) assert.throws(() => validateMagnet(value));
});
test('torrent paths are confined to their task directory', () => {
  const root = path.resolve('test-downloads');
  validateFiles([{ path: 'Movie/video.mp4' }], root);
  for (const name of ['../escape.mp4', '/absolute.mp4', 'C:\\escape.mp4', 'video.mp4:stream', 'a/../../escape.mp4']) assert.throws(() => validateFiles([{ path: name }], root));
  assert.throws(() => validateFiles([{ path: 'Movie.mp4' }, { path: 'movie.mp4' }], root));
});
