# Video Downloadest

Captures MediaSource audio/video chunks through a Chromium extension and sends them to a local Node.js server. Streams from the same MediaSource form one capture; separate players do not get mixed together.

## Run

1. Install Node.js and FFmpeg (the `ffmpeg` executable must be on PATH, or set `FFMPEG_PATH`).
2. Run `npm install` and `npm start`.
3. Load this directory as an unpacked extension in Chromium's extensions page. After updating the extension, reload it and reload the player page.
4. Videos stay paused until you choose playback: the extension removes autoplay attributes and blocks automatic `play()` calls. Click **Download & play** on the video you want to save. The button appears centered horizontally in the lower third of each paused video, including videos added after page load. Keep the page open until the progress overlay reports `✅ Saved`. The player’s existing play controls play normally without uploading, saving, or automatic seeking.

The extension finishes a capture on a successful `MediaSource.endOfStream()` or the player's `ended` event. It waits for every upload, validates the complete chunk manifest, concatenates each stream in append order, and uses FFmpeg stream copy to mux audio and video into one file under `buffers/`, preserving the video SourceBuffer container (for example, MP4 → `.mp4`, WebM → `.webm`). Audio-only and already-muxed streams are also supported. Audio-only MP4 uses `.m4a`. Codecs are copied without re-encoding; unsupported containers or incompatible audio cause an error and retain the captured chunks rather than changing formats. Filenames use Media Session title, player title/accessible label, Open Graph title, then document title, with a capture ID to avoid collisions. Unsafe filename characters are replaced.

Uploads and retry queues run inside the extension iframe attached to the player page, without a background service worker. Keep that page open until saving completes; navigating away, reloading the extension, or discarding the tab loses queued data.

The server listens only on `127.0.0.1:3000`. A progress overlay on the associated video shows chunks, MiB captured, currently buffered seconds, and buffered percentage when duration is known. It updates on SourceBuffer updates and shows the final save or failure result. Errors also appear in the server console. Failed merges retain chunks under `parts/`; the same completion request can be retried while the server stays running. Restarting the server does not restore capture state. Interrupted uploads discard the incomplete part and retry up to three times with increasing delays. Retrying an already received part is safe when its bytes match. If retries are exhausted, completion stops; reload the player to start a fresh capture. Keep the player page open: retries cannot recover queued bytes after its extension context closes.

## Scope

Captures unencrypted MediaSource streams created in the page's main JavaScript context. Direct media URLs, worker-owned MediaSources, DRM-protected media, and endless live streams are not supported. Uploading and saving start only after clicking **Download & play** for that video. To support players that preload before the click, the extension keeps copies of appended chunks in page memory (up to 64 MiB per MediaSource and 128 MiB per frame). It sends these chunks in their original order only after opting in, including when the source has already finished buffering. Normal playback never sends chunks to the server. If the cache limit is exceeded, that source’s cached bytes are released and the overlay asks you to reload and opt in sooner; it never saves a partial capture. Reloading or closing the page clears the cache. During capture, seeking, codec changes, timestamp edits, or quality switches may produce discontinuities that a simple stream-copy merge cannot repair. On video buffer updates, the extension advances only the opted-in player to the end of the buffered range. Ordinary playback is unaffected. Metadata availability depends on the player; players without exposed track associations may fall back to page metadata. A MediaSource is finalized once; players that reopen it after end-of-stream require a fresh capture.

## Verification

Run `npm test`. Tests cover opt-in capture, ordinary playback isolation, existing and dynamically inserted video overlays, preloaded chunk replay, already-buffered completion, cache limits, upload connection startup, chunk ordering, missing/duplicate chunks, stream isolation, filename safety, failed merge retries, extension metadata and completion ordering, and a real FFmpeg audio/video merge. FFmpeg with libx264 and AAC encoding is needed to generate test fixtures.
