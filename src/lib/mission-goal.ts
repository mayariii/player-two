import type { MissionState, GoalRevision } from './mission';
export function reviseGoal(state: MissionState, input: { title: string; description: string; baseVersion: number }, author: 'agent' | 'user'): GoalRevision {
  const current = state.goalHistory?.at(-1);
  if (input.baseVersion !== (current?.version || 0)) throw new Error('The mission changed. Read the current revision before updating it.');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 80 || typeof input.description !== 'string' || !input.description.trim() || input.description.length > 300) throw new Error('Use a title of 1–80 characters and description of 1–300 characters.');
  if (current?.delivery?.status === 'sending' || current?.delivery?.status === 'uncertain') throw new Error('A human correction has unresolved delivery. Wait until it is reconciled.');
  if (current?.title === input.title.trim() && current.description === input.description.trim()) throw new Error('The wording is unchanged.');
  const revision: GoalRevision = { version: (current?.version || 0) + 1, title: input.title.trim(), description: input.description.trim(), author, time: Date.now() };
  // Preserve any older pinned objective without labelling it agent-generated.
  if (!state.goalHistory?.length && state.objective) state.goalHistory = [{ version: 0, title: state.title, description: state.objective, author: 'legacy', time: Date.now() }];
  (state.goalHistory ??= []).push(revision);
  return revision;
}
