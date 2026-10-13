import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const [source, ...extra] = process.argv.slice(2);
if (!source || extra.length || !path.isAbsolute(source)) {
  console.error('Usage: node read-run.mjs <absolute-headless-stdout.jsonl>');
  process.exit(1);
}

try {
  const result = {
    source, sessionId: null, cwd: null, turns: [], steps: 0,
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
