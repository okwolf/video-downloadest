const videoElements = [];
const captureDisplays = new Map();
const playerOverlays = new Map();
let overlayFrame;
// Keep preloaded initialization/media chunks in memory, never upload before opt-in.
const capturePreloadLimit = 64 * 1024 * 1024;
const pagePreloadLimit = 128 * 1024 * 1024;
let preloadBytes = 0;

const enabledPlayers = new WeakSet();
const playbackAllowed = new WeakSet();
const sourceCaptures = new WeakMap();
const objectSources = new Map();
const createElement = document.createElement.bind(document);

function playerForCapture(capture) {
  return videoElements.find(player => {
    const source = objectSources.get(player.currentSrc) || objectSources.get(player.src) || player.srcObject;
    return sourceCaptures.get(source) === capture ||
      [...(player.videoTracks || []), ...(player.audioTracks || [])].some(track => track.sourceBuffer?.capture === capture);
  });
}

function enabledCapture(capture) {
  const player = playerForCapture(capture);
  if (!player || !enabledPlayers.has(player)) return false;
  capture.player = player;
  if (capture.preloadUnavailable) {
    capture.status = '❌ The preload cache filled before downloading was enabled. Reload this page and choose Download & play sooner.';
    showCapture(capture, player);
    return false;
  }
  return !capture.completed;
}

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
    const prompt = !enabledPlayers.has(player);
    overlay.button.hidden = !prompt;
    overlay.text.hidden = prompt;
    Object.assign(overlay.host.style, {
      display: rect.width > 0 && rect.height > 0 && (!prompt || player.paused || player.ended === true) ? 'block' : 'none',
      left: `${prompt ? rect.left + rect.width / 2 : rect.left + 8}px`,
      top: `${prompt ? rect.top + rect.height * 5 / 6 : rect.top + 8}px`,
      transform: prompt ? 'translate(-50%, -50%)' : 'none',
      width: prompt ? 'max-content' : `${Math.max(0, rect.width - 16)}px`,
      maxWidth: `${Math.max(0, rect.width - 16)}px`, maxHeight: `${Math.max(0, rect.height - 16)}px`
    });
  }
  overlayFrame = playerOverlays.size ? requestAnimationFrame(positionOverlays) : undefined;
}

function ensureOverlay(player) {
  if (!player.isConnected || playerOverlays.has(player)) return;
  // Video elements do not render child HTML; only the button receives pointer events.
  const host = createElement('div');
  host.style.cssText = 'all:initial;position:fixed!important;z-index:2147483647!important;pointer-events:none!important;overflow:hidden!important;';
  const root = host.attachShadow({ mode: 'closed' });
  const button = createElement('button');
  button.type = 'button';
  button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></svg><span>Download &amp; play</span>';
  const styles = createElement('style');
  styles.textContent = `
    button {
      box-sizing: border-box; display: inline-flex; align-items: center;
      justify-content: center; gap: 12px; max-width: 100%; min-height: 64px;
      padding: 16px 28px; border: 2px solid rgba(255,255,255,.85);
      border-radius: 14px; background: rgba(15,23,42,.94); color: white;
      font: 700 20px/1.3 system-ui,sans-serif; cursor: pointer; pointer-events: auto;
      transition: background-color 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
    }
    button[hidden] { display: none; }
    button svg { flex-shrink: 0; }
    button:hover, button:focus-visible {
      background: #2563eb; border-color: #93c5fd;
      box-shadow: inset 0 0 0 2px rgba(255,255,255,.25);
    }
    button:focus-visible { outline: 3px solid white; outline-offset: -6px; }
    button:active { background: #1d4ed8; }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  `;
  const text = createElement('div');
  text.hidden = true;
  text.style.cssText = 'box-sizing:border-box;padding:8px 10px;border-radius:6px;background:rgba(0,0,0,.78);color:white;font:12px/1.5 system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;';
  root.appendChild(button);
  root.appendChild(styles);
  root.appendChild(text);
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    enabledPlayers.add(player);
    button.hidden = true;
    text.hidden = false;
    text.textContent = '📥 Download enabled; waiting for media…';
    for (const capture of captureDisplays.values()) {
      if (playerForCapture(capture) === player && enabledCapture(capture)) {
        flushPreload(capture);
        showCapture(capture, player);
        if (capture.ended) finishCapture(capture, player);
      }
    }
    try {
      Promise.resolve(player.play()).catch(error => {
        text.textContent = `❌ Playback could not start: ${error.message}. Use the player’s play button to retry.`;
      });
    } catch (error) {
      text.textContent = `❌ Playback could not start: ${error.message}. Use the player’s play button to retry.`;
    }
  });
  playerOverlays.set(player, { host, text, button });
  if (overlayFrame === undefined) positionOverlays();
}

function showCapture(capture, player = playerForCapture(capture)) {
  if (!player?.isConnected || !enabledPlayers.has(player)) return;
  capture.player = player;
  ensureOverlay(player);
  const rows = capture.buffers.map(buffer => buffer.progress).filter(Boolean);
  playerOverlays.get(player).text.textContent = [capture.status || '📥 Capturing video', ...rows].join('\n');
}

document.addEventListener('VIDEO_CAPTURE_RESULT', ({ detail }) => {
  const capture = captureDisplays.get(detail.captureId);
  if (!capture) return;
  capture.status = detail.error ? `❌ Capture failed: ${detail.error}` : `✅ Saved: ${detail.file}`;
  showCapture(capture);
});

// Native controls do not necessarily call the JavaScript play() method.
// Remember trusted interaction with a video before its asynchronous play event.
for (const type of ['pointerdown', 'click', 'keydown']) {
  document.addEventListener(type, event => {
    if (!event.isTrusted) return;
    if (type === 'keydown' && ![' ', 'Enter', 'k', 'MediaPlayPause'].includes(event.key)) return;
    const player = event.composedPath().find(element => element.tagName?.toLowerCase() === 'video');
    if (player) playbackAllowed.add(player);
  }, true);
}

function allowPlayback(player) {
  if (enabledPlayers.has(player) || playbackAllowed.has(player)) return true;
  // Custom player controls commonly call play() from their click handler.
  if (navigator.userActivation?.isActive) {
    playbackAllowed.add(player);
    return true;
  }
  return false;
}

const nativePlay = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function (...args) {
  if (this.tagName?.toLowerCase() === 'video') {
    registerPlayer(this);
    if (!allowPlayback(this)) {
      const blocked = Promise.reject(new DOMException('Choose Download & play or use the player’s play control.', 'NotAllowedError'));
      // Pages that ignore the returned promise should not produce unhandled errors.
      blocked.catch(() => {});
      return blocked;
    }
  }
  return nativePlay.apply(this, args);
};
document.addEventListener('play', event => {
  const player = event.target;
  if (player.tagName?.toLowerCase() !== 'video') return;
  registerPlayer(player);
  if (!allowPlayback(player)) player.pause();
}, true);

const registeredPlayers = new WeakSet();
function registerPlayer(player) {
  if (!registeredPlayers.has(player)) {
    registeredPlayers.add(player);
    videoElements.push(player);
    player.addEventListener('pause', () => playbackAllowed.delete(player));
    player.addEventListener('ended', () => {
      playbackAllowed.delete(player);
      for (const capture of captureDisplays.values()) {
        if (playerForCapture(capture) === player) finishCapture(capture, player);
      }
    });
  }
  if (player.hasAttribute('autoplay')) player.removeAttribute('autoplay');
  if (!player.paused && !enabledPlayers.has(player) && !playbackAllowed.has(player)) player.pause();
  ensureOverlay(player);
}
function discoverVideos() {
  for (const player of document.querySelectorAll('video')) registerPlayer(player);
}
// Include parser-created videos and videos inserted after page load.
new MutationObserver(discoverVideos).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['autoplay'] });
discoverVideos();
document.createElement = function (...args) {
  const element = createElement(...args);
  if (element.tagName.toLowerCase() === 'video') registerPlayer(element);
  return element;
};

const originalCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = function (source) {
  const url = originalCreateObjectURL.call(this, source);
  if (sourceCaptures.has(source)) objectSources.set(url, source);
  return url;
};

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
  player ||= videoElements.find(element =>
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
    detail: { captureId: capture.id, metadata: captureMetadata(capture),
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
      captureId: capture.id,
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
      const enabled = enabledCapture(capture);
      if (capture.completed || capture.preloadUnavailable) return newBuffer.ogAppendBuffer(...args);
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
