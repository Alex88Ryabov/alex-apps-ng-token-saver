// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// Usage guidance for the MCP instructions field. Unlike tool descriptions, which a client may
// defer until a tool search, it stays in the agent's context: the one place to say which tool
// replaces which habit. README quotes it, and a test keeps the two in step.

const GUIDANCE =
  'Angular tools that answer from the compiler and the source instead of whole files. Prefer ' +
  'them to reading and grepping: ng_component_info for what a component or directive accepts ' +
  '(inputs, outputs, members, inherited ones included) instead of reading its .ts; ' +
  'ng_find_usages for where a component, directive, pipe or service is used, and with input ' +
  'for where one input is bound, instead of grep; ng_template_diagnostics after editing a ' +
  'template instead of ng build; ng_template_definition for what a template symbol is; ' +
  'ng_version_rules before suggesting an Angular API; ng_workspace_map once for projects, ' +
  'versions and strictTemplates. The first diagnostics or definition call in a workspace loads ' +
  'the project into the Angular language server and takes up to a minute on a large workspace; ' +
  'later calls take milliseconds, so a slow first answer is not a hang. Lines and characters ' +
  'are 1-based everywhere, as Read shows them.';

const PREWARM_NOTE =
  ' ng_workspace_map with a path inside an app also starts loading that app in the background.';

export function instructionsFor(prewarm: boolean): string {
  return prewarm ? GUIDANCE + PREWARM_NOTE : GUIDANCE;
}
