// The instructions text lives in the server and is quoted in README; the two must not drift.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { instructionsFor } from '../dist/instructions.js';

test('README quotes the instructions the server sends', () => {
  const readme = readFileSync('README.md', 'utf8');
  const section = readme.slice(readme.indexOf('## Using with agents'));
  const quoted = section
    .split('\n')
    .filter((line) => line.startsWith('> '))
    .map((line) => line.slice(2))
    .join(' ');
  assert.equal(quoted, instructionsFor(false));
  const stated = /`instructions` field \((\d+) characters\)/.exec(section)?.[1];
  assert.equal(Number(stated), instructionsFor(false).length, 'the length README states');
});

test('the prewarm note is added only when prewarm is on', () => {
  assert.ok(!instructionsFor(false).includes('background'));
  assert.ok(instructionsFor(true).startsWith(instructionsFor(false)));
  assert.match(instructionsFor(true), /starts loading that app in the background\.$/);
});
