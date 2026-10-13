import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { connectionFile } from './paths.mjs';

export const name = 'dsh-waibao';
export const inject = ['sessionController', 'workspaceRegistry', 'sessions', 'agentDefaultModel', 'llm'];

export async function apply(ctx) {
  if (process.platform !== 'win32') throw new Error('dsh-waibao 0.1 supports Windows desktop');
  const controller = ctx.sessionController;
  const token = randomBytes(32).toString('hex');
  const pipe = `\\\\.\\pipe\\dsh-waibao-${randomUUID()}`;
  const active = new Set();
  const sockets = new Set();

  async function execute(request, send) {
    if (request.action === 'describe') {
      send({type: 'desktop', module: import.meta.url, pid: process.pid, selection: ctx.agentDefaultModel.currentSelection()});
      return;
    }
    if (!['adopt', 'run'].includes(request.action)) throw new Error('Expected describe, adopt or run');
    if (typeof request.workspace !== 'string' || !path.isAbsolute(request.workspace)) throw new Error('Absolute workspace required');
    const workspacePath = await fs.realpath(request.workspace);
    if (!(await fs.stat(workspacePath)).isDirectory()) throw new Error('Workspace must be a directory');
    if (request.action === 'run' && (typeof request.prompt !== 'string' || !request.prompt.trim() || typeof request.requestId !== 'string' || !request.requestId)) throw new Error('Prompt and unique requestId required');
    if (request.sessionId) {
      const saved = await controller.inspect(request.sessionId);
      if (path.normalize(saved.meta.cwd) !== path.normalize(request.workspace)) throw new Error('Resume requires the exact original workspace');
      if (saved.meta.isSeeded) throw new Error('Delegation requires an ordinary session');
    } else if (request.action === 'adopt') throw new Error('Existing sessionId required');
    const workspace = await ctx.workspaceRegistry.create(workspacePath, request.workspaceTitle ?? path.basename(workspacePath));
    if (request.action === 'adopt') {
      await workspace.attachSession(request.sessionId);
      const {items} = await controller.list({});
      const summary = items.find(item => item.sessionId === request.sessionId);
      if (!summary) throw new Error('Session summary unavailable after attach');
      ctx.emit('api-session/added', summary);
      send({type: 'adopted', sessionId: request.sessionId, cwd: request.workspace, workspaceId: workspace.id});
      return;
    }
    const sessionId = request.sessionId ?? `session-${randomUUID()}`;
    if (active.has(sessionId)) throw new Error('A delegated turn already owns this session');
    active.add(sessionId);
    let stopEvents;
    let stopErrors;
    try {
      await controller.create({sessionId, workspaceId: workspace.id});
      const found = await controller.resolveAgent(sessionId);
      if (found.error) throw found.error;
      const agent = found.agent;
      if (agent.status === 'running' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw new Error('Session is busy; wait for its existing work');
      if (agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.rpcId === request.requestId)) throw new Error('Request already exists; inspect its result before continuing');
      if (request.selection) {
        if (request.sessionId) throw new Error('A continuation preserves its existing model selection');
        const resolved = await ctx.llm.resolveCallConfig(request.selection);
        controller.agents.selectForNextRequest(agent, {provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort ? {reasoningEffort: resolved.reasoningEffort} : {})});
      }
      const selection = controller.agents.selectionFor(agent).current;
      if (request.expectedSelection && ['provider', 'model', 'reasoningEffort'].some(key => request.expectedSelection[key] !== selection[key])) throw new Error('Session model changed; inspect the desktop selection before continuing');
      if (request.title) await controller.rename({sessionId, title: request.title});
      await ctx.sessions.flush(agent.session);
      send({type: 'session', sessionId, cwd: agent.session.header.cwd, workspaceId: workspace.id, selection, requestId: request.requestId, transport: 'desktop'});
      let finalText = '';
      let reason;
      let failure;
      let stepUsage;
      let usageComplete = true;
      stopEvents = ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return;
        const data = event.data;
        if (event.type === 'assistant/attempt' || event.type === 'assistant/message') {
          const usage = data.usage ?? data.stream?.findLast(record => record.type === 'chunk' && record.chunk.type === 'usage')?.chunk.usage;
          if (!usage) usageComplete = false;
          else if (!stepUsage) stepUsage = {...usage};
          else for (const key of Object.keys(stepUsage)) {
            if (typeof usage[key] === 'number' && typeof stepUsage[key] === 'number') stepUsage[key] += usage[key];
            else delete stepUsage[key];
          }
          if (event.type === 'assistant/message') {
            finalText = data.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
          }
        } else if (event.type === 'tool/call') {
          send({type: 'tool_call', name: data.name, callId: data.callId});
        } else if (event.type === 'tool/result' && event.surfaceOp === 'append') {
          send({type: 'tool_result', callId: data.message.toolCallId, status: data.message.isError === true ? 'error' : 'completed'});
        } else if (['turn/start', 'step/start', 'step/end', 'turn/end'].includes(event.type)) {
          send({type: 'status', phase: event.type.replace('/', '_'), turn: data.turn, ...(data.step === undefined ? {} : {step: data.step}), ...(event.type === 'step/end' && usageComplete && stepUsage ? {usage: stepUsage} : {}), ...(data.reason ? {reason: {kind: data.reason.kind}} : {})});
          if (event.type === 'step/end') { stepUsage = undefined; usageComplete = true; }
          if (event.type === 'turn/end') reason = data.reason;
        }
      });
      stopErrors = ctx.on('agent/error', ({agent: source, error}) => { if (source === agent) failure = error; });
      await controller.prompt({sessionId, requestId: request.requestId, content: [{type: 'text', text: request.prompt}], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone}, new AbortController().signal);
      await agent.whenIdle();
      await ctx.sessions.flush(agent.session);
      if (failure) throw failure;
      if (reason?.kind !== 'completed') throw new Error(`Turn ended without completion: ${reason?.kind ?? 'unknown'}`);
      send({type: 'final', text: finalText, sessionId});
    } finally {
      stopEvents?.();
      stopErrors?.();
      active.delete(sessionId);
    }
  }

  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(10000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    const send = value => { if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n'); };
    let input = '';
    socket.on('data', function receive(chunk) {
      input += chunk;
      if (Buffer.byteLength(input) > 512 * 1024) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      socket.removeListener('data', receive);
      socket.setTimeout(0);
      (async () => {
        const request = JSON.parse(input.slice(0, input.indexOf('\n')));
        const supplied = Buffer.from(typeof request.token === 'string' ? request.token : '');
        if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) throw new Error('Unauthenticated local client');
        await execute(request, send);
        send({type: 'done', exitCode: 0});
      })().catch(error => {
        send({type: 'error', message: String(error?.message ?? error).slice(0, 2000)});
        send({type: 'done', exitCode: 1});
      }).finally(() => socket.end());
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, resolve);
  });
  server.on('error', error => ctx.logger.error(`dsh-waibao: ${error.message}`));
  await fs.mkdir(path.dirname(connectionFile), {recursive: true});
  await fs.writeFile(connectionFile, JSON.stringify({pipe, token, pid: process.pid, startedAt: new Date().toISOString()}) + '\n', {mode: 0o600});
  ctx.effect(() => async () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    try {
      if (JSON.parse(await fs.readFile(connectionFile, 'utf8')).token === token) await fs.unlink(connectionFile);
    } catch (error) { if (error.code !== 'ENOENT') ctx.logger.warn(`dsh-waibao: ${error.message}`); }
  }, 'dsh-waibao: local server and connection record');
}
