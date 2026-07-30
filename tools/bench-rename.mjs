// Section 5, scenario 1: 'rename input X to Y across all usages' - the grep path against
// the bridge. Neither path performs the rename: measured is the information cost of
// LOCATING the binding sites.
//
// Both sides answer at the same depth: ng_find_usages takes the input name and returns
// only the tag usages that bind it, each entry pointing at the binding itself. What still
// differs is attribution, and it favours the bridge in correctness, not in the count
// below: the grep's binding lines are repo-wide and unattributed, the bridge's are scoped
// to this component's tags.
//
// The grep path an agent actually takes: read the component file - the selector and the
// input live there - then grep the workspace for the selector and for the binding
// spellings of the input. Its cost: the whole file plus every matched line in
// file:line:text form, exactly what a grep tool returns. The bridge path:
// ng_component_info (selector and inputs arrive parsed) plus ng_find_usages with `input`.
//
//   node tools/bench-rename.mjs <componentFile> <inputName>

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { locateProject } from '../dist/lsp/workspace.js';
import { loadTokenizers } from './token-count.mjs';

const componentFile = resolve(process.argv[2] ?? '');
const input = process.argv[3];
if (!process.argv[2] || !input) {
  console.error('usage: node tools/bench-rename.mjs <componentFile> <inputName>');
  process.exit(1);
}

const counters = await loadTokenizers();
console.log(`tokenizer: gpt-tokenizer ${counters.version}, o200k_base proxy (Claude's tokenizer is private)`);

const root = locateProject(componentFile).root;
const source = readFileSync(componentFile, 'utf8');
const selector = /selector:\s*['"`]([a-z][\w-]*)['"`]/.exec(source)?.[1];
if (!selector) {
  console.error('no element selector in the component file; this bench covers element selectors');
  process.exit(1);
}
console.log(`\ncomponent: ${relative(root, componentFile)}, selector <${selector}>, input [${input}]`);

// The same walk the tool uses: sources only, no node_modules or build output.
const SKIP = new Set(['node_modules', 'dist', '.git', '.angular', '.nx', 'coverage', 'out-tsc', 'tmp']);
const files = [];
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
      if (!SKIP.has(entry.name)) {
        walk(full);
      }
    } else if (/\.(html|ts)$/.test(entry.name)) {
      // .spec.ts stays in: the tool's own collectFiles does not exclude it either.
      files.push(full);
    }
  }
};
walk(root);

// grep output lines, exactly as a grep tool would print them: file:line:text.
const grepLines = (pattern) => {
  const out = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (pattern.test(lines[index])) {
        out.push(`${relative(root, file)}:${index + 1}:${lines[index].trim()}`);
      }
    }
  }
  return out;
};

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const selectorGrep = grepLines(new RegExp(`<${escape(selector)}(?![\\w-])`));
// [x]= and [(x)]= and the static x=" spelling: three greps an agent would need.
const bindingGrep = grepLines(
  new RegExp(`(?:\\[\\(?${escape(input)}\\)?\\]\\s*=|(?:^|[\\s"'(])${escape(input)}\\s*=\\s*")`),
);
const selectorFiles = new Set(selectorGrep.map((line) => line.split(':')[0]));
const noise = bindingGrep.filter((line) => !selectorFiles.has(line.split(':')[0]));

const baselineText = source + selectorGrep.join('\n') + bindingGrep.join('\n');
console.log(`\ngrep path (${files.length} files scanned):`);
console.log(`  component file: ${source.length} chars`);
console.log(`  selector grep: ${selectorGrep.length} lines, binding grep: ${bindingGrep.length} lines ` +
  `(${noise.length} of them in files without the selector - the agent cannot tell whose input that is)`);
console.log(`  total: ${baselineText.length} chars, ${counters.o200k(baselineText)} tokens o200k ` +
  `(${counters.cl100k(baselineText)} cl100k)`);

const client = new Client({ name: 'bench-rename', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js')], env: process.env }),
);
const call = async (name, args) => {
  const started = Date.now();
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  return { ms: Date.now() - started, text: response.content?.[0]?.text ?? '' };
};
const info = await call('ng_component_info', { file: componentFile });
const usages = await call('ng_find_usages', { selectorOrFile: componentFile, input, limit: 500 });
const bridgeText = info.text + usages.text;
let usageCount = null;
let note = '';
try {
  const parsed = JSON.parse(usages.text);
  usageCount = parsed.usages?.length ?? null;
  note = parsed.incomplete ?? '';
} catch {
  console.log(`  unparseable find-usages answer: ${usages.text.slice(0, 200)}`);
}
console.log(`\nbridge path:`);
console.log(`  ng_component_info: ${info.text.length} chars (${info.ms} ms), ` +
  `ng_find_usages: ${usages.text.length} chars (${usages.ms} ms), binding entries: ${usageCount ?? '?'}`);
if (note) {
  console.log(`  tool note: ${note}`);
}
console.log(`  total: ${bridgeText.length} chars, ${counters.o200k(bridgeText)} tokens o200k ` +
  `(${counters.cl100k(bridgeText)} cl100k)`);

console.log(
  `\nsaving: ${Math.round((1 - counters.o200k(bridgeText) / counters.o200k(baselineText)) * 100)}% tokens o200k, ` +
    `${Math.round((1 - bridgeText.length / baselineText.length) * 100)}% chars`,
);
await client.close();
