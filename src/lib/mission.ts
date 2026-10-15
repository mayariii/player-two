export type Execution = 'idle' | 'starting' | 'working' | 'stopping' | 'completed' | 'interrupted' | 'failed' | 'unknown';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
// Only the fields consumed by this client. Original payloads remain inspectable.
export interface WireMessage { id?: string | number; method?: string; params?: Record<string, any>; result?: any; error?: { code: number; message: string } }
export interface Activity {
  id: string; turnId?: string; type: string; title: string;
  status: string; time: number; output: string; details: Record<string, any>;
}
export interface ChatMessage { id: string; role: 'user' | 'agent'; text: string; phase?: string; clientId?: string; time: number }
export interface Attention { id: string | number; method: string; params: Record<string, any>; responding?: boolean }
export interface Proposal { id: string; text: string; time: number; source: 'agent'; disposition: 'proposed' | 'noted' | 'dismissed' }
export interface DecisionDelivery { status: 'sending' | 'accepted' | 'uncertain'; text: string; error?: string }
export interface MissionDecision { delivery?: DecisionDelivery; id: string; messageId: string; text: string; source: 'user' | 'agent'; disposition: 'proposed' | 'confirmed' | 'dismissed'; time: number }
export interface GoalRevision { version: number; title: string; description: string; author: 'agent' | 'user' | 'legacy'; time: number; delivery?: DecisionDelivery }
export interface MissionState {
  goalHistory?: GoalRevision[];
  goalToolAvailable?: boolean;
  responses?: { id: string | number; kind: 'question' | 'permission'; status: 'sent' | 'resolved' | 'uncertain'; time: number }[];
  decisions?: MissionDecision[];
  savedMissions?: { id: string; title: string; project: string; execution: Execution; updated: number }[];
  persistenceError?: string | null;
  id: string; threadId: string | null; project: string; objective: string; title: string;
  connection: 'offline' | 'connecting' | 'connected' | 'lost';
  execution: Execution; turnId: string | null; messages: ChatMessage[];
  activities: Activity[]; attention: Attention[]; proposals: Proposal[];
  warnings: string[]; error: string | null; diagnostics: string | null; lastEventAt: number | null;
  config: { model: string; approvalPolicy: unknown; approvalsReviewer: unknown; sandbox: unknown } | null;
  usage: { input: number; output: number; cached: number } | null;
}
export function emptyMission(): MissionState {
  return { id: '', threadId: null, project: '', objective: '', title: '', connection: 'offline', execution: 'idle', turnId: null, messages: [], activities: [], attention: [], proposals: [], warnings: [], error: null, diagnostics: null, lastEventAt: null, config: null, usage: null };
}
export const activeExecution = (state: MissionState) => ['starting', 'working', 'stopping'].includes(state.execution);
export function activityTitle(item: Record<string, any>): string {
  if (item.type === 'commandExecution') return item.command || 'Shell command';
  if (item.type === 'fileChange') return (item.changes || []).map((c: any) => c.path).join(', ') || 'File changes';
  if (item.type === 'dynamicToolCall') return item.tool === 'player_two_update_mission' ? 'Updated mission understanding' : item.tool === 'player_two_next_step' ? 'Proposed a next step' : item.tool === 'player_two_propose_decision' ? 'Proposed a decision' : item.tool;
  if (item.type === 'mcpToolCall') return `${item.server} / ${item.tool}`;
  if (item.type === 'plan') return 'Plan reported by Codex';
  if (item.type === 'reasoning') return 'Reasoning summary';
  if (item.type === 'webSearch') return 'Web search';
  return item.type || 'Unknown activity';
}
export function closeActivities(state: MissionState, status: string) {
  for (const item of state.activities) if (item.status === 'inProgress') item.status = status;
}
export function loseConnection(state: MissionState, reason: string, diagnostics?: string) {
  state.diagnostics = diagnostics || null;
  state.connection = 'lost';
  if (activeExecution(state)) state.execution = 'unknown';
  closeActivities(state, 'unknown');
  state.attention = [];
  for (const receipt of state.responses || []) if (receipt.status === 'sent') receipt.status = 'uncertain';
  state.error = reason;
}
const limitOutput = (text: string) => text.length > 64000 ? '[Earlier output omitted]\n' + text.slice(-64000) : text;
export function processEvent(state: MissionState, message: WireMessage, now = Date.now()) {
  const p = message.params || {};
  if (p.threadId && p.threadId !== state.threadId) return;
  const method = message.method;
  if (!method || method.startsWith('codex/event/')) return;
  if (p.threadId) state.lastEventAt = now;
  if (method === 'turn/started') { state.turnId = p.turn.id; state.execution = 'working'; state.error = null; }
  if (method === 'turn/completed') {
    if (state.turnId && p.turn.id !== state.turnId) return;
    state.execution = ['completed', 'interrupted', 'failed'].includes(p.turn.status) ? p.turn.status : 'unknown';
    state.error = p.turn.error?.message || null;
    closeActivities(state, state.execution === 'completed' ? 'unknown' : state.execution);
    state.attention = [];
  }
  if (method === 'item/started' || method === 'item/completed') {
    const item = p.item;
    if (!item?.id) return;
    if (item.type === 'userMessage' || item.type === 'agentMessage') {
      const text = item.type === 'agentMessage' ? item.text : (item.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
      const existing = state.messages.find(m => m.id === item.id || (item.clientId && m.clientId === item.clientId));
      if (existing) { existing.id = item.id; existing.text = text; existing.phase = item.phase; existing.clientId = item.clientId; }
      else state.messages.push({ id: item.id, role: item.type === 'userMessage' ? 'user' : 'agent', text, phase: item.phase, clientId: item.clientId, time: now });
    } else {
      let activity = state.activities.find(a => a.id === item.id);
      if (!activity) {
        activity = { id: item.id, turnId: p.turnId, type: item.type, title: activityTitle(item), status: 'inProgress', time: now, output: '', details: {} };
        state.activities.push(activity);
      }
      activity.title = activityTitle(item);
      activity.status = item.status || (method === 'item/completed' ? 'completed' : 'inProgress');
      activity.details = item;
      if (typeof item.aggregatedOutput === 'string') activity.output = limitOutput(item.aggregatedOutput);
      else if (item.text) activity.output = limitOutput(item.text);
      else if (item.type === 'reasoning') activity.output = (item.summary || []).join('\n');
      state.activities = state.activities.slice(-250);
    }
  }
  if (method === 'item/agentMessage/delta') {
    let m = state.messages.find(m => m.id === p.itemId);
    if (!m) { m = { id: p.itemId, role: 'agent', text: '', time: now }; state.messages.push(m); }
    m.text += p.delta || '';
  }
  if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
    const a = state.activities.find(a => a.id === p.itemId);
    if (a) a.output = limitOutput(a.output + (p.delta || ''));
  }
  if (method === 'turn/plan/updated') {
    const id = `plan-${p.turnId}`;
    const old = state.activities.find(a => a.id === id);
    const plan = { id, turnId: p.turnId, type: 'plan', title: 'Plan reported by Codex', status: 'reported', time: now, output: p.explanation || '', details: p };
    if (old) Object.assign(old, plan); else state.activities.push(plan);
  }
  if (method === 'serverRequest/resolved') {
    state.attention = state.attention.filter(a => a.id !== p.requestId);
    const receipt = state.responses?.find(r => r.id === p.requestId && r.status === 'sent');
    if (receipt) receipt.status = 'resolved';
  }
  if (method === 'mcpServer/startupStatus/updated' && p.status === 'failed') {
    const warning = `${p.name}: ${p.error || 'Connection failed'}`;
    if (!state.warnings.includes(warning)) state.warnings.push(warning);
  }
  if (method === 'thread/tokenUsage/updated') {
    const u = p.tokenUsage?.total;
    if (u) state.usage = { input: u.inputTokens, output: u.outputTokens, cached: u.cachedInputTokens };
  }
  if (method === 'error') {
    const description = p.error?.message || p.message || 'App Server reported an error';
    state.error = p.willRetry ? `${description} Retrying.` : description;
  }
}
