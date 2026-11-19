const nativeHostName = 'com.videodownloadest.host';
const fragmentBytes = 16 * 1024 * 1024;

function randomId() {
  return crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, '0')).join('');
}

function connectNativeHost() {
  const host = chrome.runtime.connectNative(nativeHostName);
  const pending = new Map();
  host.onMessage.addListener(message => {
    const request = pending.get(message?.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    if (message.error) {
      const error = new Error(message.error);
      error.retryable = message.retryable === true;
      request.reject(error);
    }
    else request.resolve(message);
  });
  host.onDisconnect.addListener(() => {
    const error = new Error(chrome.runtime.lastError?.message || 'The native host disconnected.');
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  return {
    request(message) {
      const requestId = randomId();
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        try { host.postMessage({ ...message, requestId }); }
        catch (error) { pending.delete(requestId); reject(error); }
      });
    }
  };
}

function toBase64(bytes) {
  let binary = '';
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + stride));
  }
  return btoa(binary);
}

async function sendChunk(native, data) {
  const buffer = data.buffer instanceof ArrayBuffer
    ? new Uint8Array(data.buffer)
    : ArrayBuffer.isView(data.buffer)
      ? new Uint8Array(data.buffer.buffer, data.buffer.byteOffset, data.buffer.byteLength)
      : null;
  if (!buffer) throw new Error('The captured media chunk is not binary data.');
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await native.request({
        kind: 'chunk-begin', captureId: data.captureId, streamId: data.streamId,
        index: data.index, type: data.type, byteLength: buffer.byteLength
      });
      for (let offset = 0; offset < buffer.byteLength || (buffer.byteLength === 0 && offset === 0); offset += fragmentBytes) {
        const end = Math.min(buffer.byteLength, offset + fragmentBytes);
        const final = end === buffer.byteLength;
        await native.request({
          kind: 'chunk-data', captureId: data.captureId, streamId: data.streamId,
          index: data.index, offset, data: toBase64(buffer.subarray(offset, end)), final
        });
        if (final) break;
      }
      return;
    } catch (error) {
      if (error.retryable !== true || attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

async function completeCapture(native, data) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await native.request({
        kind: 'complete', captureId: data.captureId,
        streams: data.streams, metadata: data.metadata
      });
    } catch (error) {
      if (error.retryable !== true || attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

function connectUploadPort(port) {
  const native = connectNativeHost();
  const queues = new Map();
  const reportedFailures = new Set();
  const failedUploads = new Set();
  const queuedLimit = 128 * 1024 * 1024;
  let queuedBytes = 0;
  port.onmessage = ({ data: message }) => {
    const data = message.appendBuffer ? {
      kind: 'chunk', captureId: message.appendBuffer.captureId,
      streamId: message.appendBuffer.bufferId, index: message.appendBuffer.bufferIndex,
      metadata: message.appendBuffer.metadata,
      type: message.appendBuffer.bufferType, buffer: message.appendBuffer.buffer
    } : message.bufferEnd ? { ...message.bufferEnd, kind: 'complete' } : message;
    const { captureId } = data;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(captureId || '')) return;
    if (failedUploads.has(captureId)) return;
    const bytes = data.kind === 'chunk' ? data.buffer?.byteLength || 0 : 0;
    if (queuedBytes + bytes > queuedLimit) {
      failedUploads.add(captureId);
      reportedFailures.add(captureId);
      port.postMessage({ captureId, error: 'The upload queue filled. Reload the page and retry this video.' });
      return;
    }
    queuedBytes += bytes;
    const previous = queues.get(captureId) || Promise.resolve();
    const pending = previous.then(async () => {
      if (data.kind === 'chunk') {
        await sendChunk(native, {
          ...data,
          metadata: {
            title: String(data.metadata?.title || '').slice(0, 256),
            videoType: data.metadata?.videoType
          }
        });
      } else if (data.kind === 'complete') {
        const result = await completeCapture(native, { ...data, captureId });
        port.postMessage({ captureId, file: result.file });
        reportedFailures.delete(captureId);
      }
    }).finally(() => { queuedBytes -= bytes; });
    const queued = pending.catch(error => {
      if (data.kind === 'chunk') failedUploads.add(captureId);
      // Completion may be retried after its reply is lost, but never finalize a partial capture.
      if (failedUploads.has(captureId)) throw error;
    });
    queues.set(captureId, queued);
    queued.catch(() => {});
    pending.catch(error => {
      if (reportedFailures.has(captureId)) return;
      reportedFailures.add(captureId);
      port.postMessage({ captureId, error: error.message });
    });
  };
  return native.request({ kind: 'ping' });
}

let connecting = false;
window.onmessage = async event => {
  const secret = new URLSearchParams(location.search).get('secret');
  if (connecting || event.source !== parent || event.data !== secret || !event.ports[0]) return;
  connecting = true;
  const key = `upload-port-${secret}`;
  try {
    const stored = await chrome.storage.local.get(key);
    if (!(stored[key] > Date.now())) { connecting = false; return; }
    await chrome.storage.local.remove(key);
    await connectUploadPort(event.ports[0]);
    window.onmessage = null;
    event.ports[0].postMessage({ ready: true });
  } catch (error) {
    event.ports[0].postMessage({ ready: false, error: error.message });
    connecting = false;
  }
};
