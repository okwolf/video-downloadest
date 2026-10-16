import express from "express";
import fs from "fs-extra";
import { extension } from "mime-types";
import mergeFiles from "merge-files";

const app = express();
const buffers = {};
app.post("/buffers/:bufferId/:bufferIndex", (req, res) => {
  const { bufferId, bufferIndex } = req.params;
  const { "content-type": bufferType } = req.headers;
  if (!bufferType) {
    return res.status(400).end();
  }
  if (buffers[bufferId]?.[bufferIndex]) {
    return res.status(409).end();
  }
  const fileName = `buffers/${bufferId}.${extension(bufferType)}`;
  const partName = `parts/${bufferId}.${bufferIndex}`;
  buffers[bufferId] = buffers[bufferId] || { fileName, bufferType, parts: [] };
  buffers[bufferId].parts[bufferIndex] = partName;
  fs.ensureFileSync(partName);
  const fd = fs.openSync(partName, "as");
  req.on("data", (chunk) => {
    fs.writeSync(fd, chunk);
  });
  req.on("end", () => {
    console.log(`${fileName} [${bufferIndex}]`);
    fs.closeSync(fd);
    res.status(202).end();
  });
});

app.post("/buffers/:bufferId", async (req, res) => {
  const { bufferId } = req.params;
  const buffer = buffers[bufferId];
  if (!buffer) {
    return res.status(404).end();
  }

  try {
    fs.ensureFileSync(buffer.fileName);
    await mergeFiles(buffer.parts, buffer.fileName);
    for (const partName of buffer.parts) {
      fs.unlinkSync(partName);
    }
    res.status(202).end();
    console.log(`${buffer.fileName} ✅`);
  } catch (err) {
    console.error(`${buffer.fileName} ❌`, err);
  }
});

app.listen(3000, () => {
  console.log("server started...");
});
