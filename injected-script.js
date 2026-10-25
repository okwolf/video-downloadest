(() => {
const videoElements = new Set();
const captureDisplays = new Map();
const selections = new WeakMap();
const playbackAllowed = new WeakMap();
const playerCleanups = new WeakMap();
const sourceCaptures = new WeakMap();
const objectSources = new Map();
const rootObservers = new Map();
const shadowRoots = new WeakMap();
const capturePreloadLimit = 64 * 1024 * 1024;
const pagePreloadLimit = 128 * 1024 * 1024;
let preloadBytes = 0;

function sourceKey(player) {
  return player.srcObject || player.getAttribute('src') || player.currentSrc || '';
}
function hasPlaybackGrant(player) {
  const source = playbackAllowed.get(player);
  const key = sourceKey(player);
  if (source === undefined || (source && source !== key)) return false;
  // A trusted play control can choose a source lazily. Bind that first choice
  // once loading supplies a source, without authorizing subsequent replacements.
  if (key) playbackAllowed.set(player, key);
  return true;
}
function captureForPlayer(player) {
  const key = sourceKey(player);
  if (key) return sourceCaptures.get(objectSources.get(key) || key);
  for (const track of [...(player.videoTracks || []), ...(player.audioTracks || [])]) {
    if (track.sourceBuffer?.capture) return track.sourceBuffer.capture;
  }
}
function playerForCapture(capture) {
  return [...videoElements].find(player => player.isConnected && captureForPlayer(player) === capture);
}
function resetSelection(player) {
  selections.delete(player);
  playbackAllowed.delete(player);
  if (!player.paused) player.pause();
  document.dispatchEvent(new CustomEvent('VIDEO_CAPTURE_RESET', { detail: { playerId: player.getAttribute('data-video-downloadest-id') } }));
}
function syncSelection(player) {
  const selection = selections.get(player);
  if (!selection) return;
  const capture = captureForPlayer(player);
  const key = sourceKey(player);
  if ((selection.capture && capture !== selection.capture) ||
      (selection.source && key !== selection.source)) {
    resetSelection(player);
    return;
  }
  if (capture) selection.capture = capture;
  if (key) selection.source = key;
  return selection;
}
function enabledCapture(capture) {
  if (capture.disposed || capture.completed) return false;
  const player = playerForCapture(capture);
  if (!player) return false;
  const selection = syncSelection(player);
  if (!selection || selection.capture !== capture) return false;
  capture.player = player;
  capture.sessionId = selection.sessionId;
  if (capture.preloadUnavailable) {
    capture.status = '❌ The preload cache filled before downloading was enabled. Reload this page and choose Download & play sooner.';
    showCapture(capture, player);
    return false;
  }
  return true;
}
function showCapture(capture, player = playerForCapture(capture)) {
  if (!player?.isConnected || !capture.sessionId) return;
  const rows = capture.buffers.map(buffer => buffer.progress).filter(Boolean);
  document.dispatchEvent(new CustomEvent('VIDEO_CAPTURE_STATUS', {
    detail: { player, sessionId: capture.sessionId, captureId: capture.id,
      text: [capture.status || '📥 Capturing video', ...rows].join('\n') }
  }));
}
function enableDownload(player, sessionId) {
  if (typeof sessionId !== 'string' || !player.isConnected) return;
  const capture = captureForPlayer(player);
  selections.set(player, { sessionId, capture, source: sourceKey(player) });
  if (capture && enabledCapture(capture)) {
    flushPreload(capture);
    showCapture(capture, player);
    if (capture.ended) finishCapture(capture, player);
  }
  Promise.resolve(player.play()).catch(error => {
    if (selections.get(player)?.sessionId !== sessionId) return;
    document.dispatchEvent(new CustomEvent('VIDEO_CAPTURE_STATUS', {
      detail: { player, sessionId, text: `❌ Playback could not start: ${error.message}. Use the player’s play button to retry.` }
    }));
  });
}

// A trusted gesture grants playback only to the video or unambiguous player
// container in its path. Document-wide userActivation is deliberately not used.
function gesturePlayer(event) {
  for (const element of event.composedPath()) {
    if (element.tagName?.toLowerCase() === 'video') return element;
    if (element === document || element === document.body || element === document.documentElement) break;
    const videos = element.querySelectorAll?.('video');
    if (videos?.length === 1) return videos[0];
    if (videos?.length > 1) break;
  }
}
function onGesture(event) {
  if (!event.isTrusted) return;
  if (event.type === 'keydown' && ![' ', 'Enter', 'k', 'MediaPlayPause'].includes(event.key)) return;
  const player = gesturePlayer(event);
  if (player) {
    registerPlayer(player);
    playbackAllowed.set(player, sourceKey(player));
  }
}
const nativePlay = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function (...args) {
  if (this.tagName?.toLowerCase() === 'video') {
    registerPlayer(this);
    if (!syncSelection(this) && !hasPlaybackGrant(this)) {
      const blocked = Promise.reject(new DOMException('Choose Download & play or use the player’s play control.', 'NotAllowedError'));
      blocked.catch(() => {});
      return blocked;
    }
  }
  return nativePlay.apply(this, args);
};
function announcePlayer(player) {
  document.dispatchEvent(new CustomEvent('VIDEO_CAPTURE_PLAYER', { detail: { playerId: player.getAttribute('data-video-downloadest-id') } }));
}
function registerPlayer(player) {
  if (!videoElements.has(player)) {
    videoElements.add(player);
    player.setAttribute('data-video-downloadest-id', crypto.randomUUID());
    const listeners = {
      play: () => {
        if (!syncSelection(player) && !hasPlaybackGrant(player)) player.pause();
      },
      pause: () => playbackAllowed.delete(player),
      emptied: () => {
        // A play() call may trigger initial loading. Keep an unbound first choice.
        syncSelection(player);
        for (const capture of captureDisplays.values()) {
          if (capture.player === player && captureForPlayer(player) !== capture) disposeCapture(capture);
        }
        if (!hasPlaybackGrant(player)) playbackAllowed.delete(player);
      },
      ended: () => {
        playbackAllowed.delete(player);
        const capture = captureForPlayer(player);
        if (capture) finishCapture(capture, player);
      },
      VIDEO_CAPTURE_ENABLE: event => enableDownload(player, event.detail?.sessionId)
    };
    for (const [name, callback] of Object.entries(listeners)) player.addEventListener(name, callback);
    playerCleanups.set(player, () => {
      for (const [name, callback] of Object.entries(listeners)) player.removeEventListener(name, callback);
    });
    announcePlayer(player);
  }
  syncSelection(player);
  const attachedCapture = captureForPlayer(player);
  if (attachedCapture) attachedCapture.player = player;
  if (player.hasAttribute('autoplay')) player.removeAttribute('autoplay');
  if (!player.paused && !selections.has(player) && !hasPlaybackGrant(player)) player.pause();
}
function disposeCapture(capture) {
  discardPreload(capture);
  capture.disposed = true;
  captureDisplays.delete(capture.id);
  sourceCaptures.delete(capture.source);
  for (const [url, source] of objectSources) if (source === capture.source) objectSources.delete(url);
  capture.player = undefined;
  capture.buffers.length = 0;
}
function cleanup() {
  for (const player of videoElements) {
    if (player.isConnected) continue;
    const capture = captureForPlayer(player);
    if (capture && !playerForCapture(capture)) disposeCapture(capture);
    resetSelection(player);
    playerCleanups.get(player)?.();
    playerCleanups.delete(player);
    videoElements.delete(player);
  }
  for (const [root, state] of rootObservers) {
    if (root === document) continue;
    if (root.host.isConnected) { state.connected = true; continue; }
    if (!state.connected) continue;
    state.observer.disconnect();
    for (const type of ['pointerdown', 'click', 'keydown']) root.removeEventListener(type, onGesture, true);
    rootObservers.delete(root);
  }
  // Also retire sources replaced while keeping the same video element.
  for (const capture of captureDisplays.values()) {
    if (capture.player && !playerForCapture(capture)) disposeCapture(capture);
  }
}
function discoverVideos(root = document) {
  for (const player of root.querySelectorAll('video')) registerPlayer(player);
  for (const element of root.querySelectorAll('*')) {
    const shadow = shadowRoots.get(element) || element.shadowRoot;
    if (shadow) observeRoot(shadow);
  }
}
function observeRoot(root) {
  if (rootObservers.has(root)) return;
  const observer = new MutationObserver(() => { discoverVideos(root); cleanup(); });
  rootObservers.set(root, { observer, connected: root === document || root.host.isConnected });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['autoplay', 'src'] });
  for (const type of ['pointerdown', 'click', 'keydown']) root.addEventListener(type, onGesture, true);
  discoverVideos(root);
}
const originalAttachShadow = Element.prototype.attachShadow;
Element.prototype.attachShadow = function (...args) {
  const root = originalAttachShadow.apply(this, args);
  shadowRoots.set(this, root);
  observeRoot(root); // Includes closed roots created after document_start.
  return root;
};
const originalCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = function (source) {
  const url = originalCreateObjectURL.call(this, source);
  if (sourceCaptures.has(source)) objectSources.set(url, source);
  return url;
};
const originalRevokeObjectURL = URL.revokeObjectURL;
URL.revokeObjectURL = function (url) {
  originalRevokeObjectURL.call(this, url);
  const source = objectSources.get(url);
  // Revoking a URL does not detach a player that already uses it.
  if (![...videoElements].some(player => player.isConnected && sourceKey(player) === url)) objectSources.delete(url);
  const capture = sourceCaptures.get(source);
  if (capture && !playerForCapture(capture) && ![...objectSources.values()].includes(source)) disposeCapture(capture);
};
document.addEventListener('VIDEO_CAPTURE_READY', () => {
  discoverVideos();
  for (const player of videoElements) announcePlayer(player);
});
function reportProgress(buffer, type, source) {
  const player = playerForCapture(buffer.capture);
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
  player ||= [...videoElements].find(element =>
    [...(element.videoTracks || []), ...(element.audioTracks || [])].some(track => track.sourceBuffer?.capture === capture));
  const title = navigator.mediaSession?.metadata?.title || player?.getAttribute('title') ||
    player?.getAttribute('aria-label') || document.querySelector('meta[property="og:title"]')?.content || document.title;
  return { title, pageURL: location.href,
    videoType: capture.buffers.find(buffer => buffer.bufferType.startsWith('video/'))?.bufferType };
}

function sendChunk(buffer, bytes) {
  const capture = buffer.capture;
  const index = buffer.chunkCount++;
  buffer.capturedBytes += bytes.byteLength;
  document.dispatchEvent(new CustomEvent('ON_APPEND_BUFFER', {
    detail: { sessionId: capture.sessionId, captureId: capture.id, metadata: captureMetadata(capture),
      bufferId: buffer.bufferId, bufferType: buffer.bufferType, bufferIndex: index, buffer: bytes }
  }));
}

function flushPreload(capture) {
  const pending = capture.preload;
  capture.preload = [];
  preloadBytes -= capture.preloadBytes;
  capture.preloadBytes = 0;
  for (const { buffer, bytes } of pending) sendChunk(buffer, bytes);
}

function discardPreload(capture) {
  preloadBytes -= capture.preloadBytes;
  capture.preloadBytes = 0;
  capture.preload = [];
  capture.preloadUnavailable = true;
}

function finishCapture(capture, player) {
  capture.ended = true;
  if (!enabledCapture(capture)) return;
  flushPreload(capture);
  if (!capture.buffers.some(buffer => buffer.chunkCount)) return;
  capture.completed = true;
  capture.status ||= '⏳ Waiting for uploads and merge…';
  showCapture(capture, player);
  document.dispatchEvent(new CustomEvent("ON_BUFFER_ENDED", {
    detail: {
      sessionId: capture.sessionId, captureId: capture.id,
      streams: capture.buffers.filter(buffer => buffer.chunkCount).map(buffer => ({ id: buffer.bufferId, count: buffer.chunkCount })),
      metadata: captureMetadata(capture, player)
    }
  }));
}

const OGMediaSource = window.MediaSource;
window.MediaSource = function (...args) {
  const newSource = new OGMediaSource(...args);
  const capture = { id: crypto.randomUUID(), buffers: [], completed: false, preload: [], preloadBytes: 0, ended: false };
  captureDisplays.set(capture.id, capture);
  sourceCaptures.set(newSource, capture);
  capture.source = newSource;
  newSource.addEventListener('sourceclose', () => {
    if (capture.disposed) return;
    if (capture.sessionId && !capture.completed) {
      capture.status = '❌ The media source closed before capture completed. Reload this page to try again.';
      showCapture(capture);
    }
    disposeCapture(capture);
  });
  const originalEnd = newSource.endOfStream;
  newSource.endOfStream = function (...args) {
    const result = originalEnd.apply(newSource, args);
    if (args[0] === undefined) {
      finishCapture(capture, playerForCapture(capture));
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
    newBuffer.appendBuffer = function (...args) {
      capture.player ||= playerForCapture(capture);
      const enabled = enabledCapture(capture);
      if (capture.disposed || capture.completed || capture.preloadUnavailable) return newBuffer.ogAppendBuffer(...args);
      const [buffer] = args;
      if (!enabled && (capture.preloadBytes + buffer.byteLength > capturePreloadLimit ||
          preloadBytes + buffer.byteLength > pagePreloadLimit)) {
        const result = newBuffer.ogAppendBuffer(...args);
        discardPreload(capture);
        capture.ended = false;
        return result;
      }
      // Copy before appendBuffer: the caller may reuse or detach the original bytes.
      const copy = ArrayBuffer.isView(buffer)
        ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).slice().buffer
        : buffer.slice(0);
      const result = newBuffer.ogAppendBuffer(...args);
      capture.ended = false;
      if (enabled) {
        flushPreload(capture);
        sendChunk(newBuffer, copy);
      } else {
        capture.preload.push({ buffer: newBuffer, bytes: copy });
        capture.preloadBytes += copy.byteLength;
        preloadBytes += copy.byteLength;
      }
      return result;
    };
    newBuffer.addEventListener("updateend", () => {
      if (!enabledCapture(capture)) return;
      flushPreload(capture);
      reportProgress(newBuffer, bufferType, newSource);
      if (newBuffer.buffered.length > 0) {
        const lastBufferIndex = newBuffer.buffered.length - 1;
        const player = playerForCapture(capture);
        if (bufferType.startsWith('video/') && player) {
          player.currentTime = newBuffer.buffered.end(lastBufferIndex);
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

observeRoot(document);
})();
