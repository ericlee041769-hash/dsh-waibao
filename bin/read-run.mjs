import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { dataDir } from '../src/paths.mjs';

const [rawSource, ...extra] = process.argv.slice(2);
const jobsDir = path.join(dataDir, 'jobs');
const jobIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
if (!rawSource || extra.length) {
  console.error('Usage: node read-run.mjs <job-id | absolute-headless-stdout.jsonl>');
  process.exit(1);
}

try {
  let source = rawSource;
  let job = null;
  if (jobIdPattern.test(rawSource)) {
    const record = path.join(jobsDir, `${rawSource}.json`);
    try { job = JSON.parse(fs.readFileSync(record, 'utf8')); }
    catch (error) { throw new Error(`Cannot read job record ${record}: ${error.message}`); }
    if (typeof job.stdoutPath !== 'string' || !path.isAbsolute(job.stdoutPath)) throw new Error(`Job ${rawSource} has no absolute stdout path`);
    source = job.stdoutPath;
  } else if (!path.isAbsolute(rawSource)) {
    throw new Error('Use a job ID or an absolute headless stdout path');
  }
  const result = {
    source, job: job && {
      id: job.id, status: job.status, runState: job.runState ?? null, exitCode: job.exitCode ?? null,
      workspace: job.workspace, bindingPath: job.bindingPath ?? null, task: job.task ?? null,
      stopRequestedAt: job.stopRequestedAt ?? null, discardedSteers: Array.isArray(job.discardedSteers) ? job.discardedSteers.slice(0, 50) : [],
      stdoutPath: job.stdoutPath, stderrPath: job.stderrPath ?? null, exitPath: job.exitPath ?? null,
      waiting: Array.isArray(job.waiting) ? job.waiting.slice(0, 20) : [],
      approvals: Array.isArray(job.approvals) ? job.approvals.slice(0, 20).map(record => ({
        approvalId: record.approvalId, sessionId: record.sessionId ?? null, requestId: record.requestId ?? null,
        toolName: record.toolName ?? null, callId: record.callId ?? null, reason: record.reason ?? null,
        createdAt: record.createdAt ?? null, notifiedAt: record.notifiedAt ?? null,
        notificationError: record.notificationError ?? null, outcome: record.outcome ?? null, decidedAt: record.decidedAt ?? null,
      })) : [],
      questions: Array.isArray(job.questions) ? job.questions.slice(0, 20).map(record => ({
        questionId: record.questionId, sessionId: record.sessionId ?? null, requestId: record.requestId ?? null,
        callId: record.callId ?? null, timed: record.timed === true, questions: Array.isArray(record.questions) ? record.questions.slice(0, 20) : [],
        createdAt: record.createdAt ?? null, notifiedAt: record.notifiedAt ?? null,
        notificationError: record.notificationError ?? null, outcome: record.outcome ?? null, decidedAt: record.decidedAt ?? null,
      })) : [],
      parentMessageCount: Array.isArray(job.parentMessages) ? job.parentMessages.length : 0,
      messageDeliveryErrors: Array.isArray(job.parentMessages) ? job.parentMessages.filter(record => record.notificationError).length : 0,
      parentMessages: Array.isArray(job.parentMessages) ? job.parentMessages.slice(-20).map(record => ({
        messageId: record.messageId, sessionId: record.sessionId ?? null, requestId: record.requestId ?? null,
        message: String(record.message ?? '').slice(0, 2000), messageTruncated: String(record.message ?? '').length > 2000,
        createdAt: record.createdAt ?? null, deliveryAttemptedAt: record.deliveryAttemptedAt ?? null,
        notifiedAt: record.notifiedAt ?? null, notificationError: record.notificationError ?? null,
      })) : [],
    },
    sessionId: null, cwd: null, turns: [], steps: 0,
    usageSteps: 0, cacheMeasuredSteps: 0, toolCalls: 0, toolErrors: 0,
    firstStepUsage: null, lastStepUsage: null, finalPresent: false,
    finalText: null, finalTruncated: false, errors: [],
  };
  const fields = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens'];
  const totals = {};
  const samples = {};
  let cacheInput = 0;
  let cached = 0;
  let lineNumber = 0;
  const lines = createInterface({ input: fs.createReadStream(source, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (let line of lines) {
    lineNumber++;
    if (lineNumber === 1) line = line.replace(/^\uFEFF/, '');
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error(`Invalid JSON at line ${lineNumber}; use a completed, intact stdout log.`); }
    if (event?.type === 'session') {
      if (typeof event.sessionId !== 'string' || !event.sessionId) throw new Error(`Missing session ID at line ${lineNumber}`);
      if (result.sessionId && result.sessionId !== event.sessionId) throw new Error('Multiple sessions in one log; summarize each round separately.');
      result.sessionId = event.sessionId;
      result.cwd = event.cwd ?? null;
    }
    if (event?.type === 'status' && event.phase === 'turn_start') result.turns.push(event.turn);
    if (event?.type === 'status' && event.phase === 'step_end') {
      result.steps++;
      if (event.usage && typeof event.usage === 'object') {
        result.usageSteps++;
        const values = {};
        for (const field of fields) {
          const value = event.usage[field];
          if (!Number.isFinite(value) || value < 0) continue;
          values[field] = value;
          totals[field] = (totals[field] ?? 0) + value;
          samples[field] = (samples[field] ?? 0) + 1;
        }
        const stepUsage = { turn: event.turn, step: event.step, ...values };
        result.firstStepUsage ??= stepUsage;
        result.lastStepUsage = stepUsage;
        if (values.totalTokens !== undefined && values.outputTokens !== undefined && values.cacheReadTokens !== undefined) {
          const input = values.totalTokens - values.outputTokens;
          if (input >= values.cacheReadTokens) {
            result.cacheMeasuredSteps++;
            cacheInput += input;
            cached += values.cacheReadTokens;
          }
        }
      }
    }
    if (event?.type === 'tool_call') result.toolCalls++;
    if (event?.type === 'tool_result' && event.status === 'error') result.toolErrors++;
    if (event?.type === 'error' && result.errors.length < 10) {
      result.errors.push({ line: lineNumber, message: String(event.message ?? 'Unspecified error').slice(0, 500) });
    }
    if (event?.type === 'final') {
      result.finalPresent = true;
      const text = typeof event.text === 'string' ? event.text : '';
      result.finalText = text.slice(0, 4000);
      result.finalTruncated = text.length > 4000;
      result.finalLine = lineNumber;
    }
  }
  result.lines = lineNumber;
  result.observedUsage = Object.fromEntries(fields.map(field => [field, {
    tokens: samples[field] ? totals[field] : null,
    reportedSteps: samples[field] ?? 0,
  }]));
  const rate = cacheInput > 0 ? Math.round(cached / cacheInput * 10000) / 100 : null;
  result.cacheHitPercent = result.steps > 0 && result.cacheMeasuredSteps === result.steps ? rate : null;
  result.measuredStepsCacheHitPercent = rate;
  result.usageCompleteForFinishedSteps = result.steps > 0 && result.usageSteps === result.steps;
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
