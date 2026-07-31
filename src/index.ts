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
import {
  belongsTo,
  compact,
  json,
  kindFromSignature,
  projectDirOf,
  toolError,
  type ToolResult,
} from './format.js';
import { SessionRegistry } from './lsp/registry.js';
import { NgSession, SessionError } from './lsp/session.js';
import { locateProject, WorkspaceError } from './lsp/workspace.js';
import { findUsages, targetFromSelector, targetOf } from './find-usages.js';
import { versionRules } from './version-rules.js';
import { describeWorkspaceMap } from './workspace-map.js';

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
function failure(error: unknown): ToolResult {
  if (error instanceof WorkspaceError || error instanceof SessionError) {
    return toolError({ error: error.message, hint: error.hint });
  }
  return toolError({ error: error instanceof Error ? error.message : String(error) });
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

const server = new McpServer({ name: 'ng-token-saver', version: '0.1.2' });

server.registerTool(
  'ng_template_definition',
  {
    title: 'Angular: declaration of a template symbol',
    description:
      'From a position in an Angular template (.html or inline in .ts) to its TypeScript declaration. ' +
      'line and character are 0-based, as in LSP.',
    inputSchema: {
      file: z.string().describe('Path to the template: .html, or .ts with an inline template'),
      line: z.number().int().min(0),
      character: z.number().int().min(0),
    },
  },
  async ({ file, line, character }) =>
    tracked(async () => {
      try {
        const path = resolveFile(file);
        const session = registry.acquire(path);
        const [hit] = await session.definitionAt(path, { line, character });
        if (!hit) {
          // An empty answer is indistinguishable from a failure, so we check with a canary.
          const health = await session.healthNear(path);
          if (health.state === 'broken') {
            return toolError({ error: health.reason, hint: health.hint, ...session.serverNotices() });
          }
          return json({ found: false });
        }
        const signature = await session.hoverAt(path, { line, character });
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
      'Angular compiler errors for a template after an edit. Accepts .html or .ts. ' +
      'An empty list means "no errors" only when the server is healthy.',
    inputSchema: {
      file: z.string().describe('Path to the template or to the component'),
    },
  },
  async ({ file }) =>
    tracked(async () => {
      try {
        const path = resolveFile(file);
        const session = registry.acquire(path);
        const list = await session.diagnosticsFor(path);
        if (list.length === 0) {
          // 'No errors' only means anything when the server is healthy.
          const health = await session.healthNear(path);
          if (health.state === 'broken') {
            return toolError({ error: health.reason, hint: health.hint, ...session.serverNotices() });
          }
          // And it means nothing at all when the compiler was told not to check templates.
          // The server reports one notice per project; we attach the one this file belongs to.
          const { strictTemplatesOff } = session.serverNotices();
          const off = strictTemplatesOff.find((config) => belongsTo(path, projectDirOf(config)));
          if (off) {
            return json({
              diagnostics: [],
              checksDisabled:
                `strictTemplates is off in ${off}, so an empty list does not mean the template is correct`,
            });
          }
        }
        return json({
          diagnostics: list.map((item) => ({
            line: item.range.start.line + 1,
            character: item.range.start.character + 1,
            code: typeof item.code === 'number' ? `NG${item.code}` : (item.code ?? null),
            severity: item.severity ?? 1,
            message: item.message,
          })),
        });
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
            // Both lists stay off the wire when empty: a repeated [] carries nothing.
            implements: complete.implements.length > 0 ? complete.implements : null,
            lifecycle: complete.lifecycle.length > 0 ? complete.lifecycle : null,
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
        return json(compact(describeWorkspaceMap(ts, project.root, project.angularCoreVersion)));
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
      'Usages of a component, directive or pipe across the workspace: elements, attribute ' +
      'selectors, pipes and class references. Accepts a file path or a selector.',
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
