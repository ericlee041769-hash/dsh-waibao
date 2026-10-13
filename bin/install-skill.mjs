#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills', 'dsh-waibao');
const template = await fs.readFile(path.join(root, 'skills/dsh-waibao/SKILL.md'), 'utf8');
await fs.mkdir(destination, {recursive: true});
await fs.writeFile(path.join(destination, 'SKILL.md'), template.replaceAll('__PACKAGE_ROOT__', root.replaceAll('\\', '/')).replaceAll('__NODE__', process.execPath.replaceAll('\\', '/')));
console.log(`Installed Codex skill: ${path.join(destination, 'SKILL.md')}`);
