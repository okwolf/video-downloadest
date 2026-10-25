import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

function connectFrame(code, context, port) {
  Object.assign(context, { window: {}, parent: {}, location: { search: '?secret=test' }, URLSearchParams,
    navigator: { get serviceWorker() { throw new Error('Uploads must not depend on a service worker'); } }
  });
  vm.runInNewContext(code, context);
  context.window.onmessage({ source: context.parent, data: 'test', ports: [port] });
}

const injected = await fs.readFile(new URL('../injected-script.js', import.meta.url), 'utf8');
function setupPlayerPage({ existing = false } = {}) {
  const messages = [];
  const eventListeners = {};
  const overlayHosts = [];
  let frame;
  let sequence = 0;
  let discover;
  const pageVideos = [];
  function NativeMediaSource() {
    // Instance methods must be intercepted even when they shadow the prototype.
    this.addSourceBuffer = () => ({
      buffered: { length: 1, start: () => 0, end: () => 5 },
      appendBuffer(data) { if (!data.byteLength) throw new Error('invalid'); },
      addEventListener(name, callback) { this[name] = callback; }
    });
    this.endOfStream = () => {};
  }
  Object.defineProperty(NativeMediaSource, 'isTypeSupported', { value: () => true });
  function HTMLMediaElement() {}
  HTMLMediaElement.prototype.play = function () { this.paused = false; this.playCalls = (this.playCalls || 0) + 1; return Promise.resolve(); };
  const document = {
    documentElement: { appendChild(host) { host.parentNode = this; overlayHosts.push(host); } },
    addEventListener(name, callback) { eventListeners[name] = callback; },
    createElement(tagName) {
      const tracks = [];
      tracks.addEventListener = () => {};
      return { __proto__: HTMLMediaElement.prototype, tagName, videoTracks: tracks, audioTracks: [], currentTime: 0, duration: 10,
        paused: true, pause() { this.paused = true; },
        hasAttribute(name) { return Boolean(this[name]); }, removeAttribute(name) { this[name] = false; },
        isConnected: true, style: {},
        getBoundingClientRect: () => ({ left: 20, top: 30, width: 640, height: 360 }),
        attachShadow() { this.shadow = { children: [], appendChild(child) { this.children.push(child); this.child = child; } }; return this.shadow; },
        remove() { this.removed = true; },
        getAttribute: () => 'Player title', addEventListener(name, callback) { this[name === 'pause' ? 'onpause' : name] = callback; } };
    },
    querySelectorAll: () => pageVideos,
    querySelector: () => null, title: 'Page fallback',
    dispatchEvent(event) { messages.push({ name: event.name, ...event.detail }); }
  };
  if (existing) pageVideos.push(document.createElement('video'));
  const context = { HTMLMediaElement, DOMException, URL: { createObjectURL: () => `blob:test-${sequence++}` },
    MutationObserver: function (callback) { discover = callback; return { observe() {} }; },
    requestAnimationFrame(callback) { frame = callback; return 1; }, document, window: { MediaSource: NativeMediaSource }, console: { log() {} },
    crypto: { randomUUID: () => `id-${sequence++}` }, navigator: { mediaSession: {}, userActivation: { isActive: false } },
    location: { href: 'https://example.test/watch' },
    CustomEvent: function (name, { detail }) { return { name, detail }; }
  };
  vm.runInNewContext(injected, context);
  const player = existing ? pageVideos[0] : document.createElement('video');
  return { messages, eventListeners, overlayHosts, context, player, document, pageVideos,
    discover: () => discover(), frame: () => frame(),
    click: (index = 0) => overlayHosts[index].shadow.children[0].click({ preventDefault() {}, stopPropagation() {} }) };
}

test('download click starts only the selected video and preserves paired capture completion', () => {
  const { messages, eventListeners, overlayHosts, context, player, frame, click } = setupPlayerPage();
  assert.equal(overlayHosts[0].style.left, '340px');
  assert.equal(overlayHosts[0].style.top, '330px');
  click();
  assert.equal(player.playCalls, 1);
  frame();
  const source = new context.window.MediaSource();
  const video = source.addSourceBuffer('video/mp4');
  const audio = source.addSourceBuffer('audio/mp4');
  const other = new context.window.MediaSource();
  const unrelated = other.addSourceBuffer('audio/mp4');
  player.videoTracks.push({ sourceBuffer: video });
  player.audioTracks.push({ sourceBuffer: audio });
  const bytes = new Uint8Array([9, 1, 2, 9]);
  video.appendBuffer(bytes.subarray(1, 3));
  bytes.fill(0);
  audio.appendBuffer(new Uint8Array([3]));
  unrelated.appendBuffer(new Uint8Array([4]));
  assert.throws(() => video.appendBuffer(new Uint8Array()), /invalid/);
  video.updateend();
  assert.equal(player.currentTime, 5);
  audio.updateend();
  assert.equal(overlayHosts.length, 1);
  const overlay = overlayHosts[0];
  assert.match(overlay.shadow.child.textContent, /video\/mp4: 1 chunks/);
  assert.match(overlay.shadow.child.textContent, /audio\/mp4: 1 chunks/);
  assert.match(overlay.shadow.child.textContent, /5.0s currently buffered \(50.0%\)/);
  assert.equal(overlay.style.left, '28px');
  assert.equal(overlay.style.top, '38px');
  source.endOfStream();
  player.ended();
  assert.match(overlay.shadow.child.textContent, /Waiting for uploads and merge/);
  eventListeners.VIDEO_CAPTURE_RESULT({ detail: { captureId: video.capture.id, file: 'Player title.mp4' } });
  assert.match(overlay.shadow.child.textContent, /✅ Saved: Player title.mp4/);
  eventListeners.VIDEO_CAPTURE_RESULT({ detail: { captureId: video.capture.id, error: '<b>offline</b>' } });
  assert.match(overlay.shadow.child.textContent, /❌ Capture failed: <b>offline<\/b>/);
  player.isConnected = false;
  frame();
  assert.equal(overlay.removed, true);
  const chunks = messages.filter(m => m.name === 'ON_APPEND_BUFFER');
  assert.deepEqual([...new Uint8Array(chunks[0].buffer)], [1, 2]);
  assert.equal(chunks[0].captureId, chunks[1].captureId);
  assert.equal(chunks.length, 2);
  assert.equal(unrelated.chunkCount, 0);
  const completed = messages.filter(m => m.name === 'ON_BUFFER_ENDED');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].streams.length, 2);
  assert.equal(completed[0].metadata.title, 'Player title');
  assert.equal(context.window.MediaSource.isTypeSupported(), true);
  assert.ok(source instanceof context.window.MediaSource);
  other.endOfStream('network');
  assert.equal(messages.filter(m => m.name === 'ON_BUFFER_ENDED').length, 1);
});

test('script autoplay is blocked until a user chooses playback', async () => {
  const { player, messages, overlayHosts, frame, click } = setupPlayerPage();
  await assert.rejects(player.play(), { name: 'NotAllowedError' });
  assert.equal(player.paused, true);
  assert.equal(player.playCalls, undefined);
  frame();
  assert.equal(overlayHosts[0].style.display, 'block');
  assert.equal(messages.length, 0);
  click();
  assert.equal(player.paused, false);
  assert.equal(player.playCalls, 1);
});

test('autoplay attributes and native autoplay events are suppressed', () => {
  const { player, eventListeners, discover } = setupPlayerPage({ existing: true });
  player.autoplay = true;
  player.paused = false;
  discover();
  assert.equal(player.autoplay, false);
  assert.equal(player.paused, true);
  player.paused = false;
  eventListeners.play({ target: player });
  assert.equal(player.paused, true);
});

test('trusted native controls allow ordinary play but synthetic clicks do not', async () => {
  const { player, eventListeners, messages } = setupPlayerPage();
  eventListeners.pointerdown({ isTrusted: false, composedPath: () => [player] });
  await assert.rejects(player.play(), { name: 'NotAllowedError' });
  eventListeners.keydown({ isTrusted: true, key: ' ', composedPath: () => [player] });
  await player.play();
  eventListeners.play({ target: player });
  assert.equal(player.paused, false);
  assert.equal(messages.length, 0);
  player.pause();
  player.onpause();
  await assert.rejects(player.play(), { name: 'NotAllowedError' });
});

test('normal playback never uploads, seeks, or completes a download', () => {
  const { player, context, messages, overlayHosts, frame } = setupPlayerPage({ existing: true });
  const source = new context.window.MediaSource();
  player.src = context.URL.createObjectURL(source);
  const buffer = source.addSourceBuffer('video/mp4');
  context.navigator.userActivation.isActive = true;
  player.play();
  context.navigator.userActivation.isActive = false;
  frame();
  assert.equal(overlayHosts[0].style.display, 'none');
  buffer.appendBuffer(new Uint8Array([1, 2, 3, 4]));
  buffer.updateend();
  source.endOfStream();
  player.ended();
  assert.equal(player.currentTime, 0);
  assert.equal(messages.length, 0);
  player.paused = true;
  frame();
  assert.equal(overlayHosts[0].style.display, 'block');
});

test('newly inserted videos get a prompt and object URLs associate only the selected source', () => {
  const { context, player, pageVideos, discover, overlayHosts, click, messages, frame } = setupPlayerPage();
  // Simulate a parser-created element, bypassing the createElement hook.
  const later = { __proto__: context.HTMLMediaElement.prototype, ...player, videoTracks: [], audioTracks: [], playCalls: 0 };
  pageVideos.push(later);
  discover();
  assert.equal(overlayHosts.length, 1);
  // The next animation frame attaches the second overlay.
  // Discovery must not create duplicate prompts.
  discover();
  const source = new context.window.MediaSource();
  later.src = context.URL.createObjectURL(source);
  const buffer = source.addSourceBuffer('video/mp4');
  // Append overlays by running the pending animation frame.
  frame();
  assert.equal(overlayHosts.length, 2);
  click(1);
  const normalSource = new context.window.MediaSource();
  player.src = context.URL.createObjectURL(normalSource);
  const normalBuffer = normalSource.addSourceBuffer('video/mp4');
  normalBuffer.appendBuffer(new Uint8Array([3, 4]));
  normalBuffer.updateend();
  normalSource.endOfStream();
  buffer.appendBuffer(new Uint8Array([1, 2]));
  buffer.updateend();
  source.endOfStream();
  assert.equal(player.playCalls, undefined);
  assert.equal(player.currentTime, 0);
  assert.equal(later.playCalls, 1);
  assert.equal(messages.filter(event => event.name === 'ON_APPEND_BUFFER').length, 1);
  assert.equal(messages.filter(event => event.name === 'ON_BUFFER_ENDED').length, 1);
});

test('opt-in replays preloaded audio and video in order, then appends new chunks', () => {
  const { player, context, messages, click } = setupPlayerPage();
  const source = new context.window.MediaSource();
  player.srcObject = source;
  const video = source.addSourceBuffer('video/mp4');
  const audio = source.addSourceBuffer('audio/mp4');
  const bytes = new Uint8Array([9, 1, 2, 9]);
  video.appendBuffer(bytes.subarray(1, 3));
  bytes.fill(0);
  audio.appendBuffer(new Uint8Array([3]));
  assert.throws(() => video.appendBuffer(new Uint8Array()), /invalid/);
  assert.equal(messages.length, 0);
  click();
  video.appendBuffer(new Uint8Array([4]));
  source.endOfStream();
  const chunks = messages.filter(event => event.name === 'ON_APPEND_BUFFER');
  assert.deepEqual(chunks.map(event => [...new Uint8Array(event.buffer)]), [[1, 2], [3], [4]]);
  assert.deepEqual(chunks.map(event => event.bufferIndex), [0, 0, 1]);
  const completed = messages.filter(event => event.name === 'ON_BUFFER_ENDED');
  assert.equal(completed.length, 1);
  assert.deepEqual(Array.from(completed[0].streams, stream => stream.count), [2, 1]);
  assert.equal(video.capture.preloadBytes, 0);
});

test('a fully buffered video can be downloaded after endOfStream', () => {
  const { player, context, messages, click } = setupPlayerPage();
  const source = new context.window.MediaSource();
  player.src = context.URL.createObjectURL(source);
  const buffer = source.addSourceBuffer('video/mp4');
  buffer.appendBuffer(new Uint8Array([1]));
  source.endOfStream();
  assert.equal(messages.length, 0);
  click();
  player.ended();
  assert.deepEqual(messages.map(event => event.name), ['ON_APPEND_BUFFER', 'ON_BUFFER_ENDED']);
  assert.equal(player.playCalls, 1);
});

test('preload memory is bounded and overflow never uploads a partial capture', () => {
  const { player, context, messages, overlayHosts, click } = setupPlayerPage();
  const source = new context.window.MediaSource();
  player.srcObject = source;
  const buffer = source.addSourceBuffer('video/mp4');
  buffer.appendBuffer(new Uint8Array([1]));
  buffer.appendBuffer({ byteLength: 65 * 1024 * 1024, slice() { throw new Error('Must not allocate oversized chunks'); } });
  assert.equal(buffer.capture.preloadBytes, 0);
  assert.equal(buffer.capture.preload.length, 0);
  click();
  buffer.appendBuffer(new Uint8Array([2]));
  source.endOfStream();
  assert.match(overlayHosts[0].shadow.child.textContent, /preload cache filled/);
  assert.equal(messages.length, 0);
});

test('iframe completion waits for uploads and stops after upload failure', async () => {
  const code = await fs.readFile(new URL('../iframe.js', import.meta.url), 'utf8');
  const calls = [];
  let release;
  const replies = [];
  const port = { postMessage: value => replies.push(value) };
  const context = { setTimeout: callback => queueMicrotask(callback), self: {}, fetch: async url => {
    calls.push(url);
    if (url.includes('/streams/')) await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ file: 'done.mkv' }) };
  } };
  connectFrame(code, context, port);
  port.onmessage({ data: { kind: 'chunk', captureId: 'one', streamId: 'v', index: 0, type: 'video/mp4', buffer: new ArrayBuffer(1) } });
  port.onmessage({ data: { kind: 'complete', captureId: 'one', streams: [{ id: 'v', count: 1 }] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(replies[0].file, 'done.mkv');
  context.fetch = async () => { throw new Error('offline'); };
  port.onmessage({ data: { kind: 'chunk', captureId: 'two', streamId: 'v', index: 0 } });
  port.onmessage({ data: { kind: 'complete', captureId: 'two' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies.at(-1).error, 'offline');
  assert.equal(calls.length, 2);
});

test('committed content bridge injects synchronously and forwards original event envelopes', async () => {
  const code = await fs.readFile(new URL('../content-script.js', import.meta.url), 'utf8');
  const listeners = {};
  const uploaded = [];
  const inserted = [];
  const results = [];
  let iframe;
  const port = { postMessage: message => uploaded.push(message) };
  const document = {
    documentElement: { appendChild(element) { inserted.push(element); } },
    dispatchEvent(event) { results.push(event); },
    addEventListener(name, fn) { listeners[name] = fn; },
    createElement(tag) {
      if (tag === 'script') return { remove() {} };
      if (tag === 'div') return { attachShadow: () => ({ appendChild() {} }) };
      if (tag === 'iframe') {
        iframe = { contentWindow: { location: {}, postMessage() {} } };
        return iframe;
      }
    }
  };
  vm.runInNewContext(code, { document, console, URL,
    CustomEvent: function (name, { detail }) { return { name, detail }; },
    chrome: { runtime: { getURL: path => `chrome-extension://extension/${path.replace(/^\//, '')}` } },
    MessageChannel: function () { return { port1: port, port2: {} }; }
  });
  assert.match(inserted[0].src, /injected-script.js$/);
  assert.match(iframe.contentWindow.location.href.href, /iframe.html\?secret=/);
  const detail = { captureId: 'capture', bufferId: 'stream' };
  listeners.ON_APPEND_BUFFER({ detail });
  listeners.ON_BUFFER_ENDED({ detail });
  assert.equal(uploaded.length, 0);
  iframe.onload();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(uploaded[0].appendBuffer, detail);
  assert.equal(uploaded[1].bufferEnd, detail);
  listeners.ON_APPEND_BUFFER({ detail });
  assert.equal(uploaded[2].appendBuffer, detail);
  port.onmessage({ data: { captureId: 'capture', file: 'saved.mp4' } });
  assert.equal(results[0].name, 'VIDEO_CAPTURE_RESULT');
  assert.equal(results[0].detail.file, 'saved.mp4');
});

test('iframe retries interrupted parts before sending completion', async () => {
  const code = await fs.readFile(new URL('../iframe.js', import.meta.url), 'utf8');
  let attempts = 0;
  const calls = [], replies = [], delays = [];
  const port = { postMessage: reply => replies.push(reply) };
  const context = { self: {}, setTimeout(callback, delay) { delays.push(delay); queueMicrotask(callback); },
    fetch: async (url, options) => {
      calls.push(url);
      if (url.includes('/streams/')) {
        assert.equal(options.body, 'original bytes');
        if (++attempts < 3) throw new TypeError('Failed to fetch');
      }
      return { ok: true, json: async () => ({ file: 'saved.mp4' }) };
    }
  };
  connectFrame(code, context, port);
  port.onmessage({ data: { appendBuffer: { captureId: 'retry', bufferId: 'v', bufferIndex: 0, bufferType: 'video/mp4', buffer: 'original bytes' } } });
  port.onmessage({ data: { bufferEnd: { captureId: 'retry', streams: [{ id: 'v', count: 1 }] } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [500, 1000]);
  assert.match(calls.at(-1), /complete$/);
  assert.equal(replies[0].file, 'saved.mp4');
});
