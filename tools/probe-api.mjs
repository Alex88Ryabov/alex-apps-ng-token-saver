// From which major a given Angular API exists: we ask the installed packages rather than the
// docs. We import the real @angular/* from a workspace and look at what it exports. That is
// ground truth: if the symbol is absent, any agent advice using it will not compile.
//
//
//   node tools/probe-api.mjs                     all six fixtures
//   node tools/probe-api.mjs --project <path>    plus an arbitrary workspace

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TARGETS = {
  '@angular/core': [
    'signal',
    'computed',
    'effect',
    'linkedSignal',
    'resource',
    'input',
    'output',
    'model',
    'viewChild',
    'contentChild',
    'inject',
    'DestroyRef',
    'afterNextRender',
    'afterRenderEffect',
    'provideExperimentalZonelessChangeDetection',
    'provideZonelessChangeDetection',
    'provideAppInitializer',
    'Service',
  ],
  '@angular/core/rxjs-interop': [
    'toSignal',
    'toObservable',
    'takeUntilDestroyed',
    'outputFromObservable',
    'rxResource',
  ],
  '@angular/common': ['NgIf', 'NgFor', 'NgClass', 'AsyncPipe'],
  '@angular/common/http': ['HttpClient', 'provideHttpClient', 'withFetch', 'httpResource'],
  '@angular/forms': ['FormControl', 'FormGroup', 'FormBuilder', 'NonNullableFormBuilder', 'FormRecord', 'ReactiveFormsModule', 'Validators'],
  '@angular/forms/signals': ['form', 'FormField', 'schema', 'required', 'submit'],
  '@angular/core/testing': ['TestBed', 'fakeAsync', 'tick', 'flush', 'waitForAsync', 'DeferBlockBehavior'],
};

// Packages with decorators (@angular/common and beyond) fail on JIT under bare Node, so the
// compiler must be imported first. And 'package missing' must be told from 'import failed':
// otherwise an installed package is recorded as absent, which is an invention.
const SCRIPT = `
try { await import('@angular/compiler'); } catch {}
const targets = ${JSON.stringify(TARGETS)};
const out = {};
for (const [name, symbols] of Object.entries(targets)) {
  try {
    const module = await import(name);
    out[name] = Object.fromEntries(symbols.map((s) => [s, typeof module[s] !== 'undefined']));
  } catch (error) {
    const missing = error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
    out[name] = missing ? null : { __failed: String(error?.message ?? error).slice(0, 80) };
  }
}
// Runtime shape: instance members and statics are invisible to a typeof over the module.
out.__runtime = {};
try {
  const forms = await import('@angular/forms');
  out.__runtime.formControlEvents = 'events' in new forms.FormControl('');
} catch {
  out.__runtime.formControlEvents = null;
}
try {
  const testing = await import('@angular/core/testing');
  out.__runtime.testBedStatics = Object.fromEntries(
    ['flushEffects', 'tick', 'inject', 'runInInjectionContext'].map((name) => [
      name,
      typeof testing.TestBed?.[name] === 'function',
    ]),
  );
} catch {
  out.__runtime.testBedStatics = null;
}
try {
  const signals = await import('@angular/forms/signals');
  out.__runtime.signalFormsKeys = Object.keys(signals).sort();
} catch {
  out.__runtime.signalFormsKeys = null;
}
console.log(JSON.stringify(out));
`;

// A symbol existing is not production readiness: @experimental and @developerPreview live only
// in the JSDoc of declarations and are invisible at runtime.
function declarationFiles(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.d.ts')) {
        found.push(full);
      }
    }
  };
  for (const pkg of ['core', 'common', 'forms']) {
    walk(join(root, 'node_modules', '@angular', pkg));
  }
  return found;
}

function stabilityOf(files, symbol) {
  const declaration = new RegExp(`declare (?:function|const|class|abstract class) ${symbol}[\\s<(:]`);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const hit = declaration.exec(text);
    if (!hit) {
      continue;
    }
    const before = text.slice(Math.max(0, hit.index - 2000), hit.index);
    const start = before.lastIndexOf('/**');
    const tags = (start >= 0 ? before.slice(start) : '').match(
      /@(publicApi|experimental|developerPreview)/g,
    );
    return tags ? tags[tags.length - 1].slice(1) : 'no tag';
  }
  return null;
}

function probe(root) {
  const raw = execFileSync(process.execPath, ['--input-type=module', '-e', SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1e7,
  });
  return JSON.parse(raw.trim().split('\n').pop());
}

const args = process.argv.slice(2);
const extra = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--project' && args[i + 1]) {
    extra.push(args[i + 1]);
    i += 1;
  }
}

const workspaces = ['v17', 'v18', 'v19', 'v20', 'v21', 'v22']
  .map((version) => ({ label: version, root: resolve('fixtures', version) }))
  .concat(extra.map((path) => ({ label: path.split(/[\\/]/).pop(), root: resolve(path) })))
  .filter((item) => existsSync(item.root));

const results = new Map();
for (const workspace of workspaces) {
  const files = declarationFiles(workspace.root);
  results.set(workspace.label, {
    version: angularVersion(workspace.root),
    api: probe(workspace.root),
    stability: Object.fromEntries(
      Object.values(TARGETS)
        .flat()
        .map((symbol) => [symbol, stabilityOf(files, symbol)]),
    ),
  });
}

function angularVersion(root) {
  try {
    return execFileSync(
      process.execPath,
      ['-p', `require('${resolve(root, 'node_modules/@angular/core/package.json').replace(/\\/g, '/')}').version`],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return '?';
  }
}

const labels = [...results.keys()];
console.log(`\nAPI per workspace (${labels.map((l) => `${l}=${results.get(l).version}`).join(', ')})\n`);
for (const [module, symbols] of Object.entries(TARGETS)) {
  const missing = labels.filter((l) => results.get(l).api[module] === null);
  const broken = labels.filter((l) => results.get(l).api[module]?.__failed);
  const notes = [
    missing.length ? `not installed: ${missing.join(', ')}` : '',
    broken.length ? `import failed: ${broken.join(', ')} - ${results.get(broken[0]).api[module].__failed}` : '',
  ].filter(Boolean);
  console.log(`${module}${notes.length ? `   (${notes.join('; ')})` : ''}`);
  for (const symbol of symbols) {
    const cells = labels.map((label) => {
      const api = results.get(label).api[module];
      if (api === null) {
        return ' — ';
      }
      return api.__failed ? ' ? ' : api[symbol] ? ' + ' : ' . ';
    });
    console.log(`  ${symbol.padEnd(44)}${cells.join('')}`);
  }
}
console.log(`\n  + present, . absent, - no package, ? import failed.  Columns: ${labels.join(' ')}`);

console.log('\nRuntime shape (instance members and statics, invisible to module typeof):');
for (const label of labels) {
  const runtime = results.get(label).api.__runtime ?? {};
  const statics = runtime.testBedStatics
    ? Object.entries(runtime.testBedStatics)
        .filter(([, present]) => present)
        .map(([name]) => name)
        .join(', ') || '(none of the probed)'
    : '—';
  const events = runtime.formControlEvents === null ? '—' : runtime.formControlEvents ? '+' : '.';
  console.log(`  ${label}: FormControl.events=${events}  TestBed statics: ${statics}`);
  if (runtime.signalFormsKeys) {
    const keys = runtime.signalFormsKeys;
    console.log(`    forms/signals exports (${keys.length}): ${keys.slice(0, 26).join(' ')}${keys.length > 26 ? ' …' : ''}`);
  }
}

// A symbol being present does not mean it can be advised: before stabilisation APIs break without a major.
const SHORT = { publicApi: 'stable', experimental: 'EXPERIMENTAL', developerPreview: 'preview', 'no tag': 'no tag' };
console.log('\nStability from declaration JSDoc (only where the symbol exists):');
for (const symbol of Object.values(TARGETS).flat()) {
  const cells = labels.map((label) => results.get(label).stability[symbol]);
  if (cells.every((cell) => cell === null || cell === 'no tag' || cell === 'publicApi')) {
    continue;
  }
  console.log(
    `  ${symbol.padEnd(44)}${cells.map((cell) => (cell ? (SHORT[cell] ?? cell) : '—').padEnd(12)).join('')}`,
  );
}
