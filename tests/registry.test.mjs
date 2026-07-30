// The session registry: one session per workspace, replacement of broken ones, and the
// idle shutdown. Until this file the registry was the only piece of orchestration without
// tests. The clock is injected, so idle time is driven by hand instead of sleeping.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { SessionRegistry } from '../dist/lsp/registry.js';

const wsA = resolve('fx/ws-a');
const wsB = resolve('fx/ws-b');
const fileA = resolve('fx/ws-a/src/one.component.html');
const fileB = resolve('fx/ws-b/src/two.component.html');

function fakeSession(root) {
  return {
    workspace: { root },
    disposed: false,
    busy: false,
    dead: false,
    health: { state: 'healthy' },
    getHealth() {
      return this.health;
    },
    isDead() {
      return this.dead;
    },
    isBusy() {
      return this.busy;
    },
    dispose() {
      this.disposed = true;
    },
  };
}

function setup(idleMs) {
  const created = [];
  let time = 0;
  const registry = new SessionRegistry(
    (file) => {
      const session = fakeSession(file.startsWith(wsB) ? wsB : wsA);
      created.push(session);
      return session;
    },
    idleMs,
    () => time,
  );
  return {
    registry,
    created,
    tick(ms) {
      time += ms;
    },
  };
}

test('one workspace gets one session', () => {
  const { registry, created } = setup(10_000);
  const first = registry.acquire(fileA);
  const second = registry.acquire(fileA);
  assert.equal(first, second);
  assert.equal(created.length, 1);
  registry.disposeAll();
});

test('a second workspace gets its own session', () => {
  const { registry, created } = setup(10_000);
  const a = registry.acquire(fileA);
  const b = registry.acquire(fileB);
  assert.notEqual(a, b);
  assert.equal(created.length, 2);
  assert.equal(registry.size(), 2);
  registry.disposeAll();
});

test('a broken session is disposed and replaced', () => {
  const { registry, created } = setup(10_000);
  const first = registry.acquire(fileA);
  first.health = { state: 'broken', reason: 'x', hint: 'y' };
  const second = registry.acquire(fileA);
  assert.notEqual(first, second);
  assert.equal(first.disposed, true);
  assert.equal(created.length, 2);
  registry.disposeAll();
});

test('a dead session is replaced too', () => {
  const { registry, created } = setup(10_000);
  const first = registry.acquire(fileA);
  first.dead = true;
  const second = registry.acquire(fileA);
  assert.notEqual(first, second);
  assert.equal(created.length, 2);
  registry.disposeAll();
});

// Review 7: the process behind a broken/dead session is already gone, but disposing the
// session object under an in-flight call strips the real failure from that call's error.
// Reproduced live before the fix: 'session is not up' with an empty hint instead of
// 'server process exited' with stderr.
test('a dead session still busy is replaced but not disposed under the call', () => {
  const { registry, created } = setup(10_000);
  const first = registry.acquire(fileA);
  first.dead = true;
  first.busy = true;
  const second = registry.acquire(fileA);
  assert.notEqual(first, second);
  assert.equal(first.disposed, false, 'dispose must not run under the in-flight call');
  assert.equal(created.length, 2);
  assert.equal(registry.size(), 1);
  registry.disposeAll();
});

test('an idle session is shut down by the sweep', () => {
  const { registry, created, tick } = setup(10_000);
  const first = registry.acquire(fileA);
  tick(10_000);
  registry.sweep();
  assert.equal(first.disposed, true);
  assert.equal(registry.size(), 0);
  registry.acquire(fileA);
  assert.equal(created.length, 2, 'the next call must start a fresh session');
  registry.disposeAll();
});

test('recent use postpones the shutdown', () => {
  const { registry, tick } = setup(10_000);
  const session = registry.acquire(fileA);
  tick(6_000);
  registry.acquire(fileA);
  tick(6_000);
  registry.sweep();
  assert.equal(session.disposed, false, '6 s since last use is not idle enough');
  assert.equal(registry.size(), 1);
  registry.disposeAll();
});

test('a busy session survives the deadline and counts as active', () => {
  const { registry, tick } = setup(10_000);
  const session = registry.acquire(fileA);
  session.busy = true;
  tick(60_000);
  registry.sweep();
  assert.equal(session.disposed, false, 'a call in flight must not be killed');
  session.busy = false;
  tick(9_999);
  registry.sweep();
  assert.equal(session.disposed, false, 'the busy sweep restarted the idle clock');
  tick(1);
  registry.sweep();
  assert.equal(session.disposed, true);
  registry.disposeAll();
});

test('idle 0 disables the shutdown entirely', () => {
  const { registry, tick } = setup(0);
  const session = registry.acquire(fileA);
  tick(1_000_000_000);
  registry.sweep();
  assert.equal(session.disposed, false);
  assert.equal(registry.size(), 1);
  registry.disposeAll();
});

test('disposeAll disposes every session', () => {
  const { registry } = setup(10_000);
  const a = registry.acquire(fileA);
  const b = registry.acquire(fileB);
  registry.disposeAll();
  assert.equal(a.disposed, true);
  assert.equal(b.disposed, true);
  assert.equal(registry.size(), 0);
});
