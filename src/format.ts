// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// Pure response-shaping and path helpers, kept out of the entry point so tests can
// import them without starting the transport.

import { dirname, resolve, sep } from 'node:path';

export interface ToolResult {
  // Index signature is required by the SDK result type.
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// Answers are dense JSON with no markdown: every extra character lands in the agent context.
export function json(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

// null and undefined cost tokens and say nothing, so they are dropped. false stays:
// 'not set' and 'set to false' are different answers. An empty array is an answer too.
export function compact<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => compact(item)) as T;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && item !== undefined) {
      result[key] = compact(item);
    }
  }
  return result as T;
}

// A real failure is flagged with isError, or the agent reads the breakage report as data.
export function toolError(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
}

// Compare on a separator boundary, or fixtures\v1 would swallow a request for fixtures\v17.
// Both sides are folded here: trusting callers to pre-lowercase the root is how path-as-key
// bugs start, and this project has had three of them.
export function belongsTo(file: string, root: string): boolean {
  const lowerFile = file.toLowerCase();
  const lowerRoot = root.toLowerCase();
  const prefix = lowerRoot.endsWith(sep) ? lowerRoot : lowerRoot + sep;
  return lowerFile === lowerRoot || lowerFile.startsWith(prefix);
}

// The kind comes from hover, so these are TypeScript kinds: property, method, element and
// friends. Angular-specific input/output/pipe never appear here: those need decorator
// parsing rather than the LSP.
export function kindFromSignature(signature: string | null): string {
  if (!signature) {
    return 'unknown';
  }
  const match = /^(?:public |private |protected |optional |readonly )*\((\w+)\)/.exec(signature);
  return match?.[1] ?? 'unknown';
}

// The language server reports a tsconfig path in its own shape: lowercase drive letter and
// forward slashes. resolve() brings it back to platform separators so paths compare equal.
export function projectDirOf(configFilePath: string): string {
  return dirname(resolve(configFilePath)).toLowerCase();
}
