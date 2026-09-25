#!/usr/bin/env node
// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// Angular template-awareness MCP server: six tools over the language server and the TS AST.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  componentFileFor,
  describeComponents,
  loadTypeScript,
  pickComponent,
  resolveAncestors,
} from './component-info.js';
import { diagnoseFile } from './diagnostics.js';
import { instructionsFor } from './instructions.js';
import { compact, json, kindFromSignature, symbolCharacter, toolError, type ToolResult } from './format.js';
import { SessionRegistry } from './lsp/registry.js';
import { NgSession, SessionError } from './lsp/session.js';
import { findCanaryTemplates, locateProject, WorkspaceError } from './lsp/workspace.js';
import { CONTEXT_LIMIT, findUsages, targetFromSelector, targetOf } from './find-usages.js';
import { versionRules } from './version-rules.js';
import { describeWorkspaceMap, pointsIntoOneProject, type WorkspaceMap } from './workspace-map.js';

const here = dirname(fileURLToPath(import.meta.url));
const serversDir = process.env['NG_TOKEN_SAVER_SERVERS_DIR'] ?? join(here, '..', 'tools', 'servers');

// A session unused this long shuts its ngserver down; the next call pays the cold start
// again. Policy from measured inputs (section 2.22): a warm server holds ~1 GB on the
// production monorepo (979 MB RSS) while a reload costs 8-28 s.
// Override with NG_TOKEN_SAVER_IDLE_MS; 0 disables the shutdown.
const DEFAULT_IDLE_MS = 15 * 60_000;
const rawIdleMs = Number(process.env['NG_TOKEN_SAVER_IDLE_MS'] ?? DEFAULT_IDLE_MS);
const registry = new SessionRegistry(
  (file) => {
    const session = NgSession.create(dirname(file), serversDir);
    session.start();
    return session;
  },
  Number.isFinite(rawIdleMs) && rawIdleMs >= 0 ? rawIdleMs : DEFAULT_IDLE_MS,
);
// Opt-in: a warmed server holds ~1 GB until the idle shutdown even if no LSP tool follows.
const prewarm = process.env['NG_TOKEN_SAVER_PREWARM'] === '1';

// resolve() even on an absolute path: an agent sends d:/a/b, our registries are keyed by
// d:\a\b, and a raw string would miss the session lookup — spawning a fresh server per call.
function resolveFile(input: string): string {
  const path = resolve(isAbsolute(input) ? input : join(process.cwd(), input));
  if (!existsSync(path)) {
    throw new WorkspaceError(`file not found: ${path}`, 'the path is absolute or relative to cwd');
  }
  return path;
}

// Answers are dense JSON with no markdown: every extra character lands in the agent context.
function errorBody(error: unknown): Record<string, unknown> {
  if (error instanceof WorkspaceError || error instanceof SessionError) {
    return { error: error.message, hint: error.hint };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}

function failure(error: unknown): ToolResult {
  return toolError(errorBody(error));
}

// Loads the app around this path so the first LSP call finds it ready. A folder holding several
// projects is skipped: which app to load is unknown, and booting the process alone saves 0.6 s
// of a ~20 s cold start (measured on the production monorepo).
async function warmUpAround(inside: string, map: WorkspaceMap): Promise<void> {
  const dir = statSync(inside).isDirectory() ? inside : dirname(inside);
  if (!pointsIntoOneProject(map, dir)) {
    return;
  }
  const [template] = findCanaryTemplates(dir, 1);
  if (template) {
    await registry.acquire(template).warmUp(template);
  }
}

// MCP stdio shutdown is 'close stdin, wait for exit'. Exiting straight on EOF would drop
// responses still in flight - a cold LSP call runs for seconds - so EOF only arms the exit,
// and the last settled call flushes stdout and pulls the plug.
let inFlight = 0;
let stdinClosed = false;

function finishAfterEof(): void {
  if (!stdinClosed || inFlight > 0) {
    return;
  }
  // setImmediate lets the SDK enqueue the final response; the empty write orders the exit
  // after every stdout byte already queued.
  setImmediate(() => {
    process.stdout.write('', () => {
      registry.disposeAll();
      process.exit(0);
    });
  });
}

// Mirrors NgSession.tracked. Only the six tool calls are counted: answers the SDK produces
// itself (initialize, tools/list, a bad tool name) ride on it writing them in microtasks,
// before the setImmediate above - verified by running against SDK 1.30. A call that never
// settles keeps the process alive after EOF, exactly as it kept it alive before this exit.
async function tracked(work: () => Promise<ToolResult>): Promise<ToolResult> {
  inFlight += 1;
  try {
    return await work();
  } finally {
    inFlight -= 1;
    finishAfterEof();
  }
}

// The version rides along from package.json: the literal here went stale twice.
const packageVersion = (
  JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string }
).version;
const server = new McpServer(
  { name: 'ng-token-saver', version: packageVersion },
  { instructions: instructionsFor(prewarm) },
);

server.registerTool(
  'ng_template_definition',
  {
    title: 'Angular: declaration of a template symbol',
    description:
      'From a symbol in an Angular template (.html or inline in .ts) to its TypeScript declaration. ' +
      'line is 1-based, as Read shows it; name the symbol rather than counting its column.',
    inputSchema: {
      file: z.string().describe('Path to the template: .html, or .ts with an inline template'),
      line: z.number().int().min(1),
      symbol: z.string().optional().describe('The name on that line: userName, app-user-card, date'),
      character: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('1-based column instead of symbol, when the name repeats on the line'),
    },
  },
  async ({ file, line, symbol, character }) =>
    tracked(async () => {
      try {
        if ((symbol === undefined) === (character === undefined)) {
          return toolError({ error: 'pass exactly one of symbol or character' });
        }
        const path = resolveFile(file);
        const text = readFileSync(path, 'utf8').split(/\r?\n/)[line - 1];
        if (text === undefined) {
          return toolError({ error: `line ${line} is past the end of ${path}` });
        }
        // A name missing from the line is said with the line itself: an off-by-one then shows
        // at once instead of resolving whatever sits on the neighbouring line.
        const column = symbol !== undefined ? symbolCharacter(text, symbol) : character! - 1;
        if (column === null) {
          return toolError({
            error: `${symbol} is not on line ${line}`,
            line: text.trim().slice(0, CONTEXT_LIMIT),
          });
        }
        const position = { line: line - 1, character: column };
        const session = registry.acquire(path);
        const [hit] = await session.definitionAt(path, position);
        if (!hit) {
          // An empty answer is indistinguishable from a failure, so we check with a canary.
          const health = await session.healthNear(path);
          if (health.state === 'broken') {
            return toolError({ error: health.reason, hint: health.hint, ...session.serverNotices() });
          }
          return json({ found: false });
        }
        const signature = await session.hoverAt(path, position);
        return json({
          found: true,
          file: hit.file,
          line: hit.line,
          character: hit.character,
          kind: kindFromSignature(signature),
          signature,
        });
      } catch (error) {
        return failure(error);
      }
    }),
);

server.registerTool(
  'ng_template_diagnostics',
  {
    title: 'Angular: template errors',
    description:
      'Angular compiler errors for a template after an edit. Accepts .html or .ts; files checks ' +
      'a batch. An entry anchored in the companion file names it in file. ' +
      'An empty list means "no errors" only when the server is healthy.',
    inputSchema: {
      file: z.string().optional().describe('Path to the template or to the component'),
      files: z
        .array(z.string())
        .min(1)
        .max(20)
        .optional()
        .describe('Batch of up to 20 templates; the answer groups diagnostics per file'),
    },
  },
  async ({ file, files }) =>
    tracked(async () => {
      try {
        // Both set and both missing fail alike: exactly one input form per call.
        if ((file === undefined) === (files === undefined)) {
          return toolError({ error: 'pass exactly one of file or files' });
        }
        if (file !== undefined) {
          const path = resolveFile(file);
          const outcome = await diagnoseFile(registry.acquire(path), path);
          return outcome.ok ? json(outcome.body) : toolError(outcome.body);
        }
        const answers: Record<string, unknown>[] = [];
        for (const raw of files ?? []) {
          // The echo is the canonical path once the file resolves; only an entry that
          // does not resolve echoes the caller's spelling.
          let path = raw;
          try {
            path = resolveFile(raw);
            const outcome = await diagnoseFile(registry.acquire(path), path);
            answers.push({ file: path, ...outcome.body });
          } catch (error) {
            answers.push({ file: path, ...errorBody(error) });
          }
        }
        return json({ files: answers });
      } catch (error) {
        return failure(error);
      }
    }),
);

server.registerTool(
  'ng_component_info',
  {
    title: 'Angular: component contract',
    description:
      'Public contract of a component or directive: inputs, outputs, class members, decorator ' +
      'metadata. Accepts .ts or .html. Reads the source; ngserver is not needed.',
    inputSchema: {
      file: z.string().describe('Path to the component (.ts) or to its template (.html)'),
    },
  },
  async ({ file }) =>
    tracked(async () => {
      try {
        const requested = resolveFile(file);
        const path = componentFileFor(requested);
        const project = locateProject(path);
        const ts = await loadTypeScript(project.root);
        const found = describeComponents(ts, readFileSync(path, 'utf8'), path, project.angularMajor);
        const chosen = pickComponent(found, requested.endsWith('.html') ? basename(requested) : null);
        if (!chosen) {
          return json({ found: false, file: path, reason: 'the file has no class with @Component or @Directive' });
        }
        const others = found.filter((item) => item !== chosen).map((item) => item.className);
        const complete = resolveAncestors(ts, chosen, path, project.root);
        return json(
          compact({
            found: true,
            // Echo the path only when it differs from the one passed in: the echo costs ~100 chars.
            file: path === requested ? null : path,
            angularVersion: project.angularCoreVersion,
            ...complete,
            // These lists stay off the wire when empty: a repeated [] carries nothing.
            implements: complete.implements.length > 0 ? complete.implements : null,
            lifecycle: complete.lifecycle.length > 0 ? complete.lifecycle : null,
            providers: complete.providers.length > 0 ? complete.providers : null,
            viewProviders: complete.viewProviders.length > 0 ? complete.viewProviders : null,
            others: others.length > 0 ? others : null,
          }),
        );
      } catch (error) {
        return failure(error);
      }
    }),
);

server.registerTool(
  'ng_workspace_map',
  {
    title: 'Angular: workspace map',
    description:
      'Workspace projects, Angular/CLI/TypeScript versions, strictTemplates and zone.js per ' +
      'project. Understands angular.json, Nx and solution style. Call once per session.',
    inputSchema: {
      path: z
        .string()
        .optional()
        .describe('Any file or folder inside the workspace; defaults to the working directory'),
    },
  },
  async ({ path }) =>
    tracked(async () => {
      try {
        const inside = path ? resolveFile(path) : process.cwd();
        const project = locateProject(inside);
        const ts = await loadTypeScript(project.root);
        const map = describeWorkspaceMap(ts, project.root, project.angularCoreVersion);
        if (prewarm) {
          // Failures stay silent: the first real call meets the same problem and reports it.
          warmUpAround(inside, map).catch(() => {});
        }
        return json(compact(map));
      } catch (error) {
        return failure(error);
      }
    }),
);

server.registerTool(
  'ng_version_rules',
  {
    title: 'Angular: rules for the project version',
    description:
      'What exists and what does not in this project\'s Angular version: template syntax, signal ' +
      'APIs, zoneless, DI. Every rule was measured on the v17-v22 stand.',
    inputSchema: {
      topic: z
        .enum(['components', 'control-flow', 'signals', 'di', 'forms', 'testing'])
        .optional()
        .describe('Narrow the answer to one topic'),
      path: z
        .string()
        .optional()
        .describe('Any file or folder inside the workspace; defaults to the working directory'),
    },
  },
  async ({ topic, path }) =>
    tracked(async () => {
      try {
        const inside = path ? resolveFile(path) : process.cwd();
        const project = locateProject(inside);
        return json(
          compact(versionRules(project.angularCoreVersion, project.angularMajor, topic)),
        );
      } catch (error) {
        return failure(error);
      }
    }),
);

server.registerTool(
  'ng_find_usages',
  {
    title: 'Angular: find usages',
    description:
      'Usages of a component, directive, pipe or service across the workspace: elements, ' +
      'attribute selectors, pipes and class references. Accepts a file path or a selector.',
    inputSchema: {
      selectorOrFile: z
        .string()
        .describe('Path to the declaring .ts, or the selector itself: app-user-card, [appDrag], money'),
      input: z
        .string()
        .optional()
        .describe('Only tag usages binding this input/output; entries then point at the binding'),
      path: z
        .string()
        .optional()
        .describe('Scope the search to this folder (a file means its folder); default is the whole workspace'),
      limit: z.number().int().min(1).max(500).optional().describe('How many usages to return, 100 by default'),
    },
  },
  async ({ selectorOrFile, input, path, limit }) =>
    tracked(async () => {
      try {
        const asPath = isAbsolute(selectorOrFile) || /[\\/]/.test(selectorOrFile);
        const file = asPath ? componentFileFor(resolveFile(selectorOrFile)) : null;
        const scoped = path ? resolveFile(path) : null;
        let target;
        let projectRoot: string | null = null;
        if (file) {
          projectRoot = locateProject(file).root;
          const ts = await loadTypeScript(projectRoot);
          target = targetOf(ts, readFileSync(file, 'utf8'), file);
        } else {
          target = targetFromSelector(selectorOrFile);
        }
        // The scan base is the given folder, not the workspace root findRoot walks up to:
        // without this a monorepo query always mixes every application (b2b/b2c twins).
        // A bare selector with a scope is a plain text search - no Angular workspace needed.
        let scanRoot: string;
        if (scoped) {
          scanRoot = statSync(scoped).isDirectory() ? scoped : dirname(scoped);
        } else {
          scanRoot = projectRoot ?? locateProject(process.cwd()).root;
        }
        const report = findUsages(scanRoot, target, {
          ...(file ? { declaredIn: file } : {}),
          ...(input !== undefined ? { input } : {}),
          limit: limit ?? 100,
          fileLimit: 20_000,
        });
        return json(compact({ root: scanRoot, ...report }));
      } catch (error) {
        return failure(error);
      }
    }),
);

// Child ngserver processes do not outlive the parent quietly, so we kill them explicitly.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    registry.disposeAll();
    process.exit(0);
  });
}

await server.connect(new StdioServerTransport());

// EOF on stdin is the polite shutdown request; the signals above stay the impatient one.
process.stdin.on('end', () => {
  stdinClosed = true;
  finishAfterEof();
});
