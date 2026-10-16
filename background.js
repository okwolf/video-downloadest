self.onmessage = (e) => {
  if (e.data === "port") {
    e.ports[0].onmessage = onContentMessage;
  }
};

function onContentMessage({ data }) {
  if (data.appendBuffer) {
    console.log("appendBuffer", data.appendBuffer);
    const { bufferId, bufferType, bufferIndex, buffer } = data.appendBuffer;
    fetch(`http://localhost:3000/buffers/${bufferId}/${bufferIndex}`, {
      method: "POST",
      headers: {
        "content-type": bufferType
      },
      body: buffer
    });
  } else if (data.bufferEnd) {
    console.log("bufferEnd", data.bufferEnd);
    fetch(`http://localhost:3000/buffers/${data.bufferEnd.bufferId}`, {
      method: "POST"
    });
  }
}
