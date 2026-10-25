import vm from 'node:vm';
import fs from 'node:fs/promises';
const injected = await fs.readFile(new URL('../../injected-script.js', import.meta.url), 'utf8');
const bridge = await fs.readFile(new URL('../../content-script.js', import.meta.url), 'utf8');

export function setupPlayerPage({ existing = false, bridgeFirst = false, frameReady = true } = {}) {
  const messages = [], uploaded = [], observers = [], frames = [];
  let sequence = 0;
  let port;
  let framePort;
  function Element(tagName = 'div') {
    Object.assign(this, { tagName, children: [], listeners: new Map(), style: {}, hidden: false });
  }
  Element.prototype.addEventListener = function (name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  };
  Element.prototype.removeEventListener = function (name, callback) { this.listeners.get(name)?.delete(callback); };
  Element.prototype.dispatchEvent = function (event) {
    event.target ||= this;
    for (const callback of this.listeners.get(event.type) || []) callback(event);
    return true;
  };
  Element.prototype.appendChild = function (child) { child.parentNode = this; this.children.push(child); return child; };
  Element.prototype.remove = function () {
    this.removed = true;
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  };
  Object.defineProperty(Element.prototype, 'isConnected', {
    get() { return this.connected ?? (this.parentNode?.isConnected || this.host?.isConnected || false); },
    set(value) { this.connected = value; }
  });
  Element.prototype.querySelectorAll = function (selector) {
    return this.children.flatMap(child => [...(selector === '*' || child.tagName === selector ? [child] : []), ...child.querySelectorAll(selector)]);
  };
  Element.prototype.attachShadow = function ({ mode }) {
    const root = new Element('#shadow-root'); root.host = this; this.shadow = root;
    if (mode === 'open') this.shadowRoot = root;
    return root;
  };
  Element.prototype.hasAttribute = function (name) { return Boolean(this[name]); };
  Element.prototype.removeAttribute = function (name) { this[name] = name === 'autoplay' ? false : ''; };
  Element.prototype.setAttribute = function (name, value) { this[name] = value; };
  Element.prototype.getAttribute = function (name) { return this[name] || (name === 'title' ? 'Player title' : null); };
  Element.prototype.getBoundingClientRect = () => ({ left: 20, top: 30, width: 640, height: 360 });
  Element.prototype.contains = function (element) { return this.querySelectorAll('*').includes(element); };
  function HTMLMediaElement() { Element.call(this, 'video'); }
  HTMLMediaElement.prototype = Object.create(Element.prototype);
  HTMLMediaElement.prototype.play = function () {
    this.paused = false; this.playCalls = (this.playCalls || 0) + 1;
    this.dispatchEvent({ type: 'play' }); return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function () { this.paused = true; this.dispatchEvent({ type: 'pause' }); };
  function HTMLVideoElement() {
    HTMLMediaElement.call(this);
    Object.assign(this, { videoTracks: [], audioTracks: [], currentTime: 0, duration: 10, paused: true });
  }
  HTMLVideoElement.prototype = Object.create(HTMLMediaElement.prototype);
  function NativeMediaSource() {
    this.listeners = new Map();
    this.addEventListener = Element.prototype.addEventListener;
    this.removeEventListener = Element.prototype.removeEventListener;
    this.dispatchEvent = Element.prototype.dispatchEvent;
    this.addSourceBuffer = () => ({
      buffered: { length: 1, start: () => 0, end: () => 5 },
      appendBuffer(data) { if (!data.byteLength) throw new Error('invalid'); },
      addEventListener(name, callback) { this[name] = callback; }
    });
    this.endOfStream = () => {};
  }
  Object.defineProperty(NativeMediaSource, 'isTypeSupported', { value: () => true });
  const document = new Element('#document'); document.isConnected = true;
  document.documentElement = document.appendChild(new Element('html'));
  document.body = document.documentElement.appendChild(new Element('body'));
  document.querySelector = () => null;
  document.createTreeWalker = node => { if (!(node instanceof Element)) throw new TypeError('Not a Node'); return { currentNode: node }; };
  document.title = 'Page fallback';
  document.createElement = tag => {
    const element = tag === 'video' ? new HTMLVideoElement() : new Element(tag);
    if (tag === 'iframe') {
      const location = {};
      Object.defineProperty(location, 'href', { set() { queueMicrotask(() => element.onload?.()); } });
      element.contentWindow = { location, postMessage(secret, origin, [other]) { framePort = other; if (frameReady === true) other.postMessage({ ready: true }); } };
    }
    return element;
  };
  const dispatch = document.dispatchEvent.bind(document);
  document.dispatchEvent = event => {
    if (['ON_APPEND_BUFFER', 'ON_BUFFER_ENDED'].includes(event.type)) messages.push({ name: event.type, ...event.detail });
    return dispatch(event);
  };
  const createPlayer = () => document.body.appendChild(document.createElement('video'));
  const player = existing ? createPlayer() : undefined;
  const context = {
    Element, HTMLMediaElement, HTMLVideoElement, DOMException,
    URL: Object.assign(function (...args) { return new URL(...args); }, {
      createObjectURL: () => `blob:test-${sequence++}`, revokeObjectURL() {}
    }),
    MutationObserver: function (callback) {
      const state = { callback, observe(root) { state.root = root; }, disconnect() { state.root = null; } };
      observers.push(state); return state;
    },
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    setTimeout: frameReady === false ? callback => queueMicrotask(callback) : setTimeout, clearTimeout,
    document, window: { MediaSource: NativeMediaSource }, console,
    crypto: { randomUUID: () => `id-${sequence++}` }, navigator: { mediaSession: {}, userActivation: { isActive: false } },
    location: { href: 'https://example.test/watch' },
    CustomEvent: function (type, { detail } = {}) { return { type, detail }; },
    chrome: { dom: { openOrClosedShadowRoot: element => element.shadow }, storage: { local: { async set() {}, async remove() {} } }, runtime: { getURL: path => `chrome-extension://extension/${path.replace(/^\//, '')}` } },
    MessageChannel: function () { port = { postMessage: value => uploaded.push(value) }; return { port1: port, port2: { postMessage(value) { queueMicrotask(() => port.onmessage?.({ data: value })); } } }; }
  };
  // Separate lexical contexts: page code cannot access the isolated bridge's grants.
  if (bridgeFirst) vm.runInNewContext(bridge, { ...context });
  vm.runInNewContext(injected, context);
  if (!bridgeFirst) vm.runInNewContext(bridge, { ...context });
  const actualPlayer = player || createPlayer();
  const discover = () => { for (const state of [...observers]) if (state.root) state.callback(); };
  discover();
  const overlayHosts = () => document.documentElement.children.filter(el => el.shadow?.children[0]?.tagName === 'button');
  const tick = () => { const pending = frames.splice(0); for (const callback of pending) callback(); };
  const gesture = (target = actualPlayer, { trusted = true, key, path = [target] } = {}) => {
    const event = { type: key ? 'keydown' : 'pointerdown', key, isTrusted: trusted, composedPath: () => path };
    document.dispatchEvent(event);
  };
  return { messages, uploaded, context, player: actualPlayer, document, createPlayer, discover, frame: tick, gesture,
    get overlayHosts() { return overlayHosts(); },
    click(index = 0, trusted = true) {
      overlayHosts()[index].shadow.children[0].dispatchEvent({ type: 'click', isTrusted: trusted, preventDefault() {}, stopPropagation() {} });
    },
    releaseFrame() { framePort?.postMessage({ ready: true }); },
    result(data) { port.onmessage({ data }); },
    emit(type, detail) { document.dispatchEvent(new context.CustomEvent(type, { detail })); }
  };
}
