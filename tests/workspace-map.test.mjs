// The workspace map: three layouts and strictTemplates resolution along the extends chain.
// Configs go into temp folders; the compiler comes from a fixture and is not tied to them.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { loadTypeScript } from '../dist/component-info.js';
import { describeWorkspaceMap } from '../dist/workspace-map.js';

const ts = await loadTypeScript(resolve('fixtures/v22'));

async function workspace(files) {
  const root = await mkdtemp(join(tmpdir(), 'ng-map-'));
  for (const [name, content] of Object.entries(files)) {
    const file = join(root, name);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const map = (root) => describeWorkspaceMap(ts, root, '19.2.18');

test('solution style without angular.json: projects come from tsconfig.app/lib', () => {
  const found = map(resolve('fixtures/v22'));
  assert.equal(found.kind, 'tsconfig-only');
  assert.equal(found.typescriptVersion, '6.0.3');
  assert.deepEqual(
    found.projects.map((item) => [item.name, item.type, item.strictTemplates]).sort(),
    [
      ['projects/ui-kit', 'library', true],
      ['root', 'application', true],
    ].sort(),
  );
});

test('angular.json: type, sourceRoot and tsConfig are read from the project', async () => {
  const root = await workspace({
    'angular.json': {
      projects: {
        shop: {
          projectType: 'application',
          root: '',
          sourceRoot: 'src',
          architect: { build: { options: { tsConfig: 'tsconfig.app.json', polyfills: ['zone.js'] } } },
        },
      },
    },
    'tsconfig.app.json': { angularCompilerOptions: { strictTemplates: true } },
  });
  const found = map(root);
  assert.equal(found.kind, 'angular-cli');
  assert.deepEqual(found.projects, [
    {
      name: 'shop',
      type: 'application',
      root: '',
      sourceRoot: 'src',
      tsConfig: 'tsconfig.app.json',
      strictTemplates: true,
      zoneJs: true,
    },
  ]);
  await rm(root, { recursive: true, force: true });
});

test('Nx: projects are collected from project.json files, not from a single file', async () => {
  const root = await workspace({
    'nx.json': {},
    'apps/app-2/project.json': {
      name: 'app-2',
      projectType: 'application',
      sourceRoot: 'apps/app-2/src',
      targets: { build: { options: { tsConfig: 'apps/app-2/tsconfig.app.json' } } },
    },
    'libs/ui/project.json': { name: 'ui', projectType: 'library' },
    'apps/app-2/tsconfig.app.json': { extends: './tsconfig.json' },
    'apps/app-2/tsconfig.json': { angularCompilerOptions: { strictInjectionParameters: true } },
  });
  const found = map(root);
  assert.equal(found.kind, 'nx');
  assert.deepEqual(
    found.projects.map((item) => [item.name, item.type, item.root]).sort(),
    [
      ['app-2', 'application', 'apps/app-2'],
      ['ui', 'library', 'libs/ui'],
    ].sort(),
  );
  // Nobody in the chain set strictTemplates, and Angular's default is false, not 'unknown'.
  assert.equal(found.projects.find((item) => item.name === 'app-2').strictTemplates, false);
  await rm(root, { recursive: true, force: true });
});

test('strictTemplates is inherited through extends and read from JSONC with comments', async () => {
  const root = await workspace({
    'angular.json': {
      projects: {
        app: { projectType: 'application', root: '', architect: { build: { options: { tsConfig: 'tsconfig.app.json' } } } },
      },
    },
    'tsconfig.app.json': '{ "extends": "./tsconfig.base.json" /* a comment */ }',
    'tsconfig.base.json': `{
      "angularCompilerOptions": {
        // switched off on purpose, as in the production monorepo
        // "strictTemplates": true,
        "strictInjectionParameters": true
      }
    }`,
  });
  assert.equal(map(root).projects[0].strictTemplates, false);
  await rm(root, { recursive: true, force: true });
});

test('extends pointing at a package is not resolved: we answer unknown, not disabled', async () => {
  const root = await workspace({
    'angular.json': {
      projects: {
        app: { projectType: 'application', root: '', architect: { build: { options: { tsConfig: 'tsconfig.app.json' } } } },
      },
    },
    'tsconfig.app.json': { extends: '@company/tsconfig/angular.json' },
  });
  assert.equal(map(root).projects[0].strictTemplates, null);
  await rm(root, { recursive: true, force: true });
});

test('zone.js is searched inside polyfills.ts, not in its file name', async () => {
  const build = (polyfills) => ({
    projects: {
      app: { projectType: 'application', root: '', architect: { build: { options: { tsConfig: 'tsconfig.app.json', polyfills } } } },
    },
  });
  const withImport = await workspace({
    'angular.json': build('src/polyfills.ts'),
    'tsconfig.app.json': {},
    'src/polyfills.ts': "import 'zone.js'; // Included with Angular CLI.",
  });
  assert.equal(map(withImport).projects[0].zoneJs, true);

  // The stock polyfills.ts mentions zone.js in comments even when it is not enabled.
  const mentionOnly = await workspace({
    'angular.json': build('src/polyfills.ts'),
    'tsconfig.app.json': {},
    'src/polyfills.ts': '/** By default, zone.js will patch all possible macroTask. */',
  });
  assert.equal(map(mentionOnly).projects[0].zoneJs, false);
  await rm(withImport, { recursive: true, force: true });
  await rm(mentionOnly, { recursive: true, force: true });
});

test('nx.json without a single project.json does not cancel angular.json', async () => {
  const root = await workspace({
    'nx.json': { targetDefaults: {} },
    'angular.json': {
      projects: {
        shop: { projectType: 'application', root: '', architect: { build: { options: { tsConfig: 'tsconfig.app.json' } } } },
      },
    },
    'tsconfig.app.json': { angularCompilerOptions: { strictTemplates: true } },
  });
  const found = map(root);
  assert.equal(found.kind, 'angular-cli');
  assert.deepEqual(found.projects.map((item) => item.name), ['shop']);
  await rm(root, { recursive: true, force: true });
});

test('multiple extends is not passed off as disabled', async () => {
  const root = await workspace({
    'angular.json': {
      projects: {
        app: { projectType: 'application', root: '', architect: { build: { options: { tsConfig: 'tsconfig.app.json' } } } },
      },
    },
    'tsconfig.app.json': { extends: ['./a.json', './b.json'] },
    'a.json': {},
    'b.json': { angularCompilerOptions: { strictTemplates: true } },
  });
  assert.equal(map(root).projects[0].strictTemplates, null);
  await rm(root, { recursive: true, force: true });
});

test('a complete walk is not flagged as partial', () => {
  assert.equal(map(resolve('fixtures/v22')).incomplete, null);
});
