// MCP stdio shutdown: the client closes stdin and waits. The server must answer the calls
// already in flight, flush stdout and exit on its own - a one-shot pipe used to hang forever.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const request = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const notification = (method) => JSON.stringify({ jsonrpc: '2.0', method });

test('stdin EOF: the in-flight call still answers, then the process exits by itself', async () => {
  const child = spawn(process.execPath, [resolve('dist/index.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  // ng_component_info loads the fixture's own TypeScript first, so EOF lands while the call
  // is still in flight; no ngserver and no cold start involved.
  child.stdin.end(
    [
      request(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'pipe', version: '0' },
      }),
      notification('notifications/initialized'),
      request(2, 'tools/call', {
        name: 'ng_component_info',
        arguments: { file: resolve('fixtures/v17/src/app/legacy-card.component.ts') },
      }),
    ].join('\n') + '\n',
  );

  const code = await new Promise((done, fail) => {
    const guard = setTimeout(() => {
      child.kill();
      fail(new Error(`the process did not exit after EOF; stdout so far: ${out}`));
    }, 15_000);
    child.once('exit', (exitCode) => {
      clearTimeout(guard);
      done(exitCode);
    });
  });
  assert.equal(code, 0);

  const answer = out
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((msg) => msg.id === 2);
  assert.ok(answer, `no response to the tool call in: ${out}`);
  const payload = JSON.parse(answer.result.content[0].text);
  assert.equal(payload.found, true);
  assert.equal(payload.className, 'LegacyCardComponent');
});
