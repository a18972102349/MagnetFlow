import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const formats = 'mov,matroska,webm,avi,mpegts,mpeg,asf,flv,ogg,mp3,wav,flac,aac,rm';
const MAX_SEEK_SECONDS = 7 * 24 * 60 * 60;

export function validateTranscodeInput(inputUrl, { expectedOrigin, expectedToken } = {}) {
  if (typeof inputUrl !== 'string' || inputUrl.length > 512) throw new Error('Invalid media input');
  let url;
  try { url = new URL(inputUrl); } catch { throw new Error('Invalid media input'); }
  const match = /^\/stream\/([a-f0-9]{64})\/([a-f0-9]{40})\/(\d{1,7})$/.exec(url.pathname);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || !match ||
      (expectedOrigin && url.origin !== expectedOrigin) || (expectedToken && match[1] !== expectedToken)) {
    throw new Error('Media input must be an authorized local stream');
  }
  // Do not accept URL-parser aliases such as encoded paths, decimal hosts or
  // dot segments that could bypass route checks performed by another caller.
  if (inputUrl !== url.href) throw new Error('Non-canonical media input');
  return url;
}

export function validateStartSeconds(value = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_SEEK_SECONDS) throw new Error('Invalid playback time');
  return Math.round(value * 1000) / 1000;
}

export function resolveMediaBinary(name = 'ffmpeg', explicitPath) {
  if (explicitPath) return path.resolve(explicitPath);
  const executable = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'ffmpeg', executable),
    path.join(here, 'assets', 'ffmpeg', executable)
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) || candidates[candidates.length - 1];
}

function childEnvironment() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(http|https|all|ftp)_proxy$/i.test(name)) delete env[name];
  env.no_proxy = '127.0.0.1';
  env.AV_LOG_FORCE_NOCOLOR = '1';
  return env;
}

export function transcodeArguments(inputUrl, startSeconds = 0) {
  validateTranscodeInput(inputUrl);
  const start = validateStartSeconds(startSeconds);
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    // Only ordinary media containers can be demuxed. Playlists, concat files,
    // image sequences, local files and nested network protocols are excluded.
    '-protocol_whitelist', 'http,tcp', '-format_whitelist', formats,
    '-rw_timeout', '120000000', '-probesize', '8388608', '-analyzeduration', '4000000',
    '-threads', String(Math.max(1, Math.min(4, availableParallelism()))),
    '-readrate', '1', '-readrate_initial_burst', '10',
    ...(start > 0 ? ['-ss', String(start)] : []), '-i', inputUrl,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-filter_threads', '1',
    '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '24',
    '-threads', String(Math.max(1, Math.min(4, availableParallelism()))),
    '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced*2)',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-af', 'aresample=async=1:first_pts=0',
    '-max_muxing_queue_size', '1024', '-avoid_negative_ts', 'make_zero',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '1000000', '-flush_packets', '1', '-f', 'mp4', 'pipe:1'
  ];
}

/** Bounded, cancellation-aware compatibility playback. No shell, temp video or
 * exposed filesystem input is involved. A seek creates a new fragmented MP4. */
export class MediaTranscoder {
  constructor({ binaryPath, maxProcesses = 1, startupTimeoutMs = 120000 } = {}) {
    this.binaryPath = resolveMediaBinary('ffmpeg', binaryPath);
    this.maxProcesses = Math.max(1, Math.min(4, Number(maxProcesses) || 1));
    this.startupTimeoutMs = Math.max(100, Number(startupTimeoutMs) || 120000);
    this.jobs = new Map();
    this.requests = new Map();
    this.closed = false;
  }

  availability() { return { available: existsSync(this.binaryPath), binaryPath: this.binaryPath }; }

  cancel(key) {
    const job = this.jobs.get(key);
    job?.cancel();
    return job?.done || Promise.resolve();
  }

  close() {
    this.closed = true;
    this.requests.clear();
    for (const job of this.jobs.values()) job.cancel();
  }

  async serve(req, res, { inputUrl, startSeconds = 0, key, expectedOrigin, expectedToken } = {}) {
    const url = validateTranscodeInput(inputUrl, { expectedOrigin, expectedToken });
    const start = validateStartSeconds(startSeconds);
    if (this.closed || !this.availability().available) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Compatibility playback runtime unavailable'); return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
    }
    const headers = { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'none' };
    // A browser commonly starts media loading with Range: bytes=0-. A newly
    // generated stream has no stable byte offsets; seek through startSeconds.
    if (req.headers.range && !/^bytes=0-$/.test(req.headers.range)) {
      res.writeHead(416, { 'Content-Type': 'text/plain' }); res.end('Restart compatibility playback at a time offset'); return;
    }
    if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
    const jobKey = key ?? url.pathname;
    const request = Symbol('playback');
    this.requests.set(jobKey, request);
    let cancelTimeout;
    await Promise.race([this.cancel(jobKey), new Promise(resolve => { cancelTimeout = setTimeout(resolve, 3000); cancelTimeout.unref?.(); })]);
    clearTimeout(cancelTimeout);
    if (this.requests.get(jobKey) !== request || this.closed) {
      if (!res.destroyed) { res.writeHead(409); res.end('Playback request superseded'); } return;
    }
    if (this.jobs.size >= this.maxProcesses) {
      if (this.requests.get(jobKey) === request) this.requests.delete(jobKey);
      res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '1' }); res.end('Compatibility playback is busy'); return;
    }
    if (res.destroyed) { if (this.requests.get(jobKey) === request) this.requests.delete(jobKey); return; }

    await new Promise(resolve => {
      const child = spawn(this.binaryPath, transcodeArguments(inputUrl, start), {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, env: childEnvironment()
      });
      let settled = false;
      let wroteOutput = false;
      let cancelled = false;
      let stderr = '';
      let killTimer;
      let resolveDone;
      const done = new Promise(resolve => { resolveDone = resolve; });
      const stop = () => {
        if (child.exitCode === null && !killTimer) {
          child.kill();
          killTimer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1500);
          killTimer.unref?.();
        }
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        res.off('close', onClose);
        res.off('drain', onDrain);
        resolve();
      };
      const fail = (status, message) => {
        if (settled) return;
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(message);
        } else if (!res.destroyed) res.destroy();
        stop(); finish();
      };
      const onClose = () => { cancelled = true; stop(); finish(); };
      const onDrain = () => child.stdout.resume();
      const job = { done, cancel: () => { cancelled = true; if (!res.destroyed) res.destroy(); stop(); finish(); } };
      const startupTimer = setTimeout(() => fail(504, 'Waiting for enough video data timed out; retry when more pieces are available'), this.startupTimeoutMs);
      startupTimer.unref?.();
      this.jobs.set(jobKey, job);
      res.once('close', onClose);
      res.on('drain', onDrain);
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
      child.stdout.on('error', () => fail(502, 'Compatibility playback output failed'));
      child.stdout.on('data', chunk => {
        if (res.destroyed || settled) return;
        if (!wroteOutput) {
          wroteOutput = true;
          clearTimeout(startupTimer);
          res.writeHead(200, headers);
        }
        if (!res.write(chunk)) child.stdout.pause();
      });
      child.once('error', () => fail(503, 'Compatibility playback runtime could not start'));
      child.once('close', code => {
        clearTimeout(killTimer);
        if (this.jobs.get(jobKey) === job) this.jobs.delete(jobKey);
        if (this.requests.get(jobKey) === request) this.requests.delete(jobKey);
        resolveDone();
        if (settled) return;
        if (!cancelled && code !== 0) {
          // Never reflect FFmpeg stderr: it contains the private input token and
          // may contain names controlled by the downloaded media.
          const message = /matches no streams|does not contain any stream/i.test(stderr)
            ? 'No playable video stream was found' : 'Video could not be decoded; retry after more data is downloaded';
          fail(422, message);
        } else if (!wroteOutput) fail(422, 'Video produced no playable frames');
        else { if (!res.destroyed) res.end(); finish(); }
      });
    });
  }
}
