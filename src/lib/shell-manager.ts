import * as pty from 'node-pty';
import { EventEmitter } from 'events';

export interface ShellSession {
  id: string;
  pty: pty.IPty;
  cwd: string;
  createdAt: Date;
}

class ShellManager extends EventEmitter {
  private sessions: Map<string, ShellSession> = new Map();

  createSession(id: string, cwd: string): ShellSession {
    // Kill existing session with same id
    if (this.sessions.has(id)) {
      this.killSession(id);
    }

    const shell = process.env.SHELL || '/bin/bash';

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
      },
    });

    const session: ShellSession = {
      id,
      pty: ptyProcess,
      cwd,
      createdAt: new Date(),
    };

    this.sessions.set(id, session);

    // Forward data events
    ptyProcess.onData((data) => {
      this.emit('data', id, data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.emit('exit', id, exitCode);
      this.sessions.delete(id);
    });

    return session;
  }

  write(id: string, data: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.pty.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.pty.resize(cols, rows);
    return true;
  }

  killSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.pty.kill();
    this.sessions.delete(id);
    return true;
  }

  getSession(id: string): ShellSession | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): ShellSession[] {
    return Array.from(this.sessions.values());
  }
}

// Singleton instance
export const shellManager = new ShellManager();
