import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMission, processEvent, loseConnection } from '../src/lib/mission';
const state = () => ({ ...emptyMission(), threadId: 'thread-1', connection: 'connected' as const });
const event = (method: string, params: Record<string, unknown>) => ({ method, params: { threadId: 'thread-1', ...params } });

test('concurrent operations remain independent and final output carries exit status', () => {
  const s = state();
  for (const id of ['a', 'b']) processEvent(s, event('item/started', { turnId: 't', item: { id, type: 'commandExecution', command: id, status: 'inProgress' } }));
  processEvent(s, event('item/commandExecution/outputDelta', { itemId: 'b', delta: 'test failed' }));
  processEvent(s, event('item/completed', { item: { id: 'a', type: 'commandExecution', command: 'a', status: 'completed', aggregatedOutput: 'ok', exitCode: 0 } }));
  assert.equal(s.activities.find(a => a.id === 'b')?.status, 'inProgress');
  assert.equal(s.activities.find(a => a.id === 'b')?.output, 'test failed');
  assert.equal(s.activities.find(a => a.id === 'a')?.details.exitCode, 0);
  assert.equal(s.execution, 'idle'); // A successful command does not complete a turn or objective.
});

test('interruption closes unfinished operations even without item/completed', () => {
  const s = state();
  processEvent(s, event('turn/started', { turn: { id: 't' } }));
  processEvent(s, event('item/started', { turnId: 't', item: { id: 'a', type: 'commandExecution', status: 'inProgress' } }));
  s.attention.push({ id: 1, method: 'approval', params: {} });
  processEvent(s, event('turn/completed', { turn: { id: 't', status: 'interrupted' } }));
  assert.equal(s.execution, 'interrupted');
  assert.equal(s.activities[0].status, 'interrupted');
  assert.deepEqual(s.attention, []);
});

test('transport failure makes active execution and operations unknown', () => {
  const s = state();
  processEvent(s, event('turn/started', { turn: { id: 't' } }));
  processEvent(s, event('item/started', { item: { id: 'a', type: 'mcpToolCall', status: 'inProgress' } }));
  s.attention.push({ id: 'request', method: 'approval', params: {} });
  loseConnection(s, 'Disconnected');
  assert.equal(s.connection, 'lost');
  assert.equal(s.execution, 'unknown');
  assert.equal(s.activities[0].status, 'unknown');
  assert.deepEqual(s.attention, []);
});

test('unrelated threads and old completed turns cannot overwrite the active turn', () => {
  const s = state();
  processEvent(s, event('turn/started', { turn: { id: 'new' } }));
  processEvent(s, { method: 'turn/completed', params: { threadId: 'other', turn: { id: 'new', status: 'failed' } } });
  processEvent(s, event('turn/completed', { turn: { id: 'old', status: 'completed' } }));
  assert.equal(s.execution, 'working');
});

test('streamed agent messages reconcile with final items without duplication', () => {
  const s = state();
  processEvent(s, event('item/agentMessage/delta', { itemId: 'm', delta: 'Hello' }));
  processEvent(s, event('item/agentMessage/delta', { itemId: 'm', delta: ' world' }));
  processEvent(s, event('item/completed', { item: { id: 'm', type: 'agentMessage', text: 'Hello world!', phase: 'final_answer' } }));
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].text, 'Hello world!');
});

test('failure remains distinct from completion and resolved approvals are scoped by ID', () => {
  const s = state();
  s.attention.push({ id: 1, method: 'approval', params: {} }, { id: 2, method: 'approval', params: {} });
  processEvent(s, event('serverRequest/resolved', { requestId: 1 }));
  assert.deepEqual(s.attention.map(a => a.id), [2]);
  processEvent(s, event('turn/completed', { turn: { id: 't', status: 'failed', error: { message: 'Model unavailable' } } }));
  assert.equal(s.execution, 'failed'); assert.equal(s.error, 'Model unavailable');
});

test('bounded command output explicitly marks truncation', () => {
  const s = state();
  processEvent(s, event('item/started', { item: { id: 'a', type: 'commandExecution' } }));
  processEvent(s, event('item/commandExecution/outputDelta', { itemId: 'a', delta: 'x'.repeat(70000) }));
  assert.match(s.activities[0].output, /^\[Earlier output omitted\]/);
  assert.ok(s.activities[0].output.length < 64100);
});


test('observed steering replaces the accepted receipt using its client ID', () => {
  const s = state();
  s.messages.push({ id: 'client', clientId: 'client', role: 'user', text: 'Steer', phase: 'steering_accepted', time: 1 });
  processEvent(s, event('item/completed', { item: { id: 'server', clientId: 'client', type: 'userMessage', content: [{ type: 'text', text: 'Steer' }] } }));
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].id, 'server');
  assert.equal(s.messages[0].phase, undefined);
});
