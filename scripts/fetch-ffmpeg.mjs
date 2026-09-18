// Reproducible optional media runtime download. No npm dependencies; Windows tar
// is part of Windows 10/11. The application never downloads executables at runtime.
import { mkdir, readFile, readdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(project, 'src', 'assets', 'ffmpeg');
const scratch = path.resolve(project, 'work', 'ffmpeg-runtime');
const release = '9.0.1';
const archiveName = `ffmpeg-${release}-essentials_build.7z`;
const url = `https://www.gyan.dev/ffmpeg/builds/packages/${archiveName}`;
const sha256 = '49a73bdf0850092a252ac4641d922f3048d63ed113e196cc65ce1e4f7fb33e85';
const archiveBytes = 34372199;
const sha = file => readFile(file).then(buffer => createHash('sha256').update(buffer).digest('hex'));

await mkdir(scratch, { recursive: true });
await mkdir(output, { recursive: true });
const archive = path.join(scratch, archiveName);
if (await sha(archive).catch(() => '') !== sha256) {
  console.log(`Downloading FFmpeg ${release} from the provider linked by ffmpeg.org...`);
  // Small bounded Range requests also work on networks which stall long HTTPS
  // responses. The assembled artifact still must match the pinned whole hash.
  const chunkBytes = 256 * 1024;
  const chunks = new Array(Math.ceil(archiveBytes / chunkBytes));
  let cursor = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (cursor < chunks.length) {
      const index = cursor++;
      const start = index * chunkBytes;
      const end = Math.min(archiveBytes, start + chunkBytes) - 1;
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(30000) });
          if (response.status !== 206 || new URL(response.url).hostname !== 'www.gyan.dev' || response.headers.get('content-range') !== `bytes ${start}-${end}/${archiveBytes}`) throw new Error('Unexpected FFmpeg Range response');
          const chunk = Buffer.from(await response.arrayBuffer());
          if (chunk.length !== end - start + 1) throw new Error('Truncated FFmpeg archive chunk');
          chunks[index] = chunk;
          if (index % 25 === 0) console.log(`Downloaded archive chunk ${index + 1}/${chunks.length}`);
          break;
        } catch (error) { if (attempt >= 2) throw error; }
      }
    }
  }));
  const bytes = Buffer.concat(chunks);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('FFmpeg SHA-256 verification failed');
  await writeFile(archive, bytes);
}
const { stdout: listing } = await run('tar', ['-tf', archive], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
const names = listing.split(/\r?\n/).filter(Boolean);
const prefix = `ffmpeg-${release}-essentials_build/`;
if (names.some(name => !name.startsWith(prefix) || name.includes('..') || name.includes('\\') || name.includes(':'))) throw new Error('Unsafe FFmpeg archive paths');
const unpack = path.join(scratch, 'unpacked');
await mkdir(unpack, { recursive: true });
await run('tar', ['-xf', archive, '-C', unpack], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
const source = path.join(unpack, prefix);
for (const name of ['ffmpeg.exe', 'ffprobe.exe']) await copyFile(path.join(source, 'bin', name), path.join(output, name));
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (entry.isFile() && /^(license|readme|copying)/i.test(entry.name)) await copyFile(path.join(source, entry.name), path.join(output, entry.name));
}
const sourceUrl = `https://ffmpeg.org/releases/ffmpeg-${release}.tar.xz`;
const sourceName = `ffmpeg-${release}-source.tar.xz`;
const sourceArchive = path.join(scratch, sourceName);
if (!(await readFile(sourceArchive).catch(() => null))) {
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(120000) });
  if (!response.ok || new URL(response.url).hostname !== 'ffmpeg.org') throw new Error('Unexpected FFmpeg source response');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 25 * 1024 * 1024 || bytes.length < 1000000) throw new Error('Unexpected FFmpeg source archive size');
  await writeFile(sourceArchive, bytes);
}
await copyFile(sourceArchive, path.join(output, sourceName));
const { stdout: version } = await run(path.join(output, 'ffmpeg.exe'), ['-version'], { windowsHide: true });
await writeFile(path.join(output, 'provenance.json'), JSON.stringify({
  component: 'FFmpeg', version: release, provider: 'Gyan Doshi',
  upstream: 'https://ffmpeg.org/download.html', providerPage: 'https://www.gyan.dev/ffmpeg/builds/',
  archive: url, archiveSha256: sha256,
  binarySha256: await sha(path.join(output, 'ffmpeg.exe')),
  probeSha256: await sha(path.join(output, 'ffprobe.exe')),
  license: 'GPL-3.0-or-later',
  source: 'https://github.com/FFmpeg/FFmpeg/commit/bf1b838f2a',
  sourceArchive: sourceUrl, includedSourceArchive: sourceName, includedSourceSha256: await sha(sourceArchive),
  notes: 'Separate command-line programs. Upstream LICENSE and README (including external library versions/build configuration) are included. Source and dependency license references are supplied by upstream.',
  buildConfiguration: version.trim()
}, null, 2) + '\n');
console.log(`Verified FFmpeg ${release}: ${path.join(output, 'ffmpeg.exe')}`);
