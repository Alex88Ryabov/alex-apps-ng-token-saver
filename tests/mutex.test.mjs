// The mutex protects didOpen spacing: without it concurrent calls collapse the pause to zero.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Mutex } from '../dist/lsp/mutex.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('sections do not overlap', async () => {
  const mutex = new Mutex();
  const log = [];
  const section = async (name) => {
    log.push(`${name}:enter`);
    await wait(20);
    log.push(`${name}:exit`);
  };
  await Promise.all([mutex.run(() => section('a')), mutex.run(() => section('b'))]);
  assert.deepEqual(log, ['a:enter', 'a:exit', 'b:enter', 'b:exit']);
});

test('entry order is preserved', async () => {
  const mutex = new Mutex();
  const order = [];
  await Promise.all([1, 2, 3].map((n) => mutex.run(async () => { order.push(n); })));
  assert.deepEqual(order, [1, 2, 3]);
});

test('an exception does not lock the queue forever', async () => {
  const mutex = new Mutex();
  await assert.rejects(mutex.run(async () => { throw new Error('boom'); }));
  assert.equal(await mutex.run(async () => 'next one ran'), 'next one ran');
});

test('returns the value of the action', async () => {
  const mutex = new Mutex();
  assert.equal(await mutex.run(async () => 42), 42);
});
