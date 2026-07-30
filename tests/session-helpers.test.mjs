// Pure session helpers: hover parsing, definition normalisation, stderr diagnosis.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeStderr, flattenHover, normalizeLocation } from '../dist/lsp/session.js';

test('hover from MarkupContent is stripped of markdown wrapping', () => {
  const text = flattenHover({
    contents: { kind: 'markdown', value: '```typescript\n(property) UserVm.fullName: string\n```' },
  });
  assert.equal(text, '(property) UserVm.fullName: string');
});

test('hover given as an array is joined', () => {
  assert.equal(flattenHover({ contents: ['(method) A.b(): void', 'description'] }), '(method) A.b(): void description');
});

test('an empty hover yields null rather than an empty string', () => {
  assert.equal(flattenHover({}), null);
  assert.equal(flattenHover({ contents: '' }), null);
  assert.equal(flattenHover({ contents: [] }), null);
});

test('a definition in Location form is normalised to 1-based coordinates', () => {
  const hit = normalizeLocation({
    uri: 'file:///d%3A/repo/app/user-card.component.ts',
    range: { start: { line: 11, character: 2 } },
  });
  assert.equal(hit.line, 12);
  assert.equal(hit.character, 3);
  assert.match(hit.file, /user-card\.component\.ts$/);
});

test('a definition in LocationLink form is understood too', () => {
  const hit = normalizeLocation({
    targetUri: 'file:///d%3A/repo/a.ts',
    targetSelectionRange: { start: { line: 0, character: 0 } },
  });
  assert.equal(hit.line, 1);
  assert.equal(hit.character, 1);
});

test('describeStderr tells an empty stderr from text without Error:', () => {
  assert.equal(describeStderr(''), 'stderr is empty');
  assert.equal(describeStderr('   \n  \n'), 'stderr is empty');
  assert.equal(describeStderr('some noise\nlast line'), 'last line');
});

test('describeStderr prefers the line carrying Error:', () => {
  const stderr = 'noise\nError: Failed to resolve typescript/lib/tsserverlibrary\ntail';
  assert.match(describeStderr(stderr), /Failed to resolve/);
});
