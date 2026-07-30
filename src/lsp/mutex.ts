// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// Serialized entry into a critical section. Needed because didOpen spacing is built on a
// shared timestamp: concurrent calls would collapse the pause to zero.

export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = (): void => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      // Release on throw as well, otherwise the queue stalls forever.
      release();
    }
  }
}
