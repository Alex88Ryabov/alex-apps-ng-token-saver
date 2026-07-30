// Measures SETTLE_AFTER_OPEN_MS and RETRY_DELAY_MS instead of eyeballing them. A raw
// LspClient (no session retries in the way) opens the fixture template and its companion
// exactly like NgSession does - stagger included - waits a candidate settle and asks for a
// definition. An empty first answer is re-asked every 50 ms, which gives the recovery
// distribution that justifies the retry delay.
//
//   node tools/probe-settle.mjs [fixtureRoot] [trialsPerValue]
//   defaults: fixtures/v17, 6

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LspClient, serverBinFor } from '../dist/lsp/client.js';
import { describeWorkspace, firstInterpolation } from '../dist/lsp/workspace.js';

const root = resolve(process.argv[2] ?? 'fixtures/v17');
const trials = Number(process.argv[3] ?? 6);
const SETTLES = [0, 100, 200, 300, 450, 600];
const OPEN_STAGGER_MS = 800;

const template = resolve(root, 'src/app/user-card.component.html');
const companion = template.replace(/\.html$/, '.ts');
// The first interpolation, exactly like the canary: templates differ across the fixtures.
const position = firstInterpolation(readFileSync(template, 'utf8'));
if (!position) {
  console.error('no interpolation in the template');
  process.exit(1);
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const workspace = describeWorkspace(root, resolve('tools/servers'));

async function ask(client) {
  const outcome = await client.request('textDocument/definition', {
    textDocument: { uri: pathToFileURL(template).href },
    position,
  });
  const raw = outcome.result;
  return Array.isArray(raw) ? raw.length > 0 : Boolean(raw);
}

async function trial(settle) {
  const client = new LspClient({
    serverBin: serverBinFor(workspace.serverDir),
    ngProbe: workspace.ngProbe,
    tsProbe: workspace.tsProbe,
    angularCoreVersion: workspace.angularCoreVersion,
  });
  try {
    const init = await client.initialize(workspace.root);
    if (init.error) {
      return { failed: true };
    }
    client.notify('initialized', {});
    const opened = Date.now();
    client.didOpen(template, 'html', readFileSync(template, 'utf8'), 1);
    await client.waitForProjectLoadSince(opened, 60_000);
    const gap = OPEN_STAGGER_MS - (Date.now() - opened);
    if (gap > 0) {
      await sleep(gap);
    }
    client.didOpen(companion, 'typescript', readFileSync(companion, 'utf8'), 1);
    await sleep(settle);
    const asked = Date.now();
    if (await ask(client)) {
      return { firstTry: true };
    }
    for (;;) {
      if (Date.now() - asked > 5_000) {
        return { firstTry: false, recovered: null };
      }
      await sleep(50);
      if (await ask(client)) {
        return { firstTry: false, recovered: Date.now() - asked };
      }
    }
  } finally {
    client.dispose();
  }
}

const percentile = (sorted, share) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];

console.log(`settle probe on ${root}, ${trials} trials per value`);
const recoveries = [];
for (const settle of SETTLES) {
  const results = [];
  for (let i = 0; i < trials; i += 1) {
    results.push(await trial(settle));
  }
  const failed = results.filter((item) => item.failed).length;
  const firstTry = results.filter((item) => item.firstTry).length;
  const recovered = results
    .filter((item) => item.recovered != null)
    .map((item) => item.recovered)
    .sort((a, b) => a - b);
  recoveries.push(...recovered);
  const never = results.filter((item) => item.firstTry === false && item.recovered === null).length;
  console.log(
    `  settle ${String(settle).padStart(4)} ms: first-try ${firstTry}/${trials - failed}` +
      (recovered.length ? `, recovery after empty: ${recovered.join(', ')} ms` : '') +
      (never ? `, never recovered within 5 s: ${never}` : '') +
      (failed ? `, init failed: ${failed}` : ''),
  );
}
if (recoveries.length > 0) {
  const sorted = recoveries.sort((a, b) => a - b);
  console.log(
    `\nrecovery over ${sorted.length} empties: p50 ${percentile(sorted, 0.5)} ms, ` +
      `max ${sorted[sorted.length - 1]} ms`,
  );
}
