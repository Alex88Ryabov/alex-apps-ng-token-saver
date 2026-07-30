// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// The workspace map, read from config files with no server involved. Three layouts:
// angular.json, Nx with project.json, and tsconfig-only (solution style, as on the stand).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type * as TS from 'typescript';

type TypeScriptApi = typeof TS;

export interface ProjectEntry {
  name: string;
  type: 'application' | 'library' | 'unknown';
  root: string;
  sourceRoot: string | null;
  tsConfig: string | null;
  /** After resolving the extends chain. null means the tsconfig could not be read. */
  strictTemplates: boolean | null;
  /** A fact, not a verdict: whether zone.js is in the build polyfills. null means no build target. */
  zoneJs: boolean | null;
}

export interface WorkspaceMap {
  root: string;
  kind: 'angular-cli' | 'nx' | 'tsconfig-only';
  angularVersion: string;
  cliVersion: string | null;
  typescriptVersion: string | null;
  projects: ProjectEntry[];
  /** In words: the project list is partial, and why. */
  incomplete: string | null;
}

// Angular configs are JSONC: comments are routine and JSON.parse chokes on them. We read them
// with the project's own compiler, the only thing that parses them properly.
function readJsonc(ts: TypeScriptApi, file: string): Record<string, unknown> | null {
  if (!existsSync(file)) {
    return null;
  }
  const outcome = ts.readConfigFile(file, (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  });
  const config: unknown = outcome.config;
  if (outcome.error || typeof config !== 'object' || config === null) {
    return null;
  }
  return config as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// strictTemplates is inherited through extends, so we walk the chain up to the first config that
// sets it. If nobody sets it, Angular's default is false.
function strictTemplatesOf(ts: TypeScriptApi, tsconfig: string, depth = 0): boolean | null {
  if (depth > 8) {
    return null;
  }
  const config = readJsonc(ts, tsconfig);
  if (!config) {
    return null;
  }
  const angularOptions = asRecord(config['angularCompilerOptions']);
  const written = angularOptions?.['strictTemplates'];
  if (typeof written === 'boolean') {
    return written;
  }
  const inherits = config['extends'];
  // Multiple extends (TS 5.0+): we do not resolve precedence, so 'unknown' is the honest answer.
  if (Array.isArray(inherits)) {
    return null;
  }
  const parent = asString(inherits);
  if (!parent) {
    return false;
  }
  // A package in extends (no leading ./) cannot be resolved here, so we say 'unknown'.
  if (!parent.startsWith('.')) {
    return null;
  }
  const resolved = resolve(dirname(tsconfig), parent.endsWith('.json') ? parent : `${parent}.json`);
  return strictTemplatesOf(ts, resolved, depth + 1);
}

function zoneJsOf(root: string, build: Record<string, unknown> | null): boolean | null {
  if (!build) {
    return null;
  }
  const polyfills = build['polyfills'];
  if (Array.isArray(polyfills)) {
    return polyfills.some((item) => typeof item === 'string' && item.includes('zone.js'));
  }
  if (typeof polyfills === 'string') {
    // Old schema: polyfills is a file, and zone.js is imported inside it, not named in the path.
    return polyfills.endsWith('.ts') ? importsZoneJs(resolve(root, polyfills)) : polyfills.includes('zone.js');
  }
  return null;
}

// The stock polyfills.ts mentions zone.js in comments even where it is not enabled, so we look
// for the import statement itself.
function importsZoneJs(file: string): boolean | null {
  try {
    const text = readFileSync(file, 'utf8');
    return /(?:^|\n)\s*import\s+['"][^'"]*zone\.js|require\(\s*['"][^'"]*zone\.js/.test(text);
  } catch {
    return null;
  }
}

// angular.json and project.json describe a project almost identically, so we normalise both.
function entryOf(
  ts: TypeScriptApi,
  root: string,
  name: string,
  definition: Record<string, unknown>,
): ProjectEntry {
  const targets = asRecord(definition['targets']) ?? asRecord(definition['architect']);
  const build = asRecord(targets?.['build']);
  const options = asRecord(build?.['options']);
  const declaredType = asString(definition['projectType']);
  const projectRoot = asString(definition['root']) ?? '';
  const tsConfig = asString(options?.['tsConfig']);
  const absolute = tsConfig ? resolve(root, tsConfig) : null;
  return {
    name,
    type: declaredType === 'application' || declaredType === 'library' ? declaredType : 'unknown',
    root: projectRoot,
    sourceRoot: asString(definition['sourceRoot']),
    tsConfig,
    strictTemplates: absolute ? strictTemplatesOf(ts, absolute) : null,
    zoneJs: zoneJsOf(root, options),
  };
}

function fromAngularJson(ts: TypeScriptApi, root: string): ProjectEntry[] | null {
  const config = readJsonc(ts, join(root, 'angular.json'));
  const projects = asRecord(config?.['projects']);
  if (!projects) {
    return null;
  }
  return Object.entries(projects).flatMap(([name, definition]) => {
    const record = asRecord(definition);
    return record ? [entryOf(ts, root, name, record)] : [];
  });
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.angular', '.nx', 'coverage', 'tmp']);

interface Scan {
  files: string[];
  /** The walk hit a limit: the list is partial, and staying silent about that is not an option. */
  truncated: boolean;
}

// Nx keeps no single list of projects: each one is declared by its own project.json. We do not
// descend into a project once found: only sources live there, and they nest arbitrarily deep.
function findProjectFiles(root: string, depth: number, scan: Scan): void {
  if (scan.files.length >= 500) {
    scan.truncated = true;
    return;
  }
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((entry) => entry.isFile() && entry.name === 'project.json')) {
    scan.files.push(join(root, 'project.json'));
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) {
      continue;
    }
    if (depth <= 0) {
      scan.truncated = true;
      continue;
    }
    findProjectFiles(join(root, entry.name), depth - 1, scan);
  }
}

function fromNx(ts: TypeScriptApi, root: string, scan: Scan): ProjectEntry[] | null {
  if (!existsSync(join(root, 'nx.json'))) {
    return null;
  }
  findProjectFiles(root, 5, scan);
  return scan.files.flatMap((file) => {
    const config = readJsonc(ts, file);
    if (!config) {
      return [];
    }
    const folder = relative(root, dirname(file)).replace(/\\/g, '/');
    const name = asString(config['name']) ?? folder;
    return [entryOf(ts, root, name, { root: folder, ...config })];
  });
}

// Neither angular.json nor nx.json, so tsconfigs are all that is left. That is the stand, and
function fromTsconfigs(ts: TypeScriptApi, root: string, scan: Scan): ProjectEntry[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (found.length >= 100) {
      scan.truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // No early exit here: in solution style the root is a project itself and holds others.
    entries
      .filter((entry) => /^tsconfig\.(app|lib)\.json$/.test(entry.name))
      .forEach((entry) => found.push(join(dir, entry.name)));
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) {
        continue;
      }
      if (depth <= 0) {
        scan.truncated = true;
        continue;
      }
      walk(join(dir, entry.name), depth - 1);
    }
  };
  walk(root, 5);
  return found.map((file) => {
    const folder = relative(root, dirname(file)).replace(/\\/g, '/');
    return {
      name: folder === '' ? 'root' : folder,
      type: file.endsWith('tsconfig.lib.json') ? ('library' as const) : ('application' as const),
      root: folder,
      sourceRoot: null,
      tsConfig: relative(root, file).replace(/\\/g, '/'),
      strictTemplates: strictTemplatesOf(ts, file),
      zoneJs: null,
    };
  });
}

function versionOf(root: string, pkg: string): string | null {
  const file = join(root, 'node_modules', pkg, 'package.json');
  if (!existsSync(file)) {
    return null;
  }
  try {
    return asString((JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)['version']);
  } catch {
    return null;
  }
}

export function describeWorkspaceMap(
  ts: TypeScriptApi,
  root: string,
  angularVersion: string,
): WorkspaceMap {
  // An empty list from Nx means 'nx.json exists but no project.json' - that is how package-based
  // repositories and Nx on top of a plain CLI workspace look. Treating that as the final answer
  // would report zero projects for a perfectly alive workspace.
  const scan: Scan = { files: [], truncated: false };
  const nx = fromNx(ts, root, scan);
  const found = nx && nx.length > 0 ? nx : null;
  const cli = found ? null : fromAngularJson(ts, root);
  const projects = found ?? cli ?? fromTsconfigs(ts, root, scan);
  return {
    root,
    kind: found ? 'nx' : cli ? 'angular-cli' : 'tsconfig-only',
    angularVersion,
    cliVersion: versionOf(root, join('@angular', 'cli')),
    typescriptVersion: versionOf(root, 'typescript'),
    projects,
    incomplete: scan.truncated && !cli
      ? 'the workspace walk hit a depth or count limit, so the project list is partial'
      : null,
  };
}
