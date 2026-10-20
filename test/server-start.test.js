import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createApp } from '../server.js';
import { createCaptureStore } from '../capture-store.js';

// Exercise the real entry-point guard without opening the user's port 3000.
for (const entry of ['server', 'server.js']) {
  test(`node ${entry} reaches listen`, async () => {
    const script = `
      import express from 'express';
      const original = express.application.listen;
      express.application.listen = function(port, host, ready) {
        if (port !== 3000 || host !== '127.0.0.1') throw new Error('Unexpected address');
        ready();
      };
      process.argv[1] = ${JSON.stringify(path.resolve(entry))};
      await import('./server.js');
      express.application.listen = original;
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, errors);
    assert.match(output, /Capture server listening/);
  });
}

test('extension iframe sends captured bytes to the real HTTP upload route', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-http-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createCaptureStore(root, async args => fs.writeFile(args.at(-1), 'muxed'));
  let expectedName;
  const originalExpectedFilename = store.expectedFilename;
  store.expectedFilename = (...args) => {
    expectedName = originalExpectedFilename(...args);
    return expectedName;
  };
  const server = createApp(store).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const script = await fs.readFile(new URL('../iframe.js', import.meta.url), 'utf8');
  let done;
  const completed = new Promise(resolve => { done = resolve; });
  const port = { postMessage: done };
  const context = { window: {}, parent: {}, location: { search: '?secret=test' }, URLSearchParams, fetch: (url, options) => fetch(url.replace('http://localhost:3000', origin), options) };
  vm.runInNewContext(script, context);
  context.window.onmessage({ source: context.parent, data: 'test', ports: [port] });
  port.onmessage({ data: { appendBuffer: { captureId: 'http-test', bufferId: 'video', bufferIndex: 0, bufferType: 'video/mp4', metadata: { title: 'Vidéo / title', videoType: 'video/mp4' }, buffer: new Uint8Array([1, 2, 3]) } } });
  port.onmessage({ data: { bufferEnd: { captureId: 'http-test', streams: [{ id: 'video', count: 1 }], metadata: { title: 'Vidéo / title' } } } });
  const result = await completed;
  assert.equal(result.error, undefined);
  assert.equal(expectedName, 'Vidéo _ title [http-test].mp4');
  assert.equal(path.basename(result.file), expectedName);
  assert.equal(await fs.readFile(result.file, 'utf8'), 'muxed');
});
