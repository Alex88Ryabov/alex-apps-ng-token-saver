// End-to-end check of the MCP server with a real MCP client over stdio.
// The position is picked from the first interpolation in the template.
//
//   node tools/mcp-smoke.mjs <path-to-template.html> [more templates...]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const templates = process.argv.slice(2);
if (templates.length === 0) {
  templates.push('fixtures/v17/src/app/user-card.component.html');
}

function firstInterpolation(text) {
  const lines = text.split(/\r?\n/);
  for (let line = 0; line < lines.length; line += 1) {
    const match = /\{\{\s*([A-Za-z_$][\w$]*)/.exec(lines[line]);
    if (match) {
      return { line, character: match.index + match[0].indexOf(match[1]) + 1, name: match[1] };
    }
  }
  return null;
}

const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/index.js')],
    env: process.env,
  }),
);

// What every session pays before the first call: instructions always, descriptions unless the
// client defers tools.
const { tools } = await client.listTools();
const described = tools.reduce((sum, tool) => sum + (tool.description ?? '').length, 0);
const withParams = tools.reduce(
  (sum, tool) =>
    sum +
    Object.values(tool.inputSchema?.properties ?? {}).reduce(
      (acc, item) => acc + (item.description ?? '').length,
      0,
    ),
  described,
);
console.log(
  `instructions ${client.getInstructions()?.length ?? 0} chars; ${tools.length} tools, ` +
    `descriptions ${described} chars, with parameters ${withParams}`,
);

const call = async (name, args) => {
  const started = Date.now();
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  return { ms: Date.now() - started, text: response.content?.[0]?.text ?? '' };
};

for (const item of templates) {
  const file = resolve(item);
  const target = firstInterpolation(readFileSync(file, 'utf8'));
  console.log(`\n=== ${file}`);
  if (!target) {
    console.log('  no interpolations, skipping');
    continue;
  }
  // The agent's view of the position: the line as Read numbers it, the symbol by name.
  const definition = await call('ng_template_definition', {
    file,
    line: target.line + 1,
    symbol: target.name,
  });
  console.log(`  {{ ${target.name} }} (${definition.ms} ms, ${definition.text.length} chars)`);
  console.log(`    ${definition.text.slice(0, 240)}`);
  const diagnostics = await call('ng_template_diagnostics', { file });
  console.log(`  diagnostics (${diagnostics.ms} ms)`);
  console.log(`    ${diagnostics.text.slice(0, 240)}`);
  const info = await call('ng_component_info', { file });
  const source = readFileSync(file.replace(/\.html$/, '.ts'), 'utf8').length;
  console.log(`  contract (${info.ms} ms, ${info.text.length} chars versus ${source} in the .ts)`);
  console.log(`    ${info.text.slice(0, 400)}`);
}

const batch = await call('ng_template_diagnostics', { files: templates.map((item) => resolve(item)) });
console.log(`\n=== batch diagnostics over ${templates.length} file(s) (${batch.ms} ms)`);
console.log(`  ${batch.text.slice(0, 240)}`);

// The three tools that never start the language server, on the first template's workspace.
const first = resolve(templates[0]);
for (const [name, args] of [
  ['ng_workspace_map', { path: first }],
  ['ng_version_rules', { path: first, topic: 'signals' }],
  ['ng_find_usages', { selectorOrFile: first.replace(/\.html$/, '.ts'), limit: 3 }],
]) {
  const answer = await call(name, args);
  console.log(`\n=== ${name} (${answer.ms} ms, ${answer.text.length} chars)`);
  console.log(`  ${answer.text.slice(0, 240)}`);
}

await client.close();
