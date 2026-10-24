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
const cliBin = path.join(repoRoot, 'bin', 'cli.mjs');
const readRunBin = path.join(repoRoot, 'bin', 'read-run.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waibao approval test '));
const workspace = path.join(root, 'approval project');
const dataDir = path.join(root, 'desktop data');
const codexHome = path.join(root, 'codex home');
const fakePlugin = path.join(codexHome, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools', '9.9.9');
const messageLog = path.join(fakePlugin, 'messages.jsonl');
const threadId = 'aa1b3c5d-2222-4333-8444-555566667777';
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
  if (message.method === 'initialize') {
    result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-app-tools', version: '1' } };
  } else if (message.method === 'tools/call') {
    const name = message.params?.name;
    if (name === 'read_thread') result = { content: [{ type: 'text', text: JSON.stringify({ turns: [] }) }] };
    else if (name === 'send_message_to_thread') {
      const prompt = message.params?.arguments?.prompt ?? '';
      const failed = prompt.includes('[DSH_WAIBAO_APPROVAL:') && fs.existsSync(new URL('./fail-approval-notify', import.meta.url));
      fs.appendFileSync(log, JSON.stringify({ prompt, failed, at: new Date().toISOString() }) + '\n');
      result = failed
        ? { isError: true, content: [{ type: 'text', text: 'simulated uncertain delivery' }] }
        : { content: [{ type: 'text', text: JSON.stringify({ delivered: true }) }] };
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
const approvalListeners = [];
const selection = { provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' };
const approvalOutcomes = [];
let promptCount = 0;
let desktopAnswers = 0;
let approvalAbort = null;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function on(name, fn, options) {
  if (name === 'approval/request') {
    const entry = { fn, prepend: options === true || options?.prepend === true };
    if (entry.prepend) approvalListeners.unshift(entry);
    else approvalListeners.push(entry);
    return () => {
      const index = approvalListeners.indexOf(entry);
      if (index >= 0) approvalListeners.splice(index, 1);
    };
  }
  events.on(name, fn);
  return () => events.off(name, fn);
}
function answerApproval(request) {
  let index = 0;
  const next = () => {
    const listener = approvalListeners[index++];
    if (!listener) return Promise.resolve('unavailable');
    return Promise.resolve(listener.fn.call(request.agent, request, next));
  };
  return next();
}

const ctx = {
  logger: { error: assert.fail, warn: assert.fail },
  on,
  emit: (...args) => events.emit(...args),
  effect(fn) { cleanups.push(fn()); },
  agentDefaultModel: { currentSelection: () => selection },
  llm: { resolveCallConfig: async value => value },
  sessions: { flush: async () => {} },
  workspaceRegistry: { create: async cwd => ({ id: 'workspace', cwd, attachSession: async () => {} }) },
  sessionController: {
    async inspect(id) {
      const agent = agents.get(id);
      if (!agent) throw new Error('Unknown session');
      return { meta: { cwd: workspace, isSeeded: false }, events: agent.history };
    },
    async create({ sessionId }) {
      if (agents.has(sessionId)) return;
      agents.set(sessionId, {
        ctx: {inject(deps, fn) {fn({tools: {register() {}}}); return {dispose: async () => {}};}},
        history: [], status: 'idle', inbox: { nextTurn: [], nextStep: [] },
        session: { id: sessionId, header: { cwd: workspace }, snapshotEvents: () => agents.get(sessionId).history },
        whenIdle: async () => {},
      });
    },
    resolveAgent: async id => ({ agent: agents.get(id) }),
    list: async () => ({ items: [...agents.keys()].map(sessionId => ({ sessionId })) }),
    rename: async () => {},
    agents: { selectionFor: () => ({ current: selection }), selectForNextRequest: () => {} },
    async prompt(request, signal) {
      assert(signal instanceof AbortSignal);
      promptCount++;
      const agent = agents.get(request.sessionId);
      const turn = agent.history.length + 1;
      agent.history.push({ type: 'user/message', data: { source: { rpcId: request.requestId } } });
      const controller = new AbortController();
      approvalAbort = controller;
      const outcome = await answerApproval({ agent, toolName: 'bash', callId: `call-${promptCount}`, reason: '需要越权执行测试命令', signal: controller.signal });
      approvalAbort = null;
      approvalOutcomes.push({ sessionId: request.sessionId, outcome });
      const emit = (type, data) => events.emit('session/event', agent.session, { type, data });
      emit('turn/start', { turn });
      emit('step/start', { turn, step: 1 });
      emit('assistant/message', { message: { content: [{ type: 'text', text: `turn-${turn}:${outcome}` }] }, usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 2, totalTokens: 102 } });
      emit('step/end', { turn, step: 1 });
      emit('turn/end', { turn, reason: { kind: 'completed' } });
    },
  },
};
await apply(ctx);
// Simulated desktop answerer behind the delegated-session answerer.
approvalListeners.push({ prepend: false, fn: async () => { desktopAnswers++; return 'allowed-once'; } });

const baseEnv = {
  ...process.env,
  CODEX_THREAD_ID: threadId,
  CODEX_APP_TOOLS_PIPE_PATH: '\\\\.\\pipe\\dsh-waibao-fake-approval-bridge',
  CODEX_HOME: codexHome,
  DSH_WAIBAO_DATA_DIR: dataDir,
};

after(async () => {
  approvalAbort?.abort();
  await sleep(100);
  const jobs = path.join(dataDir, 'jobs');
  if (fs.existsSync(jobs)) {
    for (const file of fs.readdirSync(jobs).filter(name => name.endsWith('.json'))) {
      try {
        const job = JSON.parse(fs.readFileSync(path.join(jobs, file), 'utf8'));
        if (!['registered', 'running', 'delivering'].includes(job.status)) continue;
        for (const pid of [job.watcherPid, job.childPid]) {
          if (Number.isInteger(pid)) { try { process.kill(pid); } catch {} }
        }
      } catch {}
    }
  }
  for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch {} }
  fs.rmSync(root, { recursive: true, force: true });
});

function taskDir(task) {
  return path.join(workspace, 'work', 'dsh-waibao', threadId, task);
}
function runNode(args, env = baseEnv) {
  const child = spawn(process.execPath, args, { env, windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}
function writeSpec(spec) {
  const specPath = path.join(root, `spec-${randomUUID()}.json`);
  fs.writeFileSync(specPath, JSON.stringify(spec));
  return specPath;
}
async function submit(spec) {
  const result = await runNode([jobBin, 'submit', writeSpec(spec)]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
}
async function cli(action, spec) {
  return await runNode([cliBin, action, writeSpec(spec)]);
}
function eventsOf(result) {
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
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
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function jobRecord(jobId) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs', `${jobId}.json`), 'utf8'));
}
async function waitForApproval(jobId) {
  return await waitFor(() => {
    const record = jobRecord(jobId);
    return record.approvals?.find(item => item.notifiedAt) ?? null;
  }, `approval notification for ${jobId}`);
}
async function waitForJob(jobId) {
  return await waitFor(() => {
    const record = jobRecord(jobId);
    return ['notified', 'failed', 'notification_uncertain'].includes(record.status) ? record : null;
  }, `job ${jobId} completion`);
}

test('a delegated approval waits, notifies once, resumes the same request and completes once', async () => {
  const accepted = await submit({ workspace, task: 'allow', prompt: '遇到需要审批的工具调用。', acceptance: '批准后继续执行。' });
  const approval = await waitForApproval(accepted.jobId);
  assert.ok(agents.has(approval.sessionId));
  assert.equal(desktopAnswers, 0);
  const pendingState = jobRecord(accepted.jobId);
  assert.equal(pendingState.status, 'running');
  assert.equal(pendingState.approvals.length, 1);
  const approvalMessages = messages().filter(item => item.prompt.includes('[DSH_WAIBAO_APPROVAL:'));
  assert.equal(approvalMessages.length, 1);
  assert.ok(approvalMessages[0].prompt.includes(approval.approvalId));
  assert.ok(!messages().some(item => item.prompt.includes(`[DSH_WAIBAO_COMPLETION:${accepted.jobId}]`)));

  const listed = eventsOf(await cli('pending', { workspace, sessionId: approval.sessionId })).find(event => event.type === 'approvals');
  assert.equal(listed.approvals.length, 1);
  assert.equal(listed.approvals[0].approvalId, approval.approvalId);
  assert.equal(listed.approvals[0].requestId, accepted.jobId);
  assert.equal(listed.truncated, false);

  const decided = eventsOf(await cli('decide', { workspace, sessionId: approval.sessionId, approvalId: approval.approvalId, requestId: accepted.jobId, outcome: 'allowed-once' })).find(event => event.type === 'approval_decision');
  assert.equal(decided.status, 'decided');
  assert.equal(decided.outcome, 'allowed-once');
  const done = await waitForJob(accepted.jobId);
  assert.equal(done.status, 'notified');
  assert.equal(done.exitCode, 0);
  assert.deepEqual(approvalOutcomes.find(item => item.sessionId === approval.sessionId), { sessionId: approval.sessionId, outcome: 'allowed-once' });
  assert.equal(promptCount, 1);
  const binding = JSON.parse(fs.readFileSync(path.join(taskDir('allow'), 'binding.json'), 'utf8'));
  assert.equal(binding.sessionId, approval.sessionId);
  assert.equal(jobRecord(accepted.jobId).approvals[0].outcome, 'allowed-once');
  const completionMessages = messages().filter(item => item.prompt.includes(`[DSH_WAIBAO_COMPLETION:${accepted.jobId}]`));
  assert.equal(completionMessages.length, 1);
  assert.ok(completionMessages[0].prompt.includes(approval.approvalId));
  const repeated = eventsOf(await cli('decide', { workspace, sessionId: approval.sessionId, approvalId: approval.approvalId, outcome: 'allowed-once' })).find(event => event.type === 'approval_decision');
  assert.equal(repeated.status, 'already-decided');
  assert.equal(repeated.outcome, 'allowed-once');
  const conflict = await cli('decide', { workspace, sessionId: approval.sessionId, approvalId: approval.approvalId, outcome: 'rejected' });
  assert.notEqual(conflict.status, 0);
  assert.match(eventsOf(conflict).find(event => event.type === 'error').message, /already settled/);
  assert.equal(promptCount, 1);

  const summary = JSON.parse((await runNode([readRunBin, accepted.jobId])).stdout);
  assert.equal(summary.job.approvals.length, 1);
  assert.equal(summary.job.approvals[0].approvalId, approval.approvalId);
  assert.equal(summary.job.approvals[0].outcome, 'allowed-once');
  assert.ok(summary.job.approvals[0].notifiedAt);
});

test('a rejected approval fails the pending tool decision without auto-approval', async () => {
  const accepted = await submit({ workspace, task: 'reject', prompt: '遇到需要审批的工具调用。', acceptance: '拒绝时不得执行。' });
  const approval = await waitForApproval(accepted.jobId);
  const decided = eventsOf(await cli('decide', { workspace, sessionId: approval.sessionId, approvalId: approval.approvalId, outcome: 'rejected' })).find(event => event.type === 'approval_decision');
  assert.equal(decided.outcome, 'rejected');
  const done = await waitForJob(accepted.jobId);
  assert.equal(done.status, 'notified');
  assert.deepEqual(approvalOutcomes.find(item => item.sessionId === approval.sessionId), { sessionId: approval.sessionId, outcome: 'rejected' });
  const stdout = fs.readFileSync(done.stdoutPath, 'utf8');
  assert.ok(stdout.includes('turn-'));
  assert.ok(stdout.includes(':rejected'));
});

test('non-delegated approvals still reach the normal desktop answerer', async () => {
  desktopAnswers = 0;
  const outcome = await answerApproval({ agent: { session: { id: 'session-other' } }, toolName: 'read', callId: 'call-normal', reason: 'ordinary approval', signal: new AbortController().signal });
  assert.equal(outcome, 'allowed-once');
  assert.equal(desktopAnswers, 1);
  const listed = eventsOf(await cli('pending', { workspace })).find(event => event.type === 'approvals');
  assert.equal(listed.approvals.length, 0);
});

test('a cancelled turn withdraws its approval and later decisions are refused', async () => {
  const accepted = await submit({ workspace, task: 'cancel', prompt: '等待审批后取消。', acceptance: '取消后不执行。' });
  const approval = await waitForApproval(accepted.jobId);
  const before = jobRecord(accepted.jobId);
  assert.equal(before.status, 'running');
  process.kill(before.childPid);
  const done = await waitForJob(accepted.jobId);
  assert.equal(done.status, 'notified');
  assert.notEqual(done.exitCode, 0);
  const cancelled = await waitFor(() => approvalOutcomes.find(item => item.sessionId === approval.sessionId), 'cancelled approval outcome');
  assert.deepEqual(cancelled, { sessionId: approval.sessionId, outcome: 'cancelled' });
  const listed = eventsOf(await cli('pending', { workspace, sessionId: approval.sessionId })).find(event => event.type === 'approvals');
  assert.equal(listed.approvals.length, 0);
  const refused = await cli('decide', { workspace, sessionId: approval.sessionId, approvalId: approval.approvalId, outcome: 'allowed-once' });
  assert.notEqual(refused.status, 0);
  assert.match(eventsOf(refused).find(event => event.type === 'error').message, /not pending/i);
});

test('an uncertain approval notification stays pending without automatic retry or completion', async () => {
  const flag = path.join(fakePlugin, 'fail-approval-notify');
  fs.writeFileSync(flag, '1');
  try {
    const accepted = await submit({ workspace, task: 'uncertain', prompt: '通知失败也必须保持等待。', acceptance: '用户仍可查询并决定。' });
    const record = await waitFor(() => {
      const state = jobRecord(accepted.jobId);
      return state.approvals?.find(item => item.notificationError) ?? null;
    }, 'uncertain approval notification');
    assert.equal(jobRecord(accepted.jobId).status, 'running');
    const attempts = messages().filter(item => item.prompt.includes(`[DSH_WAIBAO_APPROVAL:${accepted.jobId}:`));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].failed, true);
    assert.ok(!messages().some(item => item.prompt.includes(`[DSH_WAIBAO_COMPLETION:${accepted.jobId}]`)));
    const listed = eventsOf(await cli('pending', { workspace, sessionId: record.sessionId })).find(event => event.type === 'approvals');
    assert.deepEqual(listed.approvals.map(item => item.approvalId), [record.approvalId]);
    await cli('decide', { workspace, sessionId: record.sessionId, approvalId: record.approvalId, outcome: 'allowed-once' });
    const done = await waitForJob(accepted.jobId);
    assert.equal(done.status, 'notified');
    assert.equal(done.exitCode, 0);
    assert.ok(messages().some(item => item.prompt.includes(`[DSH_WAIBAO_COMPLETION:${accepted.jobId}]`)));
  } finally {
    fs.rmSync(flag, { force: true });
  }
});

test('concurrent delegated sessions keep approvals isolated by session and request', async () => {
  const first = await submit({ workspace, task: 'concurrent-a', prompt: '并发审批 A。', acceptance: 'A 单独决定。' });
  const second = await submit({ workspace, task: 'concurrent-b', prompt: '并发审批 B。', acceptance: 'B 单独决定。' });
  const firstApproval = await waitForApproval(first.jobId);
  const secondApproval = await waitForApproval(second.jobId);
  const listed = eventsOf(await cli('pending', { workspace })).find(event => event.type === 'approvals');
  assert.equal(listed.approvals.length, 2);
  assert.deepEqual(new Set(listed.approvals.map(item => item.sessionId)), new Set([firstApproval.sessionId, secondApproval.sessionId]));
  await cli('decide', { workspace, sessionId: firstApproval.sessionId, approvalId: firstApproval.approvalId, outcome: 'allowed-once' });
  const afterFirst = eventsOf(await cli('pending', { workspace })).find(event => event.type === 'approvals');
  assert.deepEqual(afterFirst.approvals.map(item => item.approvalId), [secondApproval.approvalId]);
  const firstDone = await waitForJob(first.jobId);
  assert.equal(firstDone.exitCode, 0);
  assert.equal(jobRecord(second.jobId).status, 'running');
  const foreign = await runNode([cliBin, 'decide', writeSpec({ workspace, sessionId: secondApproval.sessionId, approvalId: secondApproval.approvalId, outcome: 'allowed-once' })], { ...baseEnv, CODEX_THREAD_ID: 'bb1b3c5d-2222-4333-8444-555566667777' });
  assert.notEqual(foreign.status, 0);
  assert.match(eventsOf(foreign).find(event => event.type === 'error').message, /another Codex thread/);
  assert.equal(jobRecord(second.jobId).status, 'running');
  await cli('decide', { workspace, sessionId: secondApproval.sessionId, approvalId: secondApproval.approvalId, outcome: 'rejected' });
  const secondDone = await waitForJob(second.jobId);
  assert.equal(secondDone.status, 'notified');
  assert.deepEqual(approvalOutcomes.find(item => item.sessionId === secondApproval.sessionId), { sessionId: secondApproval.sessionId, outcome: 'rejected' });
  const completionIds = messages().map(item => item.prompt).filter(prompt => prompt.includes('[DSH_WAIBAO_COMPLETION:'));
  assert.equal(completionIds.filter(prompt => prompt.includes(first.jobId)).length, 1);
  assert.equal(completionIds.filter(prompt => prompt.includes(second.jobId)).length, 1);
});
