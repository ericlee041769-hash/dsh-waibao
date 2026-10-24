import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jobBin = path.join(repoRoot, 'bin', 'job.mjs');
const readRunBin = path.join(repoRoot, 'bin', 'read-run.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waibao interaction test '));
const workspace = path.join(root, 'interaction project');
const dataDir = path.join(root, 'desktop data');
const codexHome = path.join(root, 'codex home');
const fakePlugin = path.join(codexHome, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools', '9.9.9');
const messageLog = path.join(fakePlugin, 'messages.jsonl');
const threadId = 'cc1d3c5e-3333-4444-8555-666677778888';
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(fakePlugin, { recursive: true });
fs.writeFileSync(path.join(fakePlugin, 'server.mjs'), String.raw`
import fs from 'node:fs';
import { createInterface } from 'node:readline';
const log = new URL('./messages.jsonl', import.meta.url);
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  let result = {};
  if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-app-tools', version: '1' } };
  else if (message.method === 'tools/call') {
    const name = message.params?.name;
    if (name === 'read_thread') result = { content: [{ type: 'text', text: JSON.stringify({ turns: [] }) }] };
    else if (name === 'send_message_to_thread') {
      fs.appendFileSync(log, JSON.stringify({ prompt: message.params?.arguments?.prompt ?? '', at: new Date().toISOString() }) + '\n');
      if (message.params?.arguments?.prompt?.includes('FAIL_PARENT_DELIVERY')) {
        process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:message.id, error:{code:-32000, message:'bridge unavailable'}}) + '\n');
        return;
      }
      result = { content: [{ type: 'text', text: JSON.stringify({ delivered: true }) }] };
    } else result = { content: [{ type: 'text', text: '{}' }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
`);

process.env.DSH_WAIBAO_DATA_DIR = dataDir;
const { apply } = await import('../src/host.mjs');

const events = new EventEmitter();
const agents = new Map();
const cleanups = [];
const listeners = { approval: [], question: [] };
const selection = { provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' };
let promptCount = 0;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function gate() { return Promise.withResolvers(); }
function abortable(agent, promise) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    if (agent.controller.signal.aborted) { fail(); return; }
    const onAbort = () => fail();
    agent.controller.signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { agent.controller.signal.removeEventListener('abort', onAbort); resolve(value); }, error => { agent.controller.signal.removeEventListener('abort', onAbort); reject(error); });
  });
}
function on(name, fn, options) {
  const table = name === 'approval/request' ? listeners.approval : name === 'user-questions/request' ? listeners.question : null;
  if (table) {
    const entry = { fn, prepend: options === true || options?.prepend === true };
    if (entry.prepend) table.unshift(entry); else table.push(entry);
    return () => { const index = table.indexOf(entry); if (index >= 0) table.splice(index, 1); };
  }
  events.on(name, fn);
  return () => events.off(name, fn);
}
function waterfall(table, request) {
  let index = 0;
  const next = () => {
    const listener = table[index++];
    if (!listener) return Promise.reject(new Error('no answerer'));
    return Promise.resolve(listener.fn.call(request.agent, request, next));
  };
  return next();
}
function emit(agent, type, data) { events.emit('session/event', agent.session, { type, data }); }
function emitOf(agent) { return (type, data) => emit(agent, type, data); }

async function runTurn(agent, request) {
  try {
    agent.controller = new AbortController();
    agent.consumed = [];
    agent.questionResult = null;
    agent.approvalResult = null;
    agent.consumeGate = gate();
    agent.finishGate = gate();
    emit(agent, 'turn/start', { turn: agent.turns });
    emit(agent, 'step/start', { turn: agent.turns, step: 1 });
    if (request.prompt.includes('[question]') || request.prompt.includes('[timed-question]')) {
      try {
        agent.questionWait = request.prompt.includes('[timed-question]') ? new AbortController() : agent.controller;
        const answer = await waterfall(listeners.question, {
          agent, signal: agent.questionWait.signal, wait: { callId: `call-${agent.turns}`, timed: request.prompt.includes('[timed-question]') },
          questions: [{ id: 'q1', question: '选择哪个方案？', header: '选择', options: [{ label: 'A', description: '方案 A' }, { label: 'B' }] }],
        });
        agent.questionResult = answer;
      } catch (error) {
        if (agent.controller.signal.aborted) throw error;
        agent.questionResult = { error: error.code ?? error.message };
      }
    }
    if (request.prompt.includes('[approval]')) {
      try { agent.approvalResult = await waterfall(listeners.approval, { agent, toolName: 'bash', callId: `call-${agent.turns}`, reason: '需要权限', signal: agent.controller.signal }); }
      catch (error) { if (agent.controller.signal.aborted) throw error; agent.approvalResult = { error: error.code ?? error.message }; }
    }
    if (request.prompt.includes('[steer]')) {
      await abortable(agent, agent.consumeGate.promise);
      for (const message of [...agent.inbox.nextStep]) {
        agent.inbox.nextStep.splice(agent.inbox.nextStep.indexOf(message), 1);
        agent.consumed.push(message.source.rpcId);
        emit(agent, 'user/message', { source: message.source, content: message.content });
      }
      await abortable(agent, agent.finishGate.promise);
    }
    if (agent.controller.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const detail = [
      agent.questionResult ? `question=${JSON.stringify(agent.questionResult)}` : '',
      agent.approvalResult ? `approval=${JSON.stringify(agent.approvalResult)}` : '',
      agent.consumed.length ? `steer=${agent.consumed.join(',')}` : '',
    ].filter(Boolean).join(';');
    emit(agent, 'assistant/message', { message: { content: [{ type: 'text', text: `turn-${agent.turns}${detail ? `:${detail}` : ''}` }] }, usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 2, totalTokens: 102 } });
    emit(agent, 'step/end', { turn: agent.turns, step: 1 });
    emit(agent, 'turn/end', { turn: agent.turns, reason: { kind: 'completed' } });
  } catch (error) {
    emit(agent, 'turn/end', { turn: agent.turns, reason: { kind: 'aborted', reason: { kind: 'user' } } });
  } finally {
    agent.status = 'idle';
    agent.idleResolve();
  }
}

const ctx = {
  logger: { error: assert.fail, warn: assert.fail },
  on,
  emit: (...args) => events.emit(...args),
  effect(fn) { cleanups.push(fn()); },
  agentDefaultModel: { currentSelection: () => selection },
  llm: { resolveCallConfig: async value => value },
  sessions: { flush: async () => {} },
  get(name) {
    if (name === 'userQuestions') return {answer(agent, callId, answer) {
      assert.equal(callId, `call-${agent.turns}`);
      agent.questionResult = answer;
      return true;
    }};
  },
  workspaceRegistry: { create: async cwd => ({ id: 'workspace', cwd, attachSession: async () => {} }) },
  sessionController: {
    async inspect(id) {
      const agent = agents.get(id);
      if (!agent) throw new Error('Unknown session');
      return { meta: { cwd: workspace, isSeeded: false }, events: agent.history };
    },
    async create({ sessionId }) {
      if (agents.has(sessionId)) return;
      const idle = gate();
      agents.set(sessionId, {
        history: [], status: 'idle', turns: 0, consumed: [], inbox: { nextTurn: [], nextStep: [] },
        tools: new Map(),
        ctx: {inject(names, install) {
          const disposers = [];
          install({tools: {register(definition) {
            const agent = agents.get(sessionId);
            agent.tools.set(definition.name, definition);
            const dispose = () => agent.tools.delete(definition.name);
            disposers.push(dispose);
            return dispose;
          }}});
          return {dispose: async () => {for (const dispose of disposers) dispose();}};
        }},
        idlePromise: idle.promise, idleResolve: idle.resolve, consumeGate: gate(), finishGate: gate(),
        session: { id: sessionId, header: { cwd: workspace }, snapshotEvents: () => agents.get(sessionId).history },
        whenIdle: async () => agents.get(sessionId).idlePromise,
      });
    },
    resolveAgent: async id => ({ agent: agents.get(id) }),
    list: async () => ({ items: [...agents.keys()].map(sessionId => ({ sessionId })) }),
    rename: async () => {},
    agents: { selectionFor: () => ({ current: selection }), selectForNextRequest: () => {} },
    async prompt(request) {
      promptCount++;
      const agent = agents.get(request.sessionId);
      if (request.mode === 'steer') {
        const matches = message => message.source?.kind === 'user' && message.source.rpcId === request.requestId;
        if (agent.inbox.nextStep.some(matches) || agent.history.some(event => event.type === 'user/message' && event.data.source?.rpcId === request.requestId)) return { accepted: true };
        agent.inbox.nextStep.push({ id: randomUUID(), source: { kind: 'user', rpcId: request.requestId }, content: request.content });
        return { accepted: true };
      }
      if (agent.status === 'running') throw new Error('Session is busy');
      agent.status = 'running';
      agent.turns++;
      const idle = gate();
      agent.idlePromise = idle.promise;
      agent.idleResolve = idle.resolve;
      agent.history.push({ type: 'user/message', data: { source: { kind: 'user', rpcId: request.requestId } } });
      runTurn(agent, {...request, prompt: request.content?.[0]?.text ?? ''});
      return { accepted: true };
    },
    async cancel({ sessionId }) {
      const agent = agents.get(sessionId);
      if (!agent) throw new Error('Unknown session');
      agent.controller?.abort({ kind: 'user' });
      return { accepted: true };
    },
    async updateQueue({ sessionId, itemId, action }) {
      const agent = agents.get(sessionId);
      if (!agent) throw new Error('Unknown session');
      for (const list of [agent.inbox.nextTurn, agent.inbox.nextStep]) {
        const index = list.findIndex(message => message.id === itemId);
        if (index >= 0) {
          if (action?.kind !== 'remove') throw new Error('unsupported queue action');
          list.splice(index, 1);
          return { accepted: true };
        }
      }
      throw new Error('queue item not found');
    },
  },
};
await apply(ctx);
// Simulated desktop question answerer behind the delegated-session answerer.
listeners.question.push({ prepend: false, fn: async request => ({ answers: request.questions.map(question => ({ id: question.id, selected: ['D'] })) }) });

const baseEnv = {
  ...process.env,
  CODEX_THREAD_ID: threadId,
  CODEX_APP_TOOLS_PIPE_PATH: '\\\\.\\pipe\\dsh-waibao-fake-interaction-bridge',
  CODEX_HOME: codexHome,
  DSH_WAIBAO_DATA_DIR: dataDir,
};

after(async () => {
  await sleep(50);
  const jobs = path.join(dataDir, 'jobs');
  if (fs.existsSync(jobs)) {
    for (const file of fs.readdirSync(jobs).filter(name => name.endsWith('.json'))) {
      try {
        const job = JSON.parse(fs.readFileSync(path.join(jobs, file), 'utf8'));
        if (!['registered', 'running', 'delivering'].includes(job.status)) continue;
        for (const pid of [job.watcherPid, job.childPid]) if (Number.isInteger(pid)) { try { process.kill(pid); } catch {} }
      } catch {}
    }
  }
  for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch {} }
  fs.rmSync(root, { recursive: true, force: true });
});

function taskDir(task) { return path.join(workspace, 'work', 'dsh-waibao', threadId, task); }
function runNode(args, env = baseEnv) {
  const child = spawn(process.execPath, args, { env, windowsHide: true });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}
function writeSpec(spec) {
  const file = path.join(root, `spec-${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(spec));
  return file;
}
async function submit(task, prompt) {
  const result = await runNode([jobBin, 'submit', writeSpec({ workspace, task, prompt, acceptance: '行为测试通过' })]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
}
async function jobCommand(action, jobId, spec) {
  const result = await runNode([jobBin, action, jobId, ...(spec === undefined ? [] : [writeSpec(spec)])]);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return {status: result.status, stderr: result.stderr, event: lines.length ? JSON.parse(lines.at(-1)) : null};
}
function messages() {
  if (!fs.existsSync(messageLog)) return [];
  return fs.readFileSync(messageLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
async function waitFor(check, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(40);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function record(jobId) { return JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs', `${jobId}.json`), 'utf8')); }
async function waitForJob(jobId) {
  return await waitFor(() => {
    const job = record(jobId);
    return ['notified', 'failed', 'notification_uncertain'].includes(job.status) ? job : null;
  }, `job ${jobId}`);
}
async function waitForQuestion(jobId) {
  return await waitFor(() => record(jobId).questions?.find(item => item.notifiedAt) ?? null, `question ${jobId}`);
}
async function waitForApproval(jobId) {
  return await waitFor(() => record(jobId).approvals?.find(item => item.notifiedAt) ?? null, `approval ${jobId}`);
}
async function waitForTurn(jobId) {
  return await waitFor(() => [...agents.values()].find(agent => agent.history.some(event => event.type === 'user/message' && event.data.source.rpcId === jobId)) ?? null, `turn ${jobId}`);
}

test('non-delegated questions still reach the normal desktop answerer', async () => {
  const answer = await waterfall(listeners.question, { agent: { session: { id: 'session-other-question' } }, signal: new AbortController().signal, questions: [{ id: 'q-desktop', question: '普通问题' }] });
  assert.deepEqual(answer, { answers: [{ id: 'q-desktop', selected: ['D'] }] });
});

test('a delegated question is shown once, answered through the job CLI and resumes the same request', async () => {
  const accepted = await submit('ask', '[question] 需要用户选型');
  const question = await waitForQuestion(accepted.jobId);
  assert.equal(messages().filter(item => item.prompt.includes('[DSH_WAIBAO_QUESTION:')).length, 1);
  assert.equal(record(accepted.jobId).runState, 'waiting');
  assert.equal(record(accepted.jobId).status, 'running');
  const pending = await jobCommand('pending', accepted.jobId);
  assert.equal(pending.status, 0);
  assert.equal(pending.event.questions.length, 1);
  assert.deepEqual(pending.event.questions[0].questions.map(item => item.id), ['q1']);
  const answered = await jobCommand('answer', accepted.jobId, { questionId: question.questionId, outcome: 'answered', answers: [{ id: 'q1', selected: ['A'] }] });
  assert.equal(answered.status, 0, answered.stderr);
  assert.equal(answered.event.status, 'decided');
  const done = await waitForJob(accepted.jobId);
  assert.equal(done.status, 'notified');
  assert.equal(done.runState, 'completed');
  assert.equal(done.questions[0].outcome, 'answered');
  assert.ok(record(accepted.jobId).finalText.includes('selected'));
  const completion = messages().filter(item => item.prompt.includes(`[DSH_WAIBAO_COMPLETION:${accepted.jobId}]`));
  assert.equal(completion.length, 1);
  const summary = JSON.parse((await runNode([readRunBin, accepted.jobId])).stdout);
  assert.equal(summary.job.runState, 'completed');
  assert.equal(summary.job.questions[0].outcome, 'answered');
  const repeated = await jobCommand('answer', accepted.jobId, { questionId: question.questionId, outcome: 'answered', answers: [{ id: 'q1', selected: ['A'] }] });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.event.status, 'already-decided');
  const conflict = await jobCommand('answer', accepted.jobId, { questionId: question.questionId, outcome: 'rejected' });
  assert.notEqual(conflict.status, 0);
  const changedAnswer = await jobCommand('answer', accepted.jobId, { questionId: question.questionId, outcome: 'answered', answers: [{id: 'q1', selected: ['B']}] });
  assert.notEqual(changedAnswer.status, 0);
});

test('a timed question remains answerable during the original running delegation', async () => {
  const accepted = await submit('timed-ask', '[timed-question] [steer]');
  const question = await waitForQuestion(accepted.jobId);
  const agent = await waitForTurn(accepted.jobId);
  agent.questionWait.abort(Object.assign(new Error('timed out'), {code: 'ASK_TIMED_OUT'}));
  const pending = await jobCommand('pending', accepted.jobId);
  assert.equal(pending.event.questions[0].state, 'continued');
  const answer = {questionId: question.questionId, outcome: 'answered', answers: [{id: 'q1', selected: ['B']}]};
  const answered = await jobCommand('answer', accepted.jobId, answer);
  assert.equal(answered.status, 0, answered.stderr);
  assert.deepEqual(agent.questionResult, {answers: answer.answers});
  agent.consumeGate.resolve();
  agent.finishGate.resolve();
  assert.equal((await waitForJob(accepted.jobId)).runState, 'completed');
});

test('a rejected question fails the tool call without approving anything', async () => {
  const accepted = await submit('ask-reject', '[question] 用户拒绝回答');
  const question = await waitForQuestion(accepted.jobId);
  const rejected = await jobCommand('answer', accepted.jobId, { questionId: question.questionId, outcome: 'rejected' });
  assert.equal(rejected.status, 0, rejected.stderr);
  assert.equal(rejected.event.status, 'decided');
  const done = await waitForJob(accepted.jobId);
  assert.equal(done.runState, 'completed');
  assert.equal(done.questions[0].outcome, 'rejected');
  assert.ok(String(record(accepted.jobId).finalText).includes('ASK_REJECTED'));
  assert.equal(messages().filter(item => item.prompt.includes(`[DSH_WAIBAO_COMPLETION:${accepted.jobId}]`)).length, 1);
});

test('a running turn accepts one steer per requestId and exposes accepted versus consumed', async () => {
  const accepted = await submit('steer', '[steer] 保持执行');
  const agent = await waitForTurn(accepted.jobId);
  const first = await jobCommand('append', accepted.jobId, { requestId: 'delta-1', prompt: '追加：先跑单元测试。' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.event.status, 'accepted');
  assert.equal(first.event.consumed, false);
  const duplicate = await jobCommand('append', accepted.jobId, { requestId: 'delta-1', prompt: '重复内容不应执行。' });
  assert.equal(duplicate.status, 0);
  assert.equal(duplicate.event.status, 'duplicate');
  const before = await jobCommand('pending', accepted.jobId);
  assert.equal(before.event.appends.length, 1);
  assert.equal(before.event.appends[0].status, 'accepted');
  const jobId = accepted.jobId;
  agent.consumeGate.resolve();
  await waitFor(() => record(jobId).lastSteerRequestId === 'delta-1', 'steer consumption');
  const after = await jobCommand('pending', jobId);
  assert.equal(after.event.appends[0].status, 'consumed');
  agent.finishGate.resolve();
  const done = await waitForJob(jobId);
  assert.equal(done.status, 'notified');
  assert.equal(done.runState, 'completed');
  assert.ok(record(jobId).finalText.includes('steer=delta-1'));
  assert.equal(agent.consumed.filter(id => id === 'delta-1').length, 1);
  const late = await jobCommand('append', jobId, { requestId: 'delta-2', prompt: '太晚了' });
  assert.notEqual(late.status, 0);
});

test('stop cancels the delegated model turn, discards unconsumed steering and allows a later submit', async () => {
  const before = agents.size;
  const accepted = await submit('stop-run', '[steer] 等待追加后停止');
  await waitForTurn(accepted.jobId);
  const appended = await jobCommand('append', accepted.jobId, { requestId: 'delta-stop', prompt: '这条不应执行。' });
  assert.equal(appended.event.status, 'accepted');
  const stopped = await jobCommand('stop', accepted.jobId);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.event.status, 'cancelling');
  assert.deepEqual(stopped.event.removed, ['delta-stop']);
  const done = await waitForJob(accepted.jobId);
  assert.equal(done.status, 'notified');
  assert.equal(done.runState, 'cancelled');
  assert.equal(done.cancelled, true);
  assert.deepEqual(record(accepted.jobId).discardedSteers, ['delta-stop']);
  assert.ok(!String(record(accepted.jobId).finalText).includes('steer=delta-stop'));
  assert.equal(messages().filter(item => item.prompt.includes(`[DSH_WAIBAO_COMPLETION:${accepted.jobId}]`)).length, 1);
  const ended = await jobCommand('pending', accepted.jobId);
  assert.equal(ended.event.active, false);
  assert.equal(ended.event.runState, 'ended');
  const bindingBefore = JSON.parse(fs.readFileSync(path.join(taskDir('stop-run'), 'binding.json'), 'utf8'));
  const next = await submit('stop-run', '[steer] 停止后同会话继续');
  const bindingAfter = JSON.parse(fs.readFileSync(path.join(taskDir('stop-run'), 'binding.json'), 'utf8'));
  assert.equal(bindingAfter.sessionId, bindingBefore.sessionId);
  const agent = await waitForTurn(next.jobId);
  const stale = await jobCommand('append', accepted.jobId, { requestId: 'delta-old', prompt: '旧轮次不得生效。' });
  assert.notEqual(stale.status, 0);
  agent.consumeGate.resolve();
  agent.finishGate.resolve();
  const nextDone = await waitForJob(next.jobId);
  assert.equal(nextDone.runState, 'completed');
  assert.equal(agents.size, before + 1);
});

test('stop withdraws a pending question while another delegated session keeps running', async () => {
  const before = agents.size;
  const first = await submit('q-stop', '[question] 会被停止');
  const second = await submit('q-live', '[question] 会被回答');
  const firstQuestion = await waitForQuestion(first.jobId);
  const secondQuestion = await waitForQuestion(second.jobId);
  const stopped = await jobCommand('stop', first.jobId);
  assert.equal(stopped.status, 0, stopped.stderr);
  const firstDone = await waitForJob(first.jobId);
  assert.equal(firstDone.runState, 'cancelled');
  assert.equal(record(first.jobId).questions[0].outcome, 'cancelled');
  const answered = await jobCommand('answer', second.jobId, { questionId: secondQuestion.questionId, outcome: 'answered', answers: [{ id: 'q1', selected: ['B'] }] });
  assert.equal(answered.status, 0, answered.stderr);
  const secondDone = await waitForJob(second.jobId);
  assert.equal(secondDone.runState, 'completed');
  assert.equal(record(second.jobId).questions[0].outcome, 'answered');
  assert.equal(agents.size, before + 2);
  assert.equal(messages().filter(item => item.prompt.includes(`[DSH_WAIBAO_COMPLETION:${first.jobId}]`)).length, 1);
  assert.equal(messages().filter(item => item.prompt.includes(`[DSH_WAIBAO_COMPLETION:${second.jobId}]`)).length, 1);
  assert.notEqual(firstQuestion.questionId, secondQuestion.questionId);
});

test('stop withdraws a pending approval through the job CLI', async () => {
  const accepted = await submit('a-stop', '[approval] 等待权限');
  const approval = await waitForApproval(accepted.jobId);
  assert.equal(record(accepted.jobId).runState, 'waiting');
  const stopped = await jobCommand('stop', accepted.jobId);
  assert.equal(stopped.status, 0, stopped.stderr);
  const done = await waitForJob(accepted.jobId);
  assert.equal(done.runState, 'cancelled');
  assert.equal(record(accepted.jobId).approvals[0].outcome, 'cancelled');
  assert.equal(approval.deliveryAttemptedAt !== undefined, true);
  const decision = await jobCommand('answer', accepted.jobId, { approvalId: approval.approvalId, outcome: 'allowed-once' });
  assert.notEqual(decision.status, 0);
});

test('parallel children proactively message the parent before completion, then receive isolated steer and stop', async () => {
  const first = await submit('message-a', '[steer] 子代理 A');
  const second = await submit('message-b', '[steer] 子代理 B');
  const agentA = await waitForTurn(first.jobId);
  const agentB = await waitForTurn(second.jobId);
  const toolA = agentA.tools.get('send_to_parent');
  const toolB = agentB.tools.get('send_to_parent');
  assert(toolA && toolB, 'each delegated child must have a send_to_parent tool');
  for (const text of ['A 发现接口冲突', 'A 发现第二个问题']) await toolA.execute({message: text}, {agent: agentA});
  await toolB.execute({message: 'B 完成局部调查'}, {agent: agentB});
  await waitFor(() => record(first.jobId).parentMessages?.filter(item => item.notifiedAt).length === 2 && record(second.jobId).parentMessages?.filter(item => item.notifiedAt).length === 1, 'live child messages');
  const messagesA = record(first.jobId).parentMessages;
  const messagesB = record(second.jobId).parentMessages;
  assert.equal(new Set([...messagesA, ...messagesB].map(item => item.messageId)).size, 3);
  for (const [job, agent, items] of [[first, agentA, messagesA], [second, agentB, messagesB]]) {
    assert.equal(record(job.jobId).status, 'running');
    assert.equal(messages().some(item => item.prompt.includes(`[DSH_WAIBAO_COMPLETION:${job.jobId}]`)), false);
    for (const item of items) {
      assert.equal(item.sessionId, agent.session.id);
      assert.equal(item.requestId, job.jobId);
      assert.equal(messages().filter(message => message.prompt.includes(`[DSH_WAIBAO_MESSAGE:${job.jobId}:${item.messageId}]`)).length, 1);
    }
  }
  await assert.rejects(toolA.execute({message: 'wrong child'}, {agent: agentB}));
  const append = await jobCommand('append', first.jobId, {requestId: 'parent-reply-a', prompt: '接口采用 A 的建议，继续验证。'});
  assert.equal(append.status, 0, append.stderr);
  assert.equal(agentB.inbox.nextStep.length, 0);
  agentA.consumeGate.resolve();
  await waitFor(() => agentA.consumed.includes('parent-reply-a'), 'parent reply consumed by A');
  await jobCommand('stop', first.jobId);
  assert.equal((await waitForJob(first.jobId)).runState, 'cancelled');
  assert.equal(agentB.status, 'running');
  await assert.rejects(toolA.execute({message: 'after stop'}, {agent: agentA}));
  agentB.consumeGate.resolve();
  agentB.finishGate.resolve();
  assert.equal((await waitForJob(second.jobId)).runState, 'completed');
  assert.equal(agentA.tools.has('send_to_parent'), false);
  assert.equal(agentB.tools.has('send_to_parent'), false);
});

test('parent message delivery failures remain visible and are not silently retried', async () => {
  const accepted = await submit('message-error', '[steer] 保持执行');
  const agent = await waitForTurn(accepted.jobId);
  await agent.tools.get('send_to_parent').execute({message: 'FAIL_PARENT_DELIVERY'}, {agent});
  const failure = await waitFor(() => record(accepted.jobId).parentMessages?.find(item => item.notificationError), 'parent delivery error');
  assert.match(failure.notificationError, /bridge unavailable/);
  assert.equal(failure.notifiedAt, undefined);
  const pending = await jobCommand('pending', accepted.jobId);
  assert(pending.event.job.parentMessages.some(item => item.messageId === failure.messageId && item.notificationError));
  agent.consumeGate.resolve();
  agent.finishGate.resolve();
  await waitForJob(accepted.jobId);
  assert.equal(messages().filter(item => item.prompt.includes(`[DSH_WAIBAO_MESSAGE:${accepted.jobId}:${failure.messageId}]`)).length, 1);
});
