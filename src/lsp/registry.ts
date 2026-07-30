// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// Owns every NgSession: one per workspace found by root, replaced when broken, and shut
// down after sitting idle. An MCP server lives for hours and every session holds a whole
// ngserver process, so an abandoned workspace must not keep costing memory forever.

import { belongsTo } from '../format.js';
import type { NgSession } from './session.js';

interface Entry {
  session: NgSession;
  lastUsedAt: number;
}

export class SessionRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly timer: NodeJS.Timeout | null;

  // The clock is injectable so tests drive idle time by hand instead of sleeping.
  constructor(
    private readonly createSession: (file: string) => NgSession,
    private readonly idleMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (idleMs > 0) {
      // Sweep often enough that a short custom timeout stays roughly honest.
      this.timer = setInterval(() => this.sweep(), Math.min(60_000, idleMs));
      // The timer alone must not keep the process alive.
      this.timer.unref();
    } else {
      this.timer = null;
    }
  }

  acquire(file: string): NgSession {
    for (const [root, entry] of this.entries) {
      if (!belongsTo(file, root)) {
        continue;
      }
      if (entry.session.getHealth().state !== 'broken' && !entry.session.isDead()) {
        entry.lastUsedAt = this.now();
        return entry.session;
      }
      // A broken session never heals itself, so stop offering it and start a fresh one.
      // The process behind it is already gone, so dispose() is a formality — and under an
      // in-flight call it is harmful: nulling the client strips the real failure from that
      // call's error, degrading 'process exited + stderr' to a bare 'session is not up'.
      if (!entry.session.isBusy()) {
        entry.session.dispose();
      }
      this.entries.delete(root);
      break;
    }
    const session = this.createSession(file);
    this.entries.set(session.workspace.root.toLowerCase(), { session, lastUsedAt: this.now() });
    return session;
  }

  // Runs on the interval; public so tests can call it against a fake clock.
  sweep(): void {
    if (this.idleMs <= 0) {
      return;
    }
    for (const [root, entry] of this.entries) {
      // An in-flight call counts as activity: killing a session mid-request would turn a
      // slow cold start into an error.
      if (entry.session.isBusy()) {
        entry.lastUsedAt = this.now();
        continue;
      }
      if (this.now() - entry.lastUsedAt >= this.idleMs) {
        entry.session.dispose();
        this.entries.delete(root);
      }
    }
  }

  size(): number {
    return this.entries.size;
  }

  disposeAll(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    for (const entry of this.entries.values()) {
      entry.session.dispose();
    }
    this.entries.clear();
  }
}
