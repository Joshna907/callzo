import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// Resolve relative to the script, not the caller's working directory.
const path = new URL('../.env', import.meta.url);
const template = new URL('../.env.example', import.meta.url);
let content = readFileSync(existsSync(path) ? path : template, 'utf8');
if (!/^API_KEY=.+$/m.test(content)) {
  const line = `API_KEY=${randomBytes(32).toString('hex')}`;
  content = /^API_KEY=.*$/m.test(content)
    ? content.replace(/^API_KEY=.*$/m, line)
    : `${content.trimEnd()}\n${line}\n`;
  writeFileSync(path, content, { mode: 0o600 });
  console.log('Generated a private API key in task1/.env. No key was printed.');
} else {
  console.log('Existing task1/.env API key preserved.');
}
