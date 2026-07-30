// Resolution and diagnostics probes described by <fixture>/probes.json.
// The client lives in ./lsp-client.mjs.
//
//   node tools/lsp-probe.mjs --server tools/servers/ls17 --project fixtures/v17

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Client,
  startServer,
  parseArgs,
  uriKey,
  flattenHover,
  flattenDefinition,
} from './lsp-client.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2), { timeout: 60000, diagWait: 8000, openDelay: 800 });
  const projectDir = resolve(args.project);
  // Probes are described inside the fixture: templates and layouts differ per major.
  const spec = JSON.parse(readFileSync(join(projectDir, 'probes.json'), 'utf8'));

  const cases = spec.cases.map((entry) => {
    const path = join(projectDir, entry.document);
    const text = readFileSync(path, 'utf8');
    return { ...entry, path, text, uri: pathToFileURL(path).href, key: uriKey(path) };
  });

  const startedAt = Date.now();
  const child = startServer(resolve(args.server), projectDir);
  const client = new Client(child);

  const init = await client.initialize(projectDir);
  if (init.error) {
    console.log(JSON.stringify({ ok: false, stage: 'initialize', error: init.error }, null, 2));
    child.kill();
    process.exit(1);
  }

  client.notify('initialized', {});
  // Open one at a time: sent as a burst right after initialized, some didOpen are lost.
  // Templates go first: the server pulls in the companion itself if the .ts is not open (#2165).
  for (const item of [...cases].sort((a, b) => a.languageId.localeCompare(b.languageId))) {
    client.didOpen(item.path, item.languageId, item.text);
    if (args.openBarrier === 'true') {
      await client.request('textDocument/hover', {
        textDocument: { uri: item.uri },
        position: { line: 0, character: 0 },
      });
      continue;
    }
    await new Promise((r) => setTimeout(r, Number(args.openDelay)));
  }

  const loaded = await client.waitForProjectLoad(Number(args.timeout));
  const coldStartMs = Date.now() - startedAt;

  const results = [];
  for (const item of cases) {
    const lines = item.text.split(/\r?\n/);
    const targets = [];
    for (const target of item.targets) {
      const lineText = lines[target.line] ?? '';
      const found = lineText.indexOf(target.needle);
      if (found === -1) {
        targets.push({ target: target.name, error: `substring "${target.needle}" not found` });
        continue;
      }
      const position = { line: target.line, character: found + target.offset };
      const def = await client.request('textDocument/definition', {
        textDocument: { uri: item.uri },
        position,
      });
      const hover = await client.request('textDocument/hover', {
        textDocument: { uri: item.uri },
        position,
      });
      targets.push({
        target: target.name,
        definition: def.error ? null : flattenDefinition(def.result, projectDir),
        hover: hover.error ? null : flattenHover(hover.result),
      });
    }
    results.push({ name: item.name, document: item.document, targets });
  }

  // Diagnostics arrive as pushes per document at uneven times, so we wait for silence.
  await client.waitUntil(
    () => cases.every((item) => client.diagnostics.has(item.key)),
    Number(args.diagWait),
  );
  await client.waitForQuiet(700, Number(args.diagWait));

  for (const item of results) {
    const found = cases.find((entry) => entry.name === item.name);
    item.resolved = `${item.targets.filter((t) => t.hover).length}/${item.targets.length}`;
    item.diagnostics = (client.diagnostics.get(found.key) ?? []).map((d) => ({
      line: d.range.start.line + 1,
      code: d.code,
      message: d.message,
    }));
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        server: args.server,
        project: args.project,
        projectLoadingFinish: loaded,
        coldStartMs,
        cases: results,
        pushLog: client.log.map(
          (e) => `${e.key.split(/[\\/]/).slice(-1)[0]} ${e.count} @${e.at - startedAt}ms`,
        ),
        stderr: client.stderr.join('').split('\n').filter(Boolean).slice(0, 20),
      },
      null,
      2,
    ),
  );

  client.notify('exit', {});
  child.kill();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
