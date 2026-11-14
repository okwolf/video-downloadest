async function uploadWithRetry(url, options) {
  const attempts = 4;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      const error = new Error(await response.text());
      error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw error;
    } catch (error) {
      if (error.retryable === false || attempt === attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

// The extension iframe owns the queue for the lifetime of the player page.
function connectUploadPort(port) {
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
      let response;
      if (data.kind === 'chunk') {
        response = await uploadWithRetry(`http://localhost:3000/captures/${captureId}/streams/${encodeURIComponent(data.streamId)}/${data.index}`, {
          method: 'POST', headers: {
            'content-type': data.type,
            'x-capture-metadata': encodeURIComponent(JSON.stringify({
              title: String(data.metadata?.title || '').slice(0, 256),
              videoType: data.metadata?.videoType
            }))
          }, body: data.buffer
        });
      } else if (data.kind === 'complete') {
        response = await uploadWithRetry(`http://localhost:3000/captures/${captureId}/complete`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ streams: data.streams, metadata: data.metadata })
        });
      } else return;
      if (!response.ok) throw new Error(await response.text());
      if (data.kind === 'complete') {
        port.postMessage({ captureId, ...await response.json() });
        reportedFailures.delete(captureId);
      }
    }).finally(() => { queuedBytes -= bytes; });
    const queued = pending.catch(error => {
      if (data.kind === 'chunk') failedUploads.add(captureId);
      // Completion may be retried after its retry budget is exhausted, but never
      // recover a failed chunk queue and accidentally finalize a partial capture.
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
}

let connecting = false;
window.onmessage = async (event) => {
  const secret = new URLSearchParams(location.search).get('secret');
  if (connecting || event.source !== parent || event.data !== secret || !event.ports[0]) return;
  connecting = true;
  const key = `upload-port-${secret}`;
  try {
    const stored = await chrome.storage.local.get(key);
    if (!(stored[key] > Date.now())) { connecting = false; return; }
    await chrome.storage.local.remove(key);
    window.onmessage = null;
    connectUploadPort(event.ports[0]);
    event.ports[0].postMessage({ ready: true });
  } catch {
    connecting = false;
  }
};
