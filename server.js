import express from "express";
import { fileURLToPath } from "node:url";
import { createCaptureStore, validateMetadata } from "./capture-store.js";

export function createApp(
  store = createCaptureStore(fileURLToPath(new URL(".", import.meta.url)))
) {
  const app = express();
  app.post(
    "/captures/:captureId/streams/:streamId/:index",
    async (req, res, next) => {
      res.locals.captureRoute = { kind: "upload", ...req.params };
      try {
        if (!/^\d+$/.test(req.params.index))
          return res.status(400).json({ error: "Invalid chunk index" });
        let metadata = {};
        if (req.headers["x-capture-metadata"]) {
          try {
            metadata = JSON.parse(decodeURIComponent(req.headers["x-capture-metadata"]));
          } catch {
            throw Object.assign(new Error("Invalid capture metadata"), { status: 400 });
          }
        }
        validateMetadata(metadata);
        await store.upload(
          req.params.captureId,
          req.params.streamId,
          Number(req.params.index),
          req.headers["content-type"],
          req
        );
        console.log(
          `📥 Received ${store.expectedFilename(req.params.captureId, metadata)} [${req.params.index}]`
        );
        res.status(201).end();
      } catch (error) {
        next(error);
      }
    }
  );
  app.post(
    "/captures/:captureId/complete",
    (req, res, next) => {
      res.locals.captureRoute = { kind: "complete", ...req.params };
      next();
    },
    express.json({ limit: "64kb" }),
    async (req, res, next) => {
      try {
        const file = await store.complete(req.params.captureId, req.body);
        console.log(`✅ Saved ${file}`);
        res.json({ file });
      } catch (error) {
        next(error);
      }
    }
  );
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const route = res.locals.captureRoute || {};
    if (
      req.aborted ||
      error.code === "ECONNRESET" ||
      error.code === "ERR_STREAM_PREMATURE_CLOSE"
    ) {
      console.warn(
        `⚠️ Upload interrupted: ${route.captureId}/${route.streamId} [${route.index}]; waiting for retry.`
      );
      return;
    }
    const context = route.kind === "complete"
      ? `Capture ${route.captureId}`
      : `Upload ${route.captureId}/${route.streamId} [${route.index}]`;
    console.error(`❌ ${context} failed:`, error.status && error.status < 500 ? error.message : error);
    res.status(error.status || 500).json({ error: error.message });
  });
  return app;
}
const entry = process.argv[1];
const serverPath = fileURLToPath(import.meta.url);
if (entry === serverPath || (entry && `${entry}.js` === serverPath)) {
  createApp().listen(3000, "127.0.0.1", () =>
    console.log("Capture server listening on http://localhost:3000")
  );
}
