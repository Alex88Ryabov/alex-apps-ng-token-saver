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

// ---- The input filter: only tags that bind the name, each entry at the binding itself ----

test('input filter: the entry points at the binding line, not the tag line', async () => {
  const root = await workspace({
    'app/list.component.html': `<app-card\n  [title]="t"\n  [icon]="i">\n</app-card>\n<app-card [title]="t"></app-card>`,
  });
  try {
    const report = scan(root, targetFromSelector('app-card'), { input: 'icon' });
    assert.equal(report.total, 1, 'only the tag that binds icon counts');
    assert.deepEqual(
      report.usages.map((item) => [item.kind, item.line]),
      [['binding', 3]],
    );
    assert.match(report.incomplete, /input 'icon': bound in 1 of 2 tag usages/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('input filter: static, event and banana spellings all count', async () => {
  const root = await workspace({
    'a.html': `<app-card icon="check"></app-card>`,
    'b.html': `<app-card [(icon)]="x"></app-card>`,
    'c.html': `<app-card (icon)="onIcon()"></app-card>`,
  });
  try {
    const report = scan(root, targetFromSelector('app-card'), { input: 'icon' });
    assert.equal(report.total, 3);
    assert.ok(report.usages.every((item) => item.kind === 'binding'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('input filter: a same-named binding on a foreign tag does not count', async () => {
  const root = await workspace({
    'a.html': `<other-widget [icon]="x"></other-widget>\n<app-card [title]="t"></app-card>`,
  });
  try {
    const report = scan(root, targetFromSelector('app-card'), { input: 'icon' });
    assert.equal(report.total, 0);
    assert.match(report.incomplete, /bound in 0 of 1 tag usages/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('input filter: a quoted > does not close the tag early', async () => {
  const root = await workspace({
    'a.html': `<app-card [visible]="a > b" [icon]="i"></app-card>`,
  });
  try {
    const report = scan(root, targetFromSelector('app-card'), { input: 'icon' });
    assert.equal(report.total, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('input filter: a name that is only a substring does not match', async () => {
  const root = await workspace({
    'a.html': `<app-card [iconColor]="c" myicon="x"></app-card>`,
  });
  try {
    const report = scan(root, targetFromSelector('app-card'), { input: 'icon' });
    assert.equal(report.total, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Review 10 MAJOR: the backward search for the tag start ignored quotes, so an earlier
// attribute value containing '<' (*ngIf="count < 5") derailed the quote parity of the
// span; with a quoted '>' next, the span closed early and the binding after it was lost.
// The reviewer's exact arrangement happened to survive - this one reproduces the loss.
test('input filter: quoted < and > before the binding do not lose it', async () => {
  const root = await workspace({
    'a.html': `<div *ngIf="count < 5" appTooltip [x]="1 > 2" [tooltipText]="msg"></div>`,
  });
  try {
    const report = scan(root, targetFromSelector('[appTooltip]'), { input: 'tooltipText' });
    assert.equal(report.total, 1, 'the binding is there and must be found');
    assert.equal(report.usages[0]?.kind, 'binding');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Review 10 MAJOR: the lookbehind allowed quotes, so text inside ANOTHER attribute's value
// ("icon = special formula") passed as a static binding.
test('input filter: text inside another attribute value is not a binding', async () => {
  const root = await workspace({
    'a.html': `<app-card title="icon = special formula" [config]="1"></app-card>`,
  });
  try {
    const report = scan(root, targetFromSelector('app-card'), { input: 'icon' });
    assert.equal(report.total, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Review 10: one physical tag matching both the element and the attribute pattern must
// count once in the denominator of the note, exactly like it does in the numerator.
test('input filter: a tag matching element and attribute counts once in the note', async () => {
  const root = await workspace({
    'a.html': `<button appButton [x]="1"></button>`,
  });
  try {
    const report = scan(root, targetFromSelector('button[appButton]'), { input: 'x' });
    assert.match(report.incomplete, /bound in 1 of 1 tag usages/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The canonical prefix spellings are legal Angular; review 10 caught them missing.
test('input filter: canonical bind-/on-/bindon- spellings count', async () => {
  const root = await workspace({
    'a.html': `<app-card bind-icon="i"></app-card>`,
    'b.html': `<app-card on-icon="h()"></app-card>`,
    'c.html': `<app-card bindon-icon="m"></app-card>`,
  });
  try {
    const report = scan(root, targetFromSelector('app-card'), { input: 'icon' });
    assert.equal(report.total, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('input filter: an empty name is refused in words, not applied silently', async () => {
  const root = await workspace({
    'a.html': `<app-card [icon]="i"></app-card>`,
  });
  try {
    const report = scan(root, targetFromSelector('app-card'), { input: '  ' });
    assert.match(report.incomplete, /needs a non-empty name/);
    assert.equal(report.total, 1, 'usages stay unfiltered');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('input filter: on a pipe target it is refused in words, not applied silently', async () => {
  const root = await workspace({
    'a.html': `{{ price | money }}`,
  });
  try {
    // A bare-word selector would also read as an element; a pure pipe target comes from @Pipe.
    const target = { elements: [], attributes: [], pipes: ['money'], classNames: [] };
    const report = scan(root, target, { input: 'icon' });
    assert.equal(report.total, 1, 'usages stay unfiltered');
    assert.match(report.incomplete, /needs an element or attribute selector target/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
