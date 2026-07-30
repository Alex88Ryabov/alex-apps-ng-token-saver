// Finding usages: selector parsing, target extraction from a file, and the walk itself.
// Workspaces are built in temp folders: the fixtures contain no usages at all.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { loadTypeScript } from '../dist/component-info.js';
import { findUsages, parseSelector, targetFromSelector, targetOf } from '../dist/find-usages.js';

const ts = await loadTypeScript(resolve('fixtures/v22'));

async function workspace(files) {
  const root = await mkdtemp(join(tmpdir(), 'ng-usages-'));
  for (const [name, content] of Object.entries(files)) {
    const file = join(root, name);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

const scan = (root, target, extra = {}) =>
  findUsages(root, target, { limit: 100, fileLimit: 1000, ...extra });

test('a selector is split into elements and attributes, and :not does not count', () => {
  assert.deepEqual(parseSelector('app-user-card'), { elements: ['app-user-card'], attributes: [] });
  assert.deepEqual(parseSelector('[appDrag]'), { elements: [], attributes: ['appDrag'] });
  assert.deepEqual(parseSelector('button[appButton], a[appButton]'), {
    elements: ['button', 'a'],
    attributes: ['appButton'],
  });
  assert.deepEqual(parseSelector('app-card:not([bare])'), {
    elements: ['app-card'],
    attributes: [],
  });
});

test('target from a file: component, directive and pipe are parsed together', () => {
  const target = targetOf(
    ts,
    `
      @Component({ selector: 'app-card', template: '' })
      export class CardComponent {}
      @Directive({ selector: '[appDrag]' })
      export class DragDirective {}
      @Pipe({ name: 'money' })
      export class MoneyPipe {}
      @Injectable()
      export class Service {}
    `,
    'x.ts',
  );
  assert.deepEqual(target.elements, ['app-card']);
  assert.deepEqual(target.attributes, ['appDrag']);
  assert.deepEqual(target.pipes, ['money']);
  assert.deepEqual(target.classNames, ['CardComponent', 'DragDirective', 'MoneyPipe']);
});

test('a bare word is also searched as a pipe, a dashed one only as an element', () => {
  assert.deepEqual(targetFromSelector('money').pipes, ['money']);
  assert.deepEqual(targetFromSelector('app-card').pipes, []);
});

test('a tag with wrapped attributes is found, and the closing tag does not double the count', async () => {
  const root = await workspace({
    'src/page.component.html': [
      '<app-card [user]="u"></app-card>',
      '<app-card',
      '  [user]="other"',
      '></app-card>',
      '<app-card-extended></app-card-extended>',
    ].join('\n'),
  });
  const found = scan(root, targetFromSelector('app-card'));
  assert.equal(found.total, 2);
  assert.deepEqual(
    found.usages.map((item) => [item.line, item.kind]),
    [
      [1, 'element'],
      [2, 'element'],
    ],
  );
  await rm(root, { recursive: true, force: true });
});

test('an attribute directive is found in all three spellings', async () => {
  const root = await workspace({
    'src/a.component.html': '<div appDrag></div>\n<div [appDrag]="on"></div>\n<div (appDrag)="go()"></div>',
    'src/b.component.html': '<div appDragSomethingElse></div>',
  });
  const found = scan(root, targetFromSelector('[appDrag]'));
  assert.equal(found.total, 3);
  assert.deepEqual(new Set(found.usages.map((item) => item.file)), new Set(['src/a.component.html']));
  await rm(root, { recursive: true, force: true });
});

test('a pipe is searched by name, not by class', async () => {
  const root = await workspace({
    'src/a.component.html': '{{ sum | money }}\n{{ sum | moneyRounded }}\n{{ money }}',
  });
  const found = scan(root, targetFromSelector('money'));
  assert.equal(found.total, 1);
  assert.equal(found.usages[0].kind, 'pipe');
  await rm(root, { recursive: true, force: true });
});

test('a declaration is separated from a usage, and the own file is excluded', async () => {
  const root = await workspace({
    'src/drag.directive.ts': "@Directive({ selector: '[appDrag]' })\nexport class DragDirective {}",
    'src/use.component.html': '<div appDrag></div>',
    'src/module.ts': "import { DragDirective } from './drag.directive';",
  });
  const target = targetOf(ts, "@Directive({ selector: '[appDrag]' })\nexport class DragDirective {}", 'd.ts');

  // Searching by selector string: the own file is unknown, but the declaration is labelled as such.
  const byString = scan(root, targetFromSelector('[appDrag]'));
  assert.deepEqual(
    byString.usages.map((item) => item.kind).sort(),
    ['attribute', 'declaration'],
  );

  // Searching by file: the declaration is excluded entirely, but class references show up.
  const byFile = scan(root, target, { declaredIn: join(root, 'src/drag.directive.ts') });
  assert.deepEqual(
    byFile.usages.map((item) => [item.kind, item.file]).sort(),
    [
      ['attribute', 'src/use.component.html'],
      ['code', 'src/module.ts'],
    ].sort(),
  );
  await rm(root, { recursive: true, force: true });
});

test('truncation is admitted in words while total counts everything', async () => {
  const root = await workspace({
    'src/a.component.html': Array.from({ length: 10 }, () => '<app-card></app-card>').join('\n'),
  });
  const found = findUsages(root, targetFromSelector('app-card'), { limit: 3, fileLimit: 1000 });
  assert.equal(found.total, 10);
  assert.equal(found.usages.length, 3);
  assert.match(found.incomplete, /showing the first 3 of 10/);
  await rm(root, { recursive: true, force: true });
});

test('a target with no selector and no pipe name yields an explanation, not emptiness', async () => {
  const root = await workspace({ 'src/a.component.html': '<div></div>' });
  const found = scan(root, { elements: [], attributes: [], pipes: [], classNames: [] });
  assert.equal(found.total, 0);
  assert.match(found.incomplete, /nothing to search for/);
  await rm(root, { recursive: true, force: true });
});

test('a recursive usage inside the component own inline template is not lost', async () => {
  const declaration = [
    "@Component({ selector: 'app-tree-node', template: `",
    '  <span>{{ node.title }}</span>',
    '  <app-tree-node *ngFor="let child of node.children" [node]="child"></app-tree-node>',
    '` })',
    'export class TreeNodeComponent {}',
  ].join('\n');
  const root = await workspace({ 'src/tree-node.component.ts': declaration });
  const found = scan(root, targetOf(ts, declaration, 'tree-node.component.ts'), {
    declaredIn: join(root, 'src/tree-node.component.ts'),
  });
  assert.equal(found.total, 1);
  assert.equal(found.usages[0].kind, 'element');
  assert.equal(found.usages[0].line, 3);
  await rm(root, { recursive: true, force: true });
});

test('the structural spelling of a directive is found like the others', async () => {
  const root = await workspace({
    'src/a.component.html': '<div *appIfRole="\'admin\'"></div>\n<div appIfRole></div>',
  });
  const found = scan(root, targetFromSelector('[appIfRole]'));
  assert.equal(found.total, 2);
  await rm(root, { recursive: true, force: true });
});

test('commented-out markup does not count as a usage', async () => {
  const root = await workspace({
    'src/a.component.html': '<!-- <app-card></app-card> -->\n<app-card></app-card>',
    'src/b.component.ts': "// example: <app-card>\n/* <app-card> */\nconst x = 1;",
  });
  const found = scan(root, targetFromSelector('app-card'));
  assert.equal(found.total, 1);
  assert.equal(found.usages[0].line, 2);
  await rm(root, { recursive: true, force: true });
});

test('another selector on the same line does not turn a usage into a declaration', async () => {
  const root = await workspace({
    'src/outer.component.ts':
      "@Component({ selector: 'app-outer', template: '<app-inner></app-inner>' })\nexport class OuterComponent {}",
  });
  const found = scan(root, targetFromSelector('app-inner'));
  assert.equal(found.total, 1);
  assert.equal(found.usages[0].kind, 'element');
  await rm(root, { recursive: true, force: true });
});

test('searching by class name admits it is a heuristic', async () => {
  const root = await workspace({
    'src/a.ts': 'import { CardComponent } from "./card";',
  });
  const found = scan(root, { elements: [], attributes: [], pipes: [], classNames: ['CardComponent'] });
  assert.equal(found.total, 1);
  assert.match(found.incomplete, /without resolving imports/);
  await rm(root, { recursive: true, force: true });
});

test('the file limit is not skipped past on a large folder', async () => {
  const files = {};
  for (let index = 0; index < 20; index += 1) {
    files[`src/file-${index}.component.html`] = '<app-card></app-card>';
  }
  const root = await workspace(files);
  const found = findUsages(root, targetFromSelector('app-card'), { limit: 100, fileLimit: 5 });
  assert.equal(found.scannedFiles, 5);
  assert.match(found.incomplete, /the walk stopped at 5 files/);
  await rm(root, { recursive: true, force: true });
});
