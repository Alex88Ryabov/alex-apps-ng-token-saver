// Workspace discovery against real fixtures: version from node_modules, branch selection,
// probe locations, and refusals that state a clear reason.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describeWorkspace, firstInterpolation, WorkspaceError } from '../dist/lsp/workspace.js';

const servers = resolve('tools/servers');

test('the workspace root is searched upwards from the file', () => {
  const info = describeWorkspace(resolve('fixtures/v19/src/app'), servers);
  assert.equal(info.root, resolve('fixtures/v19'));
});

test('the version is read from the installed package', () => {
  const info = describeWorkspace(resolve('fixtures/v17/src/app'), servers);
  const installed = JSON.parse(
    readFileSync(join(info.root, 'node_modules/@angular/core/package.json'), 'utf8'),
  ).version;
  assert.equal(info.angularCoreVersion, installed);
  assert.equal(info.angularMajor, Number(installed.split('.')[0]));
});

// A fixture with package.json but no node_modules: if the version came from the declaration,
// discovery would succeed. It must fail instead.
test('package.json does not stand in for the installed version', () => {
  const withoutModules = resolve('fixtures/negative/no-node-modules');
  assert.ok(existsSync(join(withoutModules, 'package.json')));
  assert.throws(() => describeWorkspace(withoutModules, servers), WorkspaceError);
});

test('the branch is always the newest one, regardless of the project major', () => {
  const older = describeWorkspace(resolve('fixtures/v17/src/app'), servers);
  const newer = describeWorkspace(resolve('fixtures/v22/src/app'), servers);
  assert.equal(older.serverDir, newer.serverDir);
});

test('ng-probe points at the server, ts-probe at the project', () => {
  const info = describeWorkspace(resolve('fixtures/v20/src/app'), servers);
  assert.equal(info.ngProbe, join(info.serverDir, 'node_modules'));
  assert.equal(info.tsProbe, join(info.root, 'node_modules'));
});

test('without node_modules there is an error with a hint, not silence', () => {
  assert.throws(
    () => describeWorkspace(resolve('fixtures/negative/orphan'), servers),
    (error) => error instanceof WorkspaceError && error.hint.length > 0,
  );
});

test('the first interpolation is found at the correct offset', () => {
  const line = '  <p>{{ title }}</p>';
  const found = firstInterpolation(`<section>\n${line}\n</section>`);
  assert.equal(found.line, 1);
  // The position must land inside the identifier, not on its boundary.
  assert.equal(line[found.character], 'i');
});

test('an interpolation inside an attribute is found too', () => {
  const line = '<a href="{{link}}">x</a>';
  const found = firstInterpolation(line);
  assert.equal(found.line, 0);
  assert.equal(line[found.character], 'i');
});

test('a template without interpolations yields null', () => {
  assert.equal(firstInterpolation('<p>plain text</p>'), null);
});
