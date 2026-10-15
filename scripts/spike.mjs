import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const cwd = resolve('.player-two/spike-project');
mkdirSync(cwd, { recursive: true });
writeFileSync(`${cwd}/README.md`, 'Disposable Player Two connection test.\n');
const log = resolve('.player-two/spike.jsonl');
writeFileSync(log, '');
const child = spawn(process.env.CODEX_BIN || 'codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', b => appendFileSync(log + '.stderr', b));
let next = 0;
const pending = new Map();
const waiters = [];
const seen = [];
function send(message) { child.stdin.write(JSON.stringify(message) + '\n'); }
function request(method, params) {
  const id = ++next;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); send({ id, method, params });
  });
}
function waitFor(predicate, timeout = 90000) {
  const found = seen.find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const w = { predicate, resolve, timer: setTimeout(() => reject(new Error('Event timeout')), timeout) };
    waiters.push(w);
  });
}
createInterface({ input: child.stdout }).on('line', line => {
  appendFileSync(log, line + '\n');
  const m = JSON.parse(line);
  if (m.method) {
    seen.push(m);
    if (!m.method.startsWith('codex/event/') && !m.method.endsWith('/delta')) console.log(m.method, JSON.stringify(m.params).slice(0, 280));
    for (const w of [...waiters]) if (w.predicate(m)) { clearTimeout(w.timer); waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
    if (m.id !== undefined) {
      if (m.method === 'item/tool/call') send({ id: m.id, result: { contentItems: [{ type: 'inputText', text: 'Next step recorded as an agent proposal. The objective is unchanged.' }], success: true } });
      else if (m.method.endsWith('/requestApproval')) {
        // This spike explicitly declines requests. It never approves unattended actions.
        const result = m.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' };
        send({ id: m.id, result });
      } else send({ id: m.id, error: { code: -32601, message: 'Not supported by connection spike' } });
    }
  } else {
    const p = pending.get(m.id); if (!p) return;
    clearTimeout(p.timer); pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
  }
});
const watchdog = setTimeout(() => { console.error('Spike deadline exceeded'); child.kill(); process.exitCode = 1; }, 180000);
try {
  console.log('initialize', await request('initialize', { clientInfo: { name: 'player_two', title: 'Player Two', version: '0.1.0' }, capabilities: { experimentalApi: true } }));
  send({ method: 'initialized', params: {} });
  const result = await request('thread/start', {
    cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only',
    dynamicTools: [{ type: 'function', name: 'player_two_next_step', description: 'Record a proposed next step in the human mission HUD. Does not change the objective.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }],
    developerInstructions: 'This is a bounded integration test in a disposable project. Do not use subagents. Do not commit, publish, or deploy.'
  });
  const threadId = result.thread.id;
  console.log('thread', threadId, 'model', result.model, 'approvalPolicy', result.approvalPolicy, 'sandbox', result.sandbox);
  const first = await request('turn/start', { threadId, input: [{ type: 'text', text: 'Call player_two_next_step with text "Verify the connection spike". Then read README.md with a shell command. Finally request approval to execute a shell command with require_escalated permissions that writes the word test to approval-probe.txt in this project. The approval is expected to be declined; do not retry it. Report the observed outcome briefly.' }] });
  await waitFor(m => m.method === 'turn/completed' && m.params.turn.id === first.turn.id);
  const second = await request('turn/start', { threadId, input: [{ type: 'text', text: 'Run sleep 20 in the shell, then say done. This is an interruption test.' }] });
  await waitFor(m => m.method === 'item/started' && m.params.turnId === second.turn.id && m.params.item.type === 'commandExecution');
  console.log('interrupt response', await request('turn/interrupt', { threadId, turnId: second.turn.id }));
  const end = await waitFor(m => m.method === 'turn/completed' && m.params.turn.id === second.turn.id);
  console.log('RESULT', JSON.stringify({ threadId, dynamicTool: seen.some(m => m.method === 'item/tool/call'), approval: seen.some(m => m.method.endsWith('/requestApproval')), interrupt: end.params.turn.status, log }));
} catch (error) { console.error(error); process.exitCode = 1; }
finally { clearTimeout(watchdog); for (const w of waiters) clearTimeout(w.timer); child.kill(); }
