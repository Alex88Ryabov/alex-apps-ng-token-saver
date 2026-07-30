// Path and URI normalisation. The trap that cost a day: the server answers with a different
// URI string than the client sent, file:///D:/... versus file:///d%3A/....

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathKey } from '../dist/lsp/client.js';
import { resolve } from 'node:path';
import { belongsTo, compact, kindFromSignature, projectDirOf } from '../dist/format.js';

const windows = process.platform === 'win32';

test('URIs from pathToFileURL and from vscode-uri map to one key', { skip: !windows }, () => {
  const a = pathKey('file:///D:/Users/app/user-card.component.html');
  const b = pathKey('file:///d%3A/Users/app/user-card.component.html');
  assert.equal(a, b);
});

test('a path and a URI of the same file map to one key', { skip: !windows }, () => {
  assert.equal(pathKey('D:\\Users\\app\\x.html'), pathKey('file:///D:/Users/app/x.html'));
});

test('a percent-encoded space is decoded', { skip: !windows }, () => {
  assert.equal(pathKey('file:///D:/My%20Apps/x.html'), 'd:\\my apps\\x.html');
});

test('belongsTo does not confuse sibling folders sharing a prefix', () => {
  assert.equal(belongsTo('d:\\repo\\fixtures\\v17\\a.html', 'd:\\repo\\fixtures\\v1'), false);
  assert.equal(belongsTo('d:\\repo\\fixtures\\v1\\a.html', 'd:\\repo\\fixtures\\v1'), true);
});

test('belongsTo accepts the root itself', () => {
  assert.equal(belongsTo('d:\\repo', 'd:\\repo'), true);
});

// The root used to arrive pre-lowercased by convention; one caller forgetting that would make
// every lookup silently miss. Folding both sides inside is the guard.
test('belongsTo folds case on both sides', () => {
  assert.equal(belongsTo('d:\\repo\\src\\a.html', 'D:\\Repo'), true);
  assert.equal(belongsTo('D:\\REPO', 'd:\\repo'), true);
});

test('kindFromSignature extracts the kind, modifiers included', () => {
  assert.equal(kindFromSignature('(property) UserVm.fullName: string'), 'property');
  assert.equal(kindFromSignature('public (property) A.b: string'), 'property');
  assert.equal(kindFromSignature('optional (property) A.b?: any'), 'property');
  assert.equal(kindFromSignature('(method) A.onSelect(id: number): void'), 'method');
  assert.equal(kindFromSignature('(element) h2: HTMLHeadingElement'), 'element');
});

test('kindFromSignature does not invent a kind', () => {
  assert.equal(kindFromSignature(null), 'unknown');
  assert.equal(kindFromSignature('plain text'), 'unknown');
});

test('compact drops null but keeps false and an empty array', () => {
  assert.deepEqual(
    compact({ a: null, b: false, c: [], d: undefined, e: 0, f: '' }),
    { b: false, c: [], e: 0, f: '' },
  );
});

test('compact reaches objects nested in arrays', () => {
  assert.deepEqual(compact({ inputs: [{ name: 'x', alias: null, required: false }] }), {
    inputs: [{ name: 'x', required: false }],
  });
});

// The server answers with its own path shape: lowercase drive, forward slashes. Comparing it
// to a Windows path without normalising silently disabled the strictTemplates notice.
// An agent naturally sends d:/a/b in JSON while the session registry is keyed by d:\a\b.
// Compared raw, the lookup missed and every single tool call spawned a fresh language server:
// 8 s of cold start per call instead of 5 ms.
test('a forward-slash path finds a session keyed by a Windows root', { skip: !windows }, () => {
  const root = resolve('D:/dev/repo').toLowerCase();
  assert.equal(belongsTo(resolve('D:/dev/repo/apps/a/x.component.html'), root), true);
  assert.equal(belongsTo('D:/dev/repo/apps/a/x.component.html', root), false);
});

test('a tsconfig path from the server maps onto workspace files', { skip: !windows }, () => {
  const reported = 'd:/dev/repo/apps/shop/tsconfig.editor.json';
  const project = projectDirOf(reported);
  assert.equal(belongsTo(resolve('D:/dev/repo/apps/shop/src/a.component.html'), project), true);
  assert.equal(belongsTo(resolve('D:/dev/repo/apps/admin/src/a.component.html'), project), false);
});
