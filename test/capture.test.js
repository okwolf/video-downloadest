import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { createCaptureStore, filename, runFFmpeg } from '../capture-store.js';

async function setup(t, mux) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: createCaptureStore(root, mux) };
}
const body = value => Readable.from([Buffer.from(value)]);
test('store functions work independently and keep captures isolated between stores', async t => {
  const { store: first } = await setup(t);
  const { store: second } = await setup(t);
  const { upload, expectedFilename } = first;
  await upload('shared-id', 'video', 0, 'video/mp4', body('video'));
  assert.equal(expectedFilename('shared-id', { title: 'Player' }), 'Player [shared-id].mp4');
  assert.equal(second.get('shared-id').streams.size, 0);
  assert.equal(second.expectedFilename('shared-id', { title: 'Player' }), 'Player [shared-id] (container unknown)');
});
test('validates complete manifests, orders chunks, and completes only once', async t => {
  let calls = 0;
  const { root, store } = await setup(t, async args => {
    calls++;
    assert.equal(await fs.readFile(args[args.indexOf('-i') + 1], 'utf8'), 'firstsecond');
    await fs.writeFile(args.at(-1), 'merged');
  });
  await store.upload('capture', 'video', 1, 'video/mp4', body('second'));
  await assert.rejects(store.complete('capture', { streams: [{ id: 'video', count: 2 }] }), /Missing chunks/);
  await store.upload('capture', 'video', 0, 'video/mp4', body('first'));
  await assert.rejects(store.upload('capture', 'video', 0, 'video/mp4', body('duplicate')), /Duplicate/);
  await store.upload('capture', 'video', 0, 'video/mp4', body('first'));
  assert.equal(await fs.readFile(path.join(root, 'parts/capture/video.0'), 'utf8'), 'first');
  const request = { streams: [{ id: 'video', count: 2 }], metadata: { title: '../A/B: title' } };
  const [a, b] = await Promise.all([store.complete('capture', request), store.complete('capture', request)]);
  assert.equal(a, b);
  assert.equal(path.dirname(a), path.join(root, 'buffers'));
  assert.equal(calls, 1);
  assert.equal(await store.complete('capture', request), a);
});
test('failed mux retains parts and can be retried', async t => {
  let attempts = 0;
  const { root, store } = await setup(t, async args => {
    if (++attempts === 1) throw new Error('mux failure');
    await fs.writeFile(args.at(-1), 'ok');
  });
  await store.upload('one', 'audio', 0, 'audio/mp4', body('audio'));
  assert.equal(store.expectedFilename('one', { title: 'Player', videoType: 'video/mp4' }), 'Player [one].mp4');
  const request = { streams: [{ id: 'audio', count: 1 }] };
  await assert.rejects(store.complete('one', request), /mux failure/);
  assert.equal(await fs.readFile(path.join(root, 'parts/one/audio.0'), 'utf8'), 'audio');
  assert.equal(path.extname(await store.complete('one', request)), '.m4a');
});
test('rejects unsafe paths and incomplete stream sets', async t => {
  const { store } = await setup(t);
  await assert.rejects(store.upload('../escape', 'video', 0, 'video/mp4', body('')), /Invalid/);
  await store.upload('one', 'video', 0, 'video/mp4', body('v'));
  await store.upload('one', 'audio', 0, 'audio/mp4', body('a'));
  await assert.rejects(store.complete('one', { streams: [{ id: 'video', count: 1 }] }), /mismatch/);
  assert.equal(filename('.. /bad:title?'), '_bad_title_');
});
for (const format of [
  { extension: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', audioExtension: 'm4a' },
  { extension: 'webm', videoCodec: 'libvpx-vp9', audioCodec: 'libopus', audioExtension: 'webm' }
]) {
  test(`real FFmpeg preserves ${format.extension} container when merging video/audio`, async t => {
    const { root, store } = await setup(t);
    const video = path.join(root, `video.${format.extension}`);
    const audio = path.join(root, `audio.${format.audioExtension}`);
    await runFFmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10', '-t', '1', '-c:v', format.videoCodec, video]);
    await runFFmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:a', format.audioCodec, audio]);
    // Upload audio first to verify that video determines the output format.
    for (const [id, file, type] of [['a', audio, `audio/${format.extension}`], ['v', video, `video/${format.extension}; codecs="test"`]]) {
      const bytes = await fs.readFile(file);
      const split = Math.floor(bytes.length / 2);
      await store.upload('integration', id, 1, type, body(bytes.subarray(split)));
      await store.upload('integration', id, 0, type, body(bytes.subarray(0, split)));
    }
    const output = await store.complete('integration', { streams: [{ id: 'a', count: 2 }, { id: 'v', count: 2 }], metadata: { title: 'Player title' } });
    assert.match(path.basename(output), /^Player title /);
    assert.equal(path.extname(output), `.${format.extension}`);
    const bytes = await fs.readFile(output);
    if (format.extension === 'mp4') assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
    else assert.ok(bytes.subarray(0, 64).includes(Buffer.from('webm')), 'Expected WebM document type');
    await runFFmpeg(['-v', 'error', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  });
}

test('unknown containers fail without silently converting or deleting captured chunks', async t => {
  let muxed = false;
  const { root, store } = await setup(t, async () => { muxed = true; });
  await store.upload('unknown', 'v', 0, 'video/unknown', body('bytes'));
  await assert.rejects(store.complete('unknown', { streams: [{ id: 'v', count: 1 }] }), /Unsupported source container/);
  assert.equal(muxed, false);
  assert.equal(await fs.readFile(path.join(root, 'parts/unknown/v.0'), 'utf8'), 'bytes');
});

test('interrupted upload removes its partial file and allows a complete retry', async t => {
  const { root, store } = await setup(t);
  const stream = new PassThrough();
  const upload = store.upload('aborted', 'video', 0, 'video/mp4', stream);
  const failed = assert.rejects(upload, { code: 'ECONNRESET' });
  stream.write('partial');
  // Wait until the pipeline is receiving before simulating the socket closing.
  while (stream.listenerCount('error') === 0) await new Promise(resolve => setImmediate(resolve));
  stream.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
  await failed;
  assert.equal(store.get('aborted').streams.get('video').parts.size, 0);
  await assert.rejects(fs.stat(path.join(root, 'parts/aborted/video.0')), { code: 'ENOENT' });
  await store.upload('aborted', 'video', 0, 'video/mp4', body('complete'));
  assert.equal(await fs.readFile(path.join(root, 'parts/aborted/video.0'), 'utf8'), 'complete');
});

test('rejects malformed completion data while preserving uploaded chunks', async t => {
  const { root, store } = await setup(t);
  await store.upload('valid', 'video', 0, 'video/mp4', body('bytes'));
  for (const request of [null, { streams: [null] }, { streams: [{ id: 1, count: 1 }] },
    { streams: [{ id: 'video', count: 1 }], metadata: null },
    { streams: [{ id: 'video', count: 1 }], metadata: { title: 123 } }]) {
    await assert.rejects(store.complete('valid', request), { status: 400 });
  }
  assert.equal(await fs.readFile(path.join(root, 'parts/valid/video.0'), 'utf8'), 'bytes');
});

test('an exclusive-open conflict never deletes an existing part', async t => {
  const { root, store } = await setup(t);
  const directory = path.join(root, 'parts', 'old');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'video.0'), 'previous bytes');
  await assert.rejects(store.upload('old', 'video', 0, 'video/mp4', body('new bytes')), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(directory, 'video.0'), 'utf8'), 'previous bytes');
});

test('long Unicode titles fit within filesystem component limits', () => {
  const title = filename('🎬'.repeat(100));
  assert.ok(Buffer.byteLength(title) <= 120);
  assert.ok(!title.includes('\ufffd'));
});
