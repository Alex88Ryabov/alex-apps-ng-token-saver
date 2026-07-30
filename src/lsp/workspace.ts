// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// Workspace discovery: Angular major, server branch selection, probe locations.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** What we know about a project without starting the server is enough for TS AST parsing. */
export interface ProjectInfo {
  root: string;
  angularMajor: number;
  /** Exact @angular/core version: the server gates block syntax, @let and standalone on it. */
  angularCoreVersion: string;
}

export interface WorkspaceInfo extends ProjectInfo {
  serverDir: string;
  ngProbe: string;
  tsProbe: string;
}

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

// The root is the nearest ancestor holding node_modules: in a monorepo it sits above the app.
function findRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'node_modules'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new WorkspaceError(
        `no node_modules found in ${start} or above it`,
        'install project dependencies (npm install) and pass a path inside the workspace',
      );
    }
    dir = parent;
  }
}

// We read the version from node_modules rather than package.json: they drift apart, and the
// server works with what is actually installed.
function readDeclaredRange(root: string): string | null {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) {
    return null;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return pkg.dependencies?.['@angular/core'] ?? null;
}

function readAngularVersion(root: string, searchedFrom: string): string {
  const pkgPath = join(root, 'node_modules', '@angular', 'core', 'package.json');
  if (!existsSync(pkgPath)) {
    // Name the start of the search too: the nearest node_modules can belong to an unrelated
    // outer project, and a message naming only that folder sends the reader the wrong way.
    throw new WorkspaceError(
      `no @angular/core in ${root}/node_modules (the nearest node_modules found above ${searchedFrom})`,
      'this is not an Angular workspace, or dependencies are not installed',
    );
  }
  const version = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '';
  if (!Number.isFinite(Number(version.split('.')[0]))) {
    throw new WorkspaceError(
      `could not parse the @angular/core version: "${version}"`,
      'check node_modules/@angular/core/package.json',
    );
  }
  return version;
}

// Always the newest branch. Measured: branches 17-20 fail to bind external templates to
// projects in solution-style workspaces (ensureProjectAnalyzed only landed in 21), while the
// newest branch serves the whole v17-v22 range as long as it gets the exact core version.
const NEWEST_BRANCH = 'ls22';

function pickServerDir(major: number, serversDir: string, declared: string | null): string {
  if (major < 17 || major > 22) {
    const mismatch =
      declared && !declared.includes(String(major))
        ? ` package.json declares ${declared}, so node_modules looks stale; npm install helps.`
        : '';
    throw new WorkspaceError(
      `node_modules has Angular v${major} installed, which is outside the supported v17-v22 range`,
      `support is added by running a fixture for that major.${mismatch}`,
    );
  }
  const dir = join(serversDir, NEWEST_BRANCH);
  // Check both packages: require.resolve walks up the tree and would silently pick up
  // someone else's language-service if ours is missing.
  for (const pkg of ['language-server', 'language-service']) {
    if (!existsSync(join(dir, 'node_modules', '@angular', pkg))) {
      throw new WorkspaceError(
        `server branch ${NEWEST_BRANCH} has no @angular/${pkg}`,
        `run npm install in ${dir}`,
      );
    }
  }
  return dir;
}

export function locateProject(anyPathInside: string): ProjectInfo {
  const root = findRoot(anyPathInside);
  const angularCoreVersion = readAngularVersion(root, resolve(anyPathInside));
  return { root, angularMajor: Number(angularCoreVersion.split('.')[0]), angularCoreVersion };
}

export function describeWorkspace(anyPathInside: string, serversDir: string): WorkspaceInfo {
  const project = locateProject(anyPathInside);
  const { root, angularMajor } = project;
  const serverDir = pickServerDir(angularMajor, serversDir, readDeclaredRange(root));
  return {
    ...project,
    serverDir,
    // ng-probe points at the server: real projects usually have no @angular/language-service,
    // and probing the project kills the process in ~200 ms.
    ngProbe: join(serverDir, 'node_modules'),
    tsProbe: join(root, 'node_modules'),
  };
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.angular', '.nx', 'coverage', 'out-tsc']);

// Canary: a template with an interpolation we use to check that the server resolves symbols
// in this project at all. Without it an empty answer is indistinguishable from a failure.
export function findCanaryTemplates(from: string, limit: number): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (found.length >= limit) {
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) {
        return;
      }
      const full = join(dir, entry);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        if (!SKIP_DIRS.has(entry)) {
          walk(full);
        }
        continue;
      }
      if (!entry.endsWith('.component.html')) {
        continue;
      }
      if (!existsSync(full.replace(/\.html$/, '.ts'))) {
        continue;
      }
      if (/\{\{\s*[A-Za-z_$]/.test(readFileSync(full, 'utf8'))) {
        found.push(full);
      }
    }
  };
  walk(from);
  return found;
}

export function firstInterpolation(text: string): { line: number; character: number } | null {
  const lines = text.split(/\r?\n/);
  for (let line = 0; line < lines.length; line += 1) {
    const content = lines[line] ?? '';
    const match = /\{\{\s*([A-Za-z_$][\w$]*)/.exec(content);
    if (match?.[1]) {
      return { line, character: match.index + match[0].indexOf(match[1]) + 1 };
    }
  }
  return null;
}
