// Component contract parsing: exotic syntax is checked on strings, the real path on fixtures,
// because TypeScript is taken from the project's node_modules.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  componentFileFor,
  describeComponents,
  loadTypeScript,
  pickComponent,
  resolveAncestors,
} from '../dist/component-info.js';
import { locateProject } from '../dist/lsp/workspace.js';

const v22 = resolve('fixtures/v22');
const ts = await loadTypeScript(v22);

const parse = (source, major = 22) => describeComponents(ts, source, 'x.component.ts', major);
const one = (source, major = 22) => {
  const [first] = parse(source, major);
  assert.ok(first, 'no component found');
  return first;
};

test('signal input: type from the type argument, required from .required', () => {
  const contract = one(`
    @Component({ selector: 'a-b', template: '' })
    export class C {
      user = input.required<UserVm>();
      tag = input<string | null>(null);
    }
  `);
  assert.deepEqual(contract.inputs, [
    { name: 'user', type: 'UserVm', required: true, isSignal: true, alias: null },
    { name: 'tag', type: 'string | null', isSignal: true, alias: null },
  ]);
  assert.equal(contract.inlineTemplate, true);
  assert.equal(contract.templateUrl, null);
});

test('input without an annotation: the type comes from a literal, and only from a literal', () => {
  const contract = one(`
    @Component({ selector: 'a-b', template: '' })
    export class C {
      @Input() badge = '';
      @Input() count = 0;
      @Input() opened = false;
      @Input() computedSomehow = makeIt();
    }
  `);
  assert.deepEqual(
    contract.inputs.map((item) => [item.name, item.type]),
    [
      ['badge', 'string'],
      ['count', 'number'],
      ['opened', 'boolean'],
      ['computedSomehow', null],
    ],
  );
});

test('alias and required are read from both @Input forms', () => {
  const contract = one(`
    @Component({ selector: 'a-b', template: '' })
    export class C {
      @Input('outer') inner = '';
      @Input({ alias: 'shown', required: true }) hidden!: number;
      value = input(0, { alias: 'val' });
    }
  `);
  assert.deepEqual(
    contract.inputs.map((item) => [item.name, item.alias, item.required, item.type]),
    [
      ['inner', 'outer', undefined, 'string'],
      ['hidden', 'shown', true, 'number'],
      ['value', 'val', undefined, 'number'],
    ],
  );
});

test('@Input on a setter is an input, and the type comes from the parameter', () => {
  const contract = one(`
    @Component({ selector: 'a-b', template: '' })
    export class C {
      @Input() set disabled(value: boolean) { this.flag = value; }
    }
  `);
  assert.deepEqual(contract.inputs, [{ name: 'disabled', type: 'boolean', alias: null }]);
});

test('in a get/set pair the decorator is seen on either half, in any order', () => {
  const setterLast = one(`
    @Component({ selector: 'a-b', template: '' })
    export class C {
      get value(): string { return this._value; }
      @Input() set value(v: string) { this._value = v; }
    }
  `);
  assert.deepEqual(setterLast.inputs, [{ name: 'value', type: 'string', alias: null }]);
  assert.deepEqual(setterLast.publicMembers, []);

  const setterFirst = one(`
    @Component({ selector: 'a-b', template: '' })
    export class C {
      @Input() set value(v: string) { this._value = v; }
      get value(): string { return this._value; }
    }
  `);
  assert.deepEqual(setterFirst.inputs, setterLast.inputs);
});

test('resource is not passed off as a callable signal: ResourceRef is read via .value()', () => {
  const contract = one(`
    @Component({ selector: 'a-b', template: '' })
    export class C {
      users = resource({ loader: () => fetchUsers() });
      count = signal(0);
    }
  `);
  assert.deepEqual(contract.publicMembers, [
    { name: 'users', kind: 'property', signature: 'users' },
    { name: 'count', kind: 'signal', signature: 'count(): number' },
  ]);
});

test('host directives are named: their inputs are not collected into the contract', () => {
  const contract = one(`
    @Component({
      selector: 'a-b',
      template: '',
      hostDirectives: [CdkDrag, { directive: Toggleable, inputs: ['checked'] }],
    })
    export class C {}
  `);
  assert.deepEqual(contract.hostDirectives, ['CdkDrag', 'Toggleable']);
});

test('an output is described by its event type, not by the wrapper', () => {
  const contract = one(`
    @Component({ selector: 'a-b', template: '' })
    export class C {
      @Output() picked = new EventEmitter<number>();
      @Output('renamed') changed: EventEmitter<UserVm> = new EventEmitter();
      selected = output<string>();
    }
  `);
  assert.deepEqual(contract.outputs, [
    { name: 'picked', type: 'number', alias: null },
    { name: 'changed', type: 'UserVm', alias: 'renamed' },
    { name: 'selected', type: 'string', alias: null },
  ]);
});

test('model yields a pair: an input and a <name>Change output', () => {
  const contract = one(`
    @Component({ selector: 'a-b', template: '' })
    export class C {
      checked = model.required<boolean>();
    }
  `);
  assert.deepEqual(contract.inputs, [
    { name: 'checked', type: 'boolean', required: true, isSignal: true, alias: null },
  ]);
  assert.deepEqual(contract.outputs, [{ name: 'checkedChange', type: 'boolean', alias: null }]);
});

test('standalone: what is written wins, what is not is derived from the version', () => {
  const source = `
    @Component({ selector: 'a-b', template: '' })
    export class C {}
  `;
  assert.equal(one(source, 22).standalone, true);
  assert.equal(one(source, 19).standalone, true);
  assert.equal(one(source, 18).standalone, false);
  assert.equal(one(source, 17).standalone, false);
  const written = `
    @Component({ selector: 'a-b', standalone: false, template: '' })
    export class C {}
  `;
  assert.equal(one(written, 22).standalone, false);
});

test('changeDetection is reported only when written: the default boundary was never measured', () => {
  const explicit = one(`
    @Component({ selector: 'a-b', template: '', changeDetection: ChangeDetectionStrategy.OnPush })
    export class C {}
  `);
  assert.equal(explicit.changeDetection, 'OnPush');
  const implicit = one(`
    @Component({ selector: 'a-b', template: '' })
    export class C {}
  `);
  assert.equal(implicit.changeDetection, null);
});

test('private and static are hidden, protected is visible: templates can read it', () => {
  const contract = one(`
    @Component({ selector: 'a-b', template: '' })
    export class C {
      constructor(private http: HttpClient) {}
      private secret = 1;
      #harder = 2;
      static shared = 3;
      protected visible = 'yes';
    }
  `);
  assert.deepEqual(
    contract.publicMembers.map((item) => item.name),
    ['visible'],
  );
});

test('signal members are flagged and shown with parentheses', () => {
  const contract = one(`
    @Component({ selector: 'a-b', template: '' })
    export class C {
      count = signal(0);
      doubled = computed<number>(() => this.count() * 2);
      row = viewChild.required<ElementRef>('row');
      plain = 'text';
      run(id: number): void { this.count.set(id); }
    }
  `);
  assert.deepEqual(contract.publicMembers, [
    { name: 'count', kind: 'signal', signature: 'count(): number' },
    { name: 'doubled', kind: 'signal', signature: 'doubled(): number' },
    { name: 'row', kind: 'signal', signature: 'row(): ElementRef' },
    { name: 'plain', kind: 'property', signature: 'plain: string' },
    { name: 'run', kind: 'method', signature: 'run(id: number): void' },
  ]);
});

test('lifecycle hooks collapse to names: their signatures are fixed by Angular', () => {
  const contract = one(`
    @Component({ selector: 'a-b', template: '' })
    export class C implements OnInit, OnDestroy {
      ngOnInit(): void { this.load(); }
      ngOnDestroy(): void {}
      load(): void { fetch('/x'); }
    }
  `);
  assert.deepEqual(contract.lifecycle, ['ngOnInit', 'ngOnDestroy']);
  assert.deepEqual(contract.implements, ['OnInit', 'OnDestroy']);
  assert.deepEqual(
    contract.publicMembers.map((item) => item.name),
    ['load'],
  );
});

test('a hook written as a function-valued field still lands in lifecycle', () => {
  const contract = one(`
    @Component({ selector: 'a-b', template: '' })
    export class C {
      ngOnInit = () => { this.load(); };
      ngOnDestroy = function () { this.stop(); };
      load(): void { fetch('/x'); }
    }
  `);
  assert.deepEqual(contract.lifecycle, ['ngOnInit', 'ngOnDestroy']);
  assert.deepEqual(
    contract.publicMembers.map((item) => item.name),
    ['load'],
  );
});

test('an empty method body is marked noop: registerOnTouched() {} never reports touched', () => {
  const contract = one(`
    @Component({ selector: 'a-b', template: '' })
    export class C implements ControlValueAccessor {
      writeValue(value: string | null): void { this.value = value; }
      registerOnChange(fn: (value: string) => void): void { this.onChange = fn; }
      registerOnTouched(): void {}
    }
  `);
  assert.deepEqual(contract.implements, ['ControlValueAccessor']);
  assert.deepEqual(
    contract.publicMembers.find((item) => item.name === 'registerOnTouched'),
    {
      name: 'registerOnTouched',
      kind: 'method',
      signature: 'registerOnTouched(): void',
      noop: true,
    },
  );
  assert.equal(contract.publicMembers.find((item) => item.name === 'writeValue').noop, undefined);
});

test('inheritance is visible: base-class inputs will not show up here', () => {
  const contract = one(`
    @Component({ selector: 'a-b', template: '' })
    export class C extends BaseCard<UserVm> {}
  `);
  assert.equal(contract.extends, 'BaseCard<UserVm>');
});

test('the partial contract is spelled out in the answer, not hidden in the extends field', () => {
  const inherited = one(`
    import { BaseFieldComponent } from '@acme/ui/inputs';
    @Component({ selector: 'a-b', template: '' })
    export class C extends BaseFieldComponent {}
  `);
  assert.match(
    inherited.incomplete,
    /base class BaseFieldComponent \(imported from '@acme\/ui\/inputs'\).*not collected.*ng_component_info/,
  );

  // A base class with no import is declared nearby; inventing a path is not allowed.
  const local = one(`
    @Component({ selector: 'a-b', template: '' })
    export class C extends LocalBase {}
  `);
  assert.match(local.incomplete, /base class LocalBase are not collected here/);

  // A bare reference exposes nothing bindable, so the raw contract must not flag it either
  // (review 10: the exposure semantics had reached resolveAncestors but not contractOf).
  const hosted = one(`
    @Component({ selector: 'a-b', template: '', hostDirectives: [CdkDrag, Toggleable] })
    export class C {}
  `);
  assert.equal(hosted.incomplete, null);

  const exposed = one(`
    @Component({ selector: 'a-b', template: '',
      hostDirectives: [CdkDrag, { directive: Toggleable, inputs: ['checked'] }] })
    export class C {}
  `);
  assert.match(exposed.incomplete, /host directives Toggleable/);
  assert.ok(!exposed.incomplete.includes('CdkDrag'), 'the bare reference must not be flagged');

  const both = one(`
    @Component({ selector: 'a-b', template: '', hostDirectives: [CdkDrag] })
    export class C extends BaseFieldComponent {}
  `);
  assert.match(both.incomplete, /base class BaseFieldComponent/);
  assert.ok(!both.incomplete.includes('CdkDrag'));

  // A complete contract stays quiet: the flag must not sit on every component.
  const complete = one(`
    @Component({ selector: 'a-b', template: '' })
    export class C { title = 'x'; }
  `);
  assert.equal(complete.incomplete, null);
});

test('a directive is recognised, a @Pipe is not', () => {
  const directive = one(`
    @Directive({ selector: '[appHighlight]' })
    export class HighlightDirective {}
  `);
  assert.equal(directive.kind, 'directive');
  assert.equal(directive.selector, '[appHighlight]');
  assert.equal(parse(`@Pipe({ name: 'money' }) export class MoneyPipe {}`).length, 0);
});

test('the legacy inputs/outputs string lists in the decorator are not lost', () => {
  const contract = one(`
    @Component({ selector: 'a-b', template: '', inputs: ['size', 'colour: color'], outputs: ['done'] })
    export class C {}
  `);
  assert.deepEqual(
    contract.inputs.map((item) => [item.name, item.alias]),
    [
      ['size', null],
      ['colour', 'color'],
    ],
  );
  assert.deepEqual(contract.outputs, [{ name: 'done', type: null, alias: null }]);
});

test('an overloaded method is shown by its implementation, not by the first signature', () => {
  const contract = one(`
    @Component({ selector: 'a-b', template: '' })
    export class C {
      reset(): void;
      reset(next: string): void;
      reset(next?: string): void { this.value = next ?? ''; }
    }
  `);
  assert.deepEqual(contract.publicMembers, [
    { name: 'reset', kind: 'method', signature: 'reset(next?: string): void' },
  ]);
});

test('moving several fields at once does not corrupt publicMembers indices', () => {
  const contract = one(`
    @Component({
      selector: 'a-b',
      template: '',
      inputs: ['size', 'colour: color'],
      outputs: ['done', 'closed'],
    })
    export class C {
      size = 'large';
      colour = 'red';
      done = new EventEmitter<number>();
      closed = new EventEmitter<void>();
      kept = 1;
    }
  `);
  assert.deepEqual(
    contract.inputs.map((item) => [item.name, item.type]),
    [
      ['size', 'string'],
      ['colour', 'string'],
    ],
  );
  assert.deepEqual(
    contract.outputs.map((item) => [item.name, item.type]),
    [
      ['done', 'number'],
      ['closed', 'void'],
    ],
  );
  assert.deepEqual(
    contract.publicMembers.map((item) => item.name),
    ['kept'],
  );
});

test('a field declared as an input in the decorator is not duplicated and keeps its type', () => {
  const contract = one(`
    @Component({ selector: 'a-b', template: '', inputs: ['size'], outputs: ['done'] })
    export class C {
      size = 'large';
      done = new EventEmitter<number>();
      other = 1;
    }
  `);
  assert.deepEqual(contract.inputs, [{ name: 'size', type: 'string', alias: null }]);
  assert.deepEqual(contract.outputs, [{ name: 'done', type: 'number', alias: null }]);
  assert.deepEqual(
    contract.publicMembers.map((item) => item.name),
    ['other'],
  );
});

test('providers are read as written, viewProviders too', () => {
  const contract = one(`
    @Component({
      selector: 'a-b',
      template: '',
      providers: [LoginAnalyticsService, { provide: ANALYTICS, useClass: AuthAnalyticsService }],
      viewProviders: [UserIdentityService],
    })
    export class C {}
  `);
  assert.deepEqual(contract.providers, [
    'LoginAnalyticsService',
    '{ provide: ANALYTICS, useClass: AuthAnalyticsService }',
  ]);
  assert.deepEqual(contract.viewProviders, ['UserIdentityService']);
});

test('ancestors: providers are never merged - Angular replaces, not merges', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-anc-'));
  try {
    await writeFile(
      join(dir, 'base.ts'),
      `import { Directive } from '@angular/core';
       @Directive({ providers: [BaseService] })
       export class Base {}`,
    );
    const file = join(dir, 'x.component.ts');
    await writeFile(
      file,
      `import { Component } from '@angular/core';
       import { Base } from './base';
       @Component({ selector: 'a-b', template: '' })
       export class C extends Base {}`,
    );
    const complete = resolveAncestors(ts, contractFrom(file, 22), file, dir);
    assert.deepEqual(complete.ancestors, ['Base']);
    assert.deepEqual(complete.providers, [], 'the ancestor providers must not leak in');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('host directives: their providers do not leak into the contract either', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-anc-'));
  try {
    await writeFile(
      join(dir, 'analytics.directive.ts'),
      `import { Directive, Input } from '@angular/core';
       @Directive({ selector: '[appAnalytics]', providers: [AnalyticsService] })
       export class AnalyticsDirective {
         @Input() channel = '';
       }`,
    );
    const file = join(dir, 'x.component.ts');
    await writeFile(
      file,
      `import { Component } from '@angular/core';
       import { AnalyticsDirective } from './analytics.directive';
       @Component({
         selector: 'a-b',
         template: '',
         hostDirectives: [{ directive: AnalyticsDirective, inputs: ['channel'] }],
       })
       export class C {}`,
    );
    const complete = resolveAncestors(ts, contractFrom(file, 22), file, dir);
    assert.deepEqual(complete.inputs.map((item) => item.name), ['channel']);
    assert.deepEqual(complete.providers, [], 'the host directive providers must not leak in');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('styles are collected from both forms', () => {
  const contract = one(`
    @Component({ selector: 'a-b', template: '', styleUrls: ['./a.css'], styleUrl: './b.css' })
    export class C {}
  `);
  assert.deepEqual(contract.styleUrls, ['./a.css', './b.css']);
});

test('a template picks its own class out of a file with two components', () => {
  const found = parse(`
    @Component({ selector: 'a-one', templateUrl: './one.component.html' })
    export class OneComponent {}
    @Component({ selector: 'a-two', templateUrl: './two.component.html' })
    export class TwoComponent {}
  `);
  assert.equal(pickComponent(found, 'two.component.html').className, 'TwoComponent');
  assert.equal(pickComponent(found, null).className, 'OneComponent');
  assert.equal(pickComponent(found, 'no-such.html').className, 'OneComponent');
});

test('a template resolves to its companion, and a missing companion is explained', () => {
  const template = resolve(v22, 'src/app/user-card.component.html');
  assert.equal(componentFileFor(template), resolve(v22, 'src/app/user-card.component.ts'));
  assert.throws(() => componentFileFor(resolve(v22, 'src/app/missing.html')), /no .ts with a matching name/);
});

test('fixtures v17 and v22 are parsed with the TypeScript installed in the project', async () => {
  for (const [version, expected] of [
    ['v17', { standalone: true, badge: 'string', changeDetection: 'OnPush' }],
    ['v22', { standalone: true, badge: undefined, changeDetection: null }],
  ]) {
    const file = resolve('fixtures', version, 'src/app/user-card.component.ts');
    const project = locateProject(file);
    const api = await loadTypeScript(project.root);
    const [contract] = describeComponents(
      api,
      readFileSync(file, 'utf8'),
      file,
      project.angularMajor,
    );
    assert.equal(contract.className, 'UserCardComponent');
    assert.equal(contract.standalone, expected.standalone);
    assert.equal(contract.changeDetection, expected.changeDetection);
    assert.deepEqual(contract.inputs[0], {
      name: 'user',
      type: 'UserVm',
      required: true,
      isSignal: true,
      alias: null,
    });
    assert.equal(contract.inputs[1]?.type, expected.badge);
    assert.deepEqual(contract.outputs, [{ name: 'selected', type: 'number', alias: null }]);
  }
});

test('a file with no component yields an empty list rather than an invention', () => {
  assert.equal(parse('export class Plain { value = 1; }').length, 0);
});

test('a missing typescript is explained and cured by installing dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ng-bridge-'));
  const lib = join(root, 'node_modules', 'typescript', 'lib');
  assert.throws(() => loadTypeScript(root), /no typescript in/);

  // The same place after npm install: the refusal was synchronous and cached nothing.
  await mkdir(lib, { recursive: true });
  await writeFile(join(lib, 'typescript.js'), 'module.exports = { version: "0.0.0-check" };');
  const api = await loadTypeScript(root);
  assert.equal(api.version, '0.0.0-check');
  await rm(root, { recursive: true, force: true });
});

test('a broken typescript.js is explained but cannot be fixed in-process: Node caches the module', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ng-bridge-'));
  const lib = join(root, 'node_modules', 'typescript', 'lib');
  await mkdir(lib, { recursive: true });
  const entry = join(lib, 'typescript.js');

  await writeFile(entry, 'module.exports = undefined;');
  await assert.rejects(() => loadTypeScript(root), /did not expose the TypeScript API/);

  // Fixing the file on disk does not help: Node returns the same module for the same URL.
  await writeFile(entry, 'module.exports = { version: "0.0.0-check" };');
  await assert.rejects(() => loadTypeScript(root), /did not expose the TypeScript API/);
  await rm(root, { recursive: true, force: true });
});

// ---- Ancestor resolution: extends chains merged into the contract ----

const v17 = resolve('fixtures/v17');

function contractFrom(file, major = 17) {
  const [contract] = describeComponents(ts, readFileSync(file, 'utf8'), file, major);
  assert.ok(contract, `no component in ${file}`);
  return contract;
}

test('ancestors: a relative chain of two is merged and the child shadows', () => {
  const file = resolve('fixtures/v17/src/app/derived-card.component.ts');
  const complete = resolveAncestors(ts, contractFrom(file), file, v17);
  assert.deepEqual(complete.ancestors, ['BasePanel', 'BaseWidget']);
  assert.deepEqual(
    complete.inputs.map((item) => item.name),
    ['accent', 'heading', 'disabled'],
  );
  assert.deepEqual(complete.outputs.map((item) => item.name), ['blurred']);
  const focus = complete.publicMembers.filter((item) => item.name === 'focus');
  assert.equal(focus.length, 1, 'the override must shadow the inherited method');
  assert.ok(complete.publicMembers.some((item) => item.name === 'collapse'));
  assert.ok(!complete.publicMembers.some((item) => item.name === 'token'), 'private stays hidden');
  assert.equal(complete.incomplete, null);
});

test('ancestors: a base behind a tsconfig alias barrel is found', () => {
  const file = resolve('fixtures/v17/src/app/alias-card.component.ts');
  const complete = resolveAncestors(ts, contractFrom(file), file, v17);
  assert.deepEqual(complete.ancestors, ['NamedEntity']);
  assert.deepEqual(
    complete.publicMembers.map((item) => item.name).sort(),
    ['describe', 'id', 'label'],
  );
  assert.equal(complete.incomplete, null);
});

test('ancestors: a base from a package is refused and stays named in incomplete', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-anc-'));
  try {
    const file = join(dir, 'x.component.ts');
    await writeFile(
      file,
      `import { Component } from '@angular/core';
       import { CdkTree } from '@angular/cdk/tree';
       @Component({ selector: 'a-b', template: '' })
       export class C extends CdkTree {}`,
    );
    const complete = resolveAncestors(ts, contractFrom(file, 22), file, dir);
    assert.equal(complete.ancestors, null);
    assert.match(complete.incomplete, /base class CdkTree \(imported from '@angular\/cdk\/tree'\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ancestors: a generic base in the same file needs no import', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-anc-'));
  try {
    const file = join(dir, 'x.component.ts');
    await writeFile(
      file,
      `import { Component } from '@angular/core';
       export class Store<T> {
         items: T[] = [];
         clear(): void {}
       }
       @Component({ selector: 'a-b', template: '' })
       export class C extends Store<string> {}`,
    );
    const complete = resolveAncestors(ts, contractFrom(file, 22), file, dir);
    assert.deepEqual(complete.ancestors, ['Store']);
    assert.ok(complete.publicMembers.some((item) => item.name === 'clear'));
    assert.equal(complete.incomplete, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Angular inherits decorator metadata: a field redeclared without @Input over an ancestor
// @Input still binds as an input. The contract must not demote it to a plain member.
test('ancestors: a plain redeclaration over an inherited @Input stays an input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-anc-'));
  try {
    const file = join(dir, 'x.component.ts');
    await writeFile(
      file,
      `import { Component, Input } from '@angular/core';
       export class Base {
         @Input() size = 0;
       }
       @Component({ selector: 'a-b', template: '' })
       export class C extends Base {
         size: 1 | 2 | 3 = 1;
       }`,
    );
    const complete = resolveAncestors(ts, contractFrom(file, 22), file, dir);
    assert.deepEqual(
      complete.inputs.map((item) => [item.name, item.type]),
      [['size', '1 | 2 | 3']],
    );
    assert.ok(!complete.publicMembers.some((item) => item.name === 'size'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ancestors: implements and lifecycle merge from the chain, overrides collapse', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-anc-'));
  try {
    await writeFile(
      join(dir, 'base.ts'),
      `export class Base implements OnInit, ControlValueAccessor {
         ngOnInit(): void { this.setup(); }
         ngOnDestroy(): void {}
         setup(): void { this.ready = true; }
       }`,
    );
    const file = join(dir, 'x.component.ts');
    await writeFile(
      file,
      `import { Component, OnInit } from '@angular/core';
       import { Base } from './base';
       @Component({ selector: 'a-b', template: '' })
       export class C extends Base implements OnInit {
         override ngOnInit(): void { this.extra(); }
         extra(): void { this.done = true; }
       }`,
    );
    const complete = resolveAncestors(ts, contractFrom(file, 22), file, dir);
    assert.deepEqual(complete.implements, ['OnInit', 'ControlValueAccessor']);
    assert.deepEqual(complete.lifecycle, ['ngOnInit', 'ngOnDestroy']);
    assert.ok(complete.publicMembers.some((item) => item.name === 'setup'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ancestors: a mixin call is not resolvable by design', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-anc-'));
  try {
    const file = join(dir, 'x.component.ts');
    await writeFile(
      file,
      `import { Component } from '@angular/core';
       import { withBits, Base } from './mixins';
       @Component({ selector: 'a-b', template: '' })
       export class C extends withBits(Base) {}`,
    );
    const complete = resolveAncestors(ts, contractFrom(file, 22), file, dir);
    assert.equal(complete.ancestors, null);
    assert.match(complete.incomplete, /base class withBits\(Base\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Host directives are inherited in Angular, so an ancestor's surface in the contract. A bare
// reference exposes nothing bindable - so unlike before, it does not flag incompleteness.
test('ancestors: a bare host directive of an ancestor is named and flags nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-anc-'));
  try {
    await writeFile(
      join(dir, 'base.ts'),
      `import { Directive } from '@angular/core';
       import { CdkDrag } from '@angular/cdk/drag-drop';
       @Directive({ hostDirectives: [CdkDrag] })
       export class Base {
         nudge(): void {}
       }`,
    );
    const file = join(dir, 'x.component.ts');
    await writeFile(
      file,
      `import { Component } from '@angular/core';
       import { Base } from './base';
       @Component({ selector: 'a-b', template: '' })
       export class C extends Base {}`,
    );
    const complete = resolveAncestors(ts, contractFrom(file, 22), file, dir);
    assert.deepEqual(complete.ancestors, ['Base']);
    assert.deepEqual(complete.hostDirectives, ['CdkDrag']);
    assert.equal(complete.incomplete, null, 'a bare reference exposes nothing bindable');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The object form exposes listed inputs/outputs, renames included; types come from the
// directive class resolved with the same static machinery, its own extends chain included.
test('host directives: exposed inputs and outputs join the contract with types', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-anc-'));
  try {
    await writeFile(
      join(dir, 'drag-base.ts'),
      `import { Directive, Input } from '@angular/core';
       @Directive()
       export class DragBase {
         @Input() axis: 'x' | 'y' = 'x';
       }`,
    );
    await writeFile(
      join(dir, 'drag.directive.ts'),
      `import { Directive, EventEmitter, Input, Output } from '@angular/core';
       import { DragBase } from './drag-base';
       @Directive({ selector: '[appDrag]' })
       export class DragDirective extends DragBase {
         @Input('dragDisabled') disabled = false;
         @Output() dropped = new EventEmitter<number>();
       }`,
    );
    const file = join(dir, 'x.component.ts');
    await writeFile(
      file,
      `import { Component } from '@angular/core';
       import { DragDirective } from './drag.directive';
       @Component({
         selector: 'a-b',
         template: '',
         hostDirectives: [
           { directive: DragDirective, inputs: ['dragDisabled: frozen', 'axis'], outputs: ['dropped'] },
         ],
       })
       export class C {}`,
    );
    const complete = resolveAncestors(ts, contractFrom(file, 22), file, dir);
    assert.deepEqual(
      complete.inputs.map((item) => [item.name, item.type]),
      [
        ['frozen', 'boolean'],
        ['axis', `'x' | 'y'`],
      ],
    );
    assert.deepEqual(complete.outputs.map((item) => [item.name, item.type]), [['dropped', 'number']]);
    assert.equal(complete.incomplete, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Review 10: the directive itself resolves but its own extends chain breaks on a package
// base. The exposure comes out untyped, and without a word in incomplete that would be
// indistinguishable from a typo in the exposure list.
test('host directives: a broken chain inside the directive is named in incomplete', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-anc-'));
  try {
    await writeFile(
      join(dir, 'drag.directive.ts'),
      `import { Directive } from '@angular/core';
       import { PkgBase } from '@some/pkg';
       @Directive({ selector: '[appDrag]' })
       export class DragDirective extends PkgBase {}`,
    );
    const file = join(dir, 'x.component.ts');
    await writeFile(
      file,
      `import { Component } from '@angular/core';
       import { DragDirective } from './drag.directive';
       @Component({
         selector: 'a-b',
         template: '',
         hostDirectives: [{ directive: DragDirective, inputs: ['axis'] }],
       })
       export class C {}`,
    );
    const complete = resolveAncestors(ts, contractFrom(file, 22), file, dir);
    assert.deepEqual(
      complete.inputs.map((item) => [item.name, item.type]),
      [['axis', null]],
    );
    assert.match(complete.incomplete, /host directives DragDirective \(imported from '\.\/drag\.directive'\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// An exposure on a directive from a package: the names are still known from the local
// decorator and stay bindable, but their types are not - and the answer says so.
test('host directives: an unresolvable directive keeps exposed names and flags incomplete', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-anc-'));
  try {
    const file = join(dir, 'x.component.ts');
    await writeFile(
      file,
      `import { Component } from '@angular/core';
       import { CdkMenuTrigger } from '@angular/cdk/menu';
       @Component({
         selector: 'a-b',
         template: '',
         hostDirectives: [{ directive: CdkMenuTrigger, inputs: ['cdkMenuTriggerFor: menu'] }],
       })
       export class C {}`,
    );
    const complete = resolveAncestors(ts, contractFrom(file, 22), file, dir);
    assert.deepEqual(
      complete.inputs.map((item) => [item.name, item.type]),
      [['menu', null]],
    );
    assert.match(
      complete.incomplete,
      /host directives CdkMenuTrigger \(imported from '@angular\/cdk\/menu'\)/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Review 8 MAJOR: the barrel walk deduped by file alone, so a class reachable a second
// time through the same file under another name (export { Foo as Target }) was hidden.
test('ancestors: a renamed re-export through an already visited file is still found', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-anc-'));
  try {
    await writeFile(join(dir, 'shared.ts'), 'export class Foo { ping(): void {} }');
    await writeFile(join(dir, 'mid1.ts'), `export * from './shared';`);
    await writeFile(join(dir, 'mid2.ts'), `export { Foo as Target } from './shared';`);
    await writeFile(join(dir, 'barrel.ts'), `export * from './mid1';\nexport { Target } from './mid2';`);
    await writeFile(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@lib': ['barrel.ts'] } } }),
    );
    const file = join(dir, 'x.component.ts');
    await writeFile(
      file,
      `import { Component } from '@angular/core';
       import { Target } from '@lib';
       @Component({ selector: 'a-b', template: '' })
       export class C extends Target {}`,
    );
    const complete = resolveAncestors(ts, contractFrom(file, 22), file, dir);
    assert.deepEqual(complete.ancestors, ['Target']);
    assert.ok(complete.publicMembers.some((item) => item.name === 'ping'));
    assert.equal(complete.incomplete, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// paths can live one extends-hop away from tsconfig.json, exactly like strictTemplates.
test('ancestors: an alias declared behind a tsconfig extends chain resolves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-anc-'));
  try {
    await writeFile(join(dir, 'base.ts'), 'export class Base { tick(): void {} }');
    await writeFile(
      join(dir, 'tsconfig.paths.json'),
      JSON.stringify({ compilerOptions: { paths: { '@base': ['./base.ts'] } } }),
    );
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ extends: './tsconfig.paths.json' }));
    const file = join(dir, 'x.component.ts');
    await writeFile(
      file,
      `import { Component } from '@angular/core';
       import { Base } from '@base';
       @Component({ selector: 'a-b', template: '' })
       export class C extends Base {}`,
    );
    const complete = resolveAncestors(ts, contractFrom(file, 22), file, dir);
    assert.deepEqual(complete.ancestors, ['Base']);
    assert.ok(complete.publicMembers.some((item) => item.name === 'tick'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// NodeNext-style relative imports name the compiled .js while meaning the .ts next to it.
test('ancestors: a .js specifier resolves to the .ts next to it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-anc-'));
  try {
    await writeFile(join(dir, 'base.ts'), 'export class Base { run(): void {} }');
    const file = join(dir, 'x.component.ts');
    await writeFile(
      file,
      `import { Component } from '@angular/core';
       import { Base } from './base.js';
       @Component({ selector: 'a-b', template: '' })
       export class C extends Base {}`,
    );
    const complete = resolveAncestors(ts, contractFrom(file, 22), file, dir);
    assert.deepEqual(complete.ancestors, ['Base']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ancestors: an extends cycle terminates instead of hanging', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-anc-'));
  try {
    const file = join(dir, 'x.component.ts');
    await writeFile(
      file,
      `import { Component } from '@angular/core';
       @Component({ selector: 'a-b', template: '' })
       export class A extends B {}
       export class B extends A {}`,
    );
    const complete = resolveAncestors(ts, contractFrom(file, 22), file, dir);
    assert.deepEqual(complete.ancestors, ['B']);
    assert.match(complete.incomplete, /base class A/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
