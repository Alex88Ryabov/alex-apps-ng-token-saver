// Section 5 benchmark, scenario 2: 'what does this component accept' - reading the whole file
// versus ng_component_info. It goes through a real MCP client, so it measures what an agent gets.
// Characters by default; with --tokens it also counts tokens through the o200k_base proxy
// (Claude's own tokenizer is private - see tools/token-count.mjs for the caveats).
//
//   node tools/bench-contract.mjs <project root> [more roots...] [--tokens]

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadTokenizers } from './token-count.mjs';

const SKIP = new Set(['node_modules', 'dist', '.git', '.angular', '.nx', 'coverage', 'out-tsc', 'tmp']);

function findComponents(root, limit) {
  const found = [];
  const walk = (dir) => {
    if (found.length >= limit) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) {
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) {
          walk(full);
        }
      } else if (entry.name.endsWith('.component.ts') && !entry.name.endsWith('.spec.ts')) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

const percentile = (sorted, share) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];

const roots = process.argv.slice(2).filter((item) => item !== '--tokens');
if (roots.length === 0) {
  console.error('pass at least one project root');
  process.exit(1);
}
const counters = process.argv.includes('--tokens') ? await loadTokenizers() : null;
if (counters) {
  console.log(`tokenizer: gpt-tokenizer ${counters.version}, o200k_base proxy (Claude's tokenizer is private)`);
}

const client = new Client({ name: 'bench-contract', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/index.js')],
    env: process.env,
  }),
);

for (const root of roots) {
  const files = findComponents(resolve(root), 2000);
  console.log(`\n=== ${root}\n    component files found: ${files.length}`);
  const rows = [];
  let failed = 0;
  let notComponent = 0;
  let multiClass = 0;
  let firstMs = null;

  for (const file of files) {
    const started = Date.now();
    let text;
    try {
      const response = await client.callTool({ name: 'ng_component_info', arguments: { file } }, undefined, {
        timeout: 180_000,
      });
      text = response.content?.[0]?.text ?? '';
      if (response.isError) {
        failed += 1;
        if (failed === 1) {
          console.log(`    first error: ${text.slice(0, 200)}`);
        }
        continue;
      }
    } catch (error) {
      failed += 1;
      continue;
    }
    firstMs ??= Date.now() - started;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // One unreadable answer must not abort the run and take the whole tally with it.
      failed += 1;
      continue;
    }
    if (!parsed.found) {
      notComponent += 1;
      continue;
    }
    if (parsed.others) {
      // The contract covers the first class while the file length covers all of them: wrong denominator.
      multiClass += 1;
      continue;
    }
    const sourceText = readFileSync(file, 'utf8');
    rows.push({
      file,
      source: sourceText.length,
      contract: text.length,
      sourceTokens: counters ? counters.o200k(sourceText) : 0,
      contractTokens: counters ? counters.o200k(text) : 0,
      sourceCl: counters ? counters.cl100k(sourceText) : 0,
      contractCl: counters ? counters.cl100k(text) : 0,
      members: parsed.inputs.length + parsed.outputs.length + parsed.publicMembers.length,
      incomplete: typeof parsed.incomplete === 'string',
    });
  }

  if (rows.length === 0) {
    console.log(`    nothing could be parsed (errors: ${failed})`);
    continue;
  }

  const ratios = rows.map((row) => row.contract / row.source).sort((a, b) => a - b);
  const sourceTotal = rows.reduce((sum, row) => sum + row.source, 0);
  const contractTotal = rows.reduce((sum, row) => sum + row.contract, 0);
  const smaller = rows.filter((row) => row.contract < row.source);
  const bySource = [...rows].sort((a, b) => b.source - a.source);

  console.log(`    in the tally: ${rows.length}, errors: ${failed}, not a component: ${notComponent}, ` +
    `several classes in one file (excluded): ${multiClass}, first call ${firstMs} ms`);
  console.log(`    totals: sources ${sourceTotal} chars, contracts ${contractTotal} chars ` +
    `(${Math.round((1 - contractTotal / sourceTotal) * 100)}% saved)`);
  console.log(`    components where the contract is shorter than the source: ${smaller.length}/${rows.length}`);
  console.log(`    flagged as partial (base class or host directives): ${rows.filter((row) => row.incomplete).length}`);
  console.log(`    contract/source ratio - median ${percentile(ratios, 0.5).toFixed(2)}, ` +
    `p10 ${percentile(ratios, 0.1).toFixed(2)}, p90 ${percentile(ratios, 0.9).toFixed(2)}`);
  if (counters) {
    const sourceTok = rows.reduce((sum, row) => sum + row.sourceTokens, 0);
    const contractTok = rows.reduce((sum, row) => sum + row.contractTokens, 0);
    const sourceCl = rows.reduce((sum, row) => sum + row.sourceCl, 0);
    const contractCl = rows.reduce((sum, row) => sum + row.contractCl, 0);
    const tokenRatios = rows.map((row) => row.contractTokens / row.sourceTokens).sort((a, b) => a - b);
    console.log(`    tokens o200k_base: sources ${sourceTok}, contracts ${contractTok} ` +
      `(${Math.round((1 - contractTok / sourceTok) * 100)}% saved); ` +
      `cl100k_base saving ${Math.round((1 - contractCl / sourceCl) * 100)}%`);
    console.log(`    token ratio o200k - median ${percentile(tokenRatios, 0.5).toFixed(2)}, ` +
      `p10 ${percentile(tokenRatios, 0.1).toFixed(2)}, p90 ${percentile(tokenRatios, 0.9).toFixed(2)}`);
  }
  console.log('    ten largest components:');
  for (const row of bySource.slice(0, 10)) {
    const name = row.file.slice(resolve(root).length + 1);
    console.log(`      ${String(row.source).padStart(6)} -> ${String(row.contract).padStart(5)} chars ` +
      `(${(row.contract / row.source).toFixed(2)}, members ${row.members})  ${name}`);
  }
}

await client.close();
