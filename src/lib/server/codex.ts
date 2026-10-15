import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { WireMessage } from '../mission';

export class CodexConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private stderr = '';
  constructor(private onEvent: (message: WireMessage) => void, private onClose: (reason: string, diagnostics?: string) => void) {}
  async connect() {
    this.child = spawn(process.env.CODEX_BIN || 'codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', b => { this.stderr = (this.stderr + b.toString()).slice(-4000); });
    this.child.on('error', error => this.disconnect(error.message));
    this.child.on('exit', (code, signal) => this.disconnect(`App Server disconnected (${signal || code}). Reconnect to reconcile the last observed state.`));
    this.child.stdin.on('error', error => this.disconnect(error.message));
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message: WireMessage;
      try { message = JSON.parse(line); } catch { this.disconnect('Invalid JSON received from App Server'); this.child?.kill(); return; }
      if (message.method) this.onEvent(message);
      else if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      }
    });
    await this.request('initialize', { clientInfo: { name: 'player_two', title: 'Player Two', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }
  request(method: string, params: Record<string, unknown>): Promise<any> {
    if (this.closed) return Promise.reject(new Error('App Server connection is closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`${method} timed out. Its outcome is unknown.`));
        this.disconnect(`${method} timed out. Reconnect to reconcile state.`); this.child?.kill();
      }, method === 'thread/resume' ? 90000 : 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  send(message: WireMessage) {
    if (this.closed || !this.child?.stdin.writable) throw new Error('App Server is not connected');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  private disconnect(reason: string) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear(); this.onClose(reason, this.stderr);
  }
  close() { this.disconnect('App Server connection closed'); this.child?.kill(); }
}
