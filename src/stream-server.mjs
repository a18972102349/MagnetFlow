import http from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export function parseRange(header, length) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || !length) throw new Error('Invalid range');
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new Error('Invalid range');
    start = Math.max(0, length - suffix);
    end = length - 1;
  } else {
    start = Number(match[1]);
    const requestedEnd = match[2] ? Number(match[2]) : length - 1;
    if (!Number.isSafeInteger(requestedEnd)) throw new Error('Invalid range');
    end = Math.min(requestedEnd, length - 1);
  }
  if (!Number.isSafeInteger(start) || start < 0 || start >= length || end < start) throw new Error('Invalid range');
  return { start, end };
}

const types = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.flac': 'audio/flac', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.ts': 'video/mp2t' };
export class StreamServer {
  constructor(engine, { transcoder = null } = {}) {
    this.engine = engine;
    this.transcoder = transcoder;
    this.token = randomBytes(32).toString('hex');
    this.streams = new Map();
    this.server = http.createServer((req, res) => this.handle(req, res).catch(() => {
      if (!res.headersSent) { res.writeHead(503); res.end('Stream unavailable'); } else res.destroy();
    }));
    this.server.requestTimeout = 0;
    this.invalidate = id => { for (const response of this.streams.get(id) || []) response.destroy(); this.transcoder?.cancel(id); };
    engine.on('invalidate', this.invalidate);
  }
  async listen() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    this.host = `127.0.0.1:${this.port}`;
    return this;
  }
  url(id, index) { return `http://${this.host}/stream/${this.token}/${id}/${index}`; }
  compatUrl(id, index, start = 0) { return `http://${this.host}/transcode/${this.token}/${id}/${index}?start=${encodeURIComponent(start)}`; }
  async handle(req, res) {
    const pathname = req.url?.split('?')[0];
    const match = /^\/(?:stream|transcode)\/([a-f0-9]{64})\/([a-f0-9]{40})\/(\d+)$/.exec(pathname || '');
    if (req.headers.host !== this.host || !match || match[1] !== this.token) { res.writeHead(403); return res.end('Forbidden'); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    const id = match[2];
    const file = await this.engine.mediaFile(id, Number(match[3]));
    if (res.destroyed) return;
    if (pathname.startsWith('/transcode/')) {
      if (!this.transcoder) { res.writeHead(503); res.end('Compatibility playback unavailable'); return; }
      const start = Number(new URL(req.url, `http://${this.host}`).searchParams.get('start') || '0');
      return this.transcoder.serve(req, res, { inputUrl: this.url(id, Number(match[3])), startSeconds: start, key: id, expectedOrigin: `http://${this.host}`, expectedToken: this.token });
    }
    let range;
    try { range = parseRange(req.headers.range, file.length); } catch { res.writeHead(416, { 'Content-Range': `bytes */${file.length}` }); return res.end(); }
    const { start, end } = range || { start: 0, end: file.length - 1 };
    const headers = {
      'Accept-Ranges': 'bytes', 'Content-Type': types[path.extname(file.name).toLowerCase()] || 'application/octet-stream',
      'Content-Length': Math.max(0, end - start + 1), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${file.length}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || !file.length) return res.end();
    this.engine.preparePlayback?.(id, Number(match[3]), start).catch(() => {});
    // WebTorrent treats end=0 as unspecified. Read at most two bytes in that
    // special case, and bound every response to the declared Range length.
    const stream = file.createReadStream({ start, end: Math.max(1, end) });
    let remaining = end - start + 1;
    let nextPrefetch = start + 2 * 1024 * 1024;
    if (!this.streams.has(id)) this.streams.set(id, new Set());
    this.streams.get(id).add(res);
    // Backpressure bounds memory; destroying a seek's old stream removes its piece selection.
    res.setTimeout(120000, () => res.destroy());
    res.once('close', () => {
      stream.destroy();
      const streams = this.streams.get(id);
      streams?.delete(res);
      if (!streams?.size) this.streams.delete(id);
    });
    stream.on('error', () => res.destroy());
    res.on('drain', () => stream.resume());
    stream.on('data', chunk => {
      if (res.destroyed) return;
      const data = chunk.subarray(0, remaining);
      remaining -= data.length;
      const position = end + 1 - remaining;
      if (position >= nextPrefetch && remaining > 0) {
        nextPrefetch = position + 2 * 1024 * 1024;
        this.engine.preparePlayback?.(id, Number(match[3]), position).catch(() => {});
      }
      if (!res.write(data)) stream.pause();
      if (!remaining) { stream.destroy(); res.end(); }
    });
    stream.once('end', () => { if (remaining) res.destroy(); else res.end(); });
  }
  async close() {
    this.engine.off('invalidate', this.invalidate);
    this.transcoder?.close();
    for (const id of this.streams.keys()) this.invalidate(id);
    this.server.closeAllConnections();
    await new Promise(resolve => this.server.close(resolve));
  }
}
