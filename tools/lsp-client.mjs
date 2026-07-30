// The core: an LSP client for @angular/language-server on bare Node, with no dependencies.
// Manual Content-Length framing, replies to the server's own requests, URI normalisation on
// receipt. This is what the MCP server wraps.

import { appendFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// The server answers with a different URI string than we sent: pathToFileURL yields
// file:///D:/... while vscode-uri on the same side yields file:///d%3A/.... We key the registry
// by path rather than by URI.
export function uriKey(value) {
  const path = value.startsWith('file:') ? fileURLToPath(value) : value;
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

export function frameReader(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }
      const header = buf.subarray(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        buf = buf.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buf.length < start + length) {
        return;
      }
      const body = buf.subarray(start, start + length).toString('utf8');
      buf = buf.subarray(start + length);
      onMessage(JSON.parse(body));
    }
  };
}

export function flattenHover(hover) {
  if (!hover || !hover.contents) {
    return null;
  }
  const parts = [];
  const push = (item) => {
    if (typeof item === 'string') {
      parts.push(item);
      return;
    }
    if (item && typeof item.value === 'string') {
      parts.push(item.value);
    }
  };
  if (Array.isArray(hover.contents)) {
    hover.contents.forEach(push);
  } else {
    push(hover.contents);
  }
  return parts
    .join('\n')
    .replace(/```[a-z-]*\n?/gi, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' | ');
}

export function flattenDefinition(result, projectDir) {
  if (!result) {
    return null;
  }
  const list = Array.isArray(result) ? result : [result];
  return list.map((item) => {
    const uri = item.uri ?? item.targetUri;
    const range = item.range ?? item.targetSelectionRange ?? item.targetRange;
    const path = uriKey(uri);
    const relative = path.startsWith(projectDir.toLowerCase())
      ? path.slice(projectDir.length + 1)
      : path;
    return `${relative}:${range.start.line + 1}:${range.start.character + 1}`;
  });
}

export class Client {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.diagnostics = new Map();
    // A full push log: without it 'no errors' cannot be told from 'not computed yet'.
    this.log = [];
    this.projectLoading = { started: null, finished: null };
    this.startedAt = Date.now();
    this.stderr = [];
    child.stdout.on('data', frameReader((msg) => this.dispatch(msg)));
    child.stderr.on('data', (chunk) => this.stderr.push(chunk.toString()));
  }

  dispatch(msg) {
    this.trace('<-', msg);
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        entry(msg);
      }
      return;
    }
    // The server sends requests too, and blocks until answered.
    if (msg.id !== undefined && msg.method !== undefined) {
      const count = msg.params?.items?.length ?? 0;
      const result = msg.method === 'workspace/configuration' ? new Array(count).fill(null) : null;
      this.write({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      const key = uriKey(msg.params.uri);
      this.diagnostics.set(key, msg.params.diagnostics);
      this.log.push({ at: Date.now(), key, count: msg.params.diagnostics.length });
      return;
    }
    if (msg.method === 'angular/projectLoadingStart') {
      this.projectLoading.started = Date.now();
      return;
    }
    if (msg.method === 'angular/projectLoadingFinish') {
      this.projectLoading.finished = Date.now();
    }
  }

  trace(direction, msg) {
    if (!process.env.NG_TOKEN_SAVER_TRACE) {
      return;
    }
    const method = typeof msg.method === 'string' ? msg.method : `#${msg.id}`;
    const uri = msg.params?.textDocument?.uri?.split('/').slice(-1)[0] ?? '';
    appendFileSync(
      process.env.NG_TOKEN_SAVER_TRACE,
      `${Date.now() - this.startedAt}\t${direction}\t${method}\t${uri}\n`,
    );
  }

  write(msg) {
    this.trace('->', msg);
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  request(method, params, timeout = 30000) {
    const id = this.nextId++;
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolvePromise({ error: { message: `timeout ${timeout}ms` } });
      }, timeout);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolvePromise(msg);
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  initialize(projectDir) {
    const uri = pathToFileURL(projectDir).href;
    return this.request('initialize', {
      processId: process.pid,
      rootUri: uri,
      workspaceFolders: [{ uri, name: 'fixture' }],
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false },
          definition: { linkSupport: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          publishDiagnostics: {},
        },
        workspace: { workspaceFolders: true },
      },
    });
  }

  didOpen(path, languageId, text, version = 1) {
    this.notify('textDocument/didOpen', {
      textDocument: { uri: pathToFileURL(path).href, languageId, version, text },
    });
  }

  // Full content replacement: we sync from disk rather than sending incremental diffs.
  didChange(path, text, version) {
    this.notify('textDocument/didChange', {
      textDocument: { uri: pathToFileURL(path).href, version },
      contentChanges: [{ text }],
    });
  }

  waitForProjectLoad(timeout) {
    return this.waitUntil(() => this.projectLoading.finished !== null, timeout);
  }

  waitUntil(predicate, timeout) {
    const deadline = Date.now() + timeout;
    return new Promise((resolvePromise) => {
      const tick = () => {
        if (predicate()) {
          resolvePromise(true);
          return;
        }
        if (Date.now() > deadline) {
          resolvePromise(false);
          return;
        }
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  pushesSince(since, key) {
    return this.log.filter((entry) => entry.at >= since && entry.key === key);
  }

  // There are several documents and their pushes spread out in time, so we wait for silence
  // rather than for the first push, which can be empty.
  async waitForQuiet(quietMs, timeout) {
    const deadline = Date.now() + timeout;
    let previous = -1;
    while (Date.now() < deadline) {
      if (this.log.length === previous && previous > 0) {
        return true;
      }
      previous = this.log.length;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, quietMs));
    }
    return false;
  }
}

// The two probe locations resolve different things: ng finds @angular/language-service, ts finds
// typescript. Real projects usually do NOT install language-service, so ng points at the server.
// probes: a string (both the same) or { ng, ts }.
// The exact core version of the project: the server gates blocks, @let and implicit standalone on it.
export function angularCoreVersion(projectDir) {
  try {
    const pkg = join(projectDir, 'node_modules', '@angular', 'core', 'package.json');
    return JSON.parse(readFileSync(pkg, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

export function startServer(serverDir, projectDir, probes, extraArgs = []) {
  const bin = join(serverDir, 'node_modules', '@angular', 'language-server', 'bin', 'ngserver');
  const fallback = join(projectDir, 'node_modules');
  const spec = typeof probes === 'string' ? { ng: probes, ts: probes } : (probes ?? {});
  const ngProbe = spec.ng ?? fallback;
  const tsProbe = spec.ts ?? fallback;
  const core = angularCoreVersion(projectDir);
  if (core && !extraArgs.includes('--angularCoreVersion')) {
    extraArgs = [...extraArgs, '--angularCoreVersion', core];
  }
  return spawn(
    process.execPath,
    [
      bin,
      '--stdio',
      '--ngProbeLocations',
      ngProbe,
      '--tsProbeLocations',
      tsProbe,
      ...extraArgs,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

export function serverModules(serverDir) {
  return join(serverDir, 'node_modules');
}

export function parseArgs(argv, defaults = {}) {
  const args = { ...defaults };
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return args;
}
