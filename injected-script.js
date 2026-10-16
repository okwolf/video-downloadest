const videoElements = [];
document.OGCreateElement = document.createElement;
document.createElement = function (...args) {
  const newElement = document.OGCreateElement(...args);
  if (newElement.tagName.toLowerCase() === "video") {
    newElement.videoId = crypto.randomUUID();
    // console.log("CREATING VIDEO", newElement);
    newElement.videoTracks.addEventListener("addtrack", (event) => {
      // console.log("Video track added", event.track);
      event.track.sourceBuffer.videoId = newElement.videoId;
    });
    newElement.addEventListener("ended", () => {
      console.log("SAVE THE BUFFERS NAO!!!", newElement);
      const bufferIds = [];
      for (const videoTrack of newElement?.videoTracks) {
        if (videoTrack?.sourceBuffer?.bufferId) {
          bufferIds.push(videoTrack.sourceBuffer.bufferId);
        }
      }
      for (const audioTrack of newElement?.audioTracks) {
        if (audioTrack?.sourceBuffer?.bufferId) {
          bufferIds.push(audioTrack.sourceBuffer.bufferId);
        }
      }
      for (const bufferId of bufferIds) {
        document.dispatchEvent(
          new CustomEvent("ON_BUFFER_ENDED", {
            detail: {
              bufferId
            }
          })
        );
      }
    });
    videoElements.push(newElement);
  }
  return newElement;
};

const printBufferedWithPrefix = (buffer, prefix) => {
  if (buffer.buffered.length > 0) {
    console.log(
      prefix,
      [...Array(buffer.buffered.length)]
        .map(
          (_, i) => `(${buffer.buffered.start(i)},${buffer.buffered.end(i)})`
        )
        .join(",")
    );
  }
};

const OGMediaSource = window.MediaSource;
window.MediaSource = function (...args) {
  const newSource = new OGMediaSource(...args);
  newSource.OGaddSourceBuffer = newSource.addSourceBuffer;
  newSource.addSourceBuffer = function (...args) {
    const [bufferType] = args;
    // console.log("CAUGHT YA ADDING A BUFFER", bufferType);
    const newBuffer = newSource.OGaddSourceBuffer(...args);
    newBuffer.ogAppendBuffer = newBuffer.appendBuffer;
    newBuffer.bufferId = crypto.randomUUID();
    let bufferIndex = -1;
    newBuffer.appendBuffer = function (...args) {
      const [buffer] = args;
      bufferIndex++;
      console.log("CAUGHT YA APPENDING", bufferType);
      // printBufferedWithPrefix(
      //   newBuffer,
      //   `BEFORE APPEND BUFFER [${bufferType}]`
      // );
      const appendBufferResults = newBuffer.ogAppendBuffer(...args);
      printBufferedWithPrefix(newBuffer, `AFTER APPEND BUFFER [${bufferType}]`);

      document.dispatchEvent(
        new CustomEvent("ON_APPEND_BUFFER", {
          detail: {
            bufferId: newBuffer.bufferId,
            bufferType,
            bufferIndex,
            buffer
          }
        })
      );
      return appendBufferResults;
    };
    newBuffer.addEventListener("updateend", () => {
      if (newBuffer.buffered.length > 0) {
        const lastBufferIndex = newBuffer.buffered.length - 1;
        // printBufferedWithPrefix(newBuffer, `UPDATEEND BUFFER [${bufferType}]`);
        for (const videoElement of videoElements) {
          for (const videoTrack of videoElement.videoTracks) {
            if (videoTrack.sourceBuffer === newBuffer) {
              videoElement.currentTime =
                newBuffer.buffered.end(lastBufferIndex);
              // videoElement.currentTime =
              //   (videoElement.currentTime +
              //     newBuffer.buffered.end(lastBufferIndex)) /
              //   2;
            }
          }
        }
      }
    });
    return newBuffer;
  };
  return newSource;
};
for (const key in OGMediaSource) {
  window.MediaSource[key] = OGMediaSource[key];
}
