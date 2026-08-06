// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// One long-lived ngserver session per workspace: document registry, sync from disk, waiting
// for diagnostics, and a canary health check.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LspClient,
  pathKey,
  serverBinFor,
  type ClientOptions,
  type Diagnostic,
  type Position,
} from './client.js';

export type ClientFactory = (options: ClientOptions) => LspClient;
import { Mutex } from './mutex.js';
import {
  describeWorkspace,
  findCanaryTemplates,
  firstInterpolation,
  type WorkspaceInfo,
} from './workspace.js';

// A burst of didOpen is silently dropped by the server, so we space the opens out.
const OPEN_STAGGER_MS = 800;
// There is deliberately NO settle pause after didOpen: measured across 90+ opens on two
// fixtures and the production monorepo (bench:settle, section 2.22) - with the open order,
// the stagger and the project-load wait in place, a request straight after didOpen never
// came back empty. The retry below is insurance for races the stand could not reproduce:
// it never fired in those same measurements.
const RETRY_DELAY_MS = 900;
// A 'broken' verdict is rechecked: it can be a false alarm caused by document open races.
const BROKEN_VERDICT_TTL_MS = 60_000;
// After an edit diagnostics arrive in a single push in about 340-400 ms; leave headroom.
const DIAGNOSTICS_TIMEOUT_MS = 4_000;
const PROJECT_LOAD_TIMEOUT_MS = 120_000;

// Paths reach us in whatever shape the caller used: the agent sends forward slashes, our own
// canary walk builds them with join(). Registries keyed by the raw string would then hold the
// same file twice, and the second copy waits for a project load that already happened.
// Case is NOT folded here — resolve() keeps it, so registries fold via pathKey at the lookup.
function canonical(path: string): string {
  return resolve(path);
}

export class SessionError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

export type Health =
  | { state: 'warming' }
  | { state: 'healthy' }
  | { state: 'broken'; reason: string; hint: string };

interface OpenDocument {
  // The spelling used in didOpen: the server tracks the document under exactly that URI.
  path: string;
  version: number;
  text: string;
}

export class NgSession {
  private client: LspClient | null = null;
  private spawned: LspClient | null = null;
  private readonly open = new Map<string, OpenDocument>();
  private readonly areaHealth = new Map<string, { verdict: Health; until: number }>();
  private lastOpenAt = 0;
  private readonly syncLock = new Mutex();
  private readonly loadedApps = new Set<string>();
  // Companions we already waited a push for: a server that never pushes for the companion
  // must not tax every later diagnostics call with the full timeout.
  private readonly companionWaits = new Set<string>();
  private ready: Promise<void> | null = null;
  private health: Health = { state: 'warming' };
  private inFlight = 0;

  private constructor(
    readonly workspace: WorkspaceInfo,
    private readonly createClient: ClientFactory,
  ) {}

  // The factory is injectable for tests: session orchestration cannot be checked otherwise
  // without spawning a real child process.
  static create(
    anyPathInside: string,
    serversDir: string,
    createClient: ClientFactory = (options) => new LspClient(options),
  ): NgSession {
    return new NgSession(describeWorkspace(anyPathInside, serversDir), createClient);
  }

  // Start booting immediately rather than on first request: on a real project that takes 20-27 s.
  start(): void {
    if (this.ready) {
      return;
    }
    this.ready = this.boot();
  }

  private async boot(): Promise<void> {
    const client = this.createClient({
      serverBin: serverBinFor(this.workspace.serverDir),
      ngProbe: this.workspace.ngProbe,
      tsProbe: this.workspace.tsProbe,
      angularCoreVersion: this.workspace.angularCoreVersion,
    });
    // Keep the reference from spawn time, or a signal during warmup leaves an orphan process.
    this.spawned = client;

    const init = await client.initialize(this.workspace.root);
    if (init.error) {
      // Do not publish the client: the session would look healthy while requests hit a dead process.
      await client.waitForClose(500);
      client.dispose();
      this.health = {
        state: 'broken',
        reason: `the server did not answer initialize: ${init.error.message}`,
        hint: describeStderr(client.stderr),
      };
      return;
    }
    this.client = client;
    client.notify('initialized', {});
    // A project loads only after the first didOpen, and health is checked next to the requested
    // file: in a monorepo one app can be silent while its neighbour works.
    this.health = { state: 'healthy' };
  }

  private async awaitReady(): Promise<void> {
    this.start();
    await this.ready;
  }

  getHealth(): Health {
    return this.health;
  }

  // projectLoadingFinish arrives even for a broken server/project pair, so an empty answer is
  // verified by a canary: a known-valid position in a neighbouring template.
  async healthNear(rawPath: string): Promise<Health> {
    return this.tracked(async () => {
      const path = canonical(rawPath);
      const area = dirname(path).toLowerCase();
      const cached = this.areaHealth.get(area);
      // 'Healthy' is cached forever, 'broken' for a minute: the verdict can be a false alarm
      // from a race, and caching it forever would disable the tools in a working folder.
      if (cached && (cached.verdict.state === 'healthy' || Date.now() < cached.until)) {
        return cached.verdict;
      }
      const client = await this.awaitClient();
      const templates = this.collectCanaries(path);
      let verdict: Health = {
        state: 'broken',
        reason: 'the server started but resolves no symbols in templates near this file',
        hint: 'usually the tsconfig of the app; some projects stay silent even with a healthy server',
      };
      if (templates.length === 0) {
        // No neighbours, nothing to judge. awaitClient above guards against a dead process:
        // it throws SessionError, so execution never reaches this line.
        verdict = { state: 'healthy' };
      }
      for (const template of templates) {
        const position = firstInterpolation(readFileSync(template, 'utf8'));
        if (!position) {
          continue;
        }
        const outcome = await this.definitionWith(client, template, position);
        if (outcome.length > 0) {
          verdict = { state: 'healthy' };
          break;
        }
      }
      this.areaHealth.set(area, { verdict, until: Date.now() + BROKEN_VERDICT_TTL_MS });
      return verdict;
    });
  }

  // An app is the nearest ancestor holding tsconfig.json; a monorepo has several.
  private appRootFor(path: string): string {
    let dir = dirname(path);
    while (dir.length >= this.workspace.root.length) {
      if (existsSync(join(dir, 'tsconfig.json'))) {
        return dir.toLowerCase();
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    return this.workspace.root.toLowerCase();
  }

  // We widen the search upwards: a component folder usually holds only that component.
  private collectCanaries(path: string): string[] {
    const self = pathKey(path);
    let dir = dirname(path);
    for (let level = 0; level < 3; level += 1) {
      const found = findCanaryTemplates(dir, 5)
        .map(canonical)
        .filter((item) => pathKey(item) !== self);
      if (found.length >= 2) {
        return found;
      }
      const parent = dirname(dir);
      if (parent === dir || dir.length <= this.workspace.root.length) {
        return found;
      }
      dir = parent;
    }
    return [];
  }

  private async stagger(): Promise<void> {
    const wait = OPEN_STAGGER_MS - (Date.now() - this.lastOpenAt);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  // Order matters: the server opens the companion .ts itself if the template came first and the
  // .ts is not open yet (fix #2165). Opening the .ts first disables that path.
  private async syncPair(client: LspClient, path: string): Promise<void> {
    await this.sync(client, path, languageIdFor(path));
    const companion = companionOf(path);
    if (companion && existsSync(companion)) {
      await this.sync(client, companion, 'typescript');
    }
  }

  // The agent edits files behind the LSP's back, so we always reconcile with disk first.
  private async sync(client: LspClient, path: string, languageId: string): Promise<LspClient> {
    const text = readFileSync(path, 'utf8');
    // NTFS is case-insensitive and the server itself answers with d: where the agent sent D:,
    // so D:\... and d:\... must land on one registry entry, not two.
    const key = pathKey(path);
    const known = this.open.get(key);
    if (known) {
      if (known.text !== text) {
        const version = known.version + 1;
        client.didChange(known.path, text, version);
        this.open.set(key, { path: known.path, version, text });
      }
      return client;
    }

    // The mutex covers only the spacing and the didOpen itself: those share the timestamp.
    // Waiting for the project to load must stay outside; it takes tens of seconds and would
    // block requests to other apps in the workspace.
    const since = await this.syncLock.run(async () => {
      await this.stagger();
      const at = Date.now();
      client.didOpen(path, languageId, text, 1);
      this.lastOpenAt = at;
      this.open.set(key, { path, version: 1, text });
      return at;
    });

    // Wait for the load once per app. The trace shows that opening a template can bring up one
    // more project, but waiting for a second load changed nothing; the retry in definitionWith is
    // the current safety net. This spot is not settled.
    const app = this.appRootFor(path);
    if (!this.loadedApps.has(app)) {
      this.loadedApps.add(app);
      await client.waitForProjectLoadSince(since, PROJECT_LOAD_TIMEOUT_MS);
    }
    return client;
  }

  async definitionAt(rawPath: string, position: Position): Promise<LocationHit[]> {
    return this.tracked(async () => {
      const client = await this.awaitClient();
      return this.definitionWith(client, canonical(rawPath), position);
    });
  }

  private async definitionWith(
    client: LspClient,
    path: string,
    position: Position,
  ): Promise<LocationHit[]> {
    await this.syncPair(client, path);
    const first = await this.definitionOnce(client, path, position);
    if (first.length > 0) {
      return first;
    }
    // An empty answer can be a race with the server's bookkeeping, so retry once.
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return this.definitionOnce(client, path, position);
  }

  private async definitionOnce(
    client: LspClient,
    path: string,
    position: Position,
  ): Promise<LocationHit[]> {
    const outcome = await client.request('textDocument/definition', {
      textDocument: { uri: uriOf(path) },
      position,
    });
    if (outcome.error || !outcome.result) {
      return [];
    }
    const raw = Array.isArray(outcome.result) ? outcome.result : [outcome.result];
    return raw.map((item) => normalizeLocation(item as RawLocation));
  }

  async hoverAt(rawPath: string, position: Position): Promise<string | null> {
    return this.tracked(async () => {
      const path = canonical(rawPath);
      const client = await this.awaitClient();
      await this.syncPair(client, path);
      const outcome = await client.request('textDocument/hover', {
        textDocument: { uri: uriOf(path) },
        position,
      });
      if (outcome.error || !outcome.result) {
        return null;
      }
      return flattenHover(outcome.result as HoverResult);
    });
  }

  // A template and its companion .ts are checked together: template diagnostics need the class.
  async diagnosticsFor(rawPath: string): Promise<AttributedDiagnostic[]> {
    return this.tracked(async () => {
      const path = canonical(rawPath);
      const client = await this.awaitClient();
      const since = Date.now();
      const wasOpen = this.open.has(pathKey(path));
      await this.syncPair(client, path);
      const changed = this.open.get(pathKey(path))?.version ?? 1;
      // Short path only if a push already arrived: another tool may have opened the file, and
      // then 'empty' means 'not computed yet', not 'no errors'.
      if (!(wasOpen && changed === 1 && client.hadDiagnosticsPush(path))) {
        await client.waitForNextDiagnostics(path, since, DIAGNOSTICS_TIMEOUT_MS);
      }
      return this.attributeToCompanion(client, path, client.diagnosticsFor(path) ?? [], since);
    });
  }

  // The server republishes component-scope diagnostics under the template URI with spans that
  // still point into the .ts (measured on 22.0.8, section 2.28): a host-listener error came
  // as line 69 of a 58-line template. An entry the companion list carries verbatim is anchored
  // in the companion, and the answer says so with a file field.
  private async attributeToCompanion(
    client: LspClient,
    path: string,
    list: Diagnostic[],
    since: number,
  ): Promise<AttributedDiagnostic[]> {
    const companion = companionOf(path);
    if (!companion || list.length === 0 || !existsSync(companion)) {
      return list;
    }
    // The companion's own push can lag behind the template's; judging by an empty cache would
    // silently skip the attribution, so wait for its first push the same bounded way — once.
    const key = pathKey(companion);
    if (!client.hadDiagnosticsPush(companion) && !this.companionWaits.has(key)) {
      this.companionWaits.add(key);
      await client.waitForNextDiagnostics(companion, since, DIAGNOSTICS_TIMEOUT_MS);
    }
    const twins = client.diagnosticsFor(companion) ?? [];
    if (twins.length === 0) {
      return list;
    }
    const anchored = new Set(twins.map(diagnosticKey));
    return list.map((item) =>
      anchored.has(diagnosticKey(item)) ? { ...item, file: companion } : item,
    );
  }

  // The idle sweep must not kill a session mid-call: a cold project load takes two minutes.
  isBusy(): boolean {
    return this.inFlight > 0;
  }

  private async tracked<T>(work: () => Promise<T>): Promise<T> {
    this.inFlight += 1;
    try {
      return await work();
    } finally {
      this.inFlight -= 1;
    }
  }

  // The process can die after a successful start, and health must notice that.
  isAlive(): boolean {
    return this.client !== null && this.client.exited === null;
  }

  // Differs from !isAlive(): during warmup the client is not published yet, but the process lives.
  isDead(): boolean {
    return this.spawned !== null && this.spawned.exited !== null;
  }

  private async awaitClient(): Promise<LspClient> {
    await this.awaitReady();
    if (!this.isAlive()) {
      if (this.client) {
        this.health = {
          state: 'broken',
          reason: `server process exited (code ${this.client.exited})`,
          hint: describeStderr(this.client.stderr),
        };
      }
      const health = this.health;
      const reason = health.state === 'broken' ? health.reason : 'session is not up';
      const hint = health.state === 'broken' ? health.hint : '';
      throw new SessionError(reason, hint);
    }
    return this.client!;
  }


  /** What the server itself reported: why the LS is off, and where strictTemplates is off. */
  serverNotices(): { notices: string[]; strictTemplatesOff: string[] } {
    const client = this.client ?? this.spawned;
    return {
      notices: client?.notices ?? [],
      strictTemplatesOff: client?.strictTemplatesOff ?? [],
    };
  }

  dispose(): void {
    this.spawned?.dispose();
    this.spawned = null;
    this.client = null;
  }
}

export interface LocationHit {
  file: string;
  line: number;
  character: number;
}

// A diagnostic plus, when it is anchored in the pair's other document, that document's path.
export interface AttributedDiagnostic extends Diagnostic {
  file?: string;
}

// The template's pair; null for anything that is not a template path. Extension case is
// folded: the registries already learned that lesson the hard way (CLAUDE.md, fact 18).
function companionOf(path: string): string | null {
  return /\.html$/i.test(path) ? path.replace(/\.html$/i, '.ts') : null;
}

// Identity of a server diagnostic across the two publishes of one pair. The end position is
// read defensively: fakes in tests carry start-only ranges.
function diagnosticKey(item: Diagnostic): string {
  const { start, end } = item.range;
  return [
    item.code ?? '',
    start.line,
    start.character,
    end?.line ?? '',
    end?.character ?? '',
    item.message,
  ].join('|');
}

export interface RawLocation {
  uri?: string;
  targetUri?: string;
  range?: { start: Position };
  targetSelectionRange?: { start: Position };
  targetRange?: { start: Position };
}

export interface HoverResult {
  contents?: unknown;
}

export function normalizeLocation(item: RawLocation): LocationHit {
  const uri = item.uri ?? item.targetUri ?? '';
  const range = item.range ?? item.targetSelectionRange ?? item.targetRange;
  const start = range?.start ?? { line: 0, character: 0 };
  return {
    file: uri.startsWith('file:') ? fileFromUri(uri) : uri,
    line: start.line + 1,
    character: start.character + 1,
  };
}

function fileFromUri(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\/\//, '')).replace(/\//g, '\\');
}

// pathToFileURL only: manual concatenation breaks on spaces and unicode in the path.
function uriOf(path: string): string {
  return pathToFileURL(path).href;
}

function languageIdFor(path: string): string {
  return path.endsWith('.ts') ? 'typescript' : 'html';
}

// Hover comes back as markdown; the agent needs one meaningful line.
export function flattenHover(hover: HoverResult): string | null {
  const parts: string[] = [];
  const push = (item: unknown): void => {
    if (typeof item === 'string') {
      parts.push(item);
      return;
    }
    if (item && typeof item === 'object' && 'value' in item) {
      const value = (item as { value: unknown }).value;
      if (typeof value === 'string') {
        parts.push(value);
      }
    }
  };
  if (Array.isArray(hover.contents)) {
    hover.contents.forEach(push);
  } else {
    push(hover.contents);
  }
  const text = parts
    .join('\n')
    .replace(/```[a-z-]*\n?/gi, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  return text.length > 0 ? text : null;
}

// 'Empty' and 'text present but without Error:' are different diagnoses; do not collapse them.
export function describeStderr(stderr: string): string {
  const lines = stderr.split('\n').map((item) => item.trim()).filter(Boolean);
  if (lines.length === 0) {
    return 'stderr is empty';
  }
  return lines.find((item) => item.includes('Error:')) ?? lines[lines.length - 1]!;
}
