import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MissionState } from '../mission';

export class MissionStore {
  private db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS missions (id TEXT PRIMARY KEY, updated INTEGER NOT NULL, state TEXT NOT NULL)');
  }
  save(state: MissionState) {
    if (!state.id) return;
    const { savedMissions, persistenceError, ...record } = state;
    this.db.prepare('INSERT INTO missions VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated, state=excluded.state').run(state.id, Date.now(), JSON.stringify(record));
  }
  get(id: string): MissionState | undefined {
    const row = this.db.prepare('SELECT state FROM missions WHERE id=?').get(id) as { state: string } | undefined;
    return row ? JSON.parse(row.state) : undefined;
  }
  list() {
    return (this.db.prepare('SELECT state, updated FROM missions ORDER BY updated DESC').all() as { state: string; updated: number }[]).map(row => {
      const s: MissionState = JSON.parse(row.state);
      return { id: s.id, title: s.title, project: s.project, execution: s.execution, updated: row.updated };
    });
  }
  close() { this.db.close(); }
}
