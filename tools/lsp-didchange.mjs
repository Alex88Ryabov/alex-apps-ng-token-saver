// Measuring diagnostics behaviour after didChange, which angular/projectLoadingFinish does not
// cover. Three scenarios: editing the template, editing the companion .ts, and checking whether
// a request round-trip works as a barrier.
//
//   node tools/lsp-didchange.mjs --server tools/servers/ls17 --project fixtures/v17

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Client, startServer, parseArgs, uriKey } from './lsp-client.mjs';

const args = parseArgs(process.argv.slice(2), { timeout: 30000 });
const projectDir = resolve(args.project);
const htmlPath = join(projectDir, 'src', 'app', 'user-card.component.html');
const tsPath = join(projectDir, 'src', 'app', 'user-card.component.ts');
const htmlKey = uriKey(`file:///${htmlPath.replace(/\\/g, '/')}`);

const htmlBroken = readFileSync(htmlPath, 'utf8');
const tsOriginal = readFileSync(tsPath, 'utf8');

const htmlFixed = htmlBroken
  .replace('user().emailAddress', 'user().fullName')
  .replace("onSelect('not-a-number')", 'onSelect(user().id)');

const tsWithEmail = tsOriginal.replace(
  'fullName: string;',
  'fullName: string;\n  emailAddress: string;',
);

function count() {
  return client.diagnostics.get(htmlKey)?.length ?? null;
}

let client = null;

async function boot() {
  const child = startServer(resolve(args.server), projectDir);
  client = new Client(child);
  await client.initialize(projectDir);
  client.notify('initialized', {});
  client.didOpen(htmlPath, 'html', htmlBroken);
  await client.waitForProjectLoad(Number(args.timeout));
  // The companion is opened after the template and kept open, exactly as the product does.
  await new Promise((r) => setTimeout(r, 900));
  client.didOpen(tsPath, 'typescript', tsOriginal);
  const ok = await client.waitUntil(() => count() === 2, Number(args.timeout));
  if (!ok) {
    throw new Error(`baseline diagnostics never arrived, got ${count()}`);
  }
  return child;
}

function report(label, t0, expected) {
  const pushes = client.pushesSince(t0, htmlKey);
  const hit = pushes.find((p) => p.count === expected);
  const sequence = pushes.map((p) => `${p.count} item(s) @${p.at - t0}ms`).join(' -> ') || 'nothing';
  console.log(`  ${label}`);
  console.log(`    pushes after the edit : ${sequence}`);
  console.log(`    to the expected state : ${hit ? `${hit.at - t0} ms` : 'NEVER ARRIVED'}`);
}

async function main() {
  console.log('=== A. Editing the template ===');
  let child = await boot();

  let t0 = Date.now();
  client.didChange(htmlPath, htmlFixed, 2);
  await client.waitUntil(() => count() === 0, 15000);
  report('2 errors -> 0 (the agent fixed the template)', t0, 0);

  t0 = Date.now();
  client.didChange(htmlPath, htmlBroken, 3);
  await client.waitUntil(() => count() === 2, 15000);
  report('0 -> 2 errors (the agent broke the template)', t0, 2);
  child.kill();

  console.log('\n=== B. Editing the companion .ts, template untouched ===');
  child = await boot();
  client.didOpen(tsPath, 'typescript', tsOriginal);
  await new Promise((r) => setTimeout(r, 1500));

  t0 = Date.now();
  client.didChange(tsPath, tsWithEmail, 2);
  const updated = await client.waitUntil(() => count() === 1, 15000);
  report('added emailAddress to UserVm, expecting 2 -> 1', t0, 1);
  console.log(`    template diagnostics refreshed: ${updated ? 'yes' : 'NO'}`);
  child.kill();

  console.log('\n=== C. A request round-trip as a barrier ===');
  child = await boot();

  t0 = Date.now();
  client.didChange(htmlPath, htmlFixed, 2);
  const response = await client.request('textDocument/hover', {
    textDocument: { uri: `file:///${htmlPath.replace(/\\/g, '/')}` },
    position: { line: 1, character: 11 },
  });
  const atResponse = count();
  const respMs = Date.now() - t0;
  await client.waitUntil(() => count() === 0, 15000);
  const pushes = client.pushesSince(t0, htmlKey);
  console.log(`  the hover answer came back in ${respMs} ms (errors: ${response.error ? 'yes' : 'no'})`);
  console.log(`  diagnostics state at answer time: ${atResponse} (expected 0 after the edit)`);
  console.log(`  first push after the edit: ${pushes.length > 0 ? `${pushes[0].at - t0} ms` : 'none'}`);
  console.log(
    `  verdict: a round-trip ${atResponse === 0 ? 'WORKS' : 'DOES NOT WORK'} as a diagnostics barrier`,
  );
  child.kill();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
