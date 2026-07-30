// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// Low-level client for @angular/language-server: Content-Length framing, replies to the
// server's own requests, and a diagnostics registry keyed by path.

import { appendFileSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Wire trace for comparison against the reference client; enabled by an env variable.
const TRACE_FILE = process.env['NG_TOKEN_SAVER_TRACE'] ?? '';

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Diagnostic {
  range: Range;
  code?: string | number;
  severity?: number;
  message: string;
}

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message: string };
}

export interface RequestOutcome {
  result?: unknown;
  error?: { message: string };
}

interface DiagnosticsPush {
  at: number;
  key: string;
  count: number;
}

// The server answers with a different URI string than the client sent: pathToFileURL
// yields file:///D:/..., vscode-uri yields file:///d%3A/.... So we key by path.
export function pathKey(value: string): string {
  const path = value.startsWith('file:') ? fileURLToPath(value) : value;
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

export function frameReader(onMessage: (msg: JsonRpcMessage) => void): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match?.[1]) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) {
        return;
      }
      const body = buffer.subarray(start, start + length).toString('utf8');
      buffer = buffer.subarray(start + length);
      onMessage(JSON.parse(body) as JsonRpcMessage);
    }
  };
}

export interface ClientOptions {
  serverBin: string;
  ngProbe: string;
  tsProbe: string;
  /** Without it the compiler assumes newest semantics: blocks, @let, implicit standalone. */
  angularCoreVersion: string;
}

export class LspClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, (msg: JsonRpcMessage) => void>();
  private readonly diagnostics = new Map<string, Diagnostic[]>();
  private readonly pushes: DiagnosticsPush[] = [];
  private projectLoadedAt: number | null = null;
  private closed = false;
  private readonly startedAt = Date.now();
  /** Server notices about projects: why the language service is off, and where. */
  readonly notices: string[] = [];
  /** Every tsconfig the server reported strictTemplates off for; a monorepo can have several. */
  readonly strictTemplatesOff: string[] = [];
  private exitCode: number | null = null;
  private readonly stderrChunks: string[] = [];

  constructor(options: ClientOptions) {
    this.child = spawn(
      process.execPath,
      [
        options.serverBin,
        '--stdio',
        '--ngProbeLocations',
        options.ngProbe,
        '--tsProbeLocations',
        options.tsProbe,
        '--angularCoreVersion',
        options.angularCoreVersion,
        // Without this flag the server is silent: its project messages go nowhere.
        '--logToConsole',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child.stdout.on('data', frameReader((msg) => this.dispatch(msg)));
    this.child.stderr.on('data', (chunk: Buffer) => this.stderrChunks.push(chunk.toString()));
    // Without 'error' listeners an unhandled event takes down the whole MCP process,
    // not just the failing session.
    this.child.on('error', (error) => this.die(-1, error.message));
    this.child.stdin.on('error', (error) => this.die(-1, error.message));
    // exit so we stop waiting, close so we can drain stderr: it arrives after exit.
    this.child.on('exit', (code) => this.die(code ?? -1, null));
    this.child.on('close', () => {
      this.closed = true;
    });
  }

  waitForClose(timeoutMs: number): Promise<boolean> {
    return this.waitUntil(() => this.closed, timeoutMs);
  }

  // A dead process settles pending requests at once: an answer will never come.
  private die(code: number, message: string | null): void {
    if (this.exitCode !== null) {
      return;
    }
    this.exitCode = code;
    if (message) {
      this.stderrChunks.push(`${message}\n`);
    }
    const reason = `server process exited (code ${code})`;
    for (const [, resolve] of this.pending) {
      resolve({ error: { code, message: reason } });
    }
    this.pending.clear();
  }

  get exited(): number | null {
    return this.exitCode;
  }

  get stderr(): string {
    return this.stderrChunks.join('');
  }

  private dispatch(msg: JsonRpcMessage): void {
    this.trace('<-', msg as unknown as Record<string, unknown>);
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id as number);
      if (entry) {
        this.pending.delete(msg.id as number);
        entry(msg);
      }
      return;
    }
    // The server sends requests too, and blocks until answered.
    if (msg.id !== undefined && msg.method !== undefined) {
      const params = msg.params as { items?: unknown[] } | undefined;
      const result =
        msg.method === 'workspace/configuration'
          ? new Array<null>(params?.items?.length ?? 0).fill(null)
          : null;
      this.write({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      const params = msg.params as { uri: string; diagnostics: Diagnostic[] };
      const key = pathKey(params.uri);
      this.diagnostics.set(key, params.diagnostics);
      this.pushes.push({ at: Date.now(), key, count: params.diagnostics.length });
      return;
    }
    if (msg.method === 'angular/projectLoadingFinish') {
      this.projectLoadedAt = Date.now();
      return;
    }
    // The server itself says template checking is off, so no need to guess from tsconfig.
    // One notice arrives per project: keep them all, or the second app erases the first.
    if (msg.method === 'angular/suggestStrictMode') {
      const config = (msg.params as { configFilePath?: string })?.configFilePath;
      if (config && !this.strictTemplatesOff.includes(config)) {
        this.strictTemplatesOff.push(config);
      }
      return;
    }
    if (msg.method === 'angular/projectLanguageService') {
      const params = msg.params as { projectName?: string; languageServiceEnabled?: boolean };
      if (params?.languageServiceEnabled === false) {
        this.notices.push(`language service disabled for project ${params.projectName ?? '?'}`);
      }
      return;
    }
    if (msg.method === 'window/logMessage') {
      const text = (msg.params as { message?: string })?.message ?? '';
      if (/Disabling language service|No config file|could not be found|size limit/i.test(text)) {
        this.notices.push(text.trim());
      }
    }
  }

  private trace(direction: string, msg: Record<string, unknown>): void {
    if (!TRACE_FILE) {
      return;
    }
    const method = typeof msg['method'] === 'string' ? msg['method'] : `#${String(msg['id'])}`;
    const params = msg['params'] as { textDocument?: { uri?: string } } | undefined;
    const uri = params?.textDocument?.uri?.split('/').slice(-1)[0] ?? '';
    appendFileSync(TRACE_FILE, `${Date.now() - this.startedAt}\t${direction}\t${method}\t${uri}\n`);
  }

  private write(msg: Record<string, unknown>): void {
    if (this.exitCode !== null) {
      return;
    }
    this.trace('->', msg);
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<RequestOutcome> {
    if (this.exitCode !== null) {
      return Promise.resolve({
        error: { message: `server process is dead (code ${this.exitCode})` },
      });
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: `timed out after ${timeoutMs} ms on ${method}` } });
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg.error ? { error: msg.error } : { result: msg.result });
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  initialize(rootDir: string): Promise<RequestOutcome> {
    const uri = pathToFileURL(rootDir).href;
    return this.request(
      'initialize',
      {
        processId: process.pid,
        rootUri: uri,
        workspaceFolders: [{ uri, name: 'workspace' }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false },
            definition: { linkSupport: true },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            publishDiagnostics: {},
          },
          workspace: { workspaceFolders: true },
        },
      },
      60_000,
    );
  }

  didOpen(path: string, languageId: string, text: string, version: number): void {
    this.notify('textDocument/didOpen', {
      textDocument: { uri: pathToFileURL(path).href, languageId, version, text },
    });
  }

  // Full content replacement: we sync from disk rather than sending incremental diffs.
  didChange(path: string, text: string, version: number): void {
    this.notify('textDocument/didChange', {
      textDocument: { uri: pathToFileURL(path).href, version },
      contentChanges: [{ text }],
    });
  }

  diagnosticsFor(path: string): Diagnostic[] | undefined {
    return this.diagnostics.get(pathKey(path));
  }

  hadDiagnosticsPush(path: string): boolean {
    const key = pathKey(path);
    return this.pushes.some((push) => push.key === key);
  }

  // In a monorepo every app is its own project and each one loads separately.
  waitForProjectLoadSince(since: number, timeoutMs: number): Promise<boolean> {
    return this.waitUntil(() => (this.projectLoadedAt ?? 0) >= since, timeoutMs);
  }

  // Diagnostics arrive as an unsolicited push; after an edit we wait for the next one.
  async waitForNextDiagnostics(path: string, since: number, timeoutMs: number): Promise<boolean> {
    const key = pathKey(path);
    return this.waitUntil(
      () => this.pushes.some((push) => push.key === key && push.at >= since),
      timeoutMs,
    );
  }

  waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const tick = (): void => {
        if (predicate()) {
          resolve(true);
          return;
        }
        if (this.exitCode !== null || Date.now() > deadline) {
          resolve(false);
          return;
        }
        setTimeout(tick, 25);
      };
      tick();
    });
  }

  dispose(): void {
    this.notify('exit', {});
    this.child.kill();
  }
}

export function serverBinFor(serverDir: string): string {
  return join(serverDir, 'node_modules', '@angular', 'language-server', 'bin', 'ngserver');
}
