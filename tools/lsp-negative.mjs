// Negative cases from section 9: what exactly the server returns when things go wrong.
// The question is whether a malfunction can be told from an honest 'no such symbol'.
//
//   node tools/lsp-negative.mjs

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, startServer, uriKey, flattenHover } from './lsp-client.mjs';

const V17 = resolve('fixtures/v17');
const V17_MODULES = join(V17, 'node_modules');
const LS17 = resolve('tools/servers/ls17');
const LS22 = resolve('tools/servers/ls22');

// A known-valid position in the v17 template: {{ greeting }}. It doubles as the canary.
const CANARY = { line: 1, character: 11 };

async function scenario({ name, server, project, probe, document, positions }) {
  const started = Date.now();
  const child = startServer(server, project, probe);
  const client = new Client(child);
  const exit = { code: null, at: null };
  child.on('exit', (code) => {
    exit.code = code;
    exit.at = Date.now() - started;
  });

  const init = await Promise.race([
    client.initialize(project),
    new Promise((r) => setTimeout(() => r({ error: { message: 'timeout 12000ms' } }), 12000)),
  ]);
  const report = { name, initialize: null, projectLoad: null, probes: [], diagnostics: null };

  if (init.error) {
    report.initialize = `ERROR: ${init.error.message ?? JSON.stringify(init.error)}`;
    report.exit = exit.code === null ? 'process alive' : `process exited with code ${exit.code} after ${exit.at} ms`;
    report.stderr = client.stderr.join('').split('\n').filter(Boolean).slice(0, 3);
    child.kill();
    return report;
  }

  report.initialize = 'ok';
  client.notify('initialized', {});

  const path = join(project, document);
  const uri = pathToFileURL(path).href;
  client.didOpen(path, document.endsWith('.ts') ? 'typescript' : 'html', readFileSync(path, 'utf8'));

  report.projectLoad = (await client.waitForProjectLoad(12000)) ? 'arrived' : 'NEVER arrived';
  await new Promise((r) => setTimeout(r, 900));

  // As in the product: template first, companion next, and the companion stays open.
  const companion = path.replace(/\.html$/, '.ts');
  if (path.endsWith('.html') && existsSync(companion)) {
    client.didOpen(companion, 'typescript', readFileSync(companion, 'utf8'));
    await new Promise((r) => setTimeout(r, 900));
  }

  for (const position of positions) {
    const def = await client.request(
      'textDocument/definition',
      { textDocument: { uri }, position: position.at },
      12000,
    );
    const hover = await client.request(
      'textDocument/hover',
      { textDocument: { uri }, position: position.at },
      12000,
    );
    report.probes.push({
      what: position.what,
      definition: def.error ? `ERROR: ${def.error.message}` : describe(def.result),
      hover: hover.error ? `ERROR: ${hover.error.message}` : (flattenHover(hover.result) ?? 'null'),
    });
  }

  await client.waitForQuiet(700, 8000);
  const list = client.diagnostics.get(uriKey(path));
  report.diagnostics = list === undefined ? 'no push arrived' : `${list.length} item(s)`;
  report.exit = exit.code === null ? 'process alive' : `process exited with code ${exit.code}`;
  report.stderr = client.stderr.join('').split('\n').filter(Boolean).slice(0, 3);

  child.kill();
  return report;
}

function describe(result) {
  if (result === null || result === undefined) {
    return 'null';
  }
  if (Array.isArray(result) && result.length === 0) {
    return 'empty array';
  }
  return `present (${Array.isArray(result) ? result.length : 1})`;
}

const SCENARIOS = [
  {
    name: '1. No node_modules',
    server: LS22,
    project: resolve('fixtures/negative/no-node-modules'),
    probe: join(resolve('fixtures/negative/no-node-modules'), 'node_modules'),
    document: 'src/app/user-card.component.html',
    positions: [{ what: 'canary {{ greeting }}', at: CANARY }],
  },
  {
    name: '2. Broken tsconfig',
    server: LS22,
    project: resolve('fixtures/negative/broken-tsconfig'),
    probe: V17_MODULES,
    document: 'src/app/user-card.component.html',
    positions: [{ what: 'canary {{ greeting }}', at: CANARY }],
  },
  {
    name: '3. File outside any project',
    server: LS22,
    project: resolve('fixtures/negative/orphan'),
    probe: V17_MODULES,
    document: 'src/app/user-card.component.html',
    positions: [{ what: 'canary {{ greeting }}', at: CANARY }],
  },
  {
    name: '4. Position outside a symbol (healthy server)',
    server: LS22,
    project: V17,
    probe: V17_MODULES,
    document: 'src/app/user-card.component.html',
    positions: [
      { what: 'canary {{ greeting }}', at: CANARY },
      { what: 'whitespace in markup', at: { line: 1, character: 1 } },
      { what: 'text of the <h2> tag', at: { line: 1, character: 3 } },
      { what: 'a line past the end of file', at: { line: 99, character: 0 } },
    ],
  },
  {
    name: '5. Server branch older than the project (17 against v22, control)',
    server: LS17,
    project: resolve('fixtures/v22'),
    probe: join(resolve('fixtures/v22'), 'node_modules'),
    document: 'src/app/user-card.component.html',
    positions: [{ what: 'canary {{ greeting }}', at: CANARY }],
  },
];

for (const item of SCENARIOS) {
  const report = await scenario(item);
  console.log(`\n=== ${report.name} ===`);
  console.log(`  initialize        : ${report.initialize}`);
  console.log(`  projectLoadingFinish: ${report.projectLoad ?? '-'}`);
  for (const probe of report.probes) {
    console.log(`  ${probe.what}`);
    console.log(`      definition: ${probe.definition}`);
    console.log(`      hover     : ${probe.hover}`);
  }
  console.log(`  diagnostics       : ${report.diagnostics ?? '-'}`);
  console.log(`  process           : ${report.exit}`);
  if (report.stderr?.length) {
    console.log(`  stderr            : ${report.stderr.join(' | ')}`);
  }
}
