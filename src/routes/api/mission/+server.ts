import { json } from '@sveltejs/kit';
import { manager } from '$lib/server/manager';
export const GET = () => json(manager.snapshotState, { headers: { 'Cache-Control': 'no-store' } });
export async function POST({ request }: { request: Request }) {
  try {
    const body = await request.text();
    if (body.length > 50000) return json({ error: 'Request too large' }, { status: 413 });
    const data = JSON.parse(body);
    if (data.missionId !== undefined && data.missionId !== manager.state.id) throw new Error('The selected mission changed. Wait for the view to update before trying again.');
    switch (data.action) {
      case 'start': await manager.start(String(data.project || ''), String(data.objective || ''), data.sandbox, data.exploratory === true); break;
      case 'open': await manager.open(String(data.id || '')); break;
      case 'message': await manager.message(String(data.text || ''), data.steer === true); break;
      case 'stop': await manager.stop(); break;
      case 'answer': manager.answer(data.id, data.choice, data.answers); break;
      case 'decision': await manager.decide(String(data.id || ''), String(data.disposition || '')); break;
      case 'correctGoal': await manager.correctGoal({ title: data.title, description: data.description, baseVersion: data.baseVersion }); break;
      case 'proposal': manager.proposal(data.id, data.disposition); break;
      case 'reconnect': await manager.reconnect(); break;
      case 'end': manager.end(); break;
      default: throw new Error('Unknown mission action');
    }
    return json({ ok: true, state: manager.snapshotState });
  } catch (error) { return json({ error: error instanceof Error ? error.message : String(error), state: manager.snapshotState }, { status: 400 }); }
}
