import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jobBin = path.join(repoRoot, 'bin', 'job.mjs');
const readRunBin = path.join(repoRoot, 'bin', 'read-run.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waibao submit test '));
const workspace = path.join(root, 'demo project');
const dataDir = path.join(root, 'desktop data');
const codexHome = path.join(root, 'codex home');
const fakePlugin = path.join(codexHome, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools', '9.9.9');
const threadId = '9a1d3c5e-1111-4222-8333-444455556666';
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(fakePlugin, { recursive: true });
fs.writeFileSync(path.join(fakePlugin, 'server.mjs'), String.raw`
import { createInterface } from 'node:readline';
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
    else if (name === 'send_message_to_thread') result = { content: [{ type: 'text', text: JSON.stringify({ delivered: true }) }] };
    else result = { content: [{ type: 'text', text: '{}' }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
`);

process.env.DSH_WAIBAO_DATA_DIR = dataDir;
const { apply } = await import('../src/host.mjs');
// job.mjs is importable for the startup/claim unit tests below.
const { acquireClaim, claimOccupant, waitForStart } = await import(pathToFileURL(jobBin).href);

const events = new EventEmitter();
const agents = new Map();
const selection = { provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' };
let promptCount = 0;
const activeRequests = new Map();
let gate = null;
let releaseGate = () => {};
function holdPrompts() {
  gate = new Promise(resolve => {
    releaseGate = () => { gate = null; releaseGate = () => {}; resolve(); };
  });
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
let cleanup = async () => {};
const ctx = {
  logger: { error: assert.fail, warn: assert.fail },
  on(name, fn) { events.on(name, fn); return () => events.off(name, fn); },
  emit: (...args) => events.emit(...args),
  effect(fn) { cleanup = fn(); },
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
        session: { header: { cwd: workspace }, snapshotEvents: () => agents.get(sessionId).history },
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
      activeRequests.set(request.requestId, request.sessionId);
      try { if (gate) await gate; }
      finally { activeRequests.delete(request.requestId); }
      const turn = agent.history.length + 1;
      agent.history.push({ type: 'user/message', data: { source: { rpcId: request.requestId } } });
      const emit = (type, data) => events.emit('session/event', agent.session, { type, data });
      emit('turn/start', { turn });
      emit('step/start', { turn, step: 1 });
      emit('assistant/message', { message: { content: [{ type: 'text', text: `turn-${turn}` }] }, usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 2, totalTokens: 102 } });
      emit('step/end', { turn, step: 1 });
      emit('turn/end', { turn, reason: { kind: 'completed' } });
    },
  },
};
await apply(ctx);

const baseEnv = {
  ...process.env,
  CODEX_THREAD_ID: threadId,
  CODEX_APP_TOOLS_PIPE_PATH: '\\\\.\\pipe\\dsh-waibao-fake-bridge',
  CODEX_HOME: codexHome,
  DSH_WAIBAO_DATA_DIR: dataDir,
};

after(async () => {
  releaseGate();
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
  try { await cleanup(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});

function taskDir(task) {
  return path.join(workspace, 'work', 'dsh-waibao', threadId, task);
}
function roundDirs(task) {
  const dir = path.join(taskDir(task), 'rounds');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}
function startSubmit(spec, env = baseEnv) {
  const specPath = path.join(root, `spec-${randomUUID()}.json`);
  fs.writeFileSync(specPath, JSON.stringify(spec));
  return runNode([jobBin, 'submit', specPath], env);
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
function receipt(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}
async function waitForJob(jobId, timeoutMs = 30000) {
  const recordPath = path.join(dataDir, 'jobs', `${jobId}.json`);
  const terminal = new Set(['notified', 'failed', 'notification_uncertain']);
  const deadline = Date.now() + timeoutMs;
  let record;
  while (Date.now() < deadline) {
    try { record = JSON.parse(fs.readFileSync(recordPath, 'utf8')); }
    catch {}
    if (record && terminal.has(record.status)) return record;
    await sleep(50);
  }
  throw new Error(`job ${jobId} did not finish (status ${record?.status ?? 'missing'})`);
}

// This test needs a workspace with no prior task directories, so it runs first.
test('submit fails clearly outside a Codex thread', async () => {
  const env = { ...baseEnv };
  delete env.CODEX_THREAD_ID;
  const result = await startSubmit({ workspace, task: 'nocodex', prompt: 'p', acceptance: 'a' }, env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CODEX_THREAD_ID/);
  assert.equal(fs.existsSync(path.join(workspace, 'work', 'dsh-waibao')), false);
});

test('startup confirmation is testable with a short timeout and reports uncertain', async () => {
  const started = Date.now();
  const timedOut = await waitForStart(new EventEmitter(), randomUUID(), path.join(root, 'missing-coordinator.log'), { timeoutMs: 150, intervalMs: 20 });
  assert.equal(timedOut.kind, 'uncertain');
  assert.match(timedOut.message, /not confirmed within 150ms/);
  assert.match(timedOut.message, /cannot be retried automatically/);
  assert.ok(Date.now() - started < 5000);

  const jobId = randomUUID();
  fs.mkdirSync(path.join(dataDir, 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'jobs', `${jobId}.json`), JSON.stringify({ id: jobId, status: 'running' }));
  const confirmed = await waitForStart(new EventEmitter(), jobId, path.join(root, 'unused.log'), { timeoutMs: 1000, intervalMs: 20 });
  assert.equal(confirmed.kind, 'started');
  assert.equal(confirmed.status, 'running');
});

test('a claim without a job record stays unknown instead of expiring', async () => {
  const task = 'unconfirmed-claim';
  const dir = taskDir(task);
  const claimPath = path.join(dir, 'active.json');
  const oldJob = randomUUID();
  fs.mkdirSync(dir, { recursive: true });
  const oldClaim = { jobId: oldJob, task, threadId, createdAt: new Date(Date.now() - 3600_000).toISOString() };
  fs.writeFileSync(claimPath, JSON.stringify(oldClaim) + '\n');
  assert.equal(claimOccupant(oldClaim).status, 'unknown');

  const replacement = { jobId: randomUUID(), task, threadId, createdAt: new Date().toISOString() };
  await assert.rejects(acquireClaim(dir, claimPath, replacement), /no confirmed completion record/);
  assert.equal(JSON.parse(fs.readFileSync(claimPath, 'utf8')).jobId, oldJob);
  assert.equal(fs.existsSync(`${claimPath}.lock`), false);

  const finishedJob = randomUUID();
  fs.writeFileSync(path.join(dataDir, 'jobs', `${finishedJob}.json`), JSON.stringify({ id: finishedJob, status: 'notified' }));
  fs.writeFileSync(claimPath, JSON.stringify({ ...oldClaim, jobId: finishedJob }) + '\n');
  // A concurrent submit holding the claim lock blocks reclaiming; the old claim
  // stays untouched, so no submit can delete a claim another submit just wrote.
  fs.writeFileSync(`${claimPath}.lock`, '{"pid":1}\n');
  await assert.rejects(acquireClaim(dir, claimPath, replacement), /claim lock/);
  assert.equal(JSON.parse(fs.readFileSync(claimPath, 'utf8')).jobId, finishedJob);

  fs.unlinkSync(`${claimPath}.lock`);
  await acquireClaim(dir, claimPath, replacement);
  assert.equal(JSON.parse(fs.readFileSync(claimPath, 'utf8')).jobId, replacement.jobId);
});

test('concurrent submissions after a completed round start at most one new round', async t => {
  const task = 'resume-race';
  const spec = { workspace, task, prompt: '首轮完成', acceptance: '完成' };
  const first = receipt(await startSubmit(spec));
  const firstDone = await waitForJob(first.jobId);
  assert.equal(firstDone.status, 'notified');
  const claimPath = path.join(taskDir(task), 'active.json');
  assert.equal(JSON.parse(fs.readFileSync(claimPath, 'utf8')).jobId, first.jobId);

  holdPrompts();
  t.after(() => releaseGate());
  const results = await Promise.all([
    startSubmit({ ...spec, prompt: '续提 A' }),
    startSubmit({ ...spec, prompt: '续提 B' }),
  ]);
  const winners = results.filter(result => result.status === 0);
  assert.equal(winners.length, 1, results.map(result => result.stderr).join('\n'));
  const accepted = receipt(winners[0]);
  assert.equal(accepted.reusedBinding, true);
  assert.equal(roundDirs(task).length, 2);
  assert.equal(JSON.parse(fs.readFileSync(claimPath, 'utf8')).jobId, accepted.jobId);
  releaseGate();
  const done = await waitForJob(accepted.jobId);
  assert.equal(done.status, 'notified');
  assert.equal(done.exitCode, 0);
});

test('spawn runs three independent coordinator processes concurrently and list isolates the parent thread', async t => {
  holdPrompts();
  t.after(async () => {
    releaseGate();
    const jobs = path.join(dataDir, 'jobs');
    for (const file of fs.readdirSync(jobs).filter(name => name.endsWith('.json'))) {
      const job = JSON.parse(fs.readFileSync(path.join(jobs, file), 'utf8'));
      if (job.task?.startsWith('parallel-')) await waitForJob(job.id);
    }
  });
  const tasks = ['parallel-a', 'parallel-b', 'parallel-c'].map(task => ({task, prompt: '保持执行以检查并发', acceptance: '三个任务同时在执行'}));
  const spec = path.join(root, 'spawn.json');
  fs.writeFileSync(spec, JSON.stringify({workspace, tasks}));
  const result = await runNode([jobBin, 'spawn', spec]);
  const batch = receipt(result);
  assert.equal(batch.tasks.length, 3);
  assert(batch.tasks.every(item => item.ok && item.status === 'running'));
  const deadline = Date.now() + 10000;
  while (!batch.tasks.every(item => activeRequests.has(item.jobId)) && Date.now() < deadline) await sleep(20);
  assert(batch.tasks.every(item => activeRequests.has(item.jobId)), 'all three model turns must be active before releasing any');
  assert.equal(new Set(batch.tasks.map(item => activeRequests.get(item.jobId))).size, 3);
  const records = batch.tasks.map(item => JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs', `${item.jobId}.json`))));
  assert.equal(new Set(records.map(item => item.watcherPid)).size, 3);
  assert.equal(new Set(records.map(item => item.childPid)).size, 3);
  for (const item of records) {
    assert.equal(item.status, 'running');
    assert.doesNotThrow(() => process.kill(item.watcherPid, 0));
    assert.doesNotThrow(() => process.kill(item.childPid, 0));
  }
  const listed = receipt(await runNode([jobBin, 'list', workspace]));
  const current = listed.agents.filter(item => tasks.some(task => task.task === item.task));
  assert.equal(current.length, 3);
  assert.deepEqual(new Set(current.map(item => item.jobId)), new Set(batch.tasks.map(item => item.jobId)));
  const other = receipt(await runNode([jobBin, 'list', workspace], {...baseEnv, CODEX_THREAD_ID: '11111111-2222-4333-8444-555555555555'}));
  assert.deepEqual(other.agents, []);

  fs.writeFileSync(spec, JSON.stringify({workspace, tasks: [tasks[0], {task: 'parallel-d', prompt: '独立新任务', acceptance: '完成'}]}));
  const mixed = await runNode([jobBin, 'spawn', spec]);
  assert.equal(mixed.status, 1);
  const mixedReceipt = JSON.parse(mixed.stdout.trim());
  assert.equal(mixedReceipt.tasks[0].ok, false);
  assert.match(mixedReceipt.tasks[0].error, /active|running|claim|progress/i);
  assert.equal(mixedReceipt.tasks[1].ok, true);
  releaseGate();
  for (const item of [...batch.tasks, mixedReceipt.tasks[1]]) assert.equal((await waitForJob(item.jobId)).exitCode, 0);
});

// Scenarios that share counters and must run in a fixed order live in one workflow.
test('ordered workflow: registration, continuation, isolation, rejection and launch failure', async t => {
  const basePrompts = promptCount;
  const baseAgents = agents.size;
  const state = {};

  await t.test('one spec starts a registered background round with prompt, binding and evidence', async t2 => {
    holdPrompts();
    t2.after(() => releaseGate());
    const prompt = '实现 X；文件 demo/src/x.mjs；验收：npm test 通过。';
    const result = await startSubmit({ workspace, task: 'alpha', prompt, acceptance: 'npm test 通过', title: 'Alpha' });
    const accepted = receipt(result);
    assert.equal(accepted.task, 'alpha');
    assert.equal(accepted.status, 'running');
    assert.equal(accepted.reusedBinding, false);
    assert.equal(accepted.bindingPath, path.join(taskDir('alpha'), 'binding.json'));
    const roundDir = path.dirname(accepted.stdoutPath);
    assert.equal(path.dirname(roundDir), path.join(taskDir('alpha'), 'rounds'));
    assert.equal(fs.readFileSync(path.join(roundDir, 'prompt.txt'), 'utf8'), prompt);
    const taskSpec = JSON.parse(fs.readFileSync(path.join(roundDir, 'task.json'), 'utf8'));
    assert.equal(taskSpec.workspace, workspace);
    assert.equal(taskSpec.requestId, accepted.jobId);
    assert.equal(taskSpec.promptFile, path.join(roundDir, 'prompt.txt'));
    assert.equal(taskSpec.bindingPath, accepted.bindingPath);
    const jobSpec = JSON.parse(fs.readFileSync(path.join(roundDir, 'job.json'), 'utf8'));
    assert.equal(jobSpec.id, accepted.jobId);
    assert.equal(jobSpec.threadId, threadId);
    assert.equal(jobSpec.command.executable, process.execPath);
    assert.deepEqual(jobSpec.command.args, [path.join(repoRoot, 'bin', 'cli.mjs'), 'run', path.join(roundDir, 'task.json')]);
    assert.deepEqual([accepted.stdoutPath, accepted.stderrPath, accepted.exitPath], [
      path.join(roundDir, 'stdout.jsonl'), path.join(roundDir, 'stderr.log'), path.join(roundDir, 'exit.txt'),
    ]);
    // The receipt is printed only after the coordinator registered and confirmed App Tools.
    const record = JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs', `${accepted.jobId}.json`), 'utf8'));
    assert.equal(record.status, 'running');
    assert.ok(Number.isInteger(record.watcherPid));
    assert.doesNotThrow(() => process.kill(record.watcherPid, 0));
    assert.equal(roundDirs('alpha').length, 1);
    releaseGate();
    const done = await waitForJob(accepted.jobId);
    assert.equal(done.status, 'notified');
    assert.equal(done.exitCode, 0);
    const binding = JSON.parse(fs.readFileSync(accepted.bindingPath, 'utf8'));
    assert.ok(binding.sessionId);
    assert.equal(agents.size, baseAgents + 1);
    assert.equal(promptCount, basePrompts + 1);
    state.alphaSession = binding.sessionId;
    state.alphaJob = accepted.jobId;
    state.alphaRound = roundDir;
    state.alphaPrompt = prompt;

    const summary = await runNode([readRunBin, accepted.jobId]);
    assert.equal(summary.status, 0, summary.stderr);
    const parsed = JSON.parse(summary.stdout);
    assert.equal(parsed.job.id, accepted.jobId);
    assert.equal(parsed.job.status, 'notified');
    assert.equal(parsed.job.task, 'alpha');
    assert.equal(parsed.sessionId, binding.sessionId);
    assert.equal(parsed.steps, 1);
    assert.equal(parsed.finalPresent, true);
    assert.equal(parsed.finalText, 'turn-1');
    assert.equal(parsed.observedUsage.outputTokens.tokens, 2);
    assert.equal(parsed.observedUsage.inputTokens.tokens, 10);
    assert.equal(parsed.observedUsage.cacheReadTokens.tokens, 90);
  });

  await t.test('same task continues the same session and keeps per-round evidence', async () => {
    const result = await startSubmit({ workspace, task: 'alpha', prompt: '差量：补充边界测试。', acceptance: '新增测试通过' });
    const accepted = receipt(result);
    assert.equal(accepted.reusedBinding, true);
    assert.equal(accepted.sessionId, state.alphaSession);
    assert.notEqual(accepted.jobId, state.alphaJob);
    const roundDir = path.dirname(accepted.stdoutPath);
    assert.notEqual(roundDir, state.alphaRound);
    const done = await waitForJob(accepted.jobId);
    assert.equal(done.status, 'notified');
    assert.equal(done.exitCode, 0);
    const binding = JSON.parse(fs.readFileSync(accepted.bindingPath, 'utf8'));
    assert.equal(binding.sessionId, state.alphaSession);
    assert.equal(binding.lastRequestId, accepted.jobId);
    assert.equal(binding.lastJobId, accepted.jobId);
    assert.equal(agents.size, baseAgents + 1);
    assert.equal(promptCount, basePrompts + 2);
    assert.equal(roundDirs('alpha').length, 2);
    assert.equal(fs.readFileSync(path.join(state.alphaRound, 'prompt.txt'), 'utf8'), state.alphaPrompt);
  });

  await t.test('a different task gets an isolated directory, binding and session', async () => {
    const result = await startSubmit({ workspace, task: 'beta', prompt: '独立任务', acceptance: '完成' });
    const accepted = receipt(result);
    assert.equal(accepted.reusedBinding, false);
    assert.notEqual(accepted.bindingPath, path.join(taskDir('alpha'), 'binding.json'));
    assert.equal(accepted.bindingPath, path.join(taskDir('beta'), 'binding.json'));
    const done = await waitForJob(accepted.jobId);
    assert.equal(done.status, 'notified');
    const binding = JSON.parse(fs.readFileSync(accepted.bindingPath, 'utf8'));
    assert.notEqual(binding.sessionId, state.alphaSession);
    assert.equal(agents.size, baseAgents + 2);
    assert.equal(promptCount, basePrompts + 3);
    assert.equal(roundDirs('alpha').length, 2);
    assert.equal(roundDirs('beta').length, 1);
  });

  await t.test('an active round rejects concurrent submits; a failed launch releases the task', async t2 => {
    holdPrompts();
    t2.after(() => releaseGate());
    const spec = { workspace, task: 'gamma', prompt: '保持运行', acceptance: '完成' };
    const results = await Promise.all([startSubmit(spec), startSubmit(spec)]);
    const winners = results.filter(result => result.status === 0);
    assert.equal(winners.length, 1, results.map(result => result.stderr).join('\n'));
    assert.notEqual(results.find(result => result.status !== 0).status, 0);
    const accepted = receipt(winners[0]);
    assert.equal(roundDirs('gamma').length, 1);
    const duplicate = await startSubmit({ ...spec, prompt: '再次提交' });
    assert.notEqual(duplicate.status, 0);
    assert.equal(roundDirs('gamma').length, 1);
    releaseGate();
    const done = await waitForJob(accepted.jobId);
    assert.equal(done.status, 'notified');
    assert.equal(done.exitCode, 0);

    const badData = path.join(root, 'data-is-a-file');
    fs.writeFileSync(badData, 'not a directory');
    const brokenSpec = { workspace, task: 'broken', prompt: 'p', acceptance: 'a' };
    const failed = await startSubmit(brokenSpec, { ...baseEnv, DSH_WAIBAO_DATA_DIR: badData });
    assert.notEqual(failed.status, 0);
    assert.equal(fs.existsSync(path.join(taskDir('broken'), 'active.json')), false);
    const retried = receipt(await startSubmit(brokenSpec));
    assert.equal(retried.task, 'broken');
    const retriedDone = await waitForJob(retried.jobId);
    assert.equal(retriedDone.status, 'notified');
    assert.equal(retriedDone.exitCode, 0);
  });
});

test('read-run keeps unknown usage null and reports cache, input and output separately', async () => {
  const log = path.join(root, 'synthetic-round.jsonl');
  fs.writeFileSync(log, [
    { type: 'session', sessionId: 'session-synthetic', cwd: workspace },
    { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 20, cacheReadTokens: 80, outputTokens: 10, totalTokens: 110 } },
    { type: 'status', phase: 'step_end', turn: 1, step: 2 },
    { type: 'final', text: 'ok' },
  ].map(JSON.stringify).join('\n') + '\n');
  const run = await runNode([readRunBin, log]);
  assert.equal(run.status, 0, run.stderr);
  const summary = JSON.parse(run.stdout);
  assert.equal(summary.job, null);
  assert.equal(summary.steps, 2);
  assert.equal(summary.usageSteps, 1);
  assert.equal(summary.observedUsage.inputTokens.tokens, 20);
  assert.equal(summary.observedUsage.cacheReadTokens.tokens, 80);
  assert.equal(summary.observedUsage.outputTokens.tokens, 10);
  assert.equal(summary.observedUsage.cacheWriteTokens.tokens, null);
  assert.equal(summary.observedUsage.cacheWriteTokens.reportedSteps, 0);
  assert.equal(summary.usageCompleteForFinishedSteps, false);
  assert.equal(summary.cacheHitPercent, null);
  assert.equal(summary.measuredStepsCacheHitPercent, 80);

  const jobId = 'bounded-parent-messages';
  fs.writeFileSync(path.join(dataDir, 'jobs', `${jobId}.json`), JSON.stringify({id: jobId, stdoutPath: log, parentMessages: Array.from({length: 25}, (_, index) => ({messageId: `m-${index}`, message: 'x'.repeat(2100), notificationError: index === 0 ? 'failed' : undefined}))}));
  const bounded = JSON.parse((await runNode([readRunBin, jobId])).stdout);
  assert.equal(bounded.job.parentMessageCount, 25);
  assert.equal(bounded.job.messageDeliveryErrors, 1);
  assert.equal(bounded.job.parentMessages.length, 20);
  assert.equal(bounded.job.parentMessages[0].messageId, 'm-5');
  assert.equal(bounded.job.parentMessages[0].message.length, 2000);
  assert.equal(bounded.job.parentMessages[0].messageTruncated, true);
});
