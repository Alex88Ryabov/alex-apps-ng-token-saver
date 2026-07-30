// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// Angular template-awareness MCP server: six tools over the language server and the TS AST.

import { existsSync, readFileSync } from 'node:fs';
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
// again. Chosen, not measured. Override with NG_TOKEN_SAVER_IDLE_MS; 0 disables the shutdown.
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

const server = new McpServer({ name: 'ng-token-saver', version: '0.1.0' });

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
  async ({ file, line, character }) => {
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
  },
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
  async ({ file }) => {
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
  },
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
  async ({ file }) => {
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
      return json(
        compact({
          found: true,
          // Echo the path only when it differs from the one passed in: the echo costs ~100 chars.
          file: path === requested ? null : path,
          angularVersion: project.angularCoreVersion,
          ...chosen,
          others: others.length > 0 ? others : null,
        }),
      );
    } catch (error) {
      return failure(error);
    }
  },
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
  async ({ path }) => {
    try {
      const inside = path ? resolveFile(path) : process.cwd();
      const project = locateProject(inside);
      const ts = await loadTypeScript(project.root);
      return json(compact(describeWorkspaceMap(ts, project.root, project.angularCoreVersion)));
    } catch (error) {
      return failure(error);
    }
  },
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
  async ({ topic, path }) => {
    try {
      const inside = path ? resolveFile(path) : process.cwd();
      const project = locateProject(inside);
      return json(
        compact(versionRules(project.angularCoreVersion, project.angularMajor, topic)),
      );
    } catch (error) {
      return failure(error);
    }
  },
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
      path: z
        .string()
        .optional()
        .describe('Where to search when a selector is given: any path inside the workspace'),
      limit: z.number().int().min(1).max(500).optional().describe('How many usages to return, 100 by default'),
    },
  },
  async ({ selectorOrFile, path, limit }) => {
    try {
      const asPath = isAbsolute(selectorOrFile) || /[\\/]/.test(selectorOrFile);
      const file = asPath ? componentFileFor(resolveFile(selectorOrFile)) : null;
      const project = locateProject(file ?? (path ? resolveFile(path) : process.cwd()));
      let target;
      if (file) {
        const ts = await loadTypeScript(project.root);
        target = targetOf(ts, readFileSync(file, 'utf8'), file);
      } else {
        target = targetFromSelector(selectorOrFile);
      }
      const report = findUsages(project.root, target, {
        ...(file ? { declaredIn: file } : {}),
        limit: limit ?? 100,
        fileLimit: 20_000,
      });
      return json(compact({ root: project.root, ...report }));
    } catch (error) {
      return failure(error);
    }
  },
);

// Child ngserver processes do not outlive the parent quietly, so we kill them explicitly.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    registry.disposeAll();
    process.exit(0);
  });
}

await server.connect(new StdioServerTransport());
