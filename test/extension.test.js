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
test('committed constructor hook intercepts instance methods and preserves seeking and paired completion', () => {
  const messages = [];
  const eventListeners = {};
  const overlayHosts = [];
  let frame;
  let sequence = 0;
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
  const document = {
    documentElement: { appendChild(host) { host.parentNode = this; overlayHosts.push(host); } },
    addEventListener(name, callback) { eventListeners[name] = callback; },
    createElement(tagName) {
      const tracks = [];
      tracks.addEventListener = () => {};
      return { tagName, videoTracks: tracks, audioTracks: [], currentTime: 0, duration: 10,
        isConnected: true, style: {},
        getBoundingClientRect: () => ({ left: 20, top: 30, width: 640, height: 360 }),
        attachShadow() { this.shadow = { appendChild(child) { this.child = child; } }; return this.shadow; },
        remove() { this.removed = true; },
        getAttribute: () => 'Player title', addEventListener(name, callback) { this[name] = callback; } };
    },
    querySelector: () => null, title: 'Page fallback',
    dispatchEvent(event) { messages.push({ name: event.name, ...event.detail }); }
  };
  const context = { requestAnimationFrame(callback) { frame = callback; return 1; }, document, window: { MediaSource: NativeMediaSource }, console: { log() {} },
    crypto: { randomUUID: () => `id-${sequence++}` }, navigator: { mediaSession: {} },
    location: { href: 'https://example.test/watch' },
    CustomEvent: function (name, { detail }) { return { name, detail }; }
  };
  vm.runInNewContext(injected, context);
  const player = document.createElement('video');
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
  assert.notEqual(chunks[0].captureId, chunks[2].captureId);
  const completed = messages.filter(m => m.name === 'ON_BUFFER_ENDED');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].streams.length, 2);
  assert.equal(completed[0].metadata.title, 'Player title');
  assert.equal(context.window.MediaSource.isTypeSupported(), true);
  assert.ok(source instanceof context.window.MediaSource);
  other.endOfStream('network');
  assert.equal(messages.filter(m => m.name === 'ON_BUFFER_ENDED').length, 1);
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
  iframe.onload();
  await new Promise(resolve => setImmediate(resolve));
  const detail = { captureId: 'capture', bufferId: 'stream' };
  listeners.ON_APPEND_BUFFER({ detail });
  listeners.ON_BUFFER_ENDED({ detail });
  assert.equal(uploaded[0].appendBuffer, detail);
  assert.equal(uploaded[1].bufferEnd, detail);
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
