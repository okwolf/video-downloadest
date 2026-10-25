import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { spawn } from 'node:child_process';

const validId = /^[a-zA-Z0-9_-]{1,80}$/;
export function filename(title) {
  const sanitized = String(title || 'Untitled video').normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  let result = '', bytes = 0;
  // Filesystem component limits count bytes, and the capture ID also needs room.
  for (const character of sanitized) {
    bytes += Buffer.byteLength(character);
    if (bytes > 120) break;
    result += character;
  }
  return result.replace(/[. ]+$/g, '') || 'Untitled video';
}
function check(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { status: 400 });
}
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function validateMetadata(metadata = {}) {
  check(isRecord(metadata), 'Invalid capture metadata');
  check(metadata.title === undefined || typeof metadata.title === 'string', 'Invalid capture title');
  check(metadata.videoType === undefined || typeof metadata.videoType === 'string', 'Invalid video type');
  return metadata;
}
export function runFFmpeg(args, executable = process.env.FFMPEG_PATH || 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}: ${stderr}`)));
  });
}
function outputFormat(streams) {
  const types = [...streams.values()].map(stream => stream.type.split(';', 1)[0].trim().toLowerCase());
  const type = types.find(type => type.startsWith('video/')) || types[0];
  const formats = {
    'video/mp4': ['mp4', 'mp4'], 'audio/mp4': ['m4a', 'mp4'],
    'video/webm': ['webm', 'webm'], 'audio/webm': ['webm', 'webm'],
    'video/ogg': ['ogv', 'ogg'], 'audio/ogg': ['ogg', 'ogg'],
    'video/mp2t': ['ts', 'mpegts'], 'video/quicktime': ['mov', 'mov'],
    'video/x-matroska': ['mkv', 'matroska'], 'audio/x-matroska': ['mka', 'matroska'],
    'audio/mpeg': ['mp3', 'mp3'], 'audio/aac': ['aac', 'adts']
  };
  check(Object.hasOwn(formats, type), `Unsupported source container: ${type}`);
  return formats[type];
}
function captureFilename(id, title, streams) {
  const [extension] = outputFormat(streams);
  return `${filename(title)} [${id}].${extension}`;
}
export function createCaptureStore(root, mux = runFFmpeg) {
  const captures = new Map();
  function get(id) {
    check(typeof id === 'string' && validId.test(id), 'Invalid capture ID');
    if (!captures.has(id)) captures.set(id, { streams: new Map() });
    return captures.get(id);
  }
  function expectedFilename(id, metadata = {}) {
    const { title, videoType } = validateMetadata(metadata);
    const streams = new Map(get(id).streams);
    if (typeof videoType === 'string' && videoType.startsWith('video/')) {
      // A video buffer may already exist in the player before its first upload.
      streams.set('announced-video', { type: videoType });
    }
    try { return captureFilename(id, title, streams); }
    catch { return `${filename(title)} [${id}] (container unknown)`; }
  }
  async function upload(id, streamId, index, type, body) {
    const capture = get(id);
    check(typeof streamId === 'string' && validId.test(streamId), 'Invalid stream ID');
    check(Number.isSafeInteger(index) && index >= 0, 'Invalid chunk index');
    check(typeof type === 'string' && /^(audio|video)\/[^\s;]+(?:\s*;.*)?$/i.test(type), 'Invalid media type');
    check(!capture.finishing && !capture.output, 'Capture already completing');
    let stream = capture.streams.get(streamId);
    if (!stream) { stream = { type, parts: new Map() }; capture.streams.set(streamId, stream); }
    check(stream.type === type, 'Stream type changed');
    const existing = stream.parts.get(index);
    if (existing) {
      if (!existing.ready) throw Object.assign(new Error('Chunk still uploading or cleaning up'), { status: 503 });
      const hash = createHash('sha256');
      for await (const chunk of body) hash.update(chunk);
      check(hash.digest('hex') === existing.digest, 'Duplicate chunk has different bytes');
      return;
    }
    const directory = path.join(root, 'parts', id);
    const part = path.join(directory, `${streamId}.${index}`);
    stream.parts.set(index, { ready: false, path: part });
    try {
      await fs.mkdir(directory, { recursive: true });
      const hash = createHash('sha256');
      const checksum = new Transform({
        transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); }
      });
      await pipeline(body, checksum, createWriteStream(part, { flags: 'wx' }));
      stream.parts.get(index).digest = hash.digest('hex');
      stream.parts.get(index).ready = true;
    } catch (error) {
      // Keep the slot reserved until cleanup finishes so a retry cannot race unlink.
      // An exclusive-open failure may refer to a previous server's capture.
      if (error.code !== 'EEXIST') await fs.rm(part, { force: true });
      stream.parts.delete(index);
      throw error;
    }
  }
  async function complete(id, request = {}) {
    const capture = get(id);
    if (capture.output) return capture.output;
    if (capture.finishing) return capture.finishing;
    check(isRecord(request), 'Invalid completion request');
    const { streams, metadata = {} } = request;
    validateMetadata(metadata);
    check(Array.isArray(streams) && streams.length > 0, 'No streams');
    check(streams.every(stream => isRecord(stream) && typeof stream.id === 'string' && validId.test(stream.id)), 'Invalid stream manifest');
    check(new Set(streams.map(s => s.id)).size === streams.length && streams.length === capture.streams.size, 'Stream list mismatch');
    for (const { id: streamId, count } of streams) {
      const stream = capture.streams.get(streamId);
      check(stream && Number.isSafeInteger(count) && count > 0 && stream.parts.size === count, 'Missing chunks');
      for (let i = 0; i < count; i++) check(stream.parts.get(i)?.ready, 'Chunks still uploading or missing');
    }
    capture.finishing = assemble(id, capture, streams, metadata);
    try { capture.output = await capture.finishing; return capture.output; }
    finally { capture.finishing = null; }
  }
  async function assemble(id, capture, streams, metadata) {
    const [extension, format] = outputFormat(capture.streams);
    const directory = path.join(root, 'parts', id);
    const outputDirectory = path.join(root, 'buffers');
    await fs.mkdir(outputDirectory, { recursive: true });
    const inputs = [];
    for (const { id: streamId, count } of streams) {
      const input = path.join(directory, `${streamId}.media`);
      const handle = await fs.open(input, 'w');
      try {
        for (let i = 0; i < count; i++) {
          const source = createReadStream(capture.streams.get(streamId).parts.get(i).path);
          for await (const chunk of source) await handle.writeFile(chunk);
        }
      } finally { await handle.close(); }
      inputs.push(input);
    }
    const title = filename(metadata.title);
    const output = path.join(outputDirectory, captureFilename(id, metadata.title, capture.streams));
    const temporary = path.join(directory, `merged.${extension}`);
    await mux(['-hide_banner', '-loglevel', 'error', '-y', ...inputs.flatMap(input => ['-i', input]),
      ...inputs.flatMap((_, index) => ['-map', `${index}:v?`, '-map', `${index}:a?`]),
      '-c', 'copy', '-f', format, '-metadata', `title=${String(metadata.title || title)}`, temporary]);
    await fs.rename(temporary, output);
    // The committed output is valid even if removing temporary files fails.
    try { await fs.rm(directory, { recursive: true, force: true }); }
    catch (error) { console.warn(`Saved ${output}, but could not remove temporary files:`, error); }
    for (const stream of capture.streams.values()) stream.parts.clear();
    return output;
  }

  return { get, expectedFilename, upload, complete };
}
