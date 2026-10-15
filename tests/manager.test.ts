import test from 'node:test';
import assert from 'node:assert/strict';
import { MissionManager } from '../src/lib/server/manager';
import type { WireMessage } from '../src/lib/mission';

function harness() {
  let emit!: (event: WireMessage) => void;
  let disconnect!: (reason: string) => void;
  const sent: WireMessage[] = [];
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const manager = new MissionManager((receive, close) => {
    emit = receive; disconnect = close;
    return {
      connect: async () => {}, close: () => close('Closed'), send: m => { sent.push(m); },
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'thread' }, model: 'test', sandbox: { type: 'readOnly' }, approvalPolicy: 'on-request', approvalsReviewer: 'user' };
        if (method === 'turn/start') { receive({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } }); return { turn: { id: 'turn' } }; }
        if (method === 'thread/resume') return { thread: { id: 'thread', status: { type: 'idle' }, turns: [{ id: 'turn', status: 'interrupted', items: [] }] } };
        return {};
      }
    };
  });
  return { manager, sent, requests, emit: (m: WireMessage) => emit(m), disconnect: () => disconnect('Connection lost') };
}

test('agent proposals are attributed, validated, and cannot overwrite the objective', async () => {
  const h = harness();
  await h.manager.start(process.cwd(), 'Human objective', 'read-only');
  h.emit({ id: 7, method: 'item/tool/call', params: { threadId: 'thread', tool: 'player_two_next_step', arguments: { text: 'Check mobile Safari' } } });
  assert.equal(h.manager.state.objective, 'Human objective');
  assert.equal(h.manager.state.proposals[0].source, 'agent');
  assert.equal(h.manager.state.proposals[0].disposition, 'proposed');
  assert.equal(h.sent[0].result.success, true);
  h.emit({ id: 8, method: 'item/tool/call', params: { tool: 'player_two_next_step', arguments: { text: 'x'.repeat(1001) } } });
  assert.equal(h.manager.state.proposals.length, 1);
  assert.equal(h.sent[1].result.success, false);
});

test('approval choices honor available decisions and require server resolution', async () => {
  const h = harness();
  await h.manager.start(process.cwd(), 'Test', 'read-only');
  h.emit({ id: 'a', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', availableDecisions: ['accept', 'cancel'] } });
  assert.throws(() => h.manager.answer('a', 'acceptForSession'));
  assert.throws(() => h.manager.answer('a', 'decline'));
  h.manager.answer('a', 'accept');
  assert.equal(h.manager.state.attention[0].responding, true);
  assert.throws(() => h.manager.answer('a', 'accept'));
  assert.deepEqual(h.sent[0], { id: 'a', result: { decision: 'accept' } });
  h.emit({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 'a' } });
  assert.equal(h.manager.state.attention.length, 0);
});

test('stop acknowledgement is not interruption confirmation; ending stays blocked', async () => {
  const h = harness();
  await h.manager.start(process.cwd(), 'Test', 'read-only');
  await h.manager.stop();
  assert.equal(h.manager.state.execution, 'stopping');
  assert.throws(() => h.manager.end());
  h.emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } } });
  assert.equal(h.manager.state.execution, 'interrupted');
  h.manager.end(); assert.equal(h.manager.state.id, '');
});

test('reconnection reconciles without automatically starting another turn', async () => {
  const h = harness();
  await h.manager.start(process.cwd(), 'Test', 'read-only');
  h.disconnect();
  assert.equal(h.manager.state.execution, 'unknown');
  await assert.rejects(h.manager.message('Do more', false));
  await h.manager.reconnect();
  assert.equal(h.manager.state.execution, 'interrupted');
  assert.equal(h.requests.filter(r => r.method === 'turn/start').length, 1);
});

test('follow-up and explicit steering use the same thread and guard turn identity', async () => {
  const h = harness();
  await h.manager.start(process.cwd(), 'Test', 'read-only');
  await assert.rejects(h.manager.message('Follow-up', false));
  await h.manager.message('Only inspect files', true);
  const steer = h.requests.at(-1)!;
  assert.equal(steer.method, 'turn/steer');
  assert.equal(steer.params.threadId, 'thread');
  assert.equal(steer.params.expectedTurnId, 'turn');
  assert.equal(h.manager.state.messages.at(-1)?.phase, 'steering_accepted');
  assert.equal(h.manager.state.messages.at(-1)?.clientId, steer.params.clientUserMessageId);
  h.emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
  await h.manager.message('Follow-up', false);
  assert.equal(h.requests.filter(r => r.method === 'thread/start').length, 1);
  assert.equal(h.requests.at(-1)?.params.threadId, 'thread');
});

test('two simultaneous start requests create only one mission', async () => {
  const h = harness();
  const results = await Promise.allSettled([h.manager.start(process.cwd(), 'A', 'read-only'), h.manager.start(process.cwd(), 'B', 'read-only')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(h.requests.filter(r => r.method === 'thread/start').length, 1);
});

import { MissionStore } from '../src/lib/server/store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('missions survive database reopen and switching never starts a turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'player-two-store-'));
  const path = join(dir, 'missions.sqlite');
  const h = harness();
  let store = new MissionStore(path);
  h.manager.setStore(store);
  await h.manager.start(process.cwd(), 'First objective', 'read-only');
  const firstId = h.manager.state.id;
  h.emit({ id: 501, method: 'item/tool/call', params: { tool: 'player_two_update_mission', arguments: { title: 'Investigate behavior', description: 'Understand without edits.', baseVersion: 0 } } });
  h.emit({ method: 'item/completed', params: { threadId: 'thread', item: { id: 'answer', type: 'agentMessage', text: 'First answer' } } });
  h.emit({ method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } });
  h.manager.end();
  store.close(); store = new MissionStore(path); h.manager.setStore(store);
  assert.equal(store.get(firstId)?.messages[0].text, 'First answer');
  await h.manager.start(process.cwd(), 'Second objective', 'read-only');
  const secondId = h.manager.state.id;
  await assert.rejects(h.manager.open(firstId), /Stop/);
  h.emit({ method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } });
  const turnsBefore = h.requests.filter(r => r.method === 'turn/start').length;
  await h.manager.open(firstId);
  assert.equal(h.manager.state.id, firstId);
  assert.equal(h.manager.state.goalHistory?.at(-1)?.title, 'Investigate behavior');
  assert.equal(h.manager.state.objective, 'First objective');
  assert.equal(h.requests.filter(r => r.method === 'turn/start').length, turnsBefore);
  assert.equal(store.list().length, 2);
  assert.equal(store.get(secondId)?.objective, 'Second objective');
  h.manager.end();
  // Allow the manager's final notification to finish before closing its test store.
  await new Promise(resolve => setTimeout(resolve, 60));
  store.close(); rmSync(dir, { recursive: true, force: true });
});

test('Codex decisions require confirmation and retain a chat source', async () => {
  const h = harness();
  await h.manager.start(process.cwd(), 'Keep objective', 'read-only');
  h.emit({ id: 9, method: 'item/tool/call', params: { threadId: 'thread', tool: 'player_two_propose_decision', arguments: { text: 'Use the existing test runner.' } } });
  const d = h.manager.state.decisions![0];
  assert.equal(d.disposition, 'proposed');
  assert.equal(h.manager.state.messages.find(m => m.id === d.messageId)?.text, d.text);
  await h.manager.decide(d.id, 'confirmed');
  assert.equal(d.delivery?.status, 'accepted');
  assert.equal(h.requests.at(-1)?.method, 'turn/steer');
  await assert.rejects(h.manager.decide(d.id, 'confirmed'));
  assert.equal(d.disposition, 'confirmed');
  assert.equal(h.manager.state.objective, 'Keep objective');
  await assert.rejects(h.manager.decide('missing', 'confirmed'));
  await h.manager.decide(d.id, 'dismissed');
  assert.equal(d.disposition, 'dismissed');
});


test('exploratory chats do not invent an objective; idle confirmation sends a follow-up', async () => {
  const h = harness();
  await h.manager.start(process.cwd(), 'Help me explore this project', 'read-only', true);
  assert.equal(h.manager.state.objective, '');
  h.emit({ id: 19, method: 'item/tool/call', params: { threadId: 'thread', tool: 'player_two_propose_decision', arguments: { text: 'Keep the current format.' } } });
  h.emit({ method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed' } } });
  await h.manager.decide(h.manager.state.decisions![0].id, 'confirmed');
  assert.equal(h.requests.at(-1)?.method, 'turn/start');
  assert.match(JSON.stringify(h.requests.at(-1)?.params.input), /I confirm this decision/);
});

test('failed decision delivery is retained and cannot be duplicated', async () => {
  const h = harness();
  await h.manager.start(process.cwd(), 'Explore', 'read-only', true);
  h.emit({ id: 20, method: 'item/tool/call', params: { tool: 'player_two_propose_decision', arguments: { text: 'Keep the current format.' } } });
  const decision = h.manager.state.decisions![0];
  h.manager.message = async () => { throw new Error('Transport lost'); };
  await assert.rejects(h.manager.decide(decision.id, 'confirmed'));
  assert.equal(decision.delivery?.status, 'uncertain');
  await assert.rejects(h.manager.decide(decision.id, 'confirmed'), /receipt/);
});

test('question and permission responses have distinct server-resolution receipts', async () => {
  const h = harness();
  await h.manager.start(process.cwd(), 'Explore', 'read-only', true);
  h.emit({ id: 'q', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'format', question: 'Which format?' }] } });
  h.manager.answer('q', 'answer', { format: 'Plain text' });
  assert.deepEqual(h.sent.at(-1)?.result, { answers: { format: { answers: ['Plain text'] } } });
  assert.equal(h.manager.state.responses?.[0].kind, 'question');
  assert.equal(h.manager.state.responses?.[0].status, 'sent');
  h.emit({ method: 'serverRequest/resolved', params: { requestId: 'q' } });
  assert.equal(h.manager.state.responses?.[0].status, 'resolved');
  h.emit({ id: 'p', method: 'item/commandExecution/requestApproval', params: {} });
  h.manager.answer('p', 'decline');
  assert.equal(h.manager.state.responses?.[1].kind, 'permission');
  h.disconnect();
  assert.equal(h.manager.state.responses?.[1].status, 'uncertain');
});

test('mission updates are versioned and cannot silently overwrite a human correction', async () => {
  const h = harness();
  await h.manager.start(process.cwd(), 'Explore uploads', 'read-only', true);
  assert.equal(h.manager.state.goalToolAvailable, true);
  const update = (baseVersion: number, title: string) => h.emit({ id: 100 + baseVersion, method: 'item/tool/call', params: { tool: 'player_two_update_mission', arguments: { title, description: 'Understand mobile upload failures.', baseVersion } } });
  update(0, 'Investigate mobile uploads');
  assert.equal(h.manager.state.goalHistory?.[0].author, 'agent');
  await h.manager.correctGoal({title:'Diagnose only',description:'Find the cause without editing files.',baseVersion:1});
  assert.equal(h.requests.at(-1)?.method, 'turn/steer');
  assert.equal(h.manager.state.goalHistory?.at(-1)?.delivery?.status, 'accepted');
  update(1, 'Rewrite uploads');
  assert.equal(h.sent.at(-1)?.result.success, false);
  assert.equal(h.manager.state.goalHistory?.at(-1)?.title, 'Diagnose only');
  update(2, 'Explain upload failure');
  assert.equal(h.manager.state.goalHistory?.length, 3);
  h.emit({ method:'turn/completed',params:{turn:{id:'turn',status:'completed'}} });
  assert.equal(h.manager.state.goalHistory?.at(-1)?.title, 'Explain upload failure');
  assert.equal(h.manager.state.objective, '');
  await h.manager.correctGoal({title:'Document the finding',description:'Explain the cause in chat.',baseVersion:3});
  assert.equal(h.requests.at(-1)?.method, 'turn/start');
  await assert.rejects(h.manager.correctGoal({title:'Stale',description:'Old wording',baseVersion:3}));
});

test('uncertain goal correction preserves history and blocks agent overwrites', async () => {
  const h = harness();
  await h.manager.start(process.cwd(), 'Legacy title', 'read-only');
  h.manager.message = async () => { throw new Error('Transport lost'); };
  await assert.rejects(h.manager.correctGoal({title:'Corrected goal',description:'Investigate only.',baseVersion:0}));
  assert.equal(h.manager.state.goalHistory?.[0].author, 'legacy');
  assert.equal(h.manager.state.goalHistory?.at(-1)?.delivery?.status, 'uncertain');
  h.emit({id:201,method:'item/tool/call',params:{tool:'player_two_update_mission',arguments:{title:'Overwrite',description:'No',baseVersion:1}}});
  assert.equal(h.sent.at(-1)?.result.success,false);
});

test('empty idle threads recover and can accept a first message', async () => {
  const calls: string[] = [];
  const m = new MissionManager(() => ({
    connect: async () => {}, close: () => {}, send: () => {},
    request: async (method) => {
      calls.push(method);
      if (method === 'thread/resume') return { thread: { id: 'empty', status: { type: 'idle' }, turns: [] } };
      return { turn: { id: 'first' } };
    }
  }));
  m.state.threadId = 'empty'; m.state.connection = 'connected'; m.state.execution = 'unknown';
  await m.reconnect();
  assert.equal(m.state.execution, 'idle');
  assert.equal(m.state.turnId, null);
  assert.deepEqual(calls, ['thread/resume']);
  await m.message('First message', false);
  assert.equal(m.state.execution, 'working');
  assert.equal(calls.at(-1), 'turn/start');
});

test('empty paginated hydration retrieves the latest turn before classifying execution', async () => {
  const m = new MissionManager(() => ({
    connect: async () => {}, close: () => {}, send: () => {},
    request: async (method) => method === 'thread/resume'
      ? { thread: { id: 'paged', status: { type: 'idle' }, turns: [] }, turnsBackwardsCursor: 'cursor' }
      : { data: [{ id: 'last', status: 'failed', error: { message: 'Failed check' }, items: [] }] }
  }));
  m.state.threadId = 'paged'; m.state.connection = 'lost';
  await m.reconnect();
  assert.equal(m.state.execution, 'failed');
  assert.equal(m.state.error, 'Failed check');
  assert.equal(m.state.turnId, 'last');
});
