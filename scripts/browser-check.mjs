// Real DOM and trusted-input checks without third-party automation dependencies.
// Uses a disposable Chrome profile and simulates manifest MAIN/ISOLATED worlds
// through CDP; localhost uploads are recorded instead of sent to the user's server.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runFFmpeg } from '../capture-store.js';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'video-browser-'));
let chrome, socket, server;
try {
  const mediaPath = path.join(temporary, 'fixture.mp4');
  await runFFmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10', '-t', '10',
    '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', mediaPath]);
  const media = await fs.readFile(mediaPath);
  const html = `<!doctype html><style>body{margin:24px;background:#eee}video{display:block}button{margin:8px}</style>
    <div id="box" style="width:640px"><video id="video" width="640" height="360" controls muted autoplay></video><button id="normal">Play normally</button></div><button id="outside">Unrelated button</button>
    <script>
      window.earlySource = new MediaSource();
      video.src = URL.createObjectURL(earlySource);
      window.originalBytes = fetch('/fixture.mp4').then(r => r.arrayBuffer());
      earlySource.addEventListener('sourceopen', async () => {
        window.earlyBuffer = earlySource.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
        earlyBuffer.addEventListener('updateend', () => window.preloaded = true, {once:true});
        earlyBuffer.appendBuffer(await originalBytes);
      }, {once:true});
      normal.onclick = () => video.play().catch(e => window.playError = e.message);
    </script>`;
  server = http.createServer((req, res) => {
    if (req.url === '/fixture.mp4') { res.setHeader('Content-Type', 'video/mp4'); res.end(media); }
    else if (req.url.startsWith('/iframe.html')) res.end('<!doctype html><script>onmessage=e=>e.ports[0]?.postMessage({ready:true})</script>');
    else { res.setHeader('Content-Type', 'text/html'); res.end(html); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const executable = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  chrome = spawn(executable, ['--headless=new', '--disable-background-networking', '--disable-component-update', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${path.join(temporary, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Chrome did not start')), 15000);
    chrome.once('error', error => finish(error));
    chrome.once('exit', (code, signal) => finish(new Error(`Chrome exited before DevTools started (${code ?? signal})`)));
    chrome.stderr.on('data', chunk => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) finish(null, match[1]);
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0, isolatedId, mainFrameId;
  const pending = new Map(), errors = [];
  const failPending = error => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
  };
  socket.onclose = () => failPending(new Error('Chrome DevTools connection closed'));
  socket.onerror = () => failPending(new Error('Chrome DevTools connection failed'));
  socket.onmessage = ({ data }) => {
    const event = JSON.parse(data);
    if (event.id) {
      const waiter = pending.get(event.id); pending.delete(event.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        if (event.error) waiter.reject(new Error(JSON.stringify(event.error))); else waiter.resolve(event.result);
      }
    }
    if (event.method === 'Runtime.executionContextCreated' && event.params.context.name === 'review-extension' && event.params.context.auxData.frameId === mainFrameId) isolatedId = event.params.context.id;
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome DevTools timed out: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ id, method, params, sessionId })); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);
  await call('Page.enable'); await call('Runtime.enable'); await call('DOM.enable');
  mainFrameId = (await call('Page.getFrameTree')).frameTree.frame.id;
  await call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1000, deviceScaleFactor: 1, mobile: false });
  const injected = await fs.readFile(new URL('../injected-script.js', import.meta.url), 'utf8');
  const bridge = (await fs.readFile(new URL('../content-script.js', import.meta.url), 'utf8')).replace('catch { /* Ignore malformed', 'catch (error) { globalThis.reviewBridgeError=error.stack; /* Ignore malformed');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: injected });
  const stubs = `globalThis.reviewUploads=[];
    globalThis.reviewShadowRoots=new Map();
    globalThis.chrome={dom:{openOrClosedShadowRoot:element=>reviewShadowRoots.get(element)||element.shadowRoot},runtime:{getURL:p=>location.origin+p},storage:{local:{set:async()=>{},remove:async()=>{}}}};
    const NativeMessageChannel=MessageChannel;
    globalThis.MessageChannel=function(){const channel=new NativeMessageChannel();const post=channel.port1.postMessage.bind(channel.port1);
      channel.port1.postMessage=message=>{reviewUploads.push(message);post(message)};return channel};`;
  await call('Page.addScriptToEvaluateOnNewDocument', { source: stubs + bridge, worldName: 'review-extension' });
  const evaluate = async (expression, isolated = false) => {
    const result = await call('Runtime.evaluate', { expression, contextId: isolated ? isolatedId : undefined, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression, isolated = false) => {
    const deadline = Date.now() + 8000;
    while (!await evaluate(expression, isolated)) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${expression}; browser errors: ${JSON.stringify(errors)}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const clickAt = async (x, y) => {
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x, y });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x, y });
  };
  const clickElement = async id => {
    const rect = await evaluate(`(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await clickAt(rect.x, rect.y);
  };
  const downloadButtons = async () => {
    const { root } = await call('DOM.getDocument', { depth: -1, pierce: true });
    const buttons = [];
    const walk = node => {
      if (node.nodeName === 'BUTTON' && node.children?.some(child => child.nodeName === 'svg' || child.localName === 'svg')) buttons.push(node.nodeId);
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) walk(child);
    }; walk(root); return buttons;
  };
  const clickDownload = async (index = 0) => {
    const buttons = await downloadButtons();
    if (!buttons[index]) console.log('Missing button:', await evaluate('globalThis.reviewBridgeError', true), await evaluate('document.documentElement.outerHTML'), JSON.stringify(errors));
    assert.ok(buttons[index], 'Download button exists');
    const { model } = await call('DOM.getBoxModel', { nodeId: buttons[index] });
    await clickAt((model.content[0] + model.content[4]) / 2, (model.content[1] + model.content[5]) / 2);
  };
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await until('window.preloaded === true');
  assert.equal(await evaluate('Boolean(earlyBuffer.capture)'), true, 'Earliest inline MediaSource is hooked');
  assert.equal(await evaluate('video.paused'), true, 'Autoplay is blocked');
  await clickElement('outside');
  assert.equal(await evaluate("video.play().then(()=>false,e=>e.name==='NotAllowedError')"), true, 'Unrelated trusted click does not allow playback');
  await evaluate("document.dispatchEvent(new CustomEvent('ON_APPEND_BUFFER',{detail:{sessionId:'fake',captureId:'fake',buffer:new Uint8Array([1])}}))");
  assert.equal(await evaluate('reviewUploads.length', true), 0, 'Forged events are rejected');
  await clickElement('normal'); await until('!video.paused');
  assert.equal(await evaluate('reviewUploads.length', true), 0, 'Manual controls do not download');
  await evaluate(`window.lazyBox=document.createElement('div');
    lazyBox.innerHTML='<video id="lazyVideo" width="320" height="180" muted preload="none"></video><button id="lazyPlay">Load and play</button>';
    document.body.append(lazyBox);
    lazyPlay.onclick=()=>{lazyVideo.src='/fixture.mp4';lazyVideo.load();lazyVideo.play().catch(e=>window.lazyError=e.message)}`);
  await clickElement('lazyPlay');
  await until('!lazyVideo.paused && lazyVideo.readyState >= 2');
  assert.equal(await evaluate('reviewUploads.length', true), 0, 'Lazy manual playback does not download');
  await evaluate('lazyBox.remove();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await evaluate('video.pause();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await clickDownload();
  await until('reviewUploads.length === 1', true);
  assert.equal(await evaluate('reviewUploads[0].appendBuffer.bufferIndex', true), 0, 'Preload replay starts at zero');
  await evaluate(`window.oldBuffer=earlyBuffer;
    window.nextSource=new MediaSource(); video.src=URL.createObjectURL(nextSource);
    nextSource.addEventListener('sourceopen',async()=>{
      window.nextBuffer=nextSource.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
      nextBuffer.addEventListener('updateend',()=>window.nextReady=true,{once:true});nextBuffer.appendBuffer(await originalBytes)
    },{once:true})`);
  await until('window.nextReady === true');
  assert.equal(await evaluate('reviewUploads.length', true), 1, 'New source is not automatically uploaded');
  assert.equal(await evaluate('video.paused'), true);
  await until('oldBuffer.capture.disposed === true');
  await clickDownload(); await until('reviewUploads.length === 2', true);
  await evaluate(`window.shadowHost=document.createElement('section');
    const root=shadowHost.attachShadow({mode:'closed'});root.innerHTML='<video width="320" height="180" autoplay muted></video>';
    document.body.append(shadowHost);window.shadowVideo=root.querySelector('video')`);
  await until('shadowVideo.autoplay === false');
  const { root: tree } = await call('DOM.getDocument', { depth: -1, pierce: true });
  const closedHosts = [];
  const visit = node => { if (node.shadowRoots?.length) closedHosts.push(node); for (const child of node.children || []) visit(child); };
  visit(tree);
  for (const host of closedHosts) {
    const { object: hostObject } = await call('DOM.resolveNode', { nodeId: host.nodeId, executionContextId: isolatedId });
    const { object: rootObject } = await call('DOM.resolveNode', { nodeId: host.shadowRoots[0].nodeId, executionContextId: isolatedId });
    await call('Runtime.callFunctionOn', { objectId: hostObject.objectId, functionDeclaration: 'function(root){globalThis.reviewShadowRoots.set(this,root)}', arguments: [{ objectId: rootObject.objectId }] });
  }
  await evaluate("document.dispatchEvent(new CustomEvent('VIDEO_CAPTURE_READY'))");
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.equal((await downloadButtons()).length, 2, 'Closed shadow-root video gets an overlay');
  assert.equal(await evaluate("shadowVideo.play().then(()=>false,e=>e.name==='NotAllowedError')"), true);
  await evaluate('shadowHost.remove();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.equal((await downloadButtons()).length, 1, 'Detached shadow-root overlay is removed');
  await evaluate('document.body.append(shadowHost);new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.equal((await downloadButtons()).length, 2, 'Reattached closed shadow-root video regains its overlay');
  await evaluate('shadowVideo.autoplay=true');
  await until('shadowVideo.autoplay === false');
  await evaluate('window.retired=nextBuffer; video.remove(); shadowHost.remove()');
  await until('retired.capture.disposed === true');
  await until('document.querySelectorAll("video").length === 0');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('Browser checks passed: early hooks, isolated consent, trusted controls, preload replay, source reset, shadow DOM, cleanup.');
} finally {
  socket?.close();
  if (chrome?.pid && chrome.exitCode === null) {
    const exited = once(chrome, 'exit');
    chrome.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
  }
  if (server) await new Promise(resolve => server.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
