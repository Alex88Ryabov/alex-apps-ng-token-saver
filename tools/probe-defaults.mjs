// Have three measured facts gone stale? Facts are measured once, the version matrix keeps moving,
// and a measured-once fact ages exactly like documentation - just more quietly.
//
//   1. strictTemplates: where does the compiler default flip? workspace-map.ts answers false when
//      nobody writes the flag, and every fixture writes it, so that branch runs in no test.
//   2. Fact 4: is --angularCoreVersion the authority, or a fallback the project overrides?
//   3. Fact 3: do identical ng/ts probe locations really kill the server in ~200 ms?
//   4. The same strictTemplates question asked of the project's own ngc. Section 1 measures the
//      shipped server, which is one branch for every project; workspace_map describes the build,
//      and only the project's compiler can answer for that.
//
//   node tools/probe-defaults.mjs [v17 v18 v19 v20 v21 v22] [--only=1] [--only=2] [--only=3] [--only=4]

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, uriKey } from './lsp-client.mjs';

const LS22 = resolve('tools/servers/ls22');
const PROBE_DIR = 'tmp-strict-probe';

// The server names the governing tsconfig in angular/suggestStrictMode whenever strict mode is
// off - the same notice the product turns into checksDisabled. Here it answers a different
// question: which config the server actually picked for the probe.
class ProbeClient extends Client {
  constructor(child) {
    super(child);
    this.strictOff = [];
  }

  dispatch(msg) {
    if (msg.method === 'angular/suggestStrictMode') {
      this.strictOff.push(msg.params?.configFilePath ?? JSON.stringify(msg.params));
    }
    super.dispatch(msg);
  }
}

const argv = process.argv.slice(2);
const only = argv.filter((item) => item.startsWith('--only=')).map((item) => Number(item.slice(7)));
const runs = (section) => only.length === 0 || only.includes(section);
const versions = argv.filter((item) => !item.startsWith('--'));
if (versions.length === 0) {
  versions.push('v17', 'v18', 'v19', 'v20', 'v21', 'v22');
}

function coreVersion(projectDir) {
  return JSON.parse(
    readFileSync(join(projectDir, 'node_modules', '@angular', 'core', 'package.json'), 'utf8'),
  ).version;
}

// startServer in lsp-client always appends --angularCoreVersion, and probe 2 needs it absent.
function spawnServer(ngProbe, tsProbe, extra = []) {
  const bin = join(LS22, 'node_modules', '@angular', 'language-server', 'bin', 'ngserver');
  return spawn(
    process.execPath,
    [bin, '--stdio', '--ngProbeLocations', ngProbe, '--tsProbeLocations', tsProbe, ...extra],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

// One server, one document, one verdict. A timeout is reported as itself: an empty answer and a
// broken server must not look alike.
async function ask({ ngProbe, tsProbe, extra = [], projectDir, document, quietMs = 900 }) {
  const started = Date.now();
  const child = spawnServer(ngProbe, tsProbe, extra);
  const client = new ProbeClient(child);
  const exit = { code: null, at: null };
  child.on('exit', (code) => {
    exit.code = code;
    exit.at = Date.now() - started;
  });

  const report = { initialize: null, projectLoad: null, diagnostics: null, codes: [], exit: null };
  const init = await Promise.race([
    client.initialize(projectDir),
    new Promise((r) => setTimeout(() => r({ error: { message: 'timeout 20000ms' } }), 20_000)),
  ]);
  if (init.error) {
    report.initialize = `ERROR: ${init.error.message ?? JSON.stringify(init.error)}`;
    report.exit = exit.code === null ? 'alive' : `exited ${exit.code} after ${exit.at} ms`;
    report.stderr = client.stderr.join('').split('\n').filter(Boolean).slice(0, 3);
    child.kill();
    return report;
  }
  report.initialize = 'ok';
  client.notify('initialized', {});

  const path = join(projectDir, document);
  client.didOpen(path, 'typescript', readFileSync(path, 'utf8'));
  report.projectLoad = (await client.waitForProjectLoad(60_000)) ? 'arrived' : 'NEVER arrived';
  await client.waitForQuiet(quietMs, 20_000);

  const list = client.diagnostics.get(uriKey(path));
  report.diagnostics = list === undefined ? null : list.length;
  report.codes = (list ?? []).map((item) => `${item.code}[sev ${item.severity ?? 1}]`);
  report.messages = (list ?? []).map((item) => item.message);
  report.strictOff = client.strictOff;
  report.exit = exit.code === null ? 'alive' : `exited ${exit.code} after ${exit.at} ms`;
  report.stderr = client.stderr.join('').split('\n').filter(Boolean).slice(0, 3);
  child.kill();
  return report;
}

// --- 1. strictTemplates default ------------------------------------------------------------

// The textbook discriminator: a wrong type bound to an @Input is checked only under
// strictTemplates. Basic mode checks top-level interpolations of the component's own members and
// stops there, so an error here means the flag is on.
function writeProbe(projectDir, major, strict) {
  const dir = join(projectDir, PROBE_DIR);
  mkdirSync(dir, { recursive: true });
  // Its own tsconfig, not extending the fixture's: tsserver takes the nearest one, so this governs
  // the probe and the fixture's config is never touched.
  const tsconfig = {
    compilerOptions: {
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      experimentalDecorators: true,
      moduleResolution: 'bundler',
      target: 'ES2022',
      module: 'ES2022',
      lib: ['ES2022', 'dom'],
    },
    ...(strict === null ? {} : { angularCompilerOptions: { strictTemplates: strict } }),
  };
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  // standalone is written only below v19, where it is not the default (section 2.14).
  const flag = major < 19 ? '\n  standalone: true,' : '';
  writeFileSync(
    join(dir, 'child.component.ts'),
    `import { Component, Input } from '@angular/core';\n\n` +
      `@Component({\n  selector: 'probe-child',${flag}\n` +
      `  template: '<span>{{ count }}</span>',\n})\n` +
      `export class ProbeChildComponent {\n  @Input() count!: number;\n}\n`,
  );
  writeFileSync(
    join(dir, 'parent.component.ts'),
    `import { Component } from '@angular/core';\n` +
      `import { ProbeChildComponent } from './child.component';\n\n` +
      `@Component({\n  selector: 'probe-parent',${flag}\n` +
      `  imports: [ProbeChildComponent],\n` +
      `  template: '<probe-child [count]="text"></probe-child>',\n})\n` +
      `export class ProbeParentComponent {\n  text = 'not a number';\n}\n`,
  );
  return dir;
}

if (runs(1)) {
console.log('=== 1. strictTemplates: written vs default ===');
console.log('   Two controls. Written true must error, or the probe is broken and its silence says');
console.log('   nothing. Written false must NOT error, or this tsconfig is not the governing one');
console.log('   and the middle run means nothing either.\n');

for (const version of versions) {
  const projectDir = resolve('fixtures', version);
  const core = coreVersion(projectDir);
  const major = Number(core.split('.')[0]);
  const document = `${PROBE_DIR}/parent.component.ts`;
  const outcome = {};
  try {
    for (const strict of [true, null, false]) {
      writeProbe(projectDir, major, strict);
      outcome[String(strict)] = await ask({
        ngProbe: join(LS22, 'node_modules'),
        tsProbe: join(projectDir, 'node_modules'),
        extra: ['--angularCoreVersion', core],
        projectDir,
        document,
      });
    }
  } finally {
    rmSync(join(projectDir, PROBE_DIR), { recursive: true, force: true });
  }
  const on = outcome.true;
  const absent = outcome.null;
  const off = outcome.false;
  let verdict;
  if (!on.diagnostics) {
    verdict = 'PROBE BROKEN - written true found no error';
  } else if (off.diagnostics) {
    verdict = 'PROBE NOT ISOLATED - written false still errors, so this tsconfig does not govern';
  } else {
    verdict = absent.diagnostics ? 'default is ON' : 'default is OFF';
  }
  console.log(`${version} (${core}): ${verdict}`);
  for (const [label, run] of [
    ['written true ', on],
    ['not written  ', absent],
    ['written false', off],
  ]) {
    const notice = run.strictOff?.length ? ` <- suggestStrictMode: ${run.strictOff.join(', ')}` : '';
    console.log(`      ${label}: ${run.diagnostics ?? 'no push'} ${run.codes.join(', ')}${notice}`);
  }
  if (on.messages?.[0]) {
    console.log(`      error text   : ${on.messages[0].split('\n')[0]}`);
  }
}
}

// --- 2. Fact 4: --angularCoreVersion ----------------------------------------------------------

// standalone-probe.component.ts carries imports with no standalone flag: an error below v19, valid
// from v19 up. Run it on v17 with the flag and without. If the error survives the flag's absence,
// the server found the version itself and the flag is a fallback.
if (runs(2)) {
  console.log('\n=== 2. Fact 4: is --angularCoreVersion the authority? ===');
  const projectDir = resolve('fixtures/v17');
  const core = coreVersion(projectDir);
  const document = 'src/app/standalone-probe.component.ts';
  const common = {
    ngProbe: join(LS22, 'node_modules'),
    tsProbe: join(projectDir, 'node_modules'),
    projectDir,
    document,
  };
  const withFlag = await ask({ ...common, extra: ['--angularCoreVersion', core] });
  const without = await ask({ ...common });
  const verdict =
    withFlag.diagnostics === null || withFlag.diagnostics === 0
      ? 'PROBE BROKEN - the flagged run found no error'
      : without.diagnostics
        ? 'FALLBACK - the project version wins without the flag; fact 4 needs rewriting'
        : 'AUTHORITY - without the flag the newest semantics are taken; fact 4 stands';
  console.log(`v17 (${core}) on server 22.0.8: ${verdict}`);
  console.log(`      with flag    : ${withFlag.diagnostics ?? 'no push'} ${withFlag.codes.join(', ')}`);
  console.log(`      without flag : ${without.diagnostics ?? 'no push'} ${without.codes.join(', ')}`);
  if (withFlag.messages?.[0]) {
    console.log(`      with flag says: ${withFlag.messages[0].split('\n')[0]}`);
  }
}

// --- 3. Fact 3: probe locations ---------------------------------------------------------------

// The fixtures install @angular/language-service AND typescript, so all four combinations resolve
// something here - which is why lsp-negative's healthy control already runs with identical paths.
// The case fact 3 is really about is a location where the language service is absent.
if (runs(3)) {
  console.log('\n=== 3. Fact 3: identical probe locations ===');
  const projectDir = resolve('fixtures/v17');
  const core = coreVersion(projectDir);
  const document = 'src/app/standalone-probe.component.ts';
  const serverModules = join(LS22, 'node_modules');
  const projectModules = join(projectDir, 'node_modules');
  const barren = join(projectDir, 'src');
  const cases = [
    { name: 'ng=server, ts=project (what the product ships)', ng: serverModules, ts: projectModules },
    { name: 'ng=server, ts=server   (identical)', ng: serverModules, ts: serverModules },
    { name: 'ng=project, ts=project (identical)', ng: projectModules, ts: projectModules },
    { name: 'ng=project, ts=server  (swapped)', ng: projectModules, ts: serverModules },
    { name: 'ng=a folder with no language service', ng: barren, ts: projectModules },
  ];
  for (const item of cases) {
    const report = await ask({
      ngProbe: item.ng,
      tsProbe: item.ts,
      extra: ['--angularCoreVersion', core],
      projectDir,
      document,
    });
    console.log(`  ${item.name}`);
    console.log(
      `      initialize ${report.initialize}, project load ${report.projectLoad ?? '-'}, ` +
        `diagnostics ${report.diagnostics ?? 'no push'}, process ${report.exit}`,
    );
    if (report.stderr?.length) {
      console.log(`      stderr: ${report.stderr.join(' | ')}`);
    }
  }
}

// --- 4. The same question asked of the project's own compiler ----------------------------------

// Section 1 measures the shipped server: one branch, 22.0.8, for every project. ng_workspace_map
// describes what the project's build does, and only the project's own ngc can answer that.
if (runs(4)) {
  console.log("\n=== 4. strictTemplates default, asked of each project's own ngc ===");
  for (const version of versions) {
    const projectDir = resolve('fixtures', version);
    const core = coreVersion(projectDir);
    const major = Number(core.split('.')[0]);
    const cliDir = join(projectDir, 'node_modules', '@angular', 'compiler-cli');
    const cliPkg = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'));
    const binRel = typeof cliPkg.bin === 'string' ? cliPkg.bin : cliPkg.bin?.ngc;
    const seen = {};
    try {
      for (const strict of [true, null, false]) {
        writeProbe(projectDir, major, strict);
        const run = spawnSync(
          process.execPath,
          [join(cliDir, binRel), '-p', `${PROBE_DIR}/tsconfig.json`, '--noEmit'],
          { cwd: projectDir, encoding: 'utf8', timeout: 300_000 },
        );
        const listing = `${run.stdout ?? ''}${run.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/g, '');
        seen[String(strict)] = {
          // 2322 is the assignability error the probe provokes; anything else is the probe misfiring.
          hit: /error (?:NG|TS)2322/.test(listing),
          codes: [...new Set(listing.match(/error (?:NG|TS)\d+/g) ?? [])].join(', '),
          exit: run.status,
        };
      }
    } finally {
      rmSync(join(projectDir, PROBE_DIR), { recursive: true, force: true });
    }
    let verdict;
    if (!seen.true.hit) {
      verdict = `PROBE BROKEN - written true found no 2322 (${seen.true.codes || 'clean'})`;
    } else if (seen.false.hit) {
      verdict = 'PROBE BROKEN - written false still errors';
    } else {
      verdict = seen.null.hit ? 'default is ON' : 'default is OFF';
    }
    console.log(`${version} (${core}): ${verdict}`);
    for (const [label, key] of [['written true ', 'true'], ['not written  ', 'null'], ['written false', 'false']]) {
      console.log(`      ${label}: exit ${seen[key].exit}, ${seen[key].codes || 'no errors'}`);
    }
  }
}
