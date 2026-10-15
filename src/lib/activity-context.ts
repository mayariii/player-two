import type { Activity } from './mission';

type Step = { title: string; detail: string };
// Describe observed operations, never infer the agent's intent from shell text.
function commandStep(command: string): Step {
  const c = command.trim();
  if (/^(npm|pnpm|yarn|bun) (run )?(test|check|lint|typecheck)(\s|$)/.test(c) || /^(node --test|pytest|cargo test|go test)(\s|$)/.test(c)) return { title: 'Running checks', detail: c };
  if (/^(npm|pnpm|yarn|bun) (run )?build(\s|$)/.test(c)) return { title: 'Building the project', detail: c };
  if (/^git (status|diff|log)(\s|$)/.test(c)) return { title: 'Inspecting repository changes', detail: c };
  if (/^(cat|sed|head|tail)(\s|$)/.test(c)) {
    const files = c.match(/(?:[\w@.+-]+\/)+[\w@.+-]+|\b[\w+-]+\.(?:md|json|ts|js|svelte|css|mjs|yaml|yml)\b/g);
    return { title: 'Reading files', detail: files ? [...new Set(files)].join(', ') : c };
  }
  if (/^(rg|grep|find)(\s|$)/.test(c)) return { title: c.startsWith('rg --files') || c.startsWith('find ') ? 'Finding files' : 'Searching code', detail: c };
  if (/^(ls|pwd)(\s|$)/.test(c)) return { title: 'Inspecting project folders', detail: c };
  if (/^npx .*svelte-autofixer\b/.test(c)) return { title: 'Checking Svelte components', detail: c };
  if (/^(python3?|node|ruby|bash|sh)(\s|$)/.test(c)) return { title: 'Running a script', detail: 'Open to inspect the script and output' };
  return { title: 'Running a command', detail: c };
}
export function activityContext(activity: Activity): Step {
  const d = activity.details;
  if (activity.type === 'fileChange') return { title: 'File changes', detail: (d.changes || []).map((c: { path: string }) => c.path).join(', ') || 'Open to inspect the diff' };
  if (activity.type === 'dynamicToolCall' && d.tool === 'player_two_update_mission') return { title: 'Mission understanding', detail: d.arguments?.title || 'Updated by Codex' };
  if (activity.type === 'dynamicToolCall') return { title: d.tool === 'player_two_propose_decision' ? 'Decision proposal' : 'Next-step proposal', detail: d.arguments?.text ? `Codex proposed: ${d.arguments.text}` : 'Proposal from Codex' };
  if (activity.type !== 'commandExecution') return { title: activity.type === 'mcpToolCall' ? `Using ${d.tool || 'a tool'}` : activity.title, detail: activity.type === 'plan' || activity.type === 'reasoning' ? 'Reported by Codex' : 'Open to inspect details' };
  const actions = Array.isArray(d.commandActions) ? d.commandActions : [];
  const steps: Step[] = actions.map((a: any) => a.type === 'read' ? { title: 'Reading files', detail: a.path || a.name || a.command } : a.type === 'search' ? { title: 'Searching code', detail: [a.query, a.path].filter(Boolean).join(' · ') || a.command } : a.type === 'listFiles' ? { title: 'Finding files', detail: a.path || a.command } : commandStep(a.command || ''));
  // Unknown compound commands stay intact. Do not parse quoted programs or claim
  // that each operation in a shell chain ran successfully.
  if (!steps.length) steps.push(commandStep(d.command || activity.title));
  const titles = [...new Set(steps.map(s => s.title))];
  const title = titles.slice(0, 2).join(' · ') + (titles.length > 2 ? ` +${titles.length - 2}` : '');
  const displayedTitle = activity.status === 'completed' ? title.replace(/Running/g, 'Ran').replace(/Reading/g, 'Read').replace(/Searching/g, 'Searched').replace(/Building the project/g, 'Ran project build').replace(/Inspecting/g, 'Inspected').replace(/Finding/g, 'Looked for').replace(/Checking/g, 'Checked') : title;
  return { title: displayedTitle, detail: [...new Set(steps.map(s => s.detail).filter(Boolean))].join(' · ') };
}
