// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// Where a component, directive or pipe is used. A selector can be attribute-based, a tag can
// wrap onto the next line, and a pipe name differs from its class name.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type * as TS from 'typescript';

type TypeScriptApi = typeof TS;

export interface Target {
  /** Element names from the selector: app-user-card. */
  elements: string[];
  /** Attribute names from the selector: appHighlight. */
  attributes: string[];
  /** Pipe names from @Pipe({ name }). */
  pipes: string[];
  /** Class names, for programmatic use and imports arrays. */
  classNames: string[];
}

export interface Usage {
  file: string;
  line: number;
  character: number;
  kind: 'element' | 'attribute' | 'pipe' | 'code' | 'declaration';
  context: string;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.angular', '.nx', 'coverage', 'out-tsc', 'tmp']);
const CONTEXT_LIMIT = 120;

// An Angular selector is a comma-separated list, and each part can mix an element, attributes
// and classes: 'button[appButton], [appButton]'. :not(...) describes absence, so its contents
// are excluded from the search.
export function parseSelector(selector: string): { elements: string[]; attributes: string[] } {
  const elements: string[] = [];
  const attributes: string[] = [];
  for (const raw of selector.split(',')) {
    const part = raw.replace(/:not\([^)]*\)/g, '').trim();
    const element = /^([a-zA-Z][\w-]*)/.exec(part);
    if (element?.[1]) {
      elements.push(element[1]);
    }
    for (const match of part.matchAll(/\[([\w-]+)/g)) {
      if (match[1]) {
        attributes.push(match[1]);
      }
    }
  }
  return { elements: [...new Set(elements)], attributes: [...new Set(attributes)] };
}

// Take everything the file declares: a @Pipe keeps its name in name, not in selector.
export function targetOf(ts: TypeScriptApi, text: string, fileName: string): Target {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const target: Target = { elements: [], attributes: [], pipes: [], classNames: [] };
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement)) {
      continue;
    }
    for (const decorator of ts.getDecorators(statement) ?? []) {
      const call = ts.isCallExpression(decorator.expression) ? decorator.expression : null;
      const name = (call ? call.expression : decorator.expression).getText().split('.').pop();
      const meta = call?.arguments[0];
      if (!meta || !ts.isObjectLiteralExpression(meta)) {
        continue;
      }
      const written = (key: string): string | null => {
        for (const property of meta.properties) {
          if (ts.isPropertyAssignment(property) && property.name.getText() === key) {
            return ts.isStringLiteralLike(property.initializer) ? property.initializer.text : null;
          }
        }
        return null;
      };
      if (name === 'Component' || name === 'Directive') {
        const selector = written('selector');
        if (selector) {
          const parsed = parseSelector(selector);
          target.elements.push(...parsed.elements);
          target.attributes.push(...parsed.attributes);
        }
      } else if (name === 'Pipe') {
        const pipe = written('name');
        if (pipe) {
          target.pipes.push(pipe);
        }
      } else {
        continue;
      }
      if (statement.name) {
        target.classNames.push(statement.name.text);
      }
    }
  }
  return target;
}

// 'Looks like an element selector' is all one can tell from a bare string.
export function targetFromSelector(selector: string): Target {
  const parsed = parseSelector(selector);
  // A word without a dash may also be a pipe, so both readings are checked. With a dash it never
  // is: those names belong to elements, and an extra pattern would only muddy the results.
  const asPipe = /^\w+$/.test(selector.trim()) ? [selector.trim()] : [];
  return {
    elements: parsed.elements,
    attributes: parsed.attributes,
    pipes: asPipe,
    classNames: [],
  };
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

interface Pattern {
  kind: Usage['kind'];
  regex: RegExp;
}

function patternsFor(target: Target): Pattern[] {
  const patterns: Pattern[] = [];
  for (const element of target.elements) {
    // Opening tag only: the closing tag is the same usage, not a second one.
    // Tags often wrap: <app-card\n [x]="y", hence a word boundary rather than a closing >.
    patterns.push({ kind: 'element', regex: new RegExp(`<${escape(element)}(?![\\w-])`, 'g') });
  }
  for (const attribute of target.attributes) {
    // Four spellings: appDrag, [appDrag], (appDrag) and the structural *appDrag.
    patterns.push({
      kind: 'attribute',
      regex: new RegExp(`[\\s[(*]${escape(attribute)}(?![\\w-])`, 'g'),
    });
  }
  for (const pipe of target.pipes) {
    patterns.push({ kind: 'pipe', regex: new RegExp(`\\|\\s*${escape(pipe)}(?![\\w-])`, 'g') });
  }
  for (const className of target.classNames) {
    patterns.push({ kind: 'code', regex: new RegExp(`\\b${escape(className)}\\b`, 'g') });
  }
  return patterns;
}

function positionOf(text: string, index: number): { line: number; character: number } {
  let line = 1;
  let start = 0;
  for (let at = text.indexOf('\n'); at !== -1 && at < index; at = text.indexOf('\n', at + 1)) {
    line += 1;
    start = at + 1;
  }
  return { line, character: index - start + 1 };
}

// The window is centred on the match: generated markup can produce lines longer than the limit,
// and trimming from the start would return context that does not contain the match at all.
function contextAt(text: string, index: number): string {
  const from = text.lastIndexOf('\n', index) + 1;
  const to = text.indexOf('\n', index);
  const line = text.slice(from, to === -1 ? text.length : to);
  if (line.trim().length <= CONTEXT_LIMIT) {
    return line.trim();
  }
  const start = Math.max(0, Math.min(index - from - 30, line.length - CONTEXT_LIMIT));
  const window = line.slice(start, start + CONTEXT_LIMIT).trim();
  return `${start > 0 ? '…' : ''}${window}${start + CONTEXT_LIMIT < line.length ? '…' : ''}`;
}

// Commented-out markup is not a usage. Length is preserved with spaces, otherwise every
// position and line number would shift.
export function stripComments(text: string, html: boolean): string {
  const blank = (match: string): string => match.replace(/[^\n]/g, ' ');
  if (html) {
    return text.replace(/<!--[\s\S]*?-->/g, blank);
  }
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

function collectFiles(root: string, limit: number): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Check the limit per file: otherwise one large folder slips past it entirely.
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(full);
        }
      } else if (entry.name.endsWith('.html') || entry.name.endsWith('.ts')) {
        files.push(full);
      }
    }
  };
  walk(root);
  return { files, truncated };
}

export interface UsageReport {
  target: Target;
  total: number;
  usages: Usage[];
  scannedFiles: number;
  incomplete: string | null;
}

export function findUsages(
  root: string,
  target: Target,
  options: { declaredIn?: string; limit: number; fileLimit: number },
): UsageReport {
  const patterns = patternsFor(target);
  const scan = collectFiles(root, options.fileLimit);
  const usages: Usage[] = [];
  let total = 0;

  let codeHits = 0;
  for (const file of scan.files) {
    const declaring = options.declaredIn !== undefined && file.toLowerCase() === options.declaredIn.toLowerCase();
    let original;
    try {
      original = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const text = stripComments(original, file.endsWith('.html'));
    for (const pattern of patterns) {
      // In its own file only the class name is skipped: the selector inside that same file's
      // template is a recursive usage and must not be lost.
      if (declaring && pattern.kind === 'code') {
        continue;
      }
      pattern.regex.lastIndex = 0;
      for (let hit = pattern.regex.exec(text); hit; hit = pattern.regex.exec(text)) {
        // A selector inside decorator metadata is a declaration. Look immediately before the
        // match rather than at the whole line: a one-line @Component also holds the template.
        const before = text.slice(Math.max(0, hit.index - 40), hit.index);
        const declaration = /\b(selector|name)\s*:\s*['"`][^'"`]*$/.test(before);
        if (declaring && declaration) {
          continue;
        }
        total += 1;
        if (pattern.kind === 'code') {
          codeHits += 1;
        }
        if (usages.length < options.limit) {
          const at = positionOf(text, hit.index);
          usages.push({
            file: relative(root, file).replace(/\\/g, '/'),
            line: at.line,
            character: at.character,
            kind: declaration ? 'declaration' : pattern.kind,
            context: contextAt(original, hit.index),
          });
        }
      }
    }
  }

  const notes: string[] = [];
  if (total > usages.length) {
    notes.push(`showing the first ${usages.length} of ${total}`);
  }
  if (scan.truncated) {
    notes.push(`the walk stopped at ${scan.files.length} files, so the workspace was not fully scanned`);
  }
  if (patterns.length === 0) {
    notes.push('neither a selector nor a pipe name could be extracted from the target, so there was nothing to search for');
  }
  if (codeHits > 0) {
    notes.push(
      `${codeHits} matches of kind code were found by class name without resolving imports, so same-named classes from other modules may be included`,
    );
  }
  return {
    target,
    total,
    usages,
    scannedFiles: scan.files.length,
    incomplete: notes.length > 0 ? notes.join('; ') : null,
  };
}
