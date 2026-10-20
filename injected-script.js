const videoElements = [];
const captureDisplays = new Map();
const playerOverlays = new Map();
let overlayFrame;

function positionOverlays() {
  for (const [player, overlay] of playerOverlays) {
    if (!player.isConnected) {
      overlay.host.remove();
      playerOverlays.delete(player);
      continue;
    }
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && fullscreen !== player && fullscreen.contains(player)
      ? fullscreen : document.documentElement;
    if (overlay.host.parentNode !== parent) parent.appendChild(overlay.host);
    const rect = player.getBoundingClientRect();
    Object.assign(overlay.host.style, {
      display: rect.width > 0 && rect.height > 0 ? 'block' : 'none',
      left: `${rect.left + 8}px`, top: `${rect.top + 8}px`,
      width: `${Math.max(0, rect.width - 16)}px`, maxHeight: `${Math.max(0, rect.height - 16)}px`
    });
  }
  overlayFrame = playerOverlays.size ? requestAnimationFrame(positionOverlays) : undefined;
}

function showCapture(capture, player) {
  player ||= capture.player || videoElements.find(element =>
    [...(element.videoTracks || []), ...(element.audioTracks || [])].some(track => track.sourceBuffer?.capture === capture));
  if (!player?.isConnected) return;
  capture.player = player;
  let overlay = playerOverlays.get(player);
  if (!overlay) {
    // Video elements do not render child HTML; place a non-interactive overlay above them.
    const host = document.OGCreateElement('div');
    host.style.cssText = 'all:initial;position:fixed!important;z-index:2147483647!important;pointer-events:none!important;overflow:hidden!important;';
    const root = host.attachShadow({ mode: 'closed' });
    const text = document.OGCreateElement('div');
    text.style.cssText = 'box-sizing:border-box;padding:8px 10px;border-radius:6px;background:rgba(0,0,0,.78);color:white;font:12px/1.5 system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;';
    root.appendChild(text);
    overlay = { host, text };
    playerOverlays.set(player, overlay);
  }
  const rows = capture.buffers.map(buffer => buffer.progress).filter(Boolean);
  overlay.text.textContent = [capture.status || '📥 Capturing video', ...rows].join('\n');
  if (overlayFrame === undefined) positionOverlays();
}

document.addEventListener('VIDEO_CAPTURE_RESULT', ({ detail }) => {
  const capture = captureDisplays.get(detail.captureId);
  if (!capture) return;
  capture.status = detail.error ? `❌ Capture failed: ${detail.error}` : `✅ Saved: ${detail.file}`;
  showCapture(capture);
});
document.OGCreateElement = document.createElement;
document.createElement = function (...args) {
  const newElement = document.OGCreateElement(...args);
  if (newElement.tagName.toLowerCase() === "video") {
    newElement.videoId = crypto.randomUUID();
    newElement.videoTracks?.addEventListener("addtrack", (event) => {
      if (event.track.sourceBuffer) event.track.sourceBuffer.videoId = newElement.videoId;
    });
    newElement.addEventListener("ended", () => {
      const captures = new Set();
      for (const track of [...(newElement.videoTracks || []), ...(newElement.audioTracks || [])]) {
        if (track.sourceBuffer?.capture) captures.add(track.sourceBuffer.capture);
      }
      for (const capture of captures) finishCapture(capture, newElement);
    });
    videoElements.push(newElement);
  }
  return newElement;
};

function reportProgress(buffer, type, source) {
  const player = videoElements.find(element =>
    [...(element.videoTracks || []), ...(element.audioTracks || [])].some(track => track.sourceBuffer === buffer));
  const duration = Number.isFinite(player?.duration) && player.duration > 0 ? player.duration : source.duration;
  let bufferedSeconds = 0;
  for (let i = 0; i < buffer.buffered.length; i++) {
    bufferedSeconds += buffer.buffered.end(i) - buffer.buffered.start(i);
  }
  const percentage = Number.isFinite(duration) && duration > 0
    ? ` (${Math.min(100, bufferedSeconds / duration * 100).toFixed(1)}%)` : '';
  buffer.progress = `${type.split(";", 1)[0]}: ` +
    `${buffer.chunkCount} chunks, ${(buffer.capturedBytes / 1048576).toFixed(2)} MiB captured; ` +
    `${bufferedSeconds.toFixed(1)}s currently buffered${percentage}`;
  showCapture(buffer.capture, player);
}

function captureMetadata(capture, player = capture.player) {
  player ||= videoElements.find(element =>
    [...(element.videoTracks || []), ...(element.audioTracks || [])].some(track => track.sourceBuffer?.capture === capture));
  const title = navigator.mediaSession?.metadata?.title || player?.getAttribute('title') ||
    player?.getAttribute('aria-label') || document.querySelector('meta[property="og:title"]')?.content || document.title;
  return { title, pageURL: location.href,
    videoType: capture.buffers.find(buffer => buffer.bufferType.startsWith('video/'))?.bufferType };
}

function finishCapture(capture, player) {
  if (capture.completed || !capture.buffers.some(buffer => buffer.chunkCount)) return;
  capture.completed = true;
  capture.status ||= '⏳ Waiting for uploads and merge…';
  showCapture(capture, player);
  document.dispatchEvent(new CustomEvent("ON_BUFFER_ENDED", {
    detail: {
      captureId: capture.id,
      streams: capture.buffers.filter(buffer => buffer.chunkCount).map(buffer => ({ id: buffer.bufferId, count: buffer.chunkCount })),
      metadata: captureMetadata(capture, player)
    }
  }));
}

const OGMediaSource = window.MediaSource;
window.MediaSource = function (...args) {
  const newSource = new OGMediaSource(...args);
  const capture = { id: crypto.randomUUID(), buffers: [], completed: false };
  captureDisplays.set(capture.id, capture);
  const originalEnd = newSource.endOfStream;
  newSource.endOfStream = function (...args) {
    const result = originalEnd.apply(newSource, args);
    if (args[0] === undefined) {
      const player = videoElements.find(element =>
        [...(element.videoTracks || []), ...(element.audioTracks || [])].some(track => track.sourceBuffer?.capture === capture));
      finishCapture(capture, player);
    }
    return result;
  };
  newSource.OGaddSourceBuffer = newSource.addSourceBuffer;
  newSource.addSourceBuffer = function (...args) {
    const [bufferType] = args;
    const newBuffer = newSource.OGaddSourceBuffer(...args);
    newBuffer.ogAppendBuffer = newBuffer.appendBuffer;
    newBuffer.bufferId = crypto.randomUUID();
    newBuffer.capture = capture;
    newBuffer.bufferType = bufferType;
    newBuffer.chunkCount = 0;
    newBuffer.capturedBytes = 0;
    capture.buffers.push(newBuffer);
    let bufferIndex = -1;
    newBuffer.appendBuffer = function (...args) {
      const [buffer] = args;
      const copy = ArrayBuffer.isView(buffer)
        ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).slice().buffer
        : buffer.slice(0);
      const appendBufferResults = newBuffer.ogAppendBuffer(...args);
      if (capture.completed) return appendBufferResults;
      bufferIndex++;
      newBuffer.chunkCount++;
      newBuffer.capturedBytes += copy.byteLength;

      document.dispatchEvent(
        new CustomEvent("ON_APPEND_BUFFER", {
          detail: {
            captureId: capture.id,
            metadata: captureMetadata(capture),
            bufferId: newBuffer.bufferId,
            bufferType,
            bufferIndex,
            buffer: copy
          }
        })
      );
      return appendBufferResults;
    };
    newBuffer.addEventListener("updateend", () => {
      reportProgress(newBuffer, bufferType, newSource);
      if (newBuffer.buffered.length > 0) {
        const lastBufferIndex = newBuffer.buffered.length - 1;
        for (const videoElement of videoElements) {
          for (const videoTrack of (videoElement.videoTracks || [])) {
            if (videoTrack.sourceBuffer === newBuffer) {
              videoElement.currentTime =
                newBuffer.buffered.end(lastBufferIndex);
            }
          }
        }
      }
    });
    return newBuffer;
  };
  return newSource;
};
// Preserve native static methods (including non-enumerable ones) and instanceof.
Object.setPrototypeOf(window.MediaSource, OGMediaSource);
window.MediaSource.prototype = OGMediaSource.prototype;
