import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

test('authenticated desktop requests preserve identity, admission and cleanup', {skip: process.platform !== 'win32'}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'waibao-test-'));
  process.env.DSH_WAIBAO_DATA_DIR = path.join(root, 'private');
  const {apply} = await import('../src/host.mjs');
  const {connectionFile} = await import('../src/paths.mjs');
  const events = new EventEmitter();
  const agents = new Map();
  const selection = {provider: 'test', model: 'test-model', reasoningEffort: 'high'};
  let cleanup;
  let promptCount = 0;
  let selectionWrites = 0;
  let flushCount = 0;
  const ctx = {
    logger: {error: assert.fail, warn: assert.fail},
    on(name, fn) { events.on(name, fn); return () => events.off(name, fn); },
    emit: (...args) => events.emit(...args),
    effect(fn) { cleanup = fn(); },
    agentDefaultModel: {currentSelection: () => selection},
    llm: {resolveCallConfig: async value => value},
    sessions: {flush: async () => { flushCount++; }},
    workspaceRegistry: {create: async cwd => ({id: 'workspace', attachSession: async id => assert(agents.has(id)), cwd})},
    sessionController: {
      async inspect(id) { const agent = agents.get(id); if (!agent) throw new Error('Unknown session'); return {meta: {cwd: root, isSeeded: false}, events: agent.history}; },
      async create({sessionId}) {
        if (agents.has(sessionId)) return;
        const history = [];
        agents.set(sessionId, {history, status: 'idle', inbox: {nextTurn: [], nextStep: []}, session: {header: {cwd: root}, snapshotEvents: () => history}, whenIdle: async () => {}});
      },
      resolveAgent: async id => ({agent: agents.get(id)}),
      list: async () => ({items: [...agents.keys()].map(sessionId => ({sessionId}))}),
      rename: async () => {},
      agents: {selectionFor: () => ({current: selection}), selectForNextRequest: () => {selectionWrites++;}},
      async prompt(request, signal) {
        assert(signal instanceof AbortSignal);
        promptCount++;
        const agent = agents.get(request.sessionId);
        const turn = agent.history.length + 1;
        agent.history.push({type: 'user/message', data: {source: {rpcId: request.requestId}}});
        const emit = (type, data) => events.emit('session/event', agent.session, {type, data});
        emit('turn/start', {turn}); emit('step/start', {turn, step: 1});
        emit('assistant/message', {message: {content: [{type: 'text', text: `turn-${turn}`}]}, usage: {inputTokens: 10, cacheReadTokens: 90, outputTokens: 2, totalTokens: 102}});
        emit('step/end', {turn, step: 1}); emit('turn/end', {turn, reason: {kind: 'completed'}});
      }
    }
  };
  await apply(ctx);
  t.after(async () => {await cleanup(); await fs.rm(root, {recursive: true, force: true});});
  const connection = JSON.parse(await fs.readFile(connectionFile));
  // Keep the client socket open until Host acknowledges: a disconnect must not resend.
  async function request(body) {
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection(connection.pipe);
      let text = '';
      socket.setEncoding('utf8'); socket.on('error', reject);
      socket.on('connect', () => socket.write(JSON.stringify({token: connection.token, ...body}) + '\n'));
      socket.on('data', chunk => {text += chunk;});
      socket.on('end', () => resolve(text.trim().split('\n').filter(Boolean).map(JSON.parse)));
    });
  }
  const invalid = await request({action: 'describe', token: 'wrong'});
  assert.match(invalid[0].message, /Unauthenticated/);
  assert.equal(promptCount, 0);
  const base = {action: 'run', workspace: root, requestId: 'round-1', prompt: 'remember'};
  const first = await request(base);
  const session = first.find(event => event.type === 'session');
  assert(session.sessionId); assert.deepEqual(session.selection, selection);
  assert.equal(first.find(event => event.type === 'final').text, 'turn-1');
  assert.equal(first.at(-1).exitCode, 0);
  const second = await request({...base, sessionId: session.sessionId, requestId: 'round-2', expectedSelection: selection});
  assert.equal(second.find(event => event.type === 'final').text, 'turn-2');
  assert.equal(agents.size, 1); assert.equal(selectionWrites, 0); assert.equal(promptCount, 2);
  for (const body of [
    {...base, sessionId: session.sessionId},
    {...base, sessionId: 'unknown'},
    {...base, sessionId: session.sessionId, workspace: os.tmpdir()},
    {...base, sessionId: session.sessionId, requestId: 'round-3', expectedSelection: {...selection, model: 'other'}}
  ]) { assert.equal((await request(body)).at(-1).exitCode, 1); }
  agents.get(session.sessionId).status = 'running';
  assert.match((await request({...base, sessionId: session.sessionId, requestId: 'round-3'}))[0].message, /busy/);
  agents.get(session.sessionId).status = 'idle';
  assert.equal(promptCount, 2);
  assert.equal((await request({action: 'adopt', workspace: root, sessionId: session.sessionId}))[0].type, 'adopted');

  const spec = path.join(root, 'task.json');
  const binding = path.join(root, 'binding.json');
  await fs.writeFile(path.join(root, 'prompt.txt'), 'continue');
  await fs.writeFile(spec, JSON.stringify({workspace: root, bindingPath: binding, promptFile: path.join(root, 'prompt.txt'), sessionId: session.sessionId, requestId: 'round-3'}));
  const child = spawn(process.execPath, ['bin/cli.mjs', 'run', spec], {cwd: new URL('..', import.meta.url), windowsHide: true, env: process.env});
  let stdout = ''; let stderr = '';
  child.stdout.on('data', c => {stdout += c;}); child.stderr.on('data', c => {stderr += c;});
  const exit = await new Promise((resolve, reject) => {child.on('error', reject); child.on('close', resolve);});
  assert.equal(exit, 0, stderr); assert(stdout.includes('turn-3'));
  assert.equal(JSON.parse(await fs.readFile(binding)).sessionId, session.sessionId);
  assert.equal(promptCount, 3); assert.equal(agents.size, 1); assert(flushCount >= 6);
  await cleanup(); cleanup = async () => {};
  await assert.rejects(fs.access(connectionFile), {code: 'ENOENT'});
  assert.equal(events.listenerCount('session/event'), 0);
  assert.equal(events.listenerCount('agent/error'), 0);
});
