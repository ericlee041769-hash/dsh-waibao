#!/usr/bin/env node
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { connectionFile } from '../src/paths.mjs';

const [action, specPath, ...extra] = process.argv.slice(2);
try {
  if (!action || action === '--help') {
    console.log('dsh-waibao describe | adopt <absolute-spec.json> | run <absolute-spec.json>');
    process.exit(0);
  }
  if (!['describe', 'adopt', 'run'].includes(action) || extra.length || (action !== 'describe' && (!specPath || !path.isAbsolute(specPath)))) throw new Error('Usage: dsh-waibao describe | adopt <spec.json> | run <spec.json>');
  const spec = action === 'describe' ? {} : JSON.parse(fs.readFileSync(specPath, 'utf8').replace(/^\uFEFF/, ''));
  const request = {action, workspace: spec.workspace, workspaceTitle: spec.workspaceTitle, sessionId: spec.sessionId, title: spec.title, selection: spec.selection, requestId: spec.requestId};
  if (action === 'run') {
    if (!path.isAbsolute(spec.workspace ?? '') || !path.isAbsolute(spec.bindingPath ?? '') || !path.isAbsolute(spec.promptFile ?? '')) throw new Error('Absolute workspace, bindingPath and promptFile required');
    const relative = path.relative(spec.workspace, spec.bindingPath);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('bindingPath must be inside the task workspace');
    if (fs.existsSync(spec.bindingPath)) {
      const binding = JSON.parse(fs.readFileSync(spec.bindingPath, 'utf8'));
      if (path.normalize(binding.workspace) !== path.normalize(spec.workspace)) throw new Error('Binding workspace mismatch');
      if (spec.sessionId && spec.sessionId !== binding.sessionId) throw new Error('Binding session mismatch');
      if (binding.transport !== 'desktop') throw new Error('Import the existing session into desktop before continuing');
      request.sessionId = binding.sessionId;
      request.expectedSelection = binding.selection;
    }
    request.prompt = fs.readFileSync(spec.promptFile, 'utf8').replace(/^\uFEFF/, '');
  }
  const connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(connection.pipe);
    let done = false;
    const lines = createInterface({input: socket, crlfDelay: Infinity});
    socket.on('connect', () => socket.write(JSON.stringify({...request, token: connection.token}) + '\n'));
    socket.on('error', reject);
    lines.on('line', line => {
      try {
        const event = JSON.parse(line);
        if (event.type === 'session') {
          const binding = {transport: 'desktop', sessionId: event.sessionId, workspace: event.cwd, workspaceId: event.workspaceId, selection: event.selection, lastRequestId: spec.requestId, lastJobId: process.env.DSH_CODEX_JOB_ID ?? null};
          fs.mkdirSync(path.dirname(spec.bindingPath), {recursive: true});
          const temporary = `${spec.bindingPath}.${process.pid}.tmp`;
          fs.writeFileSync(temporary, JSON.stringify(binding, null, 2) + '\n');
          fs.renameSync(temporary, spec.bindingPath);
        }
        process.stdout.write(line + '\n');
        if (event.type === 'done') { done = true; process.exitCode = event.exitCode; }
      } catch (error) { socket.destroy(); reject(error); }
    });
    socket.on('close', () => {
      lines.close();
      if (done) resolve();
      else reject(new Error('Desktop connection ended before completion; inspect the saved session before any retry. The desktop may still be running the task.'));
    });
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
