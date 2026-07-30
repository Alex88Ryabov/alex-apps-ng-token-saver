// Where the 'standalone by default' boundary sits: we ask the server rather than the docs.
// Every fixture holds the same standalone-probe.component.ts with no standalone flag but with
// imports. Below the boundary that is a compiler error, above it a valid component.
//
//   node tools/probe-standalone.mjs [v17 v18 v19 v20 v21 v22]

import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const versions = process.argv.slice(2);
if (versions.length === 0) {
  versions.push('v17', 'v18', 'v19', 'v20');
}

const client = new Client({ name: 'standalone-probe', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/index.js')],
    env: process.env,
  }),
);

// A failed call must not be replaced by an empty result: 'no errors' and 'the tool failed' would
// look identical, and the benchmark would falsely confirm the hypothesis.
const call = async (name, file) => {
  const response = await client.callTool({ name, arguments: { file } }, undefined, {
    timeout: 180_000,
  });
  const parsed = JSON.parse(response.content?.[0]?.text ?? '{}');
  if (response.isError) {
    throw new Error(`${name} failed: ${parsed.error ?? 'no description'} / ${parsed.hint ?? ''}`);
  }
  return parsed;
};

for (const version of versions) {
  const file = resolve('fixtures', version, 'src/app/standalone-probe.component.ts');
  const { diagnostics = [] } = await call('ng_template_diagnostics', file);
  const info = await call('ng_component_info', file);
  // Severity matters: a deprecation hint and a real error arrive in the same list.
  const verdict =
    diagnostics.length === 0
      ? 'no errors'
      : diagnostics.map((d) => `[severity ${d.severity}] ${d.code}: ${d.message}`).join(' | ');
  console.log(`${version}: ${verdict}`);
  console.log(`      the contract says standalone=${info.standalone}`);
}

await client.close();
