// Section 5, scenario 3: 'why does the template not compile?'
// Baseline: the compiler listing an agent reads after a build. Measured with ngc - the
// template-checking core of ng build - because the fixtures carry no builder; that makes
// the baseline a conservative lower bound (a real ng build prints strictly more around
// the same errors). The bridge: one ng_template_diagnostics call through a real MCP
// client. Neither path writes anything: ngc runs with --noEmit.
//
//   node tools/bench-diagnose.mjs [projectRoot] [templateRel] [tsconfigRel]
//   defaults: fixtures/v17 src/app/user-card.component.html tsconfig.bench.json
// tsconfig.bench.json exists because the fixture's app tsconfig deliberately holds only
// main.ts, which imports nothing (brief section 2.5) - ngc would have an empty program.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadTokenizers } from './token-count.mjs';

const root = resolve(process.argv[2] ?? 'fixtures/v17');
const template = join(root, process.argv[3] ?? 'src/app/user-card.component.html');
const tsconfigRel = process.argv[4] ?? 'tsconfig.bench.json';

const counters = await loadTokenizers();
console.log(`tokenizer: gpt-tokenizer ${counters.version}, o200k_base proxy (Claude's tokenizer is private)`);

const cliDir = join(root, 'node_modules', '@angular', 'compiler-cli');
const cliPkg = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'));
const binRel = typeof cliPkg.bin === 'string' ? cliPkg.bin : cliPkg.bin?.ngc;
if (!binRel) {
  console.error('this project has no ngc in @angular/compiler-cli');
  process.exit(1);
}

const ngcStart = Date.now();
const run = spawnSync(
  process.execPath,
  [join(cliDir, binRel), '-p', tsconfigRel, '--noEmit'],
  { cwd: root, encoding: 'utf8', timeout: 300_000 },
);
const ngcMs = Date.now() - ngcStart;
// ANSI colour codes are stripped before counting: that only makes the baseline smaller.
const listing = `${run.stdout ?? ''}${run.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/g, '');
const errorsInListing = (listing.match(/error (?:NG|TS)\d+/g) ?? []).length;
console.log(`\nbaseline - ngc -p ${tsconfigRel} --noEmit, exit ${run.status}:`);
console.log(
  `  ${ngcMs} ms, ${listing.length} chars, ${counters.o200k(listing)} tokens o200k ` +
    `(${counters.cl100k(listing)} cl100k), ${errorsInListing} errors in the listing`,
);

const client = new Client({ name: 'bench-diagnose', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js')], env: process.env }),
);
const ask = async () => {
  const started = Date.now();
  const response = await client.callTool(
    { name: 'ng_template_diagnostics', arguments: { file: template } },
    undefined,
    { timeout: 180_000 },
  );
  return { ms: Date.now() - started, text: response.content?.[0]?.text ?? '' };
};
const cold = await ask();
const warm = await ask();
let diagnostics = 0;
try {
  diagnostics = JSON.parse(cold.text).diagnostics?.length ?? 0;
} catch {
  console.log(`  unparseable answer: ${cold.text.slice(0, 200)}`);
}
console.log(`\nbridge - ng_template_diagnostics on ${process.argv[3] ?? 'src/app/user-card.component.html'}:`);
console.log(
  `  cold ${cold.ms} ms, warm ${warm.ms} ms, ${cold.text.length} chars, ` +
    `${counters.o200k(cold.text)} tokens o200k (${counters.cl100k(cold.text)} cl100k), ${diagnostics} diagnostics`,
);
console.log(`  answer: ${cold.text.slice(0, 300)}`);

console.log(
  `\nsaving: ${Math.round((1 - counters.o200k(cold.text) / counters.o200k(listing)) * 100)}% tokens o200k, ` +
    `${Math.round((1 - cold.text.length / listing.length) * 100)}% chars; ` +
    `time ${ngcMs} ms (ngc) vs ${warm.ms} ms warm / ${cold.ms} ms cold`,
);
console.log(
  '  note: the ngc listing covers the whole project while the answer covers the asked file - ' +
    'that asymmetry IS the point: the agent asked about one template.',
);
await client.close();
