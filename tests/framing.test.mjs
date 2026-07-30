// Content-Length framing: messages arrive in arbitrarily sliced chunks.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameReader } from '../dist/lsp/client.js';

function frame(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

test('a single message in a single chunk', () => {
  const seen = [];
  const read = frameReader((msg) => seen.push(msg));
  read(frame({ id: 1, result: 'ok' }));
  assert.deepEqual(seen, [{ id: 1, result: 'ok' }]);
});

test('a message cut in the middle of the header and of the body', () => {
  const seen = [];
  const read = frameReader((msg) => seen.push(msg));
  const buffer = frame({ method: 'ping' });
  for (let i = 0; i < buffer.length; i += 1) {
    read(buffer.subarray(i, i + 1));
  }
  assert.deepEqual(seen, [{ method: 'ping' }]);
});

test('two messages in one chunk', () => {
  const seen = [];
  const read = frameReader((msg) => seen.push(msg));
  read(Buffer.concat([frame({ id: 1 }), frame({ id: 2 })]));
  assert.deepEqual(seen, [{ id: 1 }, { id: 2 }]);
});

test('a header without Content-Length is dropped and the next message is read', () => {
  const seen = [];
  const read = frameReader((msg) => seen.push(msg));
  read(Buffer.concat([Buffer.from('X-Junk: 1\r\n\r\n', 'ascii'), frame({ id: 7 })]));
  assert.deepEqual(seen, [{ id: 7 }]);
});

test('multi-byte characters do not break the length', () => {
  const seen = [];
  const read = frameReader((msg) => seen.push(msg));
  read(frame({ message: 'Property «fullName» does not exist on type — none' }));
  assert.equal(seen[0].message, 'Property «fullName» does not exist on type — none');
});

test('an incomplete message is withheld until its tail arrives', () => {
  const seen = [];
  const read = frameReader((msg) => seen.push(msg));
  const buffer = frame({ id: 3 });
  read(buffer.subarray(0, buffer.length - 2));
  assert.equal(seen.length, 0);
  read(buffer.subarray(buffer.length - 2));
  assert.deepEqual(seen, [{ id: 3 }]);
});
