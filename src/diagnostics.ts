// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// ng_template_diagnostics answers, kept out of the entry point so their shape can be tested.

import { resolve } from 'node:path';
import type * as TS from 'typescript';
import { loadTypeScript } from './component-info.js';
import { belongsTo, projectDirOf } from './format.js';
import type { NgSession } from './lsp/session.js';
import { writtenStrictTemplates } from './workspace-map.js';

// ok distinguishes a healthy answer from a broken server, so the single-file call can keep
// failing loudly while a batch reports per file.
export interface FileDiagnostics {
  ok: boolean;
  body: Record<string, unknown>;
}

// The language service sends Angular's own codes as -99 followed by the code (ngErrorCode in
// its bundle), and TypeScript's as they are. Checked against ngc on v17: NG2010, TS2339.
export function diagnosticCode(code: string | number | undefined): string | null {
  if (typeof code === 'string') {
    return code;
  }
  if (code === undefined) {
    return null;
  }
  const text = String(code);
  return text.startsWith('-99') ? `NG${text.slice(3)}` : `TS${text}`;
}

// The server suggests strict mode for every tsconfig that does not write strictTemplates: true,
// yet the shipped 22.0.8 checks strictly when the flag is simply absent (fact 20, re-checked on
// a v22 probe). Only a written false switches the checks off.
export function checksDisabledNote(
  ts: typeof TS,
  path: string,
  suggestedFor: string[],
): string | null {
  const config = suggestedFor.find((item) => belongsTo(path, projectDirOf(item)));
  if (!config) {
    return null;
  }
  const written = writtenStrictTemplates(ts, resolve(config));
  if (written === false) {
    return `strictTemplates is off in ${config}, so an empty list does not mean the template is correct`;
  }
  if (written === null) {
    return `strictTemplates in ${config} could not be traced through extends; if it is false, an empty list does not mean the template is correct`;
  }
  return null;
}

export async function diagnoseFile(session: NgSession, path: string): Promise<FileDiagnostics> {
  const list = await session.diagnosticsFor(path);
  if (list.length === 0) {
    // 'No errors' only means anything when the server is healthy.
    const health = await session.healthNear(path);
    if (health.state === 'broken') {
      return { ok: false, body: { error: health.reason, hint: health.hint, ...session.serverNotices() } };
    }
    const { strictTemplatesOff } = session.serverNotices();
    if (strictTemplatesOff.length > 0) {
      const ts = await loadTypeScript(session.workspace.root);
      const checksDisabled = checksDisabledNote(ts, path, strictTemplatesOff);
      if (checksDisabled) {
        return { ok: true, body: { diagnostics: [], checksDisabled } };
      }
    }
  }
  return {
    ok: true,
    body: {
      diagnostics: list.map((item) => ({
        // The server anchors some template-published entries in the companion .ts (a host
        // listener error came as line 69 of a 58-line template); file appears only then.
        ...(item.file !== undefined ? { file: item.file } : {}),
        line: item.range.start.line + 1,
        character: item.range.start.character + 1,
        code: diagnosticCode(item.code),
        severity: item.severity ?? 1,
        message: item.message,
      })),
    },
  };
}
