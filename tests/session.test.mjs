// Session orchestration against a fake client: no child process, but with real fixture files.
// It catches the class of bug that slipped past review twice: the diagnostics short path
// answering 'no errors' before the first push ever arrived.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve, sep } from 'node:path';
import { NgSession } from '../dist/lsp/session.js';

const servers = resolve('tools/servers');
const template = resolve('fixtures/v17/src/app/user-card.component.html');

function fakeClient(overrides = {}) {
  const calls = { didOpen: [], didChange: [], waitedForNext: 0 };
  const client = {
    calls,
    exited: null,
    stderr: '',
    notices: [],
    strictTemplatesOff: [],
    pushed: new Set(),
    diagnostics: [],
    async initialize() {
      return { result: {} };
    },
    notify() {},
    async request() {
      return { result: null };
    },
    didOpen(path) {
      calls.didOpen.push(path);
    },
    didChange(path) {
      calls.didChange.push(path);
    },
    diagnosticsFor() {
      return client.diagnostics;
    },
    hadDiagnosticsPush(path) {
      return client.pushed.has(path);
    },
    async waitForProjectLoadSince() {
      return true;
    },
    async waitForNextDiagnostics() {
      calls.waitedForNext += 1;
      // The push 'arrives' only now, exactly as on a live server.
      client.pushed.add(template);
      client.diagnostics = [{ range: { start: { line: 6, character: 15 } }, code: 2339, message: 'error' }];
      return true;
    },
    async waitForClose() {
      return true;
    },
    dispose() {},
    ...overrides,
  };
  return client;
}

function sessionWith(client) {
  return NgSession.create(resolve('fixtures/v17/src/app'), servers, () => client);
}

test('the first diagnostics request waits for a push instead of returning emptiness', async () => {
  const client = fakeClient();
  const session = sessionWith(client);
  const list = await session.diagnosticsFor(template);
  assert.equal(client.calls.waitedForNext, 1);
  assert.equal(list.length, 1);
});

test('a file opened by another tool does not produce a false "no errors"', async () => {
  const client = fakeClient();
  const session = sessionWith(client);
  // The definition tool opened the document, but no diagnostics push has happened yet.
  await session.definitionAt(template, { line: 1, character: 11 });
  assert.ok(client.calls.didOpen.includes(template));
  assert.equal(client.hadDiagnosticsPush(template), false);

  const list = await session.diagnosticsFor(template);
  assert.equal(client.calls.waitedForNext, 1, 'must wait for the push rather than return an empty list');
  assert.equal(list.length, 1);
});

test('a repeat request with no edits does not wait for a push again', async () => {
  const client = fakeClient();
  const session = sessionWith(client);
  await session.diagnosticsFor(template);
  await session.diagnosticsFor(template);
  assert.equal(client.calls.waitedForNext, 1);
});

test('the template is opened before its companion', async () => {
  const client = fakeClient();
  const session = sessionWith(client);
  await session.definitionAt(template, { line: 1, character: 11 });
  const opened = client.calls.didOpen;
  assert.match(opened[0], /\.html$/);
  assert.match(opened[1], /\.ts$/);
});

test('a process death after startup is visible from the outside', async () => {
  const client = fakeClient();
  const session = sessionWith(client);
  await session.definitionAt(template, { line: 1, character: 11 });
  assert.equal(session.isAlive(), true);
  assert.equal(session.isDead(), false);

  client.exited = 1;
  assert.equal(session.isAlive(), false);
  assert.equal(session.isDead(), true);
  await assert.rejects(() => session.diagnosticsFor(template), /server process exited/);
});

test('a failed initialize does not publish the client and explains why', async () => {
  const client = fakeClient({
    async initialize() {
      return { error: { message: 'timeout' } };
    },
    stderr: 'Error: Failed to resolve typescript/lib/tsserverlibrary\n',
  });
  const session = sessionWith(client);
  await assert.rejects(() => session.definitionAt(template, { line: 1, character: 11 }));
  const health = session.getHealth();
  assert.equal(health.state, 'broken');
  assert.match(health.hint, /Failed to resolve/);
});

// The server itself answers with a lowercase drive (file:///d%3A/...) where the agent sent
// D:, and the agent naturally feeds that path back. NTFS says it is the same file; without
// case folding the registry held two entries and the second call paid a full reopen.
test('the same file in two drive-letter cases is one document, not two', { skip: process.platform !== 'win32' }, async () => {
  const client = fakeClient();
  const session = sessionWith(client);
  await session.diagnosticsFor(template);
  const afterFirst = client.calls.didOpen.length;
  const head = template.charAt(0);
  const flipped = (head === head.toLowerCase() ? head.toUpperCase() : head.toLowerCase()) + template.slice(1);
  await session.diagnosticsFor(flipped);
  assert.equal(client.calls.didOpen.length, afterFirst, 'the second spelling must not reopen the file');
});

// The agent sends forward slashes, our canary walk builds paths with join(). Keyed by the raw
// string, the same file was registered twice and the second copy waited out the full
// project-load timeout: 134 s per diagnostics call on a production workspace.
test('the same file in two path spellings is one document, not two', async () => {
  const client = fakeClient();
  const session = sessionWith(client);
  const posix = template.split(sep).join('/');
  await session.diagnosticsFor(posix);
  const afterFirst = client.calls.didOpen.length;
  await session.diagnosticsFor(posix.split('/').join(sep));
  assert.equal(client.calls.didOpen.length, afterFirst, 'the second spelling must not reopen the file');
  assert.equal(new Set(client.calls.didOpen).size, client.calls.didOpen.length, 'no path opened twice');
});
