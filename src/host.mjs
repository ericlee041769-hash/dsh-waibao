import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import packageInfo from '../package.json' with {type: 'json'};
import { connectionFile } from './paths.mjs';

export const name = 'dsh-waibao';
export const inject = ['sessionController', 'workspaceRegistry', 'sessions', 'agentDefaultModel', 'llm', 'tools'];

export async function apply(ctx) {
  if (process.platform !== 'win32') throw new Error('dsh-waibao 0.1 supports Windows desktop');
  const controller = ctx.sessionController;
  const token = randomBytes(32).toString('hex');
  const pipe = `\\\\.\\pipe\\dsh-waibao-${randomUUID()}`;
  const active = new Set();
  const sockets = new Set();
  const delegated = new Map();
  const settledApprovals = new Map();
  const settledQuestions = new Map();
  const continuedQuestions = new Map();
  const maxPendingPerSession = 16;
  const maxSettledApprovals = 200;
  const maxListedApprovals = 50;
  const maxSettledQuestions = 200;

  function rememberApproval(record) {
    settledApprovals.set(record.approvalId, record);
    while (settledApprovals.size > maxSettledApprovals) settledApprovals.delete(settledApprovals.keys().next().value);
  }

  function approvalEvent(entry, event) {
    try { entry.send(event); } catch {}
  }

  function approvalView(pending) {
    return {
      approvalId: pending.approvalId, sessionId: pending.sessionId, requestId: pending.requestId,
      toolName: pending.toolName, ...(pending.callId ? {callId: pending.callId} : {}),
      ...(pending.reason ? {reason: pending.reason} : {}), createdAt: pending.createdAt,
    };
  }

  function settleApproval(entry, approvalId, outcome) {
    const pending = entry.pending.get(approvalId);
    if (!pending) return false;
    entry.pending.delete(approvalId);
    pending.signal?.removeEventListener('abort', pending.onAbort);
    rememberApproval({approvalId, sessionId: pending.sessionId, requestId: pending.requestId, workspace: entry.workspace, threadId: entry.threadId, outcome, decidedAt: new Date().toISOString()});
    approvalEvent(entry, {type: 'waiting_done', kind: 'approval', id: approvalId, outcome});
    approvalEvent(entry, {type: 'approval_decided', approvalId, sessionId: pending.sessionId, requestId: pending.requestId, outcome});
    pending.resolve(outcome);
    return true;
  }

  function cancelApprovals(entry) {
    for (const approvalId of [...entry.pending.keys()]) settleApproval(entry, approvalId, 'cancelled');
  }

  function sameCodexThread(entry, request) {
    return !entry.threadId || request.callerThreadId === entry.threadId;
  }

  function listPending(workspacePath, request) {
    const approvals = [];
    for (const [sessionId, entry] of delegated) {
      if (entry.workspace !== workspacePath) continue;
      if (!sameCodexThread(entry, request)) continue;
      if (typeof request.sessionId === 'string' && request.sessionId && request.sessionId !== sessionId) continue;
      for (const pending of entry.pending.values()) {
        if (typeof request.requestId === 'string' && request.requestId && request.requestId !== pending.requestId) continue;
        approvals.push(approvalView(pending));
        if (approvals.length > maxListedApprovals) break;
      }
      if (approvals.length > maxListedApprovals) break;
    }
    approvals.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return {type: 'approvals', approvals: approvals.slice(0, maxListedApprovals), truncated: approvals.length > maxListedApprovals};
  }

  function decideApproval(workspacePath, request) {
    if (typeof request.sessionId !== 'string' || !request.sessionId) throw new Error('sessionId is required to decide an approval');
    if (typeof request.approvalId !== 'string' || !request.approvalId) throw new Error('approvalId is required to decide an approval');
    if (!['allowed-once', 'rejected'].includes(request.outcome)) throw new Error('outcome must be "allowed-once" or "rejected"');
    const settled = settledApprovals.get(request.approvalId);
    if (settled) {
      if (settled.sessionId !== request.sessionId || settled.workspace !== workspacePath) throw new Error('Approval does not belong to this delegated session and workspace');
      if (typeof request.callerThreadId === 'string' && request.callerThreadId && settled.threadId && request.callerThreadId !== settled.threadId) throw new Error('Approval belongs to another Codex thread');
      if (request.requestId !== undefined && request.requestId !== settled.requestId) throw new Error('Approval request mismatch');
      if (!['allowed-once', 'rejected'].includes(settled.outcome)) throw new Error(`Approval is not pending: it was ${settled.outcome}`);
      if (settled.outcome !== request.outcome) throw new Error(`Approval already settled as ${settled.outcome}`);
      return {type: 'approval_decision', status: 'already-decided', approvalId: request.approvalId, sessionId: request.sessionId, requestId: settled.requestId, outcome: settled.outcome};
    }
    const entry = delegated.get(request.sessionId);
    if (!entry || entry.workspace !== workspacePath) throw new Error('No delegated session with pending approvals in this workspace');
    if (!sameCodexThread(entry, request)) throw new Error('Approval belongs to another Codex thread');
    const pending = entry.pending.get(request.approvalId);
    if (!pending) throw new Error('Approval is not pending: it may have been decided, cancelled, expired, or never existed');
    if (request.requestId !== undefined && pending.requestId !== request.requestId) throw new Error('Approval request mismatch');
    settleApproval(entry, pending.approvalId, request.outcome);
    return {type: 'approval_decision', status: 'decided', approvalId: pending.approvalId, sessionId: request.sessionId, requestId: pending.requestId, outcome: request.outcome};
  }

  function questionError(code, message) {
    const error = new Error(message);
    error.name = 'UserQuestionError';
    error.code = code;
    return error;
  }

  function rememberQuestion(record) {
    settledQuestions.set(record.questionId, record);
    while (settledQuestions.size > maxSettledQuestions) settledQuestions.delete(settledQuestions.keys().next().value);
  }

  function questionView(pending) {
    return {
      questionId: pending.questionId, sessionId: pending.sessionId, requestId: pending.requestId,
      callId: pending.callId ?? null, timed: pending.timed, questions: pending.questions,
      createdAt: pending.createdAt, state: pending.state,
    };
  }

  function settleQuestion(entry, questionId, outcome, answers) {
    const pending = entry.pendingQuestions.get(questionId);
    if (!pending) return false;
    entry.pendingQuestions.delete(questionId);
    pending.signal?.removeEventListener('abort', pending.onAbort);
    const record = {
      questionId, sessionId: pending.sessionId, requestId: pending.requestId, callId: pending.callId,
      workspace: entry.workspace, threadId: entry.threadId, outcome, answers: answers ?? null,
      questions: pending.questions, decidedAt: new Date().toISOString(),
    };
    rememberQuestion(record);
    approvalEvent(entry, {type: 'waiting_done', kind: 'question', id: questionId, outcome});
    approvalEvent(entry, {type: 'question_decided', questionId, sessionId: pending.sessionId, requestId: pending.requestId, outcome});
    if (outcome === 'answered') pending.resolve({answers});
    else pending.reject(questionError(outcome === 'cancelled' ? 'ASK_ABORTED' : 'ASK_REJECTED', `the user ${outcome} question ${questionId}`));
    return true;
  }

  function cancelQuestions(entry) {
    for (const questionId of [...entry.pendingQuestions.keys()]) settleQuestion(entry, questionId, 'cancelled');
  }

  function questionBatch(pending, request) {
    if (request.outcome === 'answered') {
      const answers = Array.isArray(request.answers) ? request.answers : null;
      if (!answers) throw new Error('answers is required when outcome is "answered"');
      const named = new Set();
      for (const answer of answers) {
        if (!answer || typeof answer !== 'object' || typeof answer.id !== 'string' || !Array.isArray(answer.selected) || !answer.selected.every(label => typeof label === 'string')) throw new Error('each answer needs a string id and a string selected array');
        if (answer.custom !== undefined && typeof answer.custom !== 'string') throw new Error('answer custom must be a string');
        if (named.has(answer.id)) throw new Error(`answer id ${JSON.stringify(answer.id)} is repeated`);
        named.add(answer.id);
      }
      const expected = pending.questions.map(question => question.id);
      if (named.size !== expected.length || !expected.every(id => named.has(id))) throw new Error(`the answer batch for ${pending.callId ?? pending.questionId} must name each of its ${expected.length} questions exactly once`);
      return answers.map(answer => ({id: answer.id, selected: [...answer.selected], ...(answer.custom === undefined ? {} : {custom: answer.custom})}));
    }
    if (request.outcome !== 'rejected' && request.outcome !== 'cancelled') throw new Error('outcome must be "answered", "rejected" or "cancelled"');
    return null;
  }

  async function answerQuestion(workspacePath, request) {
    if (typeof request.sessionId !== 'string' || !request.sessionId) throw new Error('sessionId is required to answer a question');
    if (typeof request.runRequestId !== 'string' || !request.runRequestId) throw new Error('runRequestId is required to answer a question');
    if (request.questionId !== undefined && (typeof request.questionId !== 'string' || !request.questionId)) throw new Error('questionId must be a non-empty string when provided');
    if (request.callId !== undefined && (typeof request.callId !== 'string' || !request.callId)) throw new Error('callId must be a non-empty string when provided');
    const entry = delegated.get(request.sessionId);
    if (entry) {
      if (entry.workspace !== workspacePath) throw new Error('No delegated run with pending questions in this workspace');
      if (entry.requestId !== request.runRequestId) throw new Error('The question belongs to a different delegated run');
      const pending = request.questionId
        ? entry.pendingQuestions.get(request.questionId)
        : [...entry.pendingQuestions.values()].find(item => item.callId !== null && item.callId === request.callId);
      if (pending) {
        if (pending.requestId !== request.runRequestId) throw new Error('The question belongs to a different delegated run');
        if (!sameCodexThread(entry, request)) throw new Error('Question belongs to another Codex thread');
        const answers = questionBatch(pending, request);
        settleQuestion(entry, pending.questionId, request.outcome, answers ?? []);
        return {type: 'question_decision', status: 'decided', questionId: pending.questionId, sessionId: request.sessionId, requestId: pending.requestId, callId: pending.callId, outcome: request.outcome};
      }
    }
    const settled = request.questionId ? settledQuestions.get(request.questionId) : [...settledQuestions.values()].find(item => item.sessionId === request.sessionId && item.callId !== null && item.callId === request.callId);
    if (settled) {
      if (settled.sessionId !== request.sessionId || settled.workspace !== workspacePath || settled.requestId !== request.runRequestId) throw new Error('The question belongs to a different delegated run');
      if (!sameCodexThread(settled, request)) throw new Error('Question belongs to another Codex thread');
      if (settled.outcome === 'continued') {
        if (!entry || entry.finished || entry.stopped) throw new Error('The question outlived its delegated run; continue the same task with submit and include the answer');
        const continuedAnswers = questionBatch(settled, request);
        const service = ctx.get('userQuestions');
        if (!service) throw new Error('The desktop question service is unavailable for this continued question');
        const found = await controller.resolveAgent(request.sessionId);
        if (!found?.agent) throw new Error('The delegated session is no longer live for this continued question');
        const answers = continuedAnswers ?? settled.questions.map(question => ({id: question.id, selected: []}));
        if (service.answer(found.agent, settled.callId, {answers}) !== true) throw new Error('Question is no longer answerable');
        continuedQuestions.delete(`${request.sessionId}:${settled.callId}`);
        rememberQuestion({...settled, outcome: request.outcome, answers, decidedAt: new Date().toISOString()});
        const live = delegated.get(request.sessionId);
        if (live) approvalEvent(live, {type: 'question_decided', questionId: settled.questionId, sessionId: request.sessionId, requestId: settled.requestId, outcome: request.outcome});
        return {type: 'question_decision', status: 'decided', questionId: settled.questionId, sessionId: request.sessionId, requestId: settled.requestId, callId: settled.callId, outcome: request.outcome};
      }
      if (settled.outcome !== request.outcome) throw new Error(`Question already settled as ${settled.outcome}`);
      if (settled.outcome === 'answered' && JSON.stringify(questionBatch(settled, request)) !== JSON.stringify(settled.answers)) throw new Error('Question already settled with a different answer');
      return {type: 'question_decision', status: 'already-decided', questionId: settled.questionId, sessionId: request.sessionId, requestId: settled.requestId, callId: settled.callId, outcome: settled.outcome};
    }
    throw new Error('Question is not pending: it may have been answered, rejected, cancelled, expired, or never existed');
  }

  function activeEntry(workspacePath, request) {
    if (typeof request.sessionId !== 'string' || !request.sessionId) throw new Error('sessionId is required');
    if (typeof request.runRequestId !== 'string' || !request.runRequestId) throw new Error('runRequestId is required');
    const entry = delegated.get(request.sessionId);
    if (!entry || entry.workspace !== workspacePath) throw new Error('No active delegated run in this workspace/session');
    if (entry.requestId !== request.runRequestId) throw new Error('The delegation run no longer matches this session');
    if (!sameCodexThread(entry, request)) throw new Error('The delegated run belongs to another Codex thread');
    return entry;
  }

  function userMessageState(agent, requestId) {
    const matches = message => message.source?.kind === 'user' && message.source.rpcId === requestId;
    if (agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches)) return 'accepted';
    const found = agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source?.kind === 'user' && event.data.source.rpcId === requestId);
    return found ? 'consumed' : null;
  }

  function listJobPending(workspacePath, request) {
    const entry = delegated.get(request.sessionId);
    const empty = {type: 'job-pending', active: false, sessionId: request.sessionId ?? null, runRequestId: request.runRequestId ?? null, runState: 'ended', approvals: [], questions: [], appends: []};
    if (!entry || entry.workspace !== workspacePath || entry.requestId !== request.runRequestId) return empty;
    if (!sameCodexThread(entry, request)) throw new Error('The delegated run belongs to another Codex thread');
    const continued = [...continuedQuestions.values()].filter(item => item.sessionId === request.sessionId && item.requestId === entry.requestId);
    return {
      type: 'job-pending', active: !entry.finished, sessionId: request.sessionId, runRequestId: entry.requestId,
      runState: entry.finished ? 'ended' : entry.stopped ? 'cancelling' : (entry.pending.size || entry.pendingQuestions.size || continued.length) ? 'waiting' : 'running',
      approvals: [...entry.pending.values()].map(approvalView),
      questions: [...entry.pendingQuestions.values()].map(questionView).concat(continued),
      appends: [...entry.appends.values()].map(item => ({
        requestId: item.requestId, acceptedAt: item.acceptedAt, consumedAt: item.consumedAt ?? null,
        discardedAt: item.discardedAt ?? null,
        status: item.consumedAt ? 'consumed' : item.discardedAt ? 'discarded' : 'accepted',
      })),
    };
  }

  async function appendSteer(workspacePath, request) {
    const entry = activeEntry(workspacePath, request);
    if (entry.stopped) throw new Error('The delegated run is stopping; do not append another instruction');
    if (entry.finished) throw new Error('The delegated run is finished; continue with submit instead of append');
    if (typeof request.prompt !== 'string' || !request.prompt.trim()) throw new Error('prompt is required');
    if (typeof request.appendRequestId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(request.appendRequestId)) throw new Error('A valid append requestId is required');
    const agent = entry.agent;
    if (agent.status !== 'running') throw new Error('The delegated run is not executing; continue an idle task with submit instead of append');
    const known = entry.appends.get(request.appendRequestId);
    if (known) return {type: 'append', requestId: request.appendRequestId, status: 'duplicate', consumed: Boolean(known.consumedAt), acceptedAt: known.acceptedAt};
    const existing = userMessageState(agent, request.appendRequestId);
    if (existing) return {type: 'append', requestId: request.appendRequestId, status: 'duplicate', consumed: existing === 'consumed'};
    const record = {requestId: request.appendRequestId, acceptedAt: new Date().toISOString(), consumedAt: null, discardedAt: null};
    entry.appends.set(request.appendRequestId, record);
    try {
      await controller.prompt({
        sessionId: request.sessionId, requestId: request.appendRequestId,
        content: [{type: 'text', text: request.prompt}], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        mode: 'steer',
      }, new AbortController().signal);
    } catch (error) {
      entry.appends.delete(request.appendRequestId);
      throw error;
    }
    if (entry.stopped) {
      // A stop raced this admission: remove the just-queued steer instead of
      // letting the retained inbox start another turn.
      record.discardedAt = new Date().toISOString();
      for (const list of [agent.inbox.nextTurn, agent.inbox.nextStep]) {
        const message = list.find(item => item.source?.kind === 'user' && item.source.rpcId === request.appendRequestId);
        if (!message) continue;
        try { await controller.updateQueue({sessionId: request.sessionId, itemId: message.id, action: {kind: 'remove'}}); } catch {}
      }
      return {type: 'append', requestId: request.appendRequestId, status: 'discarded', consumed: false, acceptedAt: record.acceptedAt};
    }
    return {type: 'append', requestId: request.appendRequestId, status: 'accepted', consumed: false, acceptedAt: record.acceptedAt};
  }

  async function stopRun(workspacePath, request) {
    const entry = activeEntry(workspacePath, request);
    if (entry.finished) return {type: 'stopped', status: 'ended', sessionId: request.sessionId, runRequestId: entry.requestId, removed: [], retained: []};
    if (entry.stopped) return {type: 'stopped', status: 'cancelling', sessionId: request.sessionId, runRequestId: entry.requestId, removed: [], retained: []};
    entry.stopped = true;
    entry.stopRequestedAt = new Date().toISOString();
    const agent = entry.agent;
    const removed = [];
    const retained = [];
    const owned = message => message?.source?.kind === 'user' && entry.appends.has(message.source.rpcId)
      && !entry.appends.get(message.source.rpcId).consumedAt && !entry.appends.get(message.source.rpcId).discardedAt;
    // Drop this delegation's not-yet-consumed steering before cancelling so the
    // retained inbox cannot start another turn from it.
    for (const list of [agent.inbox.nextTurn, agent.inbox.nextStep]) {
      for (const message of [...list]) {
        if (!owned(message)) continue;
        try {
          await controller.updateQueue({sessionId: request.sessionId, itemId: message.id, action: {kind: 'remove'}});
          entry.appends.get(message.source.rpcId).discardedAt = new Date().toISOString();
          removed.push(message.source.rpcId);
        } catch (error) {
          retained.push({requestId: message.source.rpcId, error: String(error?.message ?? error)});
        }
      }
    }
    try { await controller.cancel({sessionId: request.sessionId}); }
    catch (error) { throw new Error(`The desktop run could not be cancelled: ${String(error?.message ?? error)}`); }
    cancelQuestions(entry);
    cancelApprovals(entry);
    approvalEvent(entry, {type: 'stopped', requestId: entry.requestId, removed, retained});
    return {type: 'stopped', status: 'cancelling', sessionId: request.sessionId, runRequestId: entry.requestId, removed, retained};
  }

  // Only delegated sessions are answered here. Every other session delegates to
  // the composed answerers (the desktop approval/question UI), which keeps
  // ordinary and non-delegated interactions on their existing path.
  ctx.on('approval/request', (request, next) => {
    const agent = request?.agent;
    const sessionId = agent?.session?.id;
    const entry = typeof sessionId === 'string' ? delegated.get(sessionId) : undefined;
    if (!entry || entry.agent !== agent) return next();
    if (entry.pending.size >= maxPendingPerSession) return Promise.resolve('unavailable');
    const approvalId = randomUUID();
    const pending = {
      approvalId, sessionId, requestId: entry.requestId,
      toolName: String(request.toolName ?? 'unknown').slice(0, 200),
      ...(typeof request.callId === 'string' ? {callId: request.callId} : {}),
      ...(typeof request.reason === 'string' ? {reason: request.reason.slice(0, 500)} : {}),
      createdAt: new Date().toISOString(), signal: request.signal,
    };
    return new Promise(resolve => {
      let resolved = false;
      pending.resolve = outcome => { if (resolved) return; resolved = true; resolve(outcome); };
      pending.onAbort = () => settleApproval(entry, approvalId, 'cancelled');
      pending.signal?.addEventListener('abort', pending.onAbort, {once: true});
      entry.pending.set(approvalId, pending);
      if (pending.signal?.aborted) { settleApproval(entry, approvalId, 'cancelled'); return; }
      approvalEvent(entry, {type: 'waiting', kind: 'approval', id: approvalId, ...approvalView(pending)});
      approvalEvent(entry, {type: 'approval', ...approvalView(pending)});
    });
  }, {prepend: true});

  ctx.on('user-questions/request', (request, next) => {
    const agent = request?.agent;
    const sessionId = agent?.session?.id;
    const entry = typeof sessionId === 'string' ? delegated.get(sessionId) : undefined;
    if (!entry || entry.agent !== agent) return next();
    if (entry.pendingQuestions.size >= maxPendingPerSession) return Promise.reject(questionError('NO_PROVIDER', 'too many pending questions in this delegated session'));
    const questionId = randomUUID();
    const callId = typeof request.wait?.callId === 'string' ? request.wait.callId : null;
    const pending = {
      questionId, sessionId, requestId: entry.requestId, callId,
      timed: request.wait?.timed === true, state: 'open',
      questions: (request.questions ?? []).map(question => ({...question, ...(question.options ? {options: question.options.map(option => ({...option}))} : {})})),
      createdAt: new Date().toISOString(), signal: request.signal,
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      pending.resolve = answer => { if (settled) return; settled = true; resolve(answer); };
      pending.reject = error => { if (settled) return; settled = true; reject(error); };
      pending.onAbort = () => {
        if (pending.timed && request.signal?.reason?.code === 'ASK_TIMED_OUT') {
          entry.pendingQuestions.delete(questionId);
          rememberQuestion({questionId, sessionId, requestId: entry.requestId, callId, workspace: entry.workspace, threadId: entry.threadId, outcome: 'continued', answers: null, questions: pending.questions, decidedAt: new Date().toISOString()});
          continuedQuestions.set(`${sessionId}:${callId}`, {...questionView(pending), state: 'continued'});
          approvalEvent(entry, {type: 'waiting_done', kind: 'question', id: questionId, outcome: 'pending'});
          pending.reject(questionError('ASK_TIMED_OUT', 'the question wait expired; the answer is still pending'));
          return;
        }
        settleQuestion(entry, questionId, 'cancelled');
      };
      pending.signal?.addEventListener('abort', pending.onAbort, {once: true});
      entry.pendingQuestions.set(questionId, pending);
      if (pending.signal?.aborted) { pending.onAbort(); return; }
      approvalEvent(entry, {type: 'waiting', kind: 'question', id: questionId, ...questionView(pending)});
      approvalEvent(entry, {type: 'question', ...questionView(pending)});
    });
  }, {prepend: true});

  async function execute(request, send, socket) {
    if (request.action === 'describe') {
      send({type: 'desktop', module: import.meta.url, version: packageInfo.version, capabilities: {parentMessages: true}, pid: process.pid, selection: ctx.agentDefaultModel.currentSelection()});
      return;
    }
    if (!['adopt', 'run', 'pending', 'decide', 'pending-job', 'append', 'stop', 'answer-question'].includes(request.action)) throw new Error('Expected describe, adopt, run, pending, decide, pending-job, append, stop or answer-question');
    if (typeof request.workspace !== 'string' || !path.isAbsolute(request.workspace)) throw new Error('Absolute workspace required');
    const workspacePath = await fs.realpath(request.workspace);
    if (!(await fs.stat(workspacePath)).isDirectory()) throw new Error('Workspace must be a directory');
    if (request.action === 'pending') { send(listPending(workspacePath, request)); return; }
    if (request.action === 'decide') { send(decideApproval(workspacePath, request)); return; }
    if (request.action === 'pending-job') { send(listJobPending(workspacePath, request)); return; }
    if (request.action === 'append') { send(await appendSteer(workspacePath, request)); return; }
    if (request.action === 'stop') { send(await stopRun(workspacePath, request)); return; }
    if (request.action === 'answer-question') { send(await answerQuestion(workspacePath, request)); return; }
    if (request.action === 'run' && (typeof request.prompt !== 'string' || !request.prompt.trim() || typeof request.requestId !== 'string' || !request.requestId)) throw new Error('Prompt and unique requestId required');
    if (request.sessionId) {
      const saved = await controller.inspect(request.sessionId);
      if (path.normalize(saved.meta.cwd) !== path.normalize(request.workspace)) throw new Error('Resume requires the exact original workspace');
      if (saved.meta.isSeeded) throw new Error('Delegation requires an ordinary session');
    } else if (request.action !== 'run') throw new Error('Existing sessionId required');
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
    let turnTools;
    let turnEntry;
    let onSocketClose;
    try {
      await controller.create({sessionId, workspaceId: workspace.id});
      const found = await controller.resolveAgent(sessionId);
      if (found.error) throw found.error;
      const agent = found.agent;
      if (agent.status === 'running' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw new Error('Session is busy; wait for its existing work');
      if (agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.rpcId === request.requestId)) throw new Error('Request already exists; inspect its result before continuing');
      if (request.selection) {
        const resolved = await ctx.llm.resolveCallConfig(request.selection);
        controller.agents.selectForNextRequest(agent, {provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort ? {reasoningEffort: resolved.reasoningEffort} : {})});
      }
      const selection = controller.agents.selectionFor(agent).current;
      if (request.title) await controller.rename({sessionId, title: request.title});
      await ctx.sessions.flush(agent.session);
      send({type: 'session', sessionId, cwd: agent.session.header.cwd, workspaceId: workspace.id, selection, requestId: request.requestId, transport: 'desktop'});
      turnEntry = {
        agent, requestId: request.requestId, workspace: workspacePath,
        threadId: typeof request.callerThreadId === 'string' && request.callerThreadId ? request.callerThreadId : null,
        send, pending: new Map(), pendingQuestions: new Map(), appends: new Map(),
        stopped: false, finished: false,
      };
      delegated.set(sessionId, turnEntry);
      onSocketClose = () => { cancelApprovals(turnEntry); cancelQuestions(turnEntry); };
      socket.once('close', onSocketClose);
      turnTools = agent.ctx.inject(['tools'], toolsCtx => {
        toolsCtx.tools.register({
          name: 'send_to_parent',
          description: 'Send an important finding, blocker, or coordination request to the parent task while continuing this delegated run. Send only useful updates, not every progress message. A sent receipt confirms a write to this delegation coordinator channel; parent delivery is recorded separately and does not mean the parent has processed the message.',
          parameters: {type: 'object', properties: {message: {type: 'string', minLength: 1}}, required: ['message'], additionalProperties: false},
          output: {
            schema: {type: 'object', properties: {messageId: {type: 'string'}, status: {type: 'string', enum: ['sent']}}, required: ['messageId', 'status'], additionalProperties: false},
            render: (_args, value) => [{type: 'text', text: JSON.stringify(value)}],
          },
          execute: async (args, exec) => {
            if (exec?.agent !== agent || delegated.get(sessionId) !== turnEntry || turnEntry.finished || turnEntry.stopped) throw new Error('send_to_parent is available only to its active delegated agent');
            if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'message') || typeof args.message !== 'string' || !args.message.trim()) throw new Error('send_to_parent requires only a non-empty message string');
            exec.signal?.throwIfAborted();
            if (socket.destroyed || socket.writableEnded) throw new Error('The delegation coordinator message channel is closed');
            const event = {type: 'parent_message', messageId: randomUUID(), sessionId, requestId: turnEntry.requestId, message: args.message, createdAt: new Date().toISOString()};
            await new Promise((resolve, reject) => {
              socket.write(JSON.stringify(event) + '\n', error => error ? reject(error) : resolve());
            });
            return {messageId: event.messageId, status: 'sent'};
          },
        });
      });
      turnEntry.tools = turnTools;
      await turnTools;
      let finalText = '';
      let reason;
      let failure;
      let stepUsage;
      let usageComplete = true;
      stopEvents = ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return;
        const data = event.data;
        if (event.type === 'user/message') {
          const rpcId = data.source?.kind === 'user' ? data.source.rpcId : undefined;
          const appended = rpcId === undefined ? undefined : turnEntry.appends.get(rpcId);
          if (appended && !appended.consumedAt) {
            appended.consumedAt = new Date().toISOString();
            send({type: 'steer_consumed', requestId: turnEntry.requestId, steerRequestId: rpcId, sessionId});
          }
          return;
        }
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
      if (turnEntry.stopped) {
        send({type: 'final', text: '', sessionId, cancelled: true, reason: 'stopped'});
        turnEntry.finished = true;
        return;
      }
      await controller.prompt({sessionId, requestId: request.requestId, content: [{type: 'text', text: request.prompt}], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone}, new AbortController().signal);
      await agent.whenIdle();
      await ctx.sessions.flush(agent.session);
      if (failure) throw failure;
      if (reason?.kind === 'aborted') send({type: 'final', text: finalText, sessionId, cancelled: true, reason: reason.reason?.kind ?? 'aborted'});
      else if (reason?.kind !== 'completed') throw new Error(`Turn ended without completion: ${reason?.kind ?? 'unknown'}`);
      else send({type: 'final', text: finalText, sessionId});
      turnEntry.finished = true;
    } finally {
      stopEvents?.();
      stopErrors?.();
      if (turnEntry) {
        socket.removeListener('close', onSocketClose);
        cancelApprovals(turnEntry);
        cancelQuestions(turnEntry);
        for (const [key, question] of continuedQuestions) {
          if (question.sessionId === sessionId && question.requestId === turnEntry.requestId) continuedQuestions.delete(key);
        }
        delegated.delete(sessionId);
      }
      try { await turnTools?.dispose(); }
      finally { active.delete(sessionId); }
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
        await execute(request, send, socket);
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
    for (const entry of delegated.values()) cancelApprovals(entry);
    for (const entry of delegated.values()) cancelQuestions(entry);
    await Promise.all([...delegated.values()].map(entry => entry.tools?.dispose()));
    delegated.clear();
    settledApprovals.clear();
    settledQuestions.clear();
    continuedQuestions.clear();
  }, 'dsh-waibao: delegated approval and question answerers');
  ctx.effect(() => async () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    try {
      if (JSON.parse(await fs.readFile(connectionFile, 'utf8')).token === token) await fs.unlink(connectionFile);
    } catch (error) { if (error.code !== 'ENOENT') ctx.logger.warn(`dsh-waibao: ${error.message}`); }
  }, 'dsh-waibao: local server and connection record');
}
