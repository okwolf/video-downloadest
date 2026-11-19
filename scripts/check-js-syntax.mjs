import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceExtensions = new Set(['.js', '.mjs', '.cjs']);
const ignoredDirectories = new Set(['.git', 'dist', 'node_modules']);
const sources = [];

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) await collect(fullPath);
    } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      sources.push(fullPath);
    }
  }
}

await collect(projectRoot);
if (sources.length === 0) {
  console.error('No JavaScript source files were found.');
  process.exitCode = 1;
} else {
  let failures = 0;
  for (const source of sources) {
    const result = spawnSync(process.execPath, ['--check', source], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      failures++;
      console.error(path.relative(projectRoot, source));
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.error) console.error(result.error);
    }
  }
  if (failures > 0) {
    console.error(`Syntax errors found in ${failures} of ${sources.length} JavaScript source files.`);
    process.exitCode = 1;
  } else {
    console.log(`Syntax OK: checked ${sources.length} JavaScript source files.`);
  }
}
