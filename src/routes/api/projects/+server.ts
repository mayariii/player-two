import { json } from '@sveltejs/kit';
import { readFile, stat } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';

export async function GET() {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const saved = JSON.parse(await readFile(resolve('.player-two/codex-projects.json'), 'utf8'));
    if (!Array.isArray(saved.projects) || typeof saved.importedAt !== 'string') throw new Error('Invalid project import');
    const projects = await Promise.all(saved.projects.filter((p: any) => typeof p.name === 'string' && typeof p.path === 'string' && isAbsolute(p.path)).map(async (p: any) => ({
      name: p.name, path: p.path,
      available: await stat(p.path).then(s => s.isDirectory()).catch(() => false)
    })));
    return json({ projects, importedAt: saved.importedAt }, { headers });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return json({ projects: [], importedAt: null }, { headers });
    return json({ error: 'Could not read the imported Codex projects.' }, { status: 500, headers });
  }
}
