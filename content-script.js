(() => {
let uploadPort;
let connection;
const pendingMessages = [];
const pendingLimit = 128 * 1024 * 1024;
let pendingBytes = 0;
const overlays = new Map();
const grants = new Map();
const createElement = document.createElement.bind(document);
let frame;
function sourceKey(player) {
  return player.srcObject || player.getAttribute('src') || player.currentSrc || '';
}
function revoke(player) {
  const overlay = overlays.get(player);
  if (!overlay?.sessionId) return;
  const sessionId = overlay.sessionId;
  for (let i = pendingMessages.length - 1; i >= 0; i--) {
    if (pendingMessages[i].detail.sessionId !== sessionId) continue;
    pendingBytes -= pendingMessages[i].detail.buffer?.byteLength || 0;
    pendingMessages.splice(i, 1);
  }
  grants.delete(overlay.sessionId);
  overlay.sessionId = undefined;
  overlay.button.hidden = false;
  overlay.text.hidden = true;
}
function grantFor(detail) {
  const grant = grants.get(detail?.sessionId);
  if (!grant || !grant.player.isConnected) return;
  const key = sourceKey(grant.player);
  if (grant.source && grant.source !== key) { revoke(grant.player); return; }
  if (key) grant.source = key;
  if (detail.captureId) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(detail.captureId)) return;
    if (grant.captureId && grant.captureId !== detail.captureId) return;
    grant.captureId = detail.captureId;
  }
  return grant;
}
function failGrant(grant, reason) {
  if (grant.failed) return;
  grant.failed = true;
  for (let i = pendingMessages.length - 1; i >= 0; i--) {
    if (pendingMessages[i].detail.sessionId !== grant.sessionId) continue;
    pendingBytes -= pendingMessages[i].detail.buffer?.byteLength || 0;
    pendingMessages.splice(i, 1);
  }
  const overlay = overlays.get(grant.player);
  if (overlay) overlay.text.textContent = `❌ ${reason} Reload the page before trying this video again.`;
}
function forwardCapture(message, detail) {
  const grant = grantFor(detail);
  if (!grant || grant.failed) return;
  const bytes = detail.buffer?.byteLength || 0;
  if (uploadPort) uploadPort.postMessage(message);
  else if (pendingBytes + bytes > pendingLimit) failGrant(grant, 'The upload queue filled.');
  else { pendingMessages.push({ message, detail }); pendingBytes += bytes; }
}
document.addEventListener('ON_APPEND_BUFFER', ({ detail }) => forwardCapture({ appendBuffer: detail }, detail));
document.addEventListener('ON_BUFFER_ENDED', ({ detail }) => forwardCapture({ bufferEnd: detail }, detail));
document.addEventListener('VIDEO_CAPTURE_STATUS', ({ detail }) => {
  const grant = grantFor(detail);
  if (grant && !grant.failed && !grant.saved) overlays.get(grant.player).text.textContent = String(detail.text || '');
});
document.addEventListener('VIDEO_CAPTURE_RESET', ({ detail }) => {
  for (const player of overlays.keys()) if (player.getAttribute('data-video-downloadest-id') === detail?.playerId) revoke(player);
});
function findPlayer(playerId, root = document) {
  if (typeof playerId !== 'string') return;
  for (const player of root.querySelectorAll('video')) {
    if (player.getAttribute('data-video-downloadest-id') === playerId) return player;
  }
  for (const element of root.querySelectorAll('*')) {
    const shadow = chrome.dom.openOrClosedShadowRoot(element);
    if (shadow) {
      const player = findPlayer(playerId, shadow);
      if (player) return player;
    }
  }
}
document.addEventListener('VIDEO_CAPTURE_PLAYER', ({ detail }) => {
  const player = findPlayer(detail?.playerId);
  if (player) ensureOverlay(player);
});
function positionOverlays() {
  for (const [player, overlay] of overlays) {
    if (!player.isConnected) {
      revoke(player);
      overlay.host.remove();
      overlays.delete(player);
      continue;
    }
    if (overlay.sessionId) grantFor({ sessionId: overlay.sessionId });
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && fullscreen !== player && fullscreen.contains(player)
      ? fullscreen : document.documentElement;
    if (overlay.host.parentNode !== parent) parent.appendChild(overlay.host);
    const rect = player.getBoundingClientRect();
    const prompt = !overlay.sessionId;
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
  frame = overlays.size ? requestAnimationFrame(positionOverlays) : undefined;
}
function ensureOverlay(player) {
  if (!player.isConnected || overlays.has(player)) return;
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

  const overlay = { host, button, text };
  overlays.set(player, overlay);
  button.addEventListener('click', event => {
    if (!event.isTrusted || overlay.sessionId) return;
    event.preventDefault();
    event.stopPropagation();
    const sessionId = crypto.randomUUID();
    overlay.sessionId = sessionId;
    grants.set(sessionId, { player, sessionId, source: sourceKey(player) });
    button.hidden = true;
    text.hidden = false;
    text.textContent = '📥 Download enabled; waiting for media…';
    connectUploader().catch(error => { text.textContent = `❌ Upload connection failed: ${error.message}`; });
    player.dispatchEvent(new CustomEvent('VIDEO_CAPTURE_ENABLE', { detail: { sessionId } }));
  });
  if (frame === undefined) positionOverlays();
}
function connectUploader() {
  if (connection) return connection;
  connection = makeExtensionFramePort('/iframe.html').then(port => {
    port.onmessage = ({ data }) => {
      for (const grant of grants.values()) {
        if (grant.captureId !== data.captureId) continue;
        const overlay = overlays.get(grant.player);
        if (data.error) failGrant(grant, `Capture failed: ${data.error}`);
        else if (overlay) { grant.saved = true; overlay.text.textContent = `✅ Saved: ${data.file}`; }
      }
    };
    uploadPort = port;
    for (const { message, detail } of pendingMessages) {
      const grant = grantFor(detail);
      if (grant && !grant.failed) port.postMessage(message);
    }
    pendingMessages.length = 0;
    pendingBytes = 0;
  }).catch(error => {
    for (const grant of grants.values()) failGrant(grant, `Upload connection failed: ${error.message}.`);
    pendingMessages.length = 0;
    pendingBytes = 0;
    connection = undefined;
    throw error;
  });
  return connection;
}
async function makeExtensionFramePort(path) {
  const secret = crypto.randomUUID();
  // A web-accessible iframe alone is not authority to use localhost permissions.
  // Only this isolated script can create its one-use connection capability.
  await chrome.storage.local.set({ [`upload-port-${secret}`]: Date.now() + 60000 });
  const url = new URL(chrome.runtime.getURL(path));
  url.searchParams.set("secret", secret);
  const el = document.createElement("div");
  const root = el.attachShadow({ mode: "closed" });
  const iframe = document.createElement("iframe");
  iframe.hidden = true;
  root.appendChild(iframe);
  (document.body || document.documentElement).appendChild(el);
  let channel;
  try {
    await new Promise((resolve, reject) => {
      iframe.onload = resolve;
      iframe.onerror = () => reject(new Error('Upload frame did not load.'));
      iframe.contentWindow.location.href = url;
    });
    const mc = new MessageChannel();
    channel = mc;
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Upload frame did not connect.')), 10000);
      mc.port1.onmessage = ({ data }) => {
        if (data?.ready !== true) return;
        clearTimeout(timer);
        mc.port1.onmessage = null;
        resolve();
      };
    });
    iframe.contentWindow.postMessage(secret, "*", [mc.port2]);
    await ready;
    return mc.port1;
  } catch (error) {
    channel?.port1.close?.();
    channel?.port2.close?.();
    el.remove();
    throw error;
  } finally {
    try { await chrome.storage.local.remove(`upload-port-${secret}`); }
    catch { /* The frame already consumes its one-use capability on success. */ }
  }
}

document.dispatchEvent(new CustomEvent('VIDEO_CAPTURE_READY'));
})();
