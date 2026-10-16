let port;
window.onmessage = (e) => {
  if (e.data === new URLSearchParams(location.search).get("secret")) {
    window.onmessage = null;
    navigator.serviceWorker.ready.then((swr) => {
      swr.active.postMessage("port", [e.ports[0]]);
    });
  }
};
