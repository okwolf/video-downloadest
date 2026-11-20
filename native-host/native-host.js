import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createCaptureStore } from './capture-store.js';

const maxMessageBytes = 64 * 1024 * 1024;
const dataDirectory = path.resolve(process.env.VIDEO_DOWNLOADEST_DATA_DIR || '.');
const logPath = process.env.VIDEO_DOWNLOADEST_LOG_PATH;
let log = process.stderr;
if (logPath) {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  log = createWriteStream(logPath, { flags: 'a' });
}
const writeLog = (...values) => log.write(`${new Date().toISOString()} ${values.map(value => value instanceof Error ? value.stack || value.message : String(value)).join(' ')}${os.EOL}`);
console.log = writeLog;
console.warn = writeLog;
console.error = writeLog;

const store = createCaptureStore(dataDirectory);
const incoming = new Map();
let input = Buffer.alloc(0);
let chain = Promise.resolve();

function validId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

function keyOf(message) {
  return `${message.captureId}\0${message.streamId}\0${message.index}`;
}

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > 1024 * 1024) throw new Error('Native Messaging response exceeded Chrome’s message limit.');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

async function handle(message) {
  if (!message || typeof message !== 'object' || typeof message.requestId !== 'string') {
    throw new Error('Invalid Native Messaging request.');
  }
  switch (message.kind) {
    case 'ping':
      return { ready: true };
    case 'chunk-begin': {
      const { captureId, streamId, index, type, byteLength } = message;
      if (!validId(captureId) || !validId(streamId) || !Number.isSafeInteger(index) || index < 0 ||
          typeof type !== 'string' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
        throw new Error('Invalid media chunk metadata.');
      }
      const key = keyOf(message);
      if (incoming.has(key)) throw new Error('This media chunk is already being transferred.');
      const directory = path.join(dataDirectory, 'parts', '.native-host');
      await fs.mkdir(directory, { recursive: true });
      const filename = path.join(directory, `${randomUUID()}.part`);
      const handle = await fs.open(filename, 'wx');
      incoming.set(key, { filename, handle, offset: 0, byteLength, captureId, streamId, index, type });
      return { accepted: true };
    }
    case 'chunk-data': {
      const { captureId, streamId, index, offset, data, final } = message;
      if (!validId(captureId) || !validId(streamId) || !Number.isSafeInteger(index) ||
          !Number.isSafeInteger(offset) || typeof data !== 'string' || typeof final !== 'boolean') {
        throw new Error('Invalid media chunk data.');
      }
      const key = keyOf(message);
      const part = incoming.get(key);
      if (!part || offset !== part.offset) throw new Error('Media chunk data arrived out of order.');
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length === 0 && !final) throw new Error('Empty media chunk fragment.');
      if (part.offset + bytes.length > part.byteLength) throw new Error('Media chunk exceeded its declared size.');
      let written = 0;
      while (written < bytes.length) {
        const result = await part.handle.write(bytes, written, bytes.length - written, part.offset + written);
        written += result.bytesWritten;
      }
      part.offset += bytes.length;
      if (!final) return { received: part.offset };
      if (part.offset !== part.byteLength) throw new Error('Media chunk ended before all bytes arrived.');
      incoming.delete(key);
      await part.handle.close();
      try {
        await store.upload(part.captureId, part.streamId, part.index, part.type, createReadStream(part.filename));
      } finally {
        await fs.rm(part.filename, { force: true });
      }
      console.log(`Received ${part.captureId}/${part.streamId} [${part.index}]`);
      return { uploaded: true };
    }
    case 'complete': {
      if (!validId(message.captureId)) throw new Error('Invalid capture ID.');
      const file = await store.complete(message.captureId, {
        streams: message.streams,
        metadata: message.metadata
      });
      console.log(`Saved ${file}`);
      return { file };
    }
    default:
      throw new Error('Unknown Native Messaging request.');
  }
}

async function processFrame(frame) {
  let message;
  try {
    message = JSON.parse(frame.toString('utf8'));
    const result = await handle(message);
    send({ requestId: message.requestId, ...result });
  } catch (error) {
    if (message?.requestId) send({
      requestId: message.requestId,
      error: error.message || String(error),
      retryable: error.status === 503 || !error.status || error.status >= 500
    });
    console.error(error);
    if (message?.kind === 'chunk-data' && validId(message.captureId) && validId(message.streamId)) {
      const key = keyOf(message);
      const part = incoming.get(key);
      if (part) {
        incoming.delete(key);
        await part.handle.close().catch(() => {});
        await fs.rm(part.filename, { force: true }).catch(() => {});
      }
    }
  }
}

process.stdin.on('data', data => {
  input = Buffer.concat([input, data]);
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (length > maxMessageBytes) {
      console.error(`Rejected oversized Native Messaging frame (${length} bytes).`);
      process.exit(1);
      return;
    }
    if (input.length < length + 4) break;
    const frame = input.subarray(4, length + 4);
    input = input.subarray(length + 4);
    chain = chain.then(() => processFrame(frame));
  }
});

process.stdin.on('end', async () => {
  await chain;
  for (const part of incoming.values()) {
    await part.handle.close().catch(() => {});
    await fs.rm(part.filename, { force: true }).catch(() => {});
  }
});
