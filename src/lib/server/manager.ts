import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { reviseGoal } from '../mission-goal';
import { MissionStore } from './store';
import { CodexConnection } from './codex';
import { activeExecution, emptyMission, loseConnection, processEvent, type MissionState, type WireMessage } from '../mission';

export const nextStepTool = {
  type: 'function', name: 'player_two_next_step',
  description: 'Propose a concrete next step for the human in Player Two. Use for a useful handoff or unresolved check, not routine narration. Records an attributed proposal without changing the mission objective or starting work. Returns its receipt ID.',
  inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'One actionable next step, at most 1000 characters.' } }, required: ['text'], additionalProperties: false }
};

export const decisionTool = {
  ...nextStepTool, name: 'player_two_propose_decision',
  description: 'Propose a consequential project decision for human confirmation. Supply a concise choice and rationale, at most 300 characters. Player Two adds your proposal to the chat and Decisions widget. A proposal is not permission to act. Human confirmation is sent to you as a user message. Wait for that message before acting on the choice; it does not expand permissions.',
  inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 300 } }, required: ['text'], additionalProperties: false }
};

export const missionTool = {
  type: 'function', name: 'player_two_update_mission',
  description: 'Record your understanding of the current conversational goal, once clear or when direction changes. Not routine activity. One short title and one-sentence description. This grants no permission and does not mark work complete. Use baseVersion 0 initially, then the version returned by this tool or human correction. A conflict returns current wording; respect human corrections and only revise for a subsequent conversational change.',
  inputSchema: { type: 'object', properties: { title: { type: 'string', maxLength: 80 }, description: { type: 'string', maxLength: 300 }, baseVersion: { type: 'integer', minimum: 0 } }, required: ['title', 'description', 'baseVersion'], additionalProperties: false }
};

type Client = Pick<CodexConnection, 'connect' | 'request' | 'send' | 'close'>;
type ClientFactory = (onEvent: (message: WireMessage) => void, onClose: (reason: string, diagnostics?: string) => void) => Client;

export class MissionManager {
  private store?: MissionStore;
  setStore(store: MissionStore) { this.store = store; this.persist(); }
  private persist() {
    try { this.store?.save(this.state); this.state.persistenceError = null; }
    catch { this.state.persistenceError = 'Mission could not be saved. Keep this server open and retry before switching.'; }
  }
  private snapshot() { return { ...this.state, savedMissions: this.store?.list() || [] }; }
  get snapshotState() { return this.snapshot(); }
  constructor(private makeClient: ClientFactory = (onEvent, onClose) => new CodexConnection(onEvent, onClose)) {}
  state: MissionState = emptyMission();
  private connection: Client | null = null;
  private listeners = new Set<(state: MissionState) => void>();
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  subscribe(listener: (state: MissionState) => void) {
    this.listeners.add(listener); listener(this.snapshot());
    return () => { this.listeners.delete(listener); };
  }
  private publish() {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.persist();
      for (const listener of this.listeners) listener(this.snapshot());
    }, 40);
  }
  private receive(message: WireMessage) {
    const p = message.params || {};
    if (p.threadId && this.state.threadId && p.threadId !== this.state.threadId) return;
    if (message.method === 'thread/started' && !this.state.threadId) this.state.threadId = p.thread?.id;
    processEvent(this.state, message);
    if (message.id !== undefined && message.method) {
      if (message.method === 'item/tool/call') {
        if (p.tool === missionTool.name) {
          let result;
          try { const revision = reviseGoal(this.state, p.arguments || {}, 'agent'); result = { success: true, revision }; }
          catch (error) { result = { success: false, error: String(error), current: this.state.goalHistory?.at(-1) || null }; }
          this.persist();
          this.connection?.send({ id: message.id, result: { success: result.success, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] } });
          this.publish(); return;
        }
        if (p.tool === decisionTool.name) {
          const text = p.arguments?.text;
          const valid = typeof text === 'string' && text.trim().length > 0 && text.length <= 300;
          if (valid) {
            const id = randomUUID();
            const messageId = `decision-${id}`;
            this.state.messages.push({ id: messageId, role: 'agent', text: text.trim(), phase: 'decision_proposal', time: Date.now() });
            (this.state.decisions ??= []).push({ id, messageId, text: text.trim(), source: 'agent', disposition: 'proposed', time: Date.now() });
          }
          this.connection?.send({ id: message.id, result: { success: valid, contentItems: [{ type: 'inputText', text: valid ? 'Decision proposed, awaiting human confirmation. This is not permission to act.' : 'Supply a decision of 1–300 characters.' }] } });
          this.publish(); return;
        }
        const text = p.arguments?.text;
        const valid = p.tool === nextStepTool.name && typeof text === 'string' && text.trim().length > 0 && text.length <= 1000;
        const id = randomUUID();
        if (valid) this.state.proposals.push({ id, text: text.trim(), time: Date.now(), source: 'agent', disposition: 'proposed' });
        this.connection?.send({ id: message.id, result: { success: valid, contentItems: [{ type: 'inputText', text: valid ? JSON.stringify({ proposalId: id, status: 'proposed', objectiveChanged: false, message: 'Visible to the human. Work has not been scheduled or started.' }) : 'Invalid next step. Supply text between 1 and 1000 characters.' }] } });
      } else this.state.attention.push({ id: message.id, method: message.method, params: p });
    }
    this.publish();
  }
  private async connect() {
    this.state.connection = 'connecting'; this.publish();
    const connection = this.makeClient(m => { if (this.connection === connection) this.receive(m); }, (reason, diagnostics) => {
      if (this.connection !== connection) return;
      loseConnection(this.state, reason, diagnostics); this.publish();
    });
    this.connection = connection;
    await connection.connect();
    this.state.connection = 'connected'; this.state.error = null; this.state.diagnostics = null;
  }
  private assertConnected() {
    if (this.state.connection !== 'connected' || !this.connection) throw new Error('App Server is not connected. Reconnect first.');
    return this.connection;
  }
  async start(project: string, objective: string, sandbox: string, exploratory = false) {
    if (this.busy || this.state.id) throw new Error('A mission is already open. End it before starting another.');
    if (!isAbsolute(project)) throw new Error('Select an absolute local project path.');
    const cwd = await realpath(project);
    if (!(await stat(cwd)).isDirectory()) throw new Error('Project must be a directory.');
    if (!objective.trim() || objective.length > 12000) throw new Error('Enter an objective between 1 and 12000 characters.');
    if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('Invalid sandbox selection.');
    // Recheck after filesystem awaits so concurrent requests cannot create two missions.
    if (this.busy || this.state.id) throw new Error('A mission is already open.');
    this.busy = true;
    this.state = { ...emptyMission(), id: randomUUID(), project: cwd, objective: exploratory ? '' : objective.trim(), title: objective.trim().split(/[.\n]/)[0].slice(0, 72), execution: 'starting' };
    try {
      await this.connect();
      const result = await this.connection!.request('thread/start', {
        cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox,
        dynamicTools: [nextStepTool, decisionTool, missionTool],
        developerInstructions: 'You are working in Player Two, a local mission interface. One mission is one thread. Do not use subagents. Do not commit, deploy, or publish unless the human explicitly requests it. Use player_two_update_mission once the conversational goal becomes clear, and only when that goal changes. It records your understanding, not permission or completion. Do not invent a goal during open-ended exploration. Human corrections arrive as user messages with a revision number; use that version for later updates. Use player_two_propose_decision for consequential choices requiring human agreement. Do not treat proposals as permission to act. Use player_two_next_step when a concrete handoff or unresolved check would help the human. A proposal does not change the objective. Distinguish your own claims from recorded test evidence.'
      });
      this.state.threadId = result.thread.id;
      this.state.goalToolAvailable = true;
      this.state.config = { model: result.model, approvalPolicy: result.approvalPolicy, approvalsReviewer: result.approvalsReviewer, sandbox: result.sandbox };
      this.state.execution = 'idle';
      await this.sendTurn(objective.trim());
    } catch (error) {
      if (!this.state.threadId || this.state.connection !== 'lost') this.state.execution = 'failed';
      this.state.error = String(error); throw error;
    } finally { this.busy = false; this.publish(); }
  }
  private async sendTurn(text: string) {
    const connection = this.assertConnected();
    this.state.execution = 'starting'; this.state.turnId = null; this.state.error = null; this.publish();
    const result = await connection.request('turn/start', { threadId: this.state.threadId, input: [{ type: 'text', text }] });
    this.state.turnId = result.turn.id;
    // Notifications may already have moved execution ahead of this response.
    if (this.state.execution === 'starting') this.state.execution = 'working';
  }
  async message(text: string, steer: boolean) {
    if (this.busy) throw new Error('Another mission action is in progress.');
    if (!text.trim() || text.length > 20000) throw new Error('Enter a message between 1 and 20000 characters.');
    const connection = this.assertConnected();
    if (!this.state.threadId) throw new Error('Start a mission first.');
    if (this.state.execution === 'unknown') throw new Error('Reconnect to reconcile execution before sending a message.');
    this.busy = true;
    try {
      if (steer) {
        if (this.state.execution !== 'working' || !this.state.turnId) throw new Error('There is no running turn to steer.');
        const clientId = randomUUID();
        await connection.request('turn/steer', { threadId: this.state.threadId, expectedTurnId: this.state.turnId, clientUserMessageId: clientId, input: [{ type: 'text', text: text.trim() }] });
        if (!this.state.messages.some(m => m.clientId === clientId)) this.state.messages.push({ id: clientId, clientId, role: 'user', text: text.trim(), phase: 'steering_accepted', time: Date.now() });
      } else {
        if (activeExecution(this.state)) throw new Error('Work is running. Use Send steering or stop first.');
        await this.sendTurn(text.trim());
      }
    } catch (error) { if (this.state.execution === 'starting') this.state.execution = 'failed'; this.state.error = String(error); throw error; }
    finally { this.busy = false; this.publish(); }
  }
  async stop() {
    const connection = this.assertConnected();
    if (!this.state.turnId || !activeExecution(this.state)) throw new Error('No active turn to interrupt.');
    const previous = this.state.execution;
    this.state.execution = 'stopping'; this.publish();
    try { await connection.request('turn/interrupt', { threadId: this.state.threadId, turnId: this.state.turnId }); }
    catch (error) { if (this.state.connection === 'connected' && this.state.execution === 'stopping') this.state.execution = previous; throw error; }
    finally { this.publish(); }
    // Only turn/completed confirms interruption, never the request acknowledgement.
  }
  answer(id: string | number, choice: string, answers?: Record<string, string>) {
    const connection = this.assertConnected();
    const request = this.state.attention.find(a => a.id === id);
    if (!request || request.responding) throw new Error('This request is no longer pending.');
    let result: Record<string, unknown>;
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) {
      const allowed = request.params.availableDecisions || ['accept', 'decline', 'cancel'];
      if (!['accept', 'decline', 'cancel'].includes(choice) || !allowed.includes(choice)) throw new Error('That approval decision is not available.');
      result = { decision: choice };
    } else if (request.method === 'item/permissions/requestApproval') {
      if (!['accept', 'decline'].includes(choice)) throw new Error('Invalid permission decision.');
      result = { permissions: choice === 'accept' ? request.params.permissions : {}, scope: 'turn' };
    } else if (request.method === 'item/tool/requestUserInput') {
      const mapped: Record<string, { answers: string[] }> = {};
      for (const q of request.params.questions || []) {
        const answer = answers?.[q.id]?.trim();
        if (!answer || answer.length > 10000) throw new Error('Answer every question before submitting.');
        mapped[q.id] = { answers: [answer] };
      }
      result = { answers: mapped };
    } else if (request.method === 'mcpServer/elicitation/request' && ['decline', 'cancel'].includes(choice)) {
      result = { action: choice, content: null };
    } else throw new Error('This request type is not supported. Stop the turn to cancel it.');
    connection.send({ id, result }); request.responding = true;
    (this.state.responses ??= []).push({ id, kind: request.method === 'item/tool/requestUserInput' ? 'question' : 'permission', status: 'sent', time: Date.now() });
    this.publish();
  }
  async decide(id: string, disposition: string) {
    const decision = this.state.decisions?.find(d => d.id === id);
    if (!decision || !['confirmed', 'dismissed'].includes(disposition)) throw new Error('Invalid decision.');
    if (disposition === 'dismissed') { decision.disposition = 'dismissed'; this.publish(); return; }
    if (decision.delivery) throw new Error('This choice already has a delivery receipt. Check the conversation before sending it again.');
    this.assertConnected();
    if (this.busy || ['starting', 'stopping', 'unknown'].includes(this.state.execution) || this.state.attention.length) throw new Error('Resolve the pending request or wait for Codex before confirming.');
    const text = `I confirm this decision: ${decision.text}\nContinue within my existing request using this choice. This does not grant additional permissions.`;
    decision.disposition = 'confirmed';
    decision.delivery = { status: 'sending', text };
    this.persist(); this.publish();
    try {
      await this.message(text, this.state.execution === 'working');
      decision.delivery.status = 'accepted';
    } catch (error) {
      decision.delivery.status = 'uncertain'; decision.delivery.error = String(error);
      throw error;
    } finally { this.persist(); this.publish(); }
  }
  async correctGoal(input: { title: string; description: string; baseVersion: number }) {
    this.assertConnected();
    if (this.busy || !this.state.threadId || ['starting', 'stopping', 'unknown'].includes(this.state.execution) || this.state.attention.length) throw new Error('Resolve the pending request or wait for Codex before sending a correction.');
    const revision = reviseGoal(this.state, input, 'user');
    const text = `Mission correction, revision ${revision.version}: ${revision.title}\n${revision.description}\nUse this as the current goal. This does not grant additional permissions or authorize broader work. Any later mission update must use baseVersion ${revision.version}.`;
    revision.delivery = { status: 'sending', text };
    this.persist(); this.publish();
    try { await this.message(text, this.state.execution === 'working'); revision.delivery.status = 'accepted'; }
    catch (error) { revision.delivery.status = 'uncertain'; revision.delivery.error = String(error); throw error; }
    finally { this.persist(); this.publish(); }
  }
  proposal(id: string, disposition: string) {
    if (!['noted', 'dismissed'].includes(disposition)) throw new Error('Invalid proposal action.');
    const proposal = this.state.proposals.find(p => p.id === id);
    if (!proposal) throw new Error('Proposal not found.');
    proposal.disposition = disposition as 'noted' | 'dismissed'; this.publish();
  }
  async reconnect() {
    if (this.busy || (this.state.connection === 'connected' && this.state.execution !== 'unknown')) throw new Error('Already connected or busy.');
    if (!this.state.threadId) throw new Error('No thread to reconnect to. End this mission and try again.');
    this.busy = true;
    try {
      this.connection?.close();
      await this.connect();
      const result = await this.connection!.request('thread/resume', { threadId: this.state.threadId });
      this.state.config = { model: result.model, approvalPolicy: result.approvalPolicy, approvalsReviewer: result.approvalsReviewer, sandbox: result.sandbox };
      const thread = result.thread;
      // Empty hydration is not proof of an empty thread when history is paginated.
      if (!thread.turns?.length && result.turnsBackwardsCursor) {
        const page = await this.connection!.request('thread/turns/list', { threadId: thread.id, limit: 1, sortDirection: 'desc', itemsView: 'full' });
        thread.turns = page.data || [];
        if (!thread.turns.length) throw new Error('Thread history is incomplete. Reconnect to check again.');
      }
      for (const turn of thread.turns || []) {
        for (const item of turn.items || []) processEvent(this.state, { method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item } });
      }
      for (const revision of this.state.goalHistory || []) {
        if (revision.delivery?.status === 'uncertain' && this.state.messages.some(m => m.role === 'user' && m.text === revision.delivery?.text)) revision.delivery.status = 'accepted';
      }
      const last = thread.turns?.at(-1);
      this.state.turnId = last?.id || this.state.turnId;
      if (thread.status?.type === 'active') this.state.execution = 'working';
      else if (last && ['completed', 'interrupted', 'failed'].includes(last.status)) this.state.execution = last.status;
      else if (!last && thread.status?.type === 'idle') { this.state.execution = 'idle'; this.state.turnId = null; }
      else this.state.execution = 'unknown';
      this.state.error = last?.error?.message || null;
    } catch (error) { loseConnection(this.state, String(error)); throw error; }
    finally { this.busy = false; this.publish(); }
  }
  async open(id: string) {
    if (id === this.state.id) return;
    const saved = this.store?.get(id);
    if (!saved) throw new Error('Saved mission not found.');
    this.end();
    this.state = saved;
    for (const revision of this.state.goalHistory || []) if (revision.delivery?.status === 'sending') revision.delivery.status = 'uncertain';
    for (const decision of this.state.decisions || []) if (decision.delivery?.status === 'sending') decision.delivery.status = 'uncertain';
    // Approval IDs belong to the old connection, never replay them.
    this.state.attention = [];
    this.state.connection = 'lost';
    if (activeExecution(this.state)) this.state.execution = 'unknown';
    this.publish();
    if (this.state.threadId) await this.reconnect();
    else { this.state.execution = 'failed'; this.state.error = 'This mission has no Codex thread. Start a new mission.'; this.publish(); }
  }
  end() {
    if (this.busy || activeExecution(this.state) || this.state.execution === 'unknown') throw new Error('Stop and wait for confirmation before ending the mission. Reconnect if state is unknown.');
    this.persist();
    if (this.state.persistenceError) throw new Error(this.state.persistenceError);
    const connection = this.connection; this.connection = null; connection?.close();
    this.state = emptyMission(); this.publish();
  }
  shutdown() {
    this.persist();
    const connection = this.connection; this.connection = null; connection?.close();
  }
}

// Keep one connection across Vite module reloads and browser clients.
const globalManager = globalThis as typeof globalThis & { playerTwo?: MissionManager; playerTwoExitHook?: boolean; playerTwoStore?: MissionStore };
export const manager = globalManager.playerTwo ||= new MissionManager();
Object.setPrototypeOf(manager, MissionManager.prototype);
manager.setStore(globalManager.playerTwoStore ||= new MissionStore(resolve('.player-two/missions.sqlite')));
if (!globalManager.playerTwoExitHook) {
  globalManager.playerTwoExitHook = true;
  process.once('exit', () => globalManager.playerTwo?.shutdown());
}
