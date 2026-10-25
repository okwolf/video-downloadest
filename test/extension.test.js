import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

async function connectFrame(code, context, port) {
  const postMessage = port.postMessage;
  port.postMessage = value => { if (value?.ready !== true) postMessage(value); };
  Object.assign(context, { window: {}, parent: {}, location: { search: '?secret=test' }, URLSearchParams,
    chrome: { storage: { local: { async get(key) { return { [key]: Date.now() + 60000 }; }, async remove() {} } } },
    navigator: { get serviceWorker() { throw new Error('Uploads must not depend on a service worker'); } }
  });
  vm.runInNewContext(code, context);
  await context.window.onmessage({ source: context.parent, data: 'test', ports: [port] });
}

import { setupPlayerPage } from './helpers/page.js';

test('download click starts only the selected video and preserves paired capture completion', async () => {
  const { messages, result, overlayHosts, context, player, frame, click } = setupPlayerPage();
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
  assert.match(overlay.shadow.children.at(-1).textContent, /video\/mp4: 1 chunks/);
  assert.match(overlay.shadow.children.at(-1).textContent, /audio\/mp4: 1 chunks/);
  assert.match(overlay.shadow.children.at(-1).textContent, /5.0s currently buffered \(50.0%\)/);
  assert.equal(overlay.style.left, '28px');
  assert.equal(overlay.style.top, '38px');
  source.endOfStream();
  player.dispatchEvent({ type: 'ended' });
  assert.match(overlay.shadow.children.at(-1).textContent, /Waiting for uploads and merge/);
  await new Promise(resolve => setImmediate(resolve));
  result({ captureId: video.capture.id, file: 'Player title.mp4' });
  assert.match(overlay.shadow.children.at(-1).textContent, /✅ Saved: Player title.mp4/);
  result({ captureId: video.capture.id, error: '<b>offline</b>' });
  assert.match(overlay.shadow.children.at(-1).textContent, /❌ Capture failed: <b>offline<\/b>/);
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
  const { player, discover } = setupPlayerPage({ existing: true });
  player.autoplay = true;
  player.paused = false;
  discover();
  assert.equal(player.autoplay, false);
  assert.equal(player.paused, true);
  player.paused = false;
  player.dispatchEvent({ type: 'play' });
  assert.equal(player.paused, true);
});

test('trusted native controls allow ordinary play but synthetic clicks do not', async () => {
  const { player, gesture, messages } = setupPlayerPage();
  gesture(player, { trusted: false });
  await assert.rejects(player.play(), { name: 'NotAllowedError' });
  gesture(player, { key: ' ' });
  await player.play();
  player.dispatchEvent({ type: 'play' });
  assert.equal(player.paused, false);
  assert.equal(messages.length, 0);
  player.pause();
  await assert.rejects(player.play(), { name: 'NotAllowedError' });
});

test('normal playback never uploads, seeks, or completes a download', () => {
  const { player, context, messages, overlayHosts, frame, gesture } = setupPlayerPage({ existing: true });
  const source = new context.window.MediaSource();
  player.src = context.URL.createObjectURL(source);
  const buffer = source.addSourceBuffer('video/mp4');
  gesture();
  player.play();
  frame();
  assert.equal(overlayHosts[0].style.display, 'none');
  buffer.appendBuffer(new Uint8Array([1, 2, 3, 4]));
  buffer.updateend();
  source.endOfStream();
  player.dispatchEvent({ type: 'ended' });
  assert.equal(player.currentTime, 0);
  assert.equal(messages.length, 0);
  player.paused = true;
  frame();
  assert.equal(overlayHosts[0].style.display, 'block');
});

test('newly inserted videos get a prompt and only the selected source uploads', async () => {
  const page = setupPlayerPage();
  const { context, player, createPlayer, discover, click, messages, frame } = page;
  const later = createPlayer();
  discover(); frame();
  assert.equal(page.overlayHosts.length, 2);
  const source = new context.window.MediaSource();
  later.src = context.URL.createObjectURL(source);
  const buffer = source.addSourceBuffer('video/mp4');
  click(1);
  const normalSource = new context.window.MediaSource();
  player.src = context.URL.createObjectURL(normalSource);
  const normalBuffer = normalSource.addSourceBuffer('video/mp4');
  normalBuffer.appendBuffer(new Uint8Array([3, 4]));
  normalBuffer.updateend(); normalSource.endOfStream();
  buffer.appendBuffer(new Uint8Array([1, 2])); buffer.updateend(); source.endOfStream();
  assert.equal(player.playCalls, undefined);
  assert.equal(player.currentTime, 0);
  assert.equal(later.playCalls, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.uploaded.length, 2);
  assert.equal(messages.filter(event => event.name === 'ON_APPEND_BUFFER').length, 1);
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
  player.dispatchEvent({ type: 'ended' });
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
  assert.match(overlayHosts[0].shadow.children.at(-1).textContent, /preload cache filled/);
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
  await connectFrame(code, context, port);
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

test('isolated bridge ignores forged events and synthetic download clicks', async () => {
  const page = setupPlayerPage();
  const forged = { sessionId: 'forged', captureId: 'capture', bufferId: 'v', bufferIndex: 0, bufferType: 'video/mp4', buffer: new Uint8Array([1]) };
  page.emit('ON_APPEND_BUFFER', forged);
  page.emit('ON_BUFFER_ENDED', { ...forged, streams: [{ id: 'v', count: 1 }] });
  page.click(0, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.player.playCalls, undefined);
  assert.equal(page.uploaded.length, 0);
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
  await connectFrame(code, context, port);
  port.onmessage({ data: { appendBuffer: { captureId: 'retry', bufferId: 'v', bufferIndex: 0, bufferType: 'video/mp4', buffer: 'original bytes' } } });
  port.onmessage({ data: { bufferEnd: { captureId: 'retry', streams: [{ id: 'v', count: 1 }] } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [500, 1000]);
  assert.match(calls.at(-1), /complete$/);
  assert.equal(replies[0].file, 'saved.mp4');
});

test('changing a video source requires a new download choice and releases old cache', async () => {
  const page = setupPlayerPage();
  const { player, context, click, discover, frame } = page;
  const first = new context.window.MediaSource(); player.src = context.URL.createObjectURL(first);
  const oldBuffer = first.addSourceBuffer('video/mp4'); oldBuffer.appendBuffer(new Uint8Array([1]));
  click(); first.endOfStream();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.uploaded.length, 2);
  const second = new context.window.MediaSource(); player.src = context.URL.createObjectURL(second);
  const nextBuffer = second.addSourceBuffer('video/mp4'); nextBuffer.appendBuffer(new Uint8Array([2]));
  discover(); frame();
  await assert.rejects(player.play(), { name: 'NotAllowedError' });
  assert.equal(page.uploaded.length, 2);
  assert.equal(page.overlayHosts[0].shadow.children[0].hidden, false);
  assert.equal(oldBuffer.capture.disposed, true);
  click(); second.endOfStream();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.uploaded.length, 4);
});

test('unrelated document activation cannot autoplay another player', async () => {
  const { context, document, player, gesture } = setupPlayerPage();
  context.navigator.userActivation.isActive = true;
  gesture(document.body, { path: [document.body, document.documentElement, document] });
  await assert.rejects(player.play(), { name: 'NotAllowedError' });
});

test('custom play controls authorize only their containing player', async () => {
  const page = setupPlayerPage();
  const { document, player, gesture, createPlayer } = page;
  const container = document.createElement('div');
  player.remove(); container.appendChild(player); document.body.appendChild(container);
  const button = container.appendChild(document.createElement('button'));
  const other = createPlayer(); page.discover();
  gesture(button, { path: [button, container, document.body, document] });
  await player.play();
  await assert.rejects(other.play(), { name: 'NotAllowedError' });
});

test('removed players release retained preloads and reconnect with a new overlay', () => {
  const page = setupPlayerPage();
  const { player, context, discover, frame, document } = page;
  const source = new context.window.MediaSource(); player.src = context.URL.createObjectURL(source);
  const buffer = source.addSourceBuffer('video/mp4'); buffer.appendBuffer(new Uint8Array([1, 2, 3]));
  player.remove(); discover(); frame();
  assert.equal(buffer.capture.preloadBytes, 0);
  assert.equal(buffer.capture.disposed, true);
  assert.equal(page.overlayHosts.length, 0);
  document.body.appendChild(player); discover(); frame();
  assert.equal(page.overlayHosts.length, 1);
});

for (const mode of ['open', 'closed']) {
  test(`videos inserted into ${mode} shadow roots are discovered and block autoplay`, async () => {
    const page = setupPlayerPage();
    const host = page.document.createElement('section');
    const root = host.attachShadow({ mode }); // Start detached, like a custom element constructor.
    page.document.body.appendChild(host);
    const video = root.appendChild(page.document.createElement('video'));
    video.autoplay = true;
    page.discover(); page.frame();
    assert.equal(page.overlayHosts.length, 2);
    assert.equal(video.autoplay, false);
    await assert.rejects(video.play(), { name: 'NotAllowedError' });
    host.remove(); page.discover(); page.frame();
    assert.equal(page.overlayHosts.length, 1);
  });
}

test('main-world discovery works when the isolated bridge starts first', () => {
  const page = setupPlayerPage({ existing: true, bridgeFirst: true });
  assert.equal(page.overlayHosts.length, 1);
});

test('manifest installs capture directly in MAIN at document_start', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url)));
  assert.ok(manifest.content_scripts.some(script => script.world === 'MAIN' && script.run_at === 'document_start' && script.js.includes('injected-script.js')));
  const bridge = await fs.readFile(new URL('../content-script.js', import.meta.url), 'utf8');
  assert.ok(!bridge.includes('injected-script.js'));
});

test('completion retries transient failures and permits another attempt after exhaustion', async () => {
  const code = await fs.readFile(new URL('../iframe.js', import.meta.url), 'utf8');
  const replies = []; let attempts = 0;
  const port = { postMessage: reply => replies.push(reply) };
  const context = { setTimeout: cb => queueMicrotask(cb), fetch: async () => {
    if (++attempts <= 4) throw new Error('temporary');
    return { ok: true, json: async () => ({ file: 'saved.mp4' }) };
  } };
  await connectFrame(code, context, port);
  port.onmessage({ data: { kind: 'complete', captureId: 'retry-complete', streams: [] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 4);
  port.onmessage({ data: { kind: 'complete', captureId: 'retry-complete', streams: [] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 5);
  assert.equal(replies.at(-1).file, 'saved.mp4');
});

test('web-accessible upload frame rejects a page-created connection without a capability', async () => {
  const code = await fs.readFile(new URL('../iframe.js', import.meta.url), 'utf8');
  const port = {};
  const context = { window: {}, parent: {}, location: { search: '?secret=forged' }, URLSearchParams,
    chrome: { storage: { local: { async get() { return {}; }, async remove() { throw new Error('Must not accept'); } } } } };
  vm.runInNewContext(code, context);
  await context.window.onmessage({ source: context.parent, data: 'forged', ports: [port] });
  assert.equal(port.onmessage, undefined);
});

test('bridge waits for upload frame acknowledgement and drops revoked source bytes', async () => {
  const page = setupPlayerPage({ frameReady: 'manual' });
  const source = new page.context.window.MediaSource();
  page.player.srcObject = source;
  const buffer = source.addSourceBuffer('video/mp4');
  page.click();
  buffer.appendBuffer(new Uint8Array([1, 2]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.uploaded.length, 0);
  page.player.srcObject = new page.context.window.MediaSource();
  page.player.dispatchEvent({ type: 'emptied' });
  page.releaseFrame();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.uploaded.length, 0);
  assert.equal(page.overlayHosts[0].shadow.children[0].hidden, false);
});

test('bridge reports a frame that never acknowledges the connection', async () => {
  const page = setupPlayerPage({ frameReady: false });
  page.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(page.overlayHosts[0].shadow.children.at(-1).textContent, /Upload connection failed/);
  assert.equal(page.uploaded.length, 0);
});

test('iframe caps queued bytes and refuses to complete a partial capture', async () => {
  const code = await fs.readFile(new URL('../iframe.js', import.meta.url), 'utf8');
  const replies = [], calls = [];
  let release;
  const port = { postMessage: value => replies.push(value) };
  const context = { fetch: async url => { calls.push(url); await new Promise(resolve => { release = resolve; }); return { ok: true }; } };
  await connectFrame(code, context, port);
  port.onmessage({ data: { kind: 'chunk', captureId: 'bounded', streamId: 'v', index: 0, type: 'video/mp4', buffer: new ArrayBuffer(1) } });
  await new Promise(resolve => setImmediate(resolve));
  port.onmessage({ data: { kind: 'chunk', captureId: 'bounded', streamId: 'v', index: 1, type: 'video/mp4', buffer: { byteLength: 129 * 1024 * 1024 } } });
  port.onmessage({ data: { kind: 'complete', captureId: 'bounded', streams: [{ id: 'v', count: 2 }] } });
  assert.match(replies[0].error, /queue filled/);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
});

test('source changes retire detached preloads and invalidate old playback gestures', async () => {
  const page = setupPlayerPage();
  const source = new page.context.window.MediaSource();
  page.player.srcObject = source;
  const buffer = source.addSourceBuffer('video/mp4');
  buffer.appendBuffer(new Uint8Array([1, 2, 3]));
  page.gesture();
  page.player.srcObject = new page.context.window.MediaSource();
  page.player.dispatchEvent({ type: 'emptied' });
  assert.equal(buffer.capture.disposed, true);
  assert.equal(buffer.capture.preloadBytes, 0);
  await assert.rejects(page.player.play(), { name: 'NotAllowedError' });
});

test('revoking one of several URLs keeps an unbound MediaSource available', () => {
  const page = setupPlayerPage();
  const source = new page.context.window.MediaSource();
  const first = page.context.URL.createObjectURL(source);
  const second = page.context.URL.createObjectURL(source);
  const buffer = source.addSourceBuffer('video/mp4');
  buffer.appendBuffer(new Uint8Array([1]));
  page.context.URL.revokeObjectURL(first);
  assert.equal(buffer.capture.disposed, undefined);
  page.context.URL.revokeObjectURL(second);
  assert.equal(buffer.capture.disposed, true);
});

test('revoking the URL of an attached player keeps its capture connected', () => {
  const page = setupPlayerPage();
  const source = new page.context.window.MediaSource();
  const url = page.context.URL.createObjectURL(source);
  page.player.src = url;
  page.context.URL.revokeObjectURL(url);
  const buffer = source.addSourceBuffer('video/mp4');
  page.click();
  buffer.appendBuffer(new Uint8Array([7]));
  source.endOfStream();
  assert.equal(page.messages.filter(event => event.name === 'ON_APPEND_BUFFER').length, 1);
  assert.equal(buffer.capture.disposed, undefined);
});

test('closing a MediaSource releases cached bytes and reports incomplete captures', () => {
  const page = setupPlayerPage();
  const source = new page.context.window.MediaSource();
  page.player.srcObject = source;
  const buffer = source.addSourceBuffer('video/mp4');
  buffer.appendBuffer(new Uint8Array([1, 2, 3]));
  page.click();
  source.dispatchEvent({ type: 'sourceclose' });
  assert.equal(buffer.capture.disposed, true);
  assert.equal(buffer.capture.preloadBytes, 0);
  assert.match(page.overlayHosts[0].shadow.children.at(-1).textContent, /media source closed/);
});

test('ordinary playback survives initial loading and binds its first source', async () => {
  const page = setupPlayerPage();
  page.gesture();
  page.player.src = 'https://example.test/first.mp4';
  page.player.dispatchEvent({ type: 'emptied' });
  await page.player.play();
  assert.equal(page.player.paused, false);
  assert.equal(page.uploaded.length, 0);
  page.player.src = 'https://example.test/second.mp4';
  page.player.dispatchEvent({ type: 'emptied' });
  await assert.rejects(page.player.play(), { name: 'NotAllowedError' });
});

test('ordinary playback survives loading an already selected source', async () => {
  const page = setupPlayerPage();
  page.player.src = 'https://example.test/first.mp4';
  page.gesture();
  page.player.dispatchEvent({ type: 'emptied' });
  await page.player.play();
  assert.equal(page.player.paused, false);
  page.player.pause();
  await assert.rejects(page.player.play(), { name: 'NotAllowedError' });
});

for (const mode of ['open', 'closed']) {
  test(`reattached ${mode} shadow roots regain overlays and playback listeners`, async () => {
    const page = setupPlayerPage();
    const host = page.document.createElement('section');
    const root = host.attachShadow({ mode });
    const video = root.appendChild(page.document.createElement('video'));
    page.document.body.appendChild(host);
    page.discover(); page.frame();
    assert.equal(page.overlayHosts.length, 2);
    host.remove(); page.discover(); page.frame();
    assert.equal(page.overlayHosts.length, 1);
    page.document.body.appendChild(host); page.discover(); page.frame();
    assert.equal(page.overlayHosts.length, 2);
    video.paused = false;
    video.dispatchEvent({ type: 'play' });
    assert.equal(video.paused, true);
    page.click(1);
    assert.equal(video.paused, false);
    const later = root.appendChild(page.document.createElement('video'));
    page.discover(); page.frame();
    assert.equal(page.overlayHosts.length, 3);
    assert.ok(later.getAttribute('data-video-downloadest-id'));
  });
}
