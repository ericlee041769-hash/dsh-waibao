#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { dataDir } from '../src/paths.mjs';

const jobsDir = path.join(dataDir, 'jobs');
const [action, input] = process.argv.slice(2);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const jobIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;

function saveJob(job) {
  const destination = path.join(jobsDir, `${job.id}.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  job.updatedAt = new Date().toISOString();
  fs.writeFileSync(temporary, JSON.stringify(job, null, 2) + '\n');
  fs.renameSync(temporary, destination);
}

async function appTool(job, name, args) {
  const appEnv = Object.fromEntries([
    'PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA',
    'CODEX_MCP_NODE_PATH', 'CODEX_BROWSER_USE_NODE_PATH', 'CODEX_ELECTRON_RESOURCES_PATH',
    'CODEX_CLI_PATH', 'CODEX_APP_TOOLS_CALLER_HOST_ID', 'XDG_CACHE_HOME',
  ].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const child = spawn(job.connection.node, [job.connection.server], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...appEnv, CODEX_APP_TOOLS_PIPE_PATH: job.connection.pipe },
  });
  let nextId = 0;
  let stderr = '';
  const pending = new Map();
  const rejectPending = error => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on('error', rejectPending);
  child.stdin.on('error', rejectPending);
  child.on('close', code => rejectPending(new Error(`App Tools closed (${code}): ${stderr.slice(-1500)}`)));
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-3000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); }
    catch { rejectPending(new Error('Invalid JSON from App Tools')); return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => {
      if (error) { pending.delete(id); reject(error); }
    });
  });
  const timeout = setTimeout(() => {
    rejectPending(new Error('App Tools request timed out; delivery may be uncertain'));
    child.kill();
  }, 45000);
  try {
    await request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'dsh-waibao', version: '0.1.0' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const result = await request('tools/call', {
      name, arguments: args,
      _meta: { 'openai/threadId': job.callerThreadId },
    });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    const content = result.content.find(item => item.type === 'text')?.text;
    if (!content) throw new Error('App Tools returned no receipt');
    return JSON.parse(content);
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

async function deliver(job) {
  if (job.status === 'notified') {
    console.log(JSON.stringify({ id: job.id, status: job.status, duplicateSuppressed: true }));
    return;
  }
  if (!job.completedAt) throw new Error('Cannot notify before the process has completed');
  // A lost reply must not cause a second task. Reconcile the event marker first.
  if (job.deliveryAttemptedAt) {
    const history = await appTool(job, 'read_thread', { threadId: job.threadId, turnLimit: 10, includeOutputs: false });
    const found = history.turns?.some(turn => turn.items?.some(item =>
      item.type === 'userMessage' && item.content?.some(part => part.text?.includes(job.marker))));
    if (found) {
      job.status = 'notified';
      job.receipt = { recoveredFromHistory: true };
      job.notifiedAt = new Date().toISOString();
      saveJob(job);
      console.log(JSON.stringify({ id: job.id, status: job.status, recoveredFromHistory: true }));
      return;
    }
    throw new Error('Prior delivery is uncertain. No automatic resend; inspect the target chat before creating another event.');
  }
  const prompt = `${job.marker}\nDeepSeek Harness 执行轮次已结束，请按已授权要求验收。\n任务：${job.id}\n工作区：${job.workspace}\n退出码：${job.exitCode ?? '未知'}\n结束时间：${job.completedAt}\n标准输出：${job.stdoutPath}\n错误日志：${job.stderrPath}\n事件记录：${path.join(jobsDir, `${job.id}.json`)}\n${job.processError ? `进程异常：${job.processError}\n` : ''}\n${job.reviewPrompt}\n\n这是进程结束回调，不是定时检查。退出码只代表进程状态，不代表验收通过；请独立检查实际产物和测试。不要为等待 Harness 新建 heartbeat 或定时轮询。同一事件只处理一次。`;
  job.status = 'delivering';
  job.deliveryAttemptedAt = new Date().toISOString();
  saveJob(job);
  try {
    job.receipt = await appTool(job, 'send_message_to_thread', { threadId: job.threadId, hostId: 'local', prompt });
    job.status = 'notified';
    job.notifiedAt = new Date().toISOString();
    saveJob(job);
    console.log(JSON.stringify({ id: job.id, status: job.status, receipt: job.receipt }));
  } catch (error) {
    job.status = 'notification_uncertain';
    job.notificationError = error.message;
    saveJob(job);
    throw error;
  }
}

async function main() {
  if (!['run', 'deliver', 'status'].includes(action) || !input) {
    throw new Error('Usage: dsh-waibao-job run <spec.json> | deliver|status <job-id>');
  }
  fs.mkdirSync(jobsDir, { recursive: true });
  if (action === 'status') {
    if (!jobIdPattern.test(input)) throw new Error('Invalid job ID');
    const job = JSON.parse(fs.readFileSync(path.join(jobsDir, `${input}.json`), 'utf8'));
    const { connection, ...publicJob } = job;
    console.log(JSON.stringify(publicJob, null, 2));
    return;
  }
  let job;
  if (action === 'deliver') {
    if (!jobIdPattern.test(input)) throw new Error('Invalid job ID');
    job = JSON.parse(fs.readFileSync(path.join(jobsDir, `${input}.json`), 'utf8'));
    // Refresh the desktop connection only from the current, actual Codex environment.
    if (process.env.CODEX_APP_TOOLS_PIPE_PATH) job.connection.pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH;
  } else {
    const spec = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8').replace(/^\uFEFF/, ''));
    if (!jobIdPattern.test(spec.id)) throw new Error('Invalid job ID');
    if (!uuid.test(spec.threadId) || !uuid.test(process.env.CODEX_THREAD_ID ?? '')) throw new Error('A real target and originating Codex thread are required');
    if (!path.isAbsolute(spec.workspace) || !fs.statSync(spec.workspace).isDirectory()) throw new Error('Workspace must be an existing absolute directory');
    if (new Set([spec.stdoutPath, spec.stderrPath, spec.exitPath].map(value => path.resolve(value ?? '').toLowerCase())).size !== 3) throw new Error('Task evidence paths must be distinct');
    for (const key of ['stdoutPath', 'stderrPath', 'exitPath']) {
      if (!path.isAbsolute(spec[key] ?? '')) throw new Error(`${key} must be absolute`);
      const relative = path.relative(spec.workspace, spec[key]);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error(`${key} must stay within the workspace`);
      fs.mkdirSync(path.dirname(spec[key]), { recursive: true });
      if (action === 'run' && fs.existsSync(spec[key])) throw new Error(`Refusing to overwrite existing task evidence: ${spec[key]}`);
    }
    if (typeof spec.reviewPrompt !== 'string' || !spec.reviewPrompt.trim()) throw new Error('Review instructions are required');
    if (action === 'run' && (!path.isAbsolute(spec.command?.executable ?? '') || !Array.isArray(spec.command?.args) || !spec.command.args.every(value => typeof value === 'string'))) throw new Error('An absolute executable and string argument array are required');
    const pluginRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'plugins/cache/openai-bundled/codex-app-tools');
    const versions = fs.readdirSync(pluginRoot).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    const server = versions.map(version => path.join(pluginRoot, version, 'server.mjs')).find(candidate => fs.existsSync(candidate));
    const pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH;
    if (!server || !pipe) throw new Error('Start the task from a Codex desktop session with App Tools available');
    job = {
      ...spec, marker: `[DSH_WAIBAO_COMPLETION:${spec.id}]`,
      callerThreadId: process.env.CODEX_THREAD_ID,
      connection: { pipe, server, node: process.execPath },
      createdAt: new Date().toISOString(), status: 'registered', mode: action,
    };
    const record = path.join(jobsDir, `${job.id}.json`);
    fs.writeFileSync(record, JSON.stringify(job, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  const lockPath = path.join(jobsDir, `${job.id}.lock`);
  const lock = fs.openSync(lockPath, 'wx');
  fs.writeSync(lock, String(process.pid));
  try {
    if (action === 'deliver') { await deliver(job); return; }
    // Confirm the originating chat is reachable before spending a model turn.
    await appTool(job, 'read_thread', { threadId: job.threadId, turnLimit: 1, includeOutputs: false });
    job.status = 'running';
    job.watcherPid = process.pid;
    job.startedAt = new Date().toISOString();
    saveJob(job);
    let stdoutFd;
    let stderrFd;
    stdoutFd = fs.openSync(job.stdoutPath, 'wx');
    stderrFd = fs.openSync(job.stderrPath, 'wx');
    try {
      const child = spawn(job.command.executable, job.command.args, {
        cwd: job.workspace, windowsHide: true,
        env: { ...process.env, DSH_CODEX_JOB_ID: job.id },
        stdio: ['ignore', stdoutFd, stderrFd],
      });
      job.childPid = child.pid;
      saveJob(job);
      const outcome = await new Promise(resolve => {
        child.on('error', error => resolve({ code: null, error: error.message }));
        child.on('close', (code, signal) => resolve({ code, error: signal ? `Process terminated by ${signal}` : undefined }));
      });
      job.exitCode = outcome.code;
      job.processError = outcome.error;
      fs.writeFileSync(job.exitPath, `${outcome.code ?? 'unknown'}\n`, { flag: 'wx' });
      job.completedAt = new Date().toISOString();
      job.status = 'completed';
      saveJob(job);
    } finally {
      if (stdoutFd !== undefined) fs.closeSync(stdoutFd);
      if (stderrFd !== undefined) fs.closeSync(stderrFd);
    }
    await deliver(job);
    process.exitCode = Number.isInteger(job.exitCode) ? job.exitCode : 1;
  } catch (error) {
    if (job.status !== 'notification_uncertain') {
      job.status = 'failed';
      job.error = error.message;
      saveJob(job);
    }
    throw error;
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
