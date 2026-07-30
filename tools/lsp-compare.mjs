// Comparing a working and a non-working component on one server: what the server sees in the
// .ts, what it sees in the .html, and whether the .ts itself gets diagnostics.
//
//   node tools/lsp-compare.mjs --server tools/servers/ls19 --root <root> --list a.ts,b.ts

import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Client,
  startServer,
  serverModules,
  parseArgs,
  uriKey,
  flattenHover,
} from './lsp-client.mjs';

const args = parseArgs(process.argv.slice(2), { openDelay: 900, loadTimeout: 180000 });
const root = resolve(args.root);
const files = args.list.split(',').map((item) => resolve(root, item.trim()));

function classPosition(text) {
  const lines = text.split(/\r?\n/);
  for (let line = 0; line < lines.length; line += 1) {
    const match = /export class (\w+)/.exec(lines[line]);
    if (match) {
      return { line, character: match.index + match[0].indexOf(match[1]) + 2, name: match[1] };
    }
  }
  return null;
}

function templatePositions(text, limit) {
  const lines = text.split(/\r?\n/);
  const found = [];
  const seen = new Set();
  for (let line = 0; line < lines.length && found.length < limit; line += 1) {
    const match = /\{\{\s*([A-Za-z_$][\w$]*)/.exec(lines[line]);
    if (match && !seen.has(match[1])) {
      seen.add(match[1]);
      found.push({ line, character: match.index + match[0].indexOf(match[1]) + 1, name: match[1] });
    }
  }
  return found;
}

const child = startServer(
  resolve(args.server),
  root,
  {
    ng: serverModules(resolve(args.server)),
    ts: args.tsProbe ? resolve(args.tsProbe) : resolve(root, 'node_modules'),
  },
  [
    ...(args.logFile ? ['--logFile', resolve(args.logFile), '--logVerbosity', 'verbose'] : []),
    ...(args.coreVersion ? ['--angularCoreVersion', args.coreVersion] : []),
    ...(args.logToConsole === 'true' ? ['--logToConsole'] : []),
  ],
);
const client = new Client(child);
await client.initialize(root);
client.notify('initialized', {});

let first = true;
for (const tsPath of files) {
  const htmlPath = tsPath.replace(/\.ts$/, '.html');
  const tsText = readFileSync(tsPath, 'utf8');
  const htmlText = readFileSync(htmlPath, 'utf8');

  // htmlOnly=true does not open the companion: the server has its own recovery path, and it only
  // kicks in when the client has not opened the .ts yet (fix #2165).
  if (args.htmlOnly !== 'true') {
    client.didOpen(tsPath, 'typescript', tsText);
    if (first) {
      await client.waitForProjectLoad(Number(args.loadTimeout));
      first = false;
    }
    await new Promise((r) => setTimeout(r, Number(args.openDelay)));
  }
  client.didOpen(htmlPath, 'html', htmlText);
  if (first) {
    await client.waitForProjectLoad(Number(args.loadTimeout));
    first = false;
  }
  await new Promise((r) => setTimeout(r, Number(args.openDelay)));

  if (args.settle) {
    await new Promise((r) => setTimeout(r, Number(args.settle)));
  }

  const cls = classPosition(tsText);
  const targets = templatePositions(htmlText, 8);

  console.log(`\n=== ${relative(root, tsPath)}  (class ${cls?.name})`);
  for (const target of targets) {
    const hover = await client.request('textDocument/hover', {
      textDocument: { uri: pathToFileURL(htmlPath).href },
      position: { line: target.line, character: target.character },
    });
    const flat = flattenHover(hover.result);
    console.log(`  {{ ${target.name} }} line ${target.line + 1} -> ${flat ?? 'EMPTY'}`);
    if (!flat) {
      console.log(`      raw result: ${JSON.stringify(hover.result)?.slice(0, 300) ?? 'no result'}`);
      console.log(`      raw error: ${JSON.stringify(hover.error) ?? 'none'}`);
    }
  }

  await client.waitForQuiet(700, 8000);
  const htmlDiag = client.diagnostics.get(uriKey(htmlPath));
  console.log(`  .html diagnostics: ${htmlDiag === undefined ? 'no push' : `${htmlDiag.length} item(s)`}`);
}

child.kill();
