// Diagnostics answers: codes an agent can look up, and a checksDisabled note only where the
// checks really are off.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { loadTypeScript } from '../dist/component-info.js';
import { checksDisabledNote, diagnosticCode, groupRepeats } from '../dist/diagnostics.js';

const ts = await loadTypeScript(resolve('fixtures/v22'));

// The pairs come from one v17 fixture: ngc prints NG2010 and TS2339 where the language
// service sends -992010 and 2339.
test('Angular codes lose the -99 marker, TypeScript codes get their own prefix', () => {
  assert.equal(diagnosticCode(-992010), 'NG2010');
  assert.equal(diagnosticCode(2339), 'TS2339');
  assert.equal(diagnosticCode(6385), 'TS6385');
  assert.equal(diagnosticCode('NG8113'), 'NG8113');
  assert.equal(diagnosticCode(undefined), null);
});

async function project(tsconfig, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ng-diag-'));
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify(tsconfig));
  for (const [name, content] of Object.entries(extra)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), JSON.stringify(content));
  }
  // The server reports the path in its own shape: forward slashes.
  return { root, suggested: [join(root, 'tsconfig.json').replace(/\\/g, '/')] };
}

test('a written false keeps the checksDisabled note', async () => {
  const { root, suggested } = await project({ angularCompilerOptions: { strictTemplates: false } });
  assert.match(checksDisabledNote(ts, join(root, 'a.component.html'), suggested), /strictTemplates is off/);
  await rm(root, { recursive: true, force: true });
});

test('a written true gives no note even if the server suggested strict mode', async () => {
  const { root, suggested } = await project({ angularCompilerOptions: { strictTemplates: true } });
  assert.equal(checksDisabledNote(ts, join(root, 'a.component.html'), suggested), null);
  await rm(root, { recursive: true, force: true });
});

// Re-checked on a v22 probe without the flag: the server reported a strict-only input type
// error, so its empty list is a real 'no errors' there.
test('an unwritten flag gives no note: the server checks strictly anyway', async () => {
  const { root, suggested } = await project(
    { extends: './tsconfig.base.json' },
    { 'tsconfig.base.json': { compilerOptions: { strict: true } } },
  );
  assert.equal(checksDisabledNote(ts, join(root, 'a.component.html'), suggested), null);
  await rm(root, { recursive: true, force: true });
});

test('a chain we cannot follow is said to be unverified, not disabled', async () => {
  const { root, suggested } = await project({ extends: '@company/tsconfig/angular.json' });
  assert.match(checksDisabledNote(ts, join(root, 'a.component.html'), suggested), /could not be traced/);
  await rm(root, { recursive: true, force: true });
});

test('a notice about another project does not attach to this file', async () => {
  const { root, suggested } = await project({ angularCompilerOptions: { strictTemplates: false } });
  assert.equal(checksDisabledNote(ts, join(tmpdir(), 'elsewhere', 'a.component.html'), suggested), null);
  await rm(root, { recursive: true, force: true });
});

test('one message on many lines comes once with its lines; a single one keeps its column', () => {
  const hint = (line, message) => ({ line, character: 5, code: 'TS6385', severity: 4, message });
  const grouped = groupRepeats([
    hint(1, "'ngIf' is deprecated."),
    { line: 2, character: 9, code: 'TS2339', severity: 1, message: 'no such property' },
    hint(3, "'ngIf' is deprecated."),
    hint(4, "'ngForOf' is deprecated."),
  ]);
  assert.deepEqual(grouped, [
    { lines: [1, 3], code: 'TS6385', severity: 4, message: "'ngIf' is deprecated." },
    { line: 2, character: 9, code: 'TS2339', severity: 1, message: 'no such property' },
    hint(4, "'ngForOf' is deprecated."),
  ]);
});

test('entries anchored in the companion are not merged with the template ones', () => {
  const entry = (file) => ({ ...(file ? { file } : {}), line: 1, character: 1, code: 'TS2554', severity: 1, message: 'm' });
  assert.equal(groupRepeats([entry(), entry('a.component.ts')]).length, 2);
});
