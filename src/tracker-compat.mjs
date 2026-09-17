import fs from 'node:fs/promises';
import querystring from 'node:querystring';
import fetch from 'cross-fetch-ponyfill';
import bencode from 'bencode';

const SUPPORTED_VERSION = '11.2.3';
const PATCH = Symbol.for('magnetflow.tracker-http-compat.1');
let installation;

// Preserve BitTorrent's binary query encoding, matching the MIT-licensed
// bittorrent-tracker common.querystringStringify implementation. Standard
// URLSearchParams would UTF-8 encode info_hash / peer_id bytes incorrectly.
function encodeQuery(params) {
  return querystring.stringify(params, null, null, { encodeURIComponent: escape })
    .replace(/[@*/+]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function trackerError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function messageText(value) {
  return (ArrayBuffer.isView(value) ? Buffer.from(value).toString('utf8') : String(value)).slice(0, 500);
}

/** Factory is exported for isolated local-server testing with shorter deadlines. */
export function createTrackerRequest({ timeoutMs = 15000, maxResponseBytes = 1024 * 1024 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid tracker timeout.');
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 4 * 1024 * 1024) throw new Error('Invalid tracker response limit.');

  return async function request(requestUrl, params, callback) {
    if (this.destroyed) return;
    const controller = new AbortController();
    let cleaned = false, expired = false, failure, data, warning;
    let timer;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      const index = this.cleanupFns.indexOf(cleanup);
      if (index !== -1) this.cleanupFns.splice(index, 1);
      if (!controller.signal.aborted) controller.abort();
      // Cooperate with HTTPTracker.destroy's pending-request grace period.
      this.maybeDestroyCleanup?.();
    };
    this.cleanupFns.push(cleanup);
    timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
    timer.unref?.();
    try {
      const url = new URL(requestUrl + (requestUrl.includes('?') ? '&' : '?') + encodeQuery(params));
      let agent;
      if (this.client._proxyOpts) {
        agent = url.protocol === 'https:' ? this.client._proxyOpts.httpsAgent : this.client._proxyOpts.httpAgent;
        agent ||= this.client._proxyOpts.socksProxy;
      }
      const response = await fetch(url.href, {
        agent, dispatcher: agent, signal: controller.signal,
        headers: { 'user-agent': this.client._userAgent || '' }
      });
      if (response.status !== 200) throw trackerError(`Tracker returned HTTP ${response.status}: ${this.announceUrl}`, 'ERR_TRACKER_STATUS');
      const declaredSize = Number(response.headers.get('content-length'));
      if (declaredSize > maxResponseBytes) throw trackerError(`Tracker response exceeds ${maxResponseBytes} bytes.`, 'ERR_TRACKER_BODY_LIMIT');
      const chunks = [];
      let length = 0;
      // Both Node streams and native Fetch ReadableStreams support async
      // iteration. Network/body aborts stay inside this same try/catch, and
      // chunked/compressed responses cannot evade the byte limit.
      if (response.body) for await (const value of response.body) {
        const chunk = Buffer.from(value);
        length += chunk.length;
        if (length > maxResponseBytes) throw trackerError(`Tracker response exceeds ${maxResponseBytes} bytes.`, 'ERR_TRACKER_BODY_LIMIT');
        chunks.push(chunk);
      }
      if (!length) throw trackerError(`Tracker returned an empty response: ${this.announceUrl}`, 'ERR_TRACKER_EMPTY');
      data = bencode.decode(Buffer.concat(chunks, length));
      if (!data || typeof data !== 'object' || Array.isArray(data) || ArrayBuffer.isView(data)) throw trackerError('Tracker response is not a bencoded dictionary.', 'ERR_TRACKER_FORMAT');
      if (data['failure reason']) throw trackerError(messageText(data['failure reason']), 'ERR_TRACKER_FAILURE');
      if (data['warning message']) warning = trackerError(messageText(data['warning message']), 'ERR_TRACKER_WARNING');
    } catch (error) {
      failure = expired ? trackerError(`Tracker request timed out after ${timeoutMs} ms: ${this.announceUrl}`, 'ERR_TRACKER_TIMEOUT') : error;
    } finally {
      cleanup();
    }
    // A closed client no longer consumes callbacks. Live requests get exactly
    // one terminal callback, never separate stream-error and promise callbacks.
    if (this.destroyed || this.client.destroyed) return;
    if (warning) this.client.emit('warning', warning);
    callback(failure || null, failure ? undefined : data);
  };
}

/** Call once, before creating WebTorrent clients. No files or global handlers change. */
export async function installTrackerCompatibility() {
  if (installation) return installation;
  installation = (async () => {
    // Resolve through the package's public client entry so this also works from
    // Electron's app.asar and does not rely on a development-directory path.
    const clientUrl = import.meta.resolve('bittorrent-tracker/client');
    const manifest = JSON.parse(await fs.readFile(new URL('./package.json', clientUrl), 'utf8'));
    if (manifest.version !== SUPPORTED_VERSION) throw new Error(`HTTP Tracker compatibility adapter requires bittorrent-tracker ${SUPPORTED_VERSION}; installed ${manifest.version}. Revalidate the adapter before updating this dependency.`);
    const { default: HTTPTracker } = await import(new URL('./lib/client/http-tracker.js', clientUrl).href);
    if (typeof HTTPTracker?.prototype?._request !== 'function' || typeof HTTPTracker.prototype.destroy !== 'function') throw new Error('Unsupported HTTP Tracker implementation.');
    if (!HTTPTracker.prototype[PATCH]) {
      HTTPTracker.prototype._request = createTrackerRequest();
      Object.defineProperty(HTTPTracker.prototype, PATCH, { value: true });
    }
    return Object.freeze({ installed: true, version: manifest.version, timeoutMs: 15000, maxResponseBytes: 1024 * 1024 });
  })();
  try { return await installation; } catch (error) { installation = null; throw error; }
}
