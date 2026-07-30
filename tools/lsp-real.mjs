// A probe against a production project. Read-only: it opens templates through the LSP one by
// one, as the MCP server would on an agent request, and measures resolution, diagnostics and latency.
//
//   node tools/lsp-real.mjs --server tools/servers/ls22 --root <root> --scan <folder>

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Client,
  startServer,
  serverModules,
  parseArgs,
  uriKey,
  flattenHover,
} from './lsp-client.mjs';

const SKIP = new Set(['node_modules', 'dist', '.git', '.angular', '.nx', 'coverage', 'out-tsc']);

function findTemplates(dir, acc, limit) {
  if (acc.length >= limit) {
    return acc;
  }
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (acc.length >= limit) {
      return acc;
    }
    const full = join(dir, entry);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      if (!SKIP.has(entry)) {
        findTemplates(full, acc, limit);
      }
      continue;
    }
    // Only templates that have a component next to them.
    if (entry.endsWith('.component.html') || entry.endsWith('.page.html')) {
      const companion = full.replace(/\.html$/, '.ts');
      try {
        statSync(companion);
        acc.push(full);
      } catch {
        continue;
      }
    }
  }
  return acc;
}

// Positions are picked from the markup: interpolations and event handlers.
function pickPositions(text, perFile) {
  const lines = text.split(/\r?\n/);
  const found = [];
  for (let line = 0; line < lines.length && found.length < perFile; line += 1) {
    const content = lines[line];
    const interpolation = /\{\{\s*([A-Za-z_$][\w$]*)/.exec(content);
    if (interpolation) {
      found.push({
        what: `{{ ${interpolation[1]} }}`,
        at: { line, character: interpolation.index + interpolation[0].indexOf(interpolation[1]) + 1 },
      });
      continue;
    }
    const handler = /\((\w+)\)="\s*([A-Za-z_$][\w$]*)/.exec(content);
    if (handler) {
      found.push({
        what: `(${handler[1]})="${handler[2]}"`,
        at: { line, character: handler.index + handler[0].indexOf(handler[2], handler[1].length) + 1 },
      });
    }
  }
  return found;
}

const args = parseArgs(process.argv.slice(2), {
  files: 12,
  perFile: 4,
  openDelay: 800,
  loadTimeout: 180000,
  diagWait: 15000,
});

const root = resolve(args.root);
const scan = resolve(args.scan ?? args.root);
const templates = findTemplates(scan, [], Number(args.files));

console.log(`server    : ${args.server}`);
console.log(`root      : ${root}`);
console.log(`scan      : ${scan}`);
console.log(`templates : ${templates.length}\n`);

const startedAt = Date.now();
const child = startServer(resolve(args.server), root, {
  ng: serverModules(resolve(args.server)),
  ts: join(root, 'node_modules'),
});
const client = new Client(child);
child.on('exit', (code) => {
  console.log(`\n!! server process exited with code ${code} after ${Date.now() - startedAt} ms`);
});

const init = await client.initialize(root);
if (init.error) {
  console.log(`initialize ERROR: ${JSON.stringify(init.error)}`);
  process.exit(1);
}
client.notify('initialized', {});

let coldStartMs = null;
let totalTargets = 0;
let resolved = 0;
const latencies = [];
const rows = [];

for (const path of templates) {
  const text = readFileSync(path, 'utf8');
  const positions = pickPositions(text, Number(args.perFile));
  const uri = pathToFileURL(path).href;
  const key = uriKey(path);
  const openedAt = Date.now();

  // The companion is opened first: in a monorepo it can pull the component into a project.
  if (args.openCompanion === 'true') {
    const companion = path.replace(/\.html$/, '.ts');
    client.didOpen(companion, 'typescript', readFileSync(companion, 'utf8'));
    await new Promise((r) => setTimeout(r, Number(args.openDelay)));
  }

  client.didOpen(path, 'html', text);

  if (coldStartMs === null) {
    const loaded = await client.waitForProjectLoad(Number(args.loadTimeout));
    coldStartMs = Date.now() - startedAt;
    console.log(`projectLoadingFinish: ${loaded ? 'arrived' : 'NEVER arrived'} in ${coldStartMs} ms\n`);
  } else {
    await new Promise((r) => setTimeout(r, Number(args.openDelay)));
  }

  let fileResolved = 0;
  const detail = [];
  for (const position of positions) {
    const at = Date.now();
    const def = await client.request(
      'textDocument/definition',
      { textDocument: { uri }, position: position.at },
      30000,
    );
    const hover = await client.request(
      'textDocument/hover',
      { textDocument: { uri }, position: position.at },
      30000,
    );
    latencies.push(Date.now() - at);
    totalTargets += 1;
    const text = hover.error ? null : flattenHover(hover.result);
    const hasDefinition = !def.error && def.result && (!Array.isArray(def.result) || def.result.length > 0);
    if (text && hasDefinition) {
      fileResolved += 1;
      resolved += 1;
    }
    detail.push(`      ${position.what} line ${position.at.line + 1} -> ${text ?? 'EMPTY'}`);
  }

  await client.waitUntil(() => client.diagnostics.has(key), Number(args.diagWait));
  const list = client.diagnostics.get(key);
  const diagMs = client.log.find((e) => e.key === key)?.at;

  rows.push({
    file: relative(root, path),
    targets: positions.length,
    resolved: fileResolved,
    diagnostics: list === undefined ? 'no push' : `${list.length}`,
    diagMs: diagMs ? diagMs - openedAt : null,
    // Details are printed only where something went wrong.
    detail: fileResolved < positions.length || (list?.length ?? 0) > 0 ? detail : null,
    messages: (list ?? []).map((d) => `      line ${d.range.start.line + 1}: NG${d.code} ${d.message}`),
  });

  client.notify('textDocument/didClose', { textDocument: { uri } });
}

console.log('file (resolved / targets, diagnostics, push after):');
for (const row of rows) {
  console.log(
    `  ${row.resolved}/${row.targets}  diag ${row.diagnostics}` +
      `${row.diagMs === null ? '' : ` @${row.diagMs}ms`}  ${row.file}`,
  );
  if (row.detail) {
    row.detail.forEach((line) => console.log(line));
    row.messages.forEach((line) => console.log(line));
  }
}

const sorted = [...latencies].sort((a, b) => a - b);
console.log(`\ntotal resolved : ${resolved}/${totalTargets}`);
console.log(`cold start     : ${coldStartMs} ms`);
console.log(
  `definition+hover latency: median ${sorted[Math.floor(sorted.length / 2)]} ms, ` +
    `max ${sorted[sorted.length - 1]} ms`,
);
const stderr = client.stderr.join('').split('\n').filter(Boolean);
if (stderr.length) {
  console.log(`stderr: ${stderr.slice(0, 5).join(' | ')}`);
}

child.kill();
