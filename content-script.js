let uploadPort;
const pendingMessages = [];
function forwardCapture(message) {
  if (uploadPort) uploadPort.postMessage(message);
  else pendingMessages.push(message);
}
document.addEventListener('ON_APPEND_BUFFER', ({ detail }) => forwardCapture({ appendBuffer: detail }));
document.addEventListener('ON_BUFFER_ENDED', ({ detail }) => forwardCapture({ bufferEnd: detail }));

const injectedScript = document.createElement("script");
injectedScript.src = chrome.runtime.getURL("injected-script.js");
document.documentElement.appendChild(injectedScript);
injectedScript.remove();

(async () => {
  const port = await makeExtensionFramePort("/iframe.html");
  port.onmessage = ({ data }) => {
    document.dispatchEvent(new CustomEvent("VIDEO_CAPTURE_RESULT", { detail: data }));
  };
  uploadPort = port;
  for (const message of pendingMessages) port.postMessage(message);
  pendingMessages.length = 0;
})();

async function makeExtensionFramePort(path) {
  const secret = Math.random().toString(36);
  const url = new URL(chrome.runtime.getURL(path));
  url.searchParams.set("secret", secret);
  const el = document.createElement("div");
  const root = el.attachShadow({ mode: "closed" });
  const iframe = document.createElement("iframe");
  iframe.hidden = true;
  root.appendChild(iframe);
  (document.body || document.documentElement).appendChild(el);
  await new Promise((resolve, reject) => {
    iframe.onload = resolve;
    iframe.onerror = reject;
    iframe.contentWindow.location.href = url;
  });
  const mc = new MessageChannel();
  iframe.contentWindow.postMessage(secret, "*", [mc.port2]);
  return mc.port1;
}
