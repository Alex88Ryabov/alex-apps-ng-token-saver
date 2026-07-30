// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// The public contract of a component, taken from the TS AST. The LSP answers about a position
// rather than a whole class, so parsing lives here: no Program, no type checking, only what is
// actually written in the file.

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as TS from 'typescript';
import { WorkspaceError } from './lsp/workspace.js';

type TypeScriptApi = typeof TS;

export interface InputInfo {
  name: string;
  type: string | null;
  required: boolean;
  isSignal: boolean;
  alias: string | null;
}

export interface OutputInfo {
  name: string;
  type: string | null;
  alias: string | null;
}

export interface MemberInfo {
  name: string;
  kind: 'property' | 'method' | 'accessor' | 'signal';
  signature: string;
}

export interface ComponentContract {
  className: string;
  kind: 'component' | 'directive';
  selector: string | null;
  standalone: boolean;
  /** Only what the decorator says: where the default-OnPush boundary sits was never measured. */
  changeDetection: string | null;
  templateUrl: string | null;
  inlineTemplate: boolean;
  styleUrls: string[];
  imports: string[];
  /** Host directive names; resolveAncestors merges what their object form exposes. */
  hostDirectives: string[];
  /** The direct base class as written; resolveAncestors merges its members when it can. */
  extends: string | null;
  /** Resolved extends chain whose members are merged below, nearest ancestor first. */
  ancestors: string[] | null;
  inputs: InputInfo[];
  outputs: OutputInfo[];
  publicMembers: MemberInfo[];
  /** Says in words that the lists are partial: otherwise 'no such input' and 'input lives in another file' look the same. */
  incomplete: string | null;
}

const loaded = new Map<string, Promise<TypeScriptApi>>();

// TypeScript comes from the project's node_modules, not ours: across the v17..v22 stand that is
// 5.4..6.0, and parsing must use the very compiler that builds the project.
export function loadTypeScript(root: string): Promise<TypeScriptApi> {
  const key = root.toLowerCase();
  const known = loaded.get(key);
  if (known) {
    return known;
  }
  const entry = join(root, 'node_modules', 'typescript', 'lib', 'typescript.js');
  if (!existsSync(entry)) {
    throw new WorkspaceError(
      `no typescript in ${root}/node_modules`,
      'install the project dependencies (npm install)',
    );
  }
  // Cache the promise, not the result: concurrent calls must not load the compiler twice.
  // A broken typescript.js cannot be fixed within one process: Node itself caches the module.
  const loading = import(pathToFileURL(entry).href).then((module) => {
    // The API arrives under default across the whole stand: the file stays CJS even in 6.x.
    const api = (module as { default?: TypeScriptApi }).default;
    if (!api) {
      throw new WorkspaceError(
        `${entry} did not expose the TypeScript API`,
        'unexpected layout of the typescript package in this project',
      );
    }
    return api;
  });
  loaded.set(key, loading);
  return loading;
}

// The component class lives in the .ts, but the agent usually has the template at hand.
export function componentFileFor(path: string): string {
  if (!path.endsWith('.html')) {
    return path;
  }
  const companion = path.replace(/\.html$/, '.ts');
  if (!existsSync(companion)) {
    throw new WorkspaceError(
      `no .ts with a matching name next to ${basename(path)}`,
      'pass the component file directly',
    );
  }
  return companion;
}

// One file can hold several components; the template points at its own.
export function pickComponent(
  found: ComponentContract[],
  template: string | null,
): ComponentContract | undefined {
  if (template) {
    const byTemplate = found.find(
      (item) => item.templateUrl !== null && basename(item.templateUrl) === template,
    );
    if (byTemplate) {
      return byTemplate;
    }
  }
  return found[0];
}

export function describeComponents(
  ts: TypeScriptApi,
  text: string,
  fileName: string,
  angularMajor: number,
): ComponentContract[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: ComponentContract[] = [];
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement)) {
      continue;
    }
    const decorated = angularDecorator(ts, statement);
    if (decorated) {
      found.push(contractOf(ts, statement, decorated.kind, decorated.meta, angularMajor));
    }
  }
  return found;
}

interface Decorated {
  kind: 'component' | 'directive';
  meta: TS.ObjectLiteralExpression | null;
}

function angularDecorator(ts: TypeScriptApi, node: TS.ClassDeclaration): Decorated | null {
  for (const decorator of ts.getDecorators(node) ?? []) {
    const call = ts.isCallExpression(decorator.expression) ? decorator.expression : null;
    const reference = call ? call.expression : decorator.expression;
    // The import can go through a namespace: @core.Component({...}).
    const name = reference.getText().split('.').pop();
    if (name !== 'Component' && name !== 'Directive') {
      continue;
    }
    const first = call?.arguments[0];
    return {
      kind: name === 'Component' ? 'component' : 'directive',
      meta: first && ts.isObjectLiteralExpression(first) ? first : null,
    };
  }
  return null;
}

function contractOf(
  ts: TypeScriptApi,
  node: TS.ClassDeclaration,
  kind: 'component' | 'directive',
  meta: TS.ObjectLiteralExpression | null,
  angularMajor: number,
): ComponentContract {
  const written = boolProp(ts, meta, 'standalone');
  const styleUrl = stringProp(ts, meta, 'styleUrl');
  const baseClass = baseClassOf(ts, node);
  const hostDirectiveSpecs = hostDirectiveSpecsOf(ts, meta);
  const members = collectMembers(ts, node, meta);

  return {
    className: node.name?.text ?? '(anonymous class)',
    kind,
    selector: stringProp(ts, meta, 'selector'),
    // Implicit standalone turns on from 19.0.0, which is how the shipped compiler gates it too.
    standalone: written ?? angularMajor >= 19,
    changeDetection: lastSegment(ts, meta, 'changeDetection'),
    templateUrl: stringProp(ts, meta, 'templateUrl'),
    inlineTemplate: propOf(ts, meta, 'template') !== null,
    styleUrls: [...stringArrayProp(ts, meta, 'styleUrls'), ...(styleUrl ? [styleUrl] : [])],
    imports: textArrayProp(ts, meta, 'imports'),
    hostDirectives: hostDirectiveSpecs.map((spec) => spec.name),
    extends: baseClass,
    ancestors: null,
    ...members,
    incomplete: incompletenessOf(ts, node.getSourceFile(), baseClass, hostDirectiveSpecs),
  };
}

interface MemberBag {
  inputs: InputInfo[];
  outputs: OutputInfo[];
  publicMembers: MemberInfo[];
}

// Shared by the component itself and by every ancestor: a base class carries the same
// member shapes, with or without an Angular decorator of its own.
function collectMembers(
  ts: TypeScriptApi,
  node: TS.ClassDeclaration,
  meta: TS.ObjectLiteralExpression | null,
): MemberBag {
  const inputs: InputInfo[] = [];
  const outputs: OutputInfo[] = [];
  const publicMembers: MemberInfo[] = [];

  // A get/set pair is two members sharing a name, and @Input can sit on either half.
  const groups = new Map<string, TS.ClassElement[]>();
  for (const member of node.members) {
    const name = isHidden(ts, member) ? null : nameOf(ts, member);
    if (!name) {
      continue;
    }
    const known = groups.get(name);
    if (known) {
      known.push(member);
    } else {
      groups.set(name, [member]);
    }
  }
  for (const [name, group] of groups) {
    classifyMember(ts, group, name, inputs, outputs, publicMembers);
  }
  // Legacy form: inputs/outputs as string lists in the decorator. The field is declared in the
  // class and already parsed with its real type, so we move it rather than duplicate it as null.
  declaredInMeta(ts, meta, 'inputs').forEach((item) => {
    const known = takeMember(publicMembers, item.name);
    inputs.push({
      name: item.name,
      type: known,
      required: false,
      isSignal: false,
      alias: item.alias,
    });
  });
  declaredInMeta(ts, meta, 'outputs').forEach((item) => {
    outputs.push({ name: item.name, type: emitted(takeMember(publicMembers, item.name)), alias: item.alias });
  });
  return { inputs, outputs, publicMembers };
}

// The partial-contract flag must be in the answer itself and in words: the agent is not obliged
// to read extends/hostDirectives, and 'no such input' looks exactly like 'input is elsewhere'.
// The import path goes with the name: without it the advice to ask about those files is useless.
function incompletenessOf(
  ts: TypeScriptApi,
  source: TS.SourceFile,
  baseClass: string | null,
  hostDirectives: HostDirectiveSpec[],
): string | null {
  const sources: string[] = [];
  if (baseClass) {
    sources.push(`base class ${namedWithImport(ts, source, baseClass)}`);
  }
  // A bare reference exposes nothing bindable and is not a source of incompleteness.
  const exposed = hostDirectives.filter((spec) => spec.inputs.length > 0 || spec.outputs.length > 0);
  if (exposed.length > 0) {
    sources.push(
      `host directives ${exposed.map((spec) => namedWithImport(ts, source, spec.name)).join(', ')}`,
    );
  }
  return incompleteMessage(sources);
}

function namedWithImport(ts: TypeScriptApi, source: TS.SourceFile, name: string): string {
  const from = importSpecifierOf(ts, source, name.replace(/<.*$/, ''));
  return from ? `${name} (imported from '${from}')` : name;
}

function incompleteMessage(sources: string[]): string | null {
  if (sources.length === 0) {
    return null;
  }
  return `inputs, outputs and members of ${sources.join(' and ')} are not collected here - ask ng_component_info about their files`;
}

// The path is reported as written: resolving aliases is TypeScript's job, not ours.
function importSpecifierOf(ts: TypeScriptApi, source: TS.SourceFile, name: string): string | null {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    const hit = bindings.elements.some((element) => element.name.text === name);
    if (hit && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      return statement.moduleSpecifier.text;
    }
  }
  return null;
}

function classifyMember(
  ts: TypeScriptApi,
  group: TS.ClassElement[],
  name: string,
  inputs: InputInfo[],
  outputs: OutputInfo[],
  publicMembers: MemberInfo[],
): void {
  // For a get/set pair the decorator can sit on either half, in any order in the file.
  // For an overloaded method take the implementation: its signature is how you actually call it.
  const member =
    group.find((item) => memberDecorator(ts, item, ['Input', 'Output'])) ??
    group.find((item) => ts.isMethodDeclaration(item) && item.body !== undefined) ??
    group[0]!;
  const initializer = ts.isPropertyDeclaration(member) ? member.initializer : undefined;
  // Annotations are often omitted: look for a type across the pair, then at the initializer.
  const declared =
    group.map((item) => writtenType(ts, item)).find((type) => type !== null) ??
    literalType(ts, initializer);

  const decorator = memberDecorator(ts, member, ['Input', 'Output']);
  if (decorator) {
    const options = aliasAndRequired(ts, decorator.args);
    if (decorator.name === 'Input') {
      inputs.push({
        name,
        type: declared,
        required: options.required,
        isSignal: false,
        alias: options.alias,
      });
    } else {
      outputs.push({ name, type: emitted(declared), alias: options.alias });
    }
    return;
  }

  const call = initializer && ts.isCallExpression(initializer) ? factoryCall(ts, initializer) : null;
  if (call?.factory === 'input' || call?.factory === 'model') {
    inputs.push({
      name,
      type: call.type,
      required: call.required,
      isSignal: true,
      alias: call.alias,
    });
    // model is a pair: an input plus a <name>Change output that is nowhere in the class body.
    if (call.factory === 'model') {
      outputs.push({ name: `${name}Change`, type: call.type, alias: call.alias ? `${call.alias}Change` : null });
    }
    return;
  }
  if (call?.factory === 'output') {
    outputs.push({ name, type: call.type, alias: call.alias });
    return;
  }

  if (ts.isMethodDeclaration(member)) {
    publicMembers.push({ name, kind: 'method', signature: methodSignature(ts, member, name) });
    return;
  }
  if (call && SIGNAL_FACTORIES.has(call.factory)) {
    // Signals are called in templates, so a signature with parentheses is the most useful thing here.
    publicMembers.push({ name, kind: 'signal', signature: `${name}()${suffix(call.type)}` });
    return;
  }
  const kind = ts.isPropertyDeclaration(member) ? 'property' : 'accessor';
  publicMembers.push({ name, kind, signature: `${name}${suffix(declared)}` });
}

// Knowing a member is a signal matters more than its type for template work: it needs parentheses.
// resource() and httpResource() are excluded: they return ResourceRef, an interface with a
// value: Signal<T> field; it is not callable and reads as resource.value() in a template.
const SIGNAL_FACTORIES = new Set([
  'signal',
  'computed',
  'linkedSignal',
  'toSignal',
  'viewChild',
  'viewChildren',
  'contentChild',
  'contentChildren',
]);

interface FactoryCall {
  factory: string;
  required: boolean;
  type: string | null;
  alias: string | null;
}

// input.required<T>(), model<T>(x, {alias}), output<T>(): we parse the call, not the type.
function factoryCall(ts: TypeScriptApi, call: TS.CallExpression): FactoryCall {
  const callee = call.expression.getText();
  const required = callee.endsWith('.required');
  const factory = (required ? callee.slice(0, -'.required'.length) : callee).split('.').pop() ?? '';
  const written = call.typeArguments?.[0];
  const positional = call.arguments.filter((item) => !ts.isObjectLiteralExpression(item));
  const options = call.arguments.find((item) => ts.isObjectLiteralExpression(item));
  return {
    factory,
    required,
    type: written ? typeText(written) : literalType(ts, positional[0]),
    alias: options && ts.isObjectLiteralExpression(options) ? stringProp(ts, options, 'alias') : null,
  };
}

function aliasAndRequired(
  ts: TypeScriptApi,
  args: readonly TS.Expression[],
): { alias: string | null; required: boolean } {
  const first = args[0];
  if (!first) {
    return { alias: null, required: false };
  }
  if (ts.isObjectLiteralExpression(first)) {
    return { alias: stringProp(ts, first, 'alias'), required: boolProp(ts, first, 'required') === true };
  }
  return { alias: ts.isStringLiteralLike(first) ? first.text : null, required: false };
}

function memberDecorator(
  ts: TypeScriptApi,
  member: TS.ClassElement,
  wanted: string[],
): { name: string; args: readonly TS.Expression[] } | null {
  const list = ts.canHaveDecorators(member) ? (ts.getDecorators(member) ?? []) : [];
  for (const decorator of list) {
    const call = ts.isCallExpression(decorator.expression) ? decorator.expression : null;
    const name = (call ? call.expression : decorator.expression).getText().split('.').pop() ?? '';
    if (wanted.includes(name)) {
      return { name, args: call?.arguments ?? [] };
    }
  }
  return null;
}

// Templates can see protected but not private, #fields or static, so those are hidden.
function isHidden(ts: TypeScriptApi, member: TS.ClassElement): boolean {
  if (member.name && ts.isPrivateIdentifier(member.name)) {
    return true;
  }
  if (ts.isConstructorDeclaration(member)) {
    return true;
  }
  const modifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : [];
  return modifiers.some(
    (item) => item.kind === ts.SyntaxKind.PrivateKeyword || item.kind === ts.SyntaxKind.StaticKeyword,
  );
}

function nameOf(ts: TypeScriptApi, member: TS.ClassElement): string | null {
  const name = member.name;
  if (!name) {
    return null;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  return null;
}

// The type is taken as written: without a Program there is nothing to infer from, and guessing is not allowed.
function writtenType(ts: TypeScriptApi, member: TS.ClassElement): string | null {
  if (ts.isPropertyDeclaration(member) || ts.isGetAccessorDeclaration(member)) {
    return member.type ? typeText(member.type) : null;
  }
  if (ts.isSetAccessorDeclaration(member)) {
    const parameter = member.parameters[0];
    return parameter?.type ? typeText(parameter.type) : null;
  }
  return null;
}

function literalType(ts: TypeScriptApi, node: TS.Expression | undefined): string | null {
  if (!node) {
    return null;
  }
  if (ts.isStringLiteralLike(node)) {
    return 'string';
  }
  if (ts.isNumericLiteral(node)) {
    return 'number';
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    return 'boolean';
  }
  if (ts.isNewExpression(node)) {
    const args = node.typeArguments?.map(typeText).join(', ');
    return `${node.expression.getText()}${args ? `<${args}>` : ''}`;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const inner = literalType(ts, node.elements[0]);
    return inner ? `${inner}[]` : null;
  }
  return null;
}

// An output is described by its event type, not the wrapper: @Output() x = new EventEmitter<number>() -> number.
function emitted(type: string | null): string | null {
  if (!type) {
    return null;
  }
  const match = /^(?:EventEmitter|OutputEmitterRef)<(.+)>$/.exec(type);
  return match?.[1] ?? type;
}

function methodSignature(ts: TypeScriptApi, member: TS.MethodDeclaration, name: string): string {
  const parameters = member.parameters
    .map((parameter) => {
      const optional = parameter.questionToken ? '?' : '';
      return `${parameter.name.getText()}${optional}${suffix(parameter.type ? typeText(parameter.type) : null)}`;
    })
    .join(', ');
  return `${name}(${parameters})${suffix(member.type ? typeText(member.type) : null)}`;
}

function suffix(type: string | null): string {
  return type ? `: ${type}` : '';
}

function typeText(node: TS.TypeNode): string {
  return node.getText().replace(/\s+/g, ' ');
}

function baseClassOf(ts: TypeScriptApi, node: TS.ClassDeclaration): string | null {
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
      const first = clause.types[0];
      return first ? first.getText() : null;
    }
  }
  return null;
}

function propOf(
  ts: TypeScriptApi,
  meta: TS.ObjectLiteralExpression | null,
  name: string,
): TS.Expression | null {
  for (const property of meta?.properties ?? []) {
    if (ts.isPropertyAssignment(property) && property.name.getText() === name) {
      return property.initializer;
    }
  }
  return null;
}

function stringProp(
  ts: TypeScriptApi,
  meta: TS.ObjectLiteralExpression | null,
  name: string,
): string | null {
  const value = propOf(ts, meta, name);
  return value && ts.isStringLiteralLike(value) ? value.text : null;
}

function boolProp(
  ts: TypeScriptApi,
  meta: TS.ObjectLiteralExpression | null,
  name: string,
): boolean | null {
  const value = propOf(ts, meta, name);
  if (value?.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (value?.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  return null;
}

// ChangeDetectionStrategy.OnPush → OnPush.
function lastSegment(
  ts: TypeScriptApi,
  meta: TS.ObjectLiteralExpression | null,
  name: string,
): string | null {
  const value = propOf(ts, meta, name);
  return value ? (value.getText().split('.').pop() ?? null) : null;
}

function stringArrayProp(
  ts: TypeScriptApi,
  meta: TS.ObjectLiteralExpression | null,
  name: string,
): string[] {
  const value = propOf(ts, meta, name);
  if (!value || !ts.isArrayLiteralExpression(value)) {
    return [];
  }
  return value.elements.filter(ts.isStringLiteralLike).map((item) => item.text);
}

function textArrayProp(
  ts: TypeScriptApi,
  meta: TS.ObjectLiteralExpression | null,
  name: string,
): string[] {
  const value = propOf(ts, meta, name);
  if (!value || !ts.isArrayLiteralExpression(value)) {
    return [];
  }
  return value.elements.map((item) => item.getText().replace(/\s+/g, ' '));
}

interface HostDirectiveSpec {
  name: string;
  /** Exposure lists as written: 'inner' or 'inner: outer'. Empty means nothing is bindable. */
  inputs: string[];
  outputs: string[];
}

// Angular exposes a host directive's inputs and outputs only when they are listed in the
// object form; a bare class reference applies the directive but exposes nothing bindable.
function hostDirectiveSpecsOf(ts: TypeScriptApi, meta: TS.ObjectLiteralExpression | null): HostDirectiveSpec[] {
  const value = propOf(ts, meta, 'hostDirectives');
  if (!value || !ts.isArrayLiteralExpression(value)) {
    return [];
  }
  return value.elements.map((item) => {
    if (!ts.isObjectLiteralExpression(item)) {
      return { name: item.getText().replace(/\s+/g, ' '), inputs: [], outputs: [] };
    }
    const named = propOf(ts, item, 'directive');
    return {
      name: (named ?? item).getText().replace(/\s+/g, ' '),
      inputs: stringArrayProp(ts, item, 'inputs'),
      outputs: stringArrayProp(ts, item, 'outputs'),
    };
  });
}


// The legacy form declares the input in the decorator and the field in the class. Take the type
// from the parsed member and remove it from publicMembers so the field is not listed twice.
function takeMember(members: MemberInfo[], name: string): string | null {
  const index = members.findIndex((item) => item.name === name);
  if (index < 0) {
    return null;
  }
  const [removed] = members.splice(index, 1);
  const tail = removed?.signature.slice(name.length) ?? '';
  return tail.startsWith(': ') ? tail.slice(2) : null;
}

function declaredInMeta(
  ts: TypeScriptApi,
  meta: TS.ObjectLiteralExpression | null,
  name: 'inputs' | 'outputs',
): Array<{ name: string; alias: string | null }> {
  return stringArrayProp(ts, meta, name).map((entry) => {
    const [declared, alias] = entry.split(':').map((part) => part.trim());
    return { name: declared ?? entry, alias: alias ?? null };
  });
}

// A chain deeper than this is treated as unresolvable; nothing real comes close.
const ANCESTOR_DEPTH_LIMIT = 10;

// Walks the extends chain and merges inherited inputs, outputs and members into the contract,
// then expands host directives: the names their object form exposes become inputs/outputs of
// the contract, typed from the directive class resolved with the same machinery. Resolution
// is deliberately static - the same file, a relative import, a tsconfig path alias - and a
// link it cannot follow (a package, a mixin call) stays named in `incomplete`: a missing
// member is honest, an invented one is not.
export function resolveAncestors(
  ts: TypeScriptApi,
  contract: ComponentContract,
  file: string,
  projectRoot: string,
): ComponentContract {
  if (!contract.extends && contract.hostDirectives.length === 0) {
    return contract;
  }
  const parsed = new Map<string, TS.SourceFile>();
  const sourceOf = (path: string): TS.SourceFile => {
    const key = path.toLowerCase();
    const known = parsed.get(key);
    if (known) {
      return known;
    }
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    parsed.set(key, source);
    return source;
  };

  const merged: ComponentContract = {
    ...contract,
    inputs: [...contract.inputs],
    outputs: [...contract.outputs],
    publicMembers: [...contract.publicMembers],
  };
  // The component itself is pre-visited, or a (broken) extends cycle would merge it into itself.
  const visited = new Set<string>([`${file.toLowerCase()}#${contract.className}`]);
  const chain = walkExtends(ts, sourceOf, projectRoot, file, contract.extends, visited);
  for (const step of chain.steps) {
    mergeInherited(merged, step.bag);
  }
  merged.ancestors = chain.steps.length > 0 ? chain.steps.map((step) => step.name) : null;

  // Host directives are inherited in Angular, so an ancestor's count like the component's
  // own. The contract keeps only names, so the component's specs are re-read from its file.
  const ownNode = findClassIn(ts, sourceOf(file), contract.className);
  const ownSpecs = ownNode
    ? hostDirectiveSpecsOf(ts, angularDecorator(ts, ownNode)?.meta ?? null)
    : contract.hostDirectives.map((name) => ({ name, inputs: [], outputs: [] }));
  const refs: Array<HostDirectiveSpec & { file: string }> = [];
  for (const candidate of [
    ...ownSpecs.map((spec) => ({ ...spec, file })),
    ...chain.steps.flatMap((step) => step.hostSpecs.map((spec) => ({ ...spec, file: step.file }))),
  ]) {
    if (!refs.some((ref) => ref.name === candidate.name)) {
      refs.push(candidate);
    }
  }

  const parts: string[] = [];
  if (chain.unresolved) {
    parts.push(`base class ${chain.unresolved}`);
  }
  const unresolvedHosts: string[] = [];
  for (const ref of refs) {
    // A bare reference exposes nothing bindable, so there is nothing to collect or to flag.
    if (ref.inputs.length === 0 && ref.outputs.length === 0) {
      continue;
    }
    const found = directiveBag(ts, sourceOf, projectRoot, ref.file, ref.name);
    mergeExposed(merged, exposeFrom(found?.bag ?? null, ref));
    // Unresolved covers both faces: the directive itself, or a link inside its own chain -
    // either way an untyped exposure must not read as a typo in the exposure list.
    if (!found || found.unresolved) {
      unresolvedHosts.push(namedWithImport(ts, sourceOf(ref.file), ref.name));
    }
  }
  if (unresolvedHosts.length > 0) {
    parts.push(`host directives ${unresolvedHosts.join(', ')}`);
  }
  merged.hostDirectives = refs.map((ref) => ref.name);
  merged.incomplete = incompleteMessage(parts);
  return merged;
}

interface ChainStep {
  bag: MemberBag;
  hostSpecs: HostDirectiveSpec[];
  file: string;
  name: string;
}

// The extends walk, shared between the component itself and its host directives' classes.
// Returns per-ancestor bags nearest-first; unresolved is the link static resolution refused,
// already named with its import specifier.
function walkExtends(
  ts: TypeScriptApi,
  sourceOf: (path: string) => TS.SourceFile,
  projectRoot: string,
  file: string,
  firstBase: string | null,
  visited: Set<string>,
): { steps: ChainStep[]; unresolved: string | null } {
  const steps: ChainStep[] = [];
  let currentFile = file;
  let baseText: string | null = firstBase;
  let unresolved: string | null = null;

  while (baseText) {
    const currentSource = sourceOf(currentFile);
    const baseName = baseText.replace(/<.*$/, '').trim();
    // A mixin call or a namespaced base is not statically resolvable without a checker.
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(baseName) || steps.length >= ANCESTOR_DEPTH_LIMIT) {
      unresolved = namedWithImport(ts, currentSource, baseText);
      break;
    }
    let baseFile = currentFile;
    let baseNode = findClassIn(ts, currentSource, baseName);
    if (!baseNode) {
      const specifier = importSpecifierOf(ts, currentSource, baseName);
      const target = specifier ? resolveImportTarget(ts, currentFile, specifier, projectRoot) : null;
      const found = target ? findClassInModule(ts, sourceOf, projectRoot, target, baseName) : null;
      baseNode = found?.node ?? null;
      baseFile = found?.file ?? currentFile;
    }
    const key = `${baseFile.toLowerCase()}#${baseName}`;
    if (!baseNode || visited.has(key)) {
      unresolved = namedWithImport(ts, currentSource, baseText);
      break;
    }
    visited.add(key);
    const meta = angularDecorator(ts, baseNode)?.meta ?? null;
    steps.push({
      bag: collectMembers(ts, baseNode, meta),
      hostSpecs: hostDirectiveSpecsOf(ts, meta),
      file: baseFile,
      name: baseName,
    });
    currentFile = baseFile;
    baseText = baseClassOf(ts, baseNode);
  }
  return { steps, unresolved };
}

// The full member bag of a host directive class: its own members plus its extends chain.
// Nested host directives of the directive are not expanded: an exposure that points into
// them comes out with a null type rather than an invented one.
function directiveBag(
  ts: TypeScriptApi,
  sourceOf: (path: string) => TS.SourceFile,
  projectRoot: string,
  fromFile: string,
  name: string,
): { bag: MemberBag; unresolved: string | null } | null {
  const source = sourceOf(fromFile);
  let node = findClassIn(ts, source, name);
  let declaredIn = fromFile;
  if (!node) {
    const specifier = importSpecifierOf(ts, source, name);
    const target = specifier ? resolveImportTarget(ts, fromFile, specifier, projectRoot) : null;
    const found = target ? findClassInModule(ts, sourceOf, projectRoot, target, name) : null;
    node = found?.node ?? null;
    declaredIn = found?.file ?? fromFile;
  }
  if (!node) {
    return null;
  }
  const bag = collectMembers(ts, node, angularDecorator(ts, node)?.meta ?? null);
  const visited = new Set<string>([`${declaredIn.toLowerCase()}#${name}`]);
  const chain = walkExtends(ts, sourceOf, projectRoot, declaredIn, baseClassOf(ts, node), visited);
  for (const step of chain.steps) {
    mergeInherited(bag, step.bag);
  }
  return { bag, unresolved: chain.unresolved };
}

// 'inner: outer' exposes the directive's public name inner as outer on the host. The public
// name is the alias when the directive declared one. An exposure the bag cannot back keeps
// its outer name with a null type: present and bindable, but not typed.
function exposeFrom(
  bag: MemberBag | null,
  ref: HostDirectiveSpec,
): { inputs: InputInfo[]; outputs: OutputInfo[] } {
  const split = (entry: string): { inner: string; outer: string } => {
    const [inner, outer] = entry.split(':').map((part) => part.trim());
    return { inner: inner ?? entry, outer: outer ?? inner ?? entry };
  };
  const inputs = ref.inputs.map((entry) => {
    const { inner, outer } = split(entry);
    const found = bag?.inputs.find((item) => (item.alias ?? item.name) === inner) ?? null;
    if (found) {
      return { ...found, name: outer, alias: null };
    }
    return { name: outer, type: null, required: false, isSignal: false, alias: null };
  });
  const outputs = ref.outputs.map((entry) => {
    const { inner, outer } = split(entry);
    const found = bag?.outputs.find((item) => (item.alias ?? item.name) === inner) ?? null;
    return { name: outer, type: found?.type ?? null, alias: null };
  });
  return { inputs, outputs };
}

// Exposed names join the contract unless the component already declares the name itself.
function mergeExposed(
  target: MemberBag,
  exposed: { inputs: InputInfo[]; outputs: OutputInfo[] },
): void {
  const taken = new Set(
    [...target.inputs, ...target.outputs, ...target.publicMembers].map((item) => item.name),
  );
  for (const input of exposed.inputs) {
    if (!taken.has(input.name)) {
      target.inputs.push(input);
      taken.add(input.name);
    }
  }
  for (const output of exposed.outputs) {
    if (!taken.has(output.name)) {
      target.outputs.push(output);
      taken.add(output.name);
    }
  }
}

// The nearest declaration wins: a child that redeclares a name shadows every ancestor.
// One exception, straight from Angular semantics: decorator metadata is inherited, so a
// child field redeclared WITHOUT @Input over an ancestor @Input still binds as an input.
// The entry stays an input and takes the child's type.
function mergeInherited(target: MemberBag, inherited: MemberBag): void {
  const taken = new Set(
    [...target.inputs, ...target.outputs, ...target.publicMembers].map((item) => item.name),
  );
  const push = <T extends { name: string }>(list: T[], item: T): void => {
    if (!taken.has(item.name)) {
      list.push(item);
      taken.add(item.name);
    }
  };
  const plainChildMember = (name: string): boolean => {
    return target.publicMembers.some((item) => item.name === name);
  };
  for (const input of inherited.inputs) {
    if (!taken.has(input.name)) {
      push(target.inputs, input);
    } else if (plainChildMember(input.name)) {
      const childType = takeMember(target.publicMembers, input.name);
      target.inputs.push({ ...input, type: childType ?? input.type });
    }
  }
  for (const output of inherited.outputs) {
    if (!taken.has(output.name)) {
      push(target.outputs, output);
    } else if (plainChildMember(output.name)) {
      const childType = takeMember(target.publicMembers, output.name);
      target.outputs.push({ ...output, type: childType ? emitted(childType) : output.type });
    }
  }
  inherited.publicMembers.forEach((item) => push(target.publicMembers, item));
}

function findClassIn(ts: TypeScriptApi, source: TS.SourceFile, name: string): TS.ClassDeclaration | null {
  for (const statement of source.statements) {
    if (ts.isClassDeclaration(statement) && statement.name?.text === name) {
      return statement;
    }
  }
  return null;
}

interface FoundClass {
  node: TS.ClassDeclaration;
  file: string;
}

// Aliases almost always land on a barrel: an index.ts of re-exports and not a single class.
// Follow `export * from` and `export { X } from` (with renames) a few hops deep.
function findClassInModule(
  ts: TypeScriptApi,
  sourceOf: (path: string) => TS.SourceFile,
  projectRoot: string,
  file: string,
  name: string,
  visited: Set<string> = new Set(),
): FoundClass | null {
  // The key is (file, name), not the file alone: a renamed re-export may legitimately come
  // back to an already visited file looking for a different class.
  const key = `${file.toLowerCase()}#${name}`;
  if (visited.has(key) || visited.size >= 20) {
    return null;
  }
  visited.add(key);
  const source = sourceOf(file);
  const direct = findClassIn(ts, source, name);
  if (direct) {
    return { node: direct, file };
  }
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }
    const spec = statement.moduleSpecifier;
    const from =
      spec && ts.isStringLiteralLike(spec) ? resolveImportTarget(ts, file, spec.text, projectRoot) : null;
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const element = statement.exportClause.elements.find((item) => item.name.text === name);
      if (!element) {
        continue;
      }
      // export { Inner as Name }: past this barrel the class goes by its inner name.
      const innerName = element.propertyName?.text ?? name;
      if (!from) {
        const local = findClassIn(ts, source, innerName);
        if (local) {
          return { node: local, file };
        }
        continue;
      }
      const hit = findClassInModule(ts, sourceOf, projectRoot, from, innerName, visited);
      if (hit) {
        return hit;
      }
    } else if (!statement.exportClause && from) {
      const hit = findClassInModule(ts, sourceOf, projectRoot, from, name, visited);
      if (hit) {
        return hit;
      }
    }
  }
  return null;
}

interface AliasTable {
  baseUrl: string;
  patterns: Array<[string, string[]]>;
}

// Cached for the process lifetime, like loadTypeScript: a paths entry edited in tsconfig
// is not picked up until restart. Conscious trade-off, recorded in CLAUDE.md.
const aliases = new Map<string, AliasTable>();

// Nx keeps paths in tsconfig.base.json, the CLI in tsconfig.json at the root; both are
// JSONC, so only the compiler's own reader can parse them (fact 16). paths can also sit
// an extends-hop deeper, so each candidate is followed up the chain like strictTemplates.
function aliasesOf(ts: TypeScriptApi, root: string): AliasTable {
  const key = root.toLowerCase();
  const known = aliases.get(key);
  if (known) {
    return known;
  }
  const table =
    pathsFromConfig(ts, join(root, 'tsconfig.base.json'), 0) ??
    pathsFromConfig(ts, join(root, 'tsconfig.json'), 0) ?? { baseUrl: root, patterns: [] };
  aliases.set(key, table);
  return table;
}

// Without baseUrl, paths resolve relative to the config file that declares them.
function pathsFromConfig(ts: TypeScriptApi, configPath: string, depth: number): AliasTable | null {
  if (depth > 5 || !existsSync(configPath)) {
    return null;
  }
  const config = ts.readConfigFile(configPath, (path) => readFileSync(path, 'utf8')).config as
    | {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
        extends?: unknown;
      }
    | undefined;
  const options = config?.compilerOptions;
  if (options?.paths) {
    return {
      baseUrl: resolve(dirname(configPath), options.baseUrl ?? '.'),
      patterns: Object.entries(options.paths),
    };
  }
  // A package extends (no leading dot) would need the project's resolver: refuse.
  const parent =
    typeof config?.extends === 'string' && config.extends.startsWith('.') ? config.extends : null;
  if (!parent) {
    return null;
  }
  const next = resolve(dirname(configPath), parent);
  return pathsFromConfig(ts, next.endsWith('.json') ? next : `${next}.json`, depth + 1);
}

// The specifier may name a file with or without extension, a folder with an index.ts, or -
// NodeNext style - a .js path that means the .ts next to it.
function existingTsFile(base: string): string | null {
  const candidates = base.endsWith('.ts')
    ? [base]
    : base.endsWith('.js')
      ? [base.replace(/\.js$/, '.ts')]
      : [`${base}.ts`, join(base, 'index.ts')];
  return candidates.find((item) => existsSync(item)) ?? null;
}

function resolveImportTarget(
  ts: TypeScriptApi,
  fromFile: string,
  specifier: string,
  projectRoot: string,
): string | null {
  if (specifier.startsWith('.')) {
    return existingTsFile(resolve(dirname(fromFile), specifier));
  }
  const { baseUrl, patterns } = aliasesOf(ts, projectRoot);
  for (const [pattern, targets] of patterns) {
    const star = pattern.indexOf('*');
    let tail: string | null = null;
    if (star < 0) {
      tail = specifier === pattern ? '' : null;
    } else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
        tail = specifier.slice(prefix.length, specifier.length - suffix.length);
      }
    }
    if (tail === null) {
      continue;
    }
    for (const target of targets) {
      const hit = existingTsFile(resolve(baseUrl, target.replace('*', tail)));
      if (hit) {
        return hit;
      }
    }
  }
  // Anything else is a package: without the project's resolver we refuse rather than guess.
  return null;
}
