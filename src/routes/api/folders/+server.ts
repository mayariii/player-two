import { json } from '@sveltejs/kit';
import { readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

export async function GET({ url }: { url: URL }) {
  try {
    const requested = url.searchParams.get('path') || homedir();
    if (!isAbsolute(requested)) throw new Error('Enter an absolute folder path.');
    const path = await realpath(requested);
    const entries = await readdir(path, { withFileTypes: true });
    const folders = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => ({ name: entry.name, path: join(path, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return json({ path, parent: dirname(path), folders }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return json({ error: 'Could not open that folder. Check the path and access permissions.' }, { status: 400 });
  }
}
