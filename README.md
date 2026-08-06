# ng-token-saver

[![npm version](https://img.shields.io/npm/v/%40alex-apps%2Fng-token-saver)](https://www.npmjs.com/package/@alex-apps/ng-token-saver)
[![weekly downloads](https://img.shields.io/npm/dw/%40alex-apps%2Fng-token-saver)](https://www.npmjs.com/package/@alex-apps/ng-token-saver)
[![node](https://img.shields.io/node/v/%40alex-apps%2Fng-token-saver)](#requirements-and-setup)
[![license](https://img.shields.io/npm/l/%40alex-apps%2Fng-token-saver)](LICENSE)

An MCP server that lets an AI agent understand Angular **templates** by asking the same
compiler that builds the project, instead of guessing from file text. The token saving is
measured, not promised.

Angular ships a first-class language server, but no official AI integration exposes it — the
Angular CLI MCP (`ng mcp`) works at the docs-and-build level and does not touch templates.
This server is that missing layer, and it answers **for the Angular version the project
actually runs**.

Everything below marked as measured was produced by running code against six real Angular
workspaces (17.3.12, 18.2.14, 19.2.25, 20.3.26, 21.2.18, 22.0.8) and two production projects.
Every number can be reproduced with the commands in
[Reproducing the measurements](#reproducing-the-measurements).

## Quick start

The language server ships as a regular dependency — nothing to install besides the package:

```
npm install -g @alex-apps/ng-token-saver
```

Claude Code:

```
claude mcp add ng-token-saver -- ng-token-saver
```

Codex CLI:

```
codex mcp add ng-token-saver -- ng-token-saver
```

Any other MCP client:

```json
{ "mcpServers": { "ng-token-saver": { "command": "ng-token-saver" } } }
```

Or skip the install and let the client fetch it through npx:

```json
{ "mcpServers": { "ng-token-saver": { "command": "npx", "args": ["-y", "@alex-apps/ng-token-saver"] } } }
```

In Cursor that npx form is one click:

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=ng-token-saver&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBhbGV4LWFwcHMvbmctdG9rZW4tc2F2ZXIiXX0%3D)

The npm and npx paths are verified by running: the packed tarball (79 kB, dist only) was
installed into a clean prefix and all four tool kinds answered through a real MCP client,
and the npx form connects in 1.2–2.0 s from a warm npm cache (the very first run on a
machine also downloads the dependency tree — the language server alone unpacks to 13.6 MB).

A first question to ask it — the contract of a component whose members are scattered across
an extends chain. Asked for `fixtures/v17/src/app/derived-card.component.ts` (a fixture in
this repository), `ng_component_info` answers, verbatim:

```json
{"found":true,"angularVersion":"17.3.12","className":"DerivedCardComponent","kind":"component","selector":"app-derived-card","standalone":true,"inlineTemplate":true,"styleUrls":[],"imports":[],"hostDirectives":[],"extends":"BasePanel","ancestors":["BasePanel","BaseWidget"],"inputs":[{"name":"accent","type":"boolean"},{"name":"heading","type":"string"},{"name":"disabled","type":"boolean"}],"outputs":[{"name":"blurred","type":"void"}],"publicMembers":[{"name":"focus","kind":"method","signature":"focus(): void","noop":true},{"name":"collapse","kind":"method","signature":"collapse(animated: boolean): void","noop":true}]}
```

624 characters, 305 ms on the session's first call (it loads the project's own TypeScript),
single-digit milliseconds after. The asked file declares one input and an `extends` clause;
`heading`, `disabled`, the output and both methods live in `BasePanel` and `BaseWidget` and
are resolved statically, and `"noop": true` on `focus()` is the subclass shadowing it with
an empty body — the kind of fact that otherwise costs a whole file read per ancestor.

Configs for Cursor, VS Code, Windsurf, Codex CLI and JetBrains, the Node floor, and running
from source are in [Requirements and setup](#requirements-and-setup).

## The two problems it solves

**1. No template awareness.** `grep` over an `.html` file cannot tell you where
`{{ user().fullName }}` is declared, and no amount of reading gives you `NG2339 Property
'emailAddress' does not exist on type 'UserVm'`. That is compiler output, not text.

**2. Version drift.** The AI context files on angular.dev (`llms.txt`) describe only the
newest major and carry no version markers; the versioned archive sites serve none at all.
On v17–v21 they hand the agent instructions that produce APIs which do not exist. Measured
examples are in [Version facts](#version-facts).

## Tools

Six tools, 921 characters of descriptions in total. Answers are dense JSON with no markdown.

| Tool | What it answers | Needs the language server |
|---|---|---|
| `ng_template_definition` | where a symbol under this template position is declared | yes |
| `ng_template_diagnostics` | Angular compiler errors for this template | yes |
| `ng_component_info` | the public contract of a component or directive | no |
| `ng_workspace_map` | projects, versions, `strictTemplates` and zone.js per project | no |
| `ng_version_rules` | what exists and what does not in this project's Angular version | no |
| `ng_find_usages` | where a component, directive, pipe or service is used; with `input` — where that input is bound | no |

Four of the six never start the language server, so they answer in milliseconds and keep
working on workspaces where the server refuses to load.

## Measured: contract instead of the whole file

`ng_component_info` returns the public contract of a component rather than its source.
Measured across two production codebases through a real MCP client:

| | Nx monorepo | CLI workspace\* |
|---|---|---|
| Angular / TypeScript | 19.2.18 / 5.8.3 | 17.3.8 / 5.3.3 |
| Components in the tally | 1298 | 407 |
| Parse errors | 0 | 0 |
| Sources | 5 404 708 chars | 1 735 223 chars |
| Contracts (base-class members included) | 1 759 331 chars | 463 563 chars |
| **Saved** | **67%** | **73%** |
| **Saved in tokens** (o200k_base proxy) | **67%** | **71%** |
| Contract shorter than source | 1201 of 1298 (93%) | 386 of 407 (95%) |
| Flagged as partial | 1 of 1298 | 3 of 407 |
| First call (loads the project's TypeScript) | 306 ms | 564 ms |

\* measured with the pre-0.1.2 wire format; the current format is leaner, so this saving
is a floor.

The largest component in the monorepo shrinks from **177 863 to 10 770 characters** while
listing 117 contract members. Contracts include members inherited from base classes — the
extends chain is resolved through relative imports, tsconfig path aliases and barrels.
Before that resolver, 91 of 1298 monorepo contracts were flagged as partial; now 1 is.

Three caveats that travel with these numbers:

- **Tokens are counted through a proxy** — OpenAI's `o200k_base`, since Claude's tokenizer
  is not public; `cl100k_base` agrees within one point on this data. Characters are exact.
- **The baseline is reading the whole file**, which is what an agent does by default.
- **JSON tokenizes slightly worse than TypeScript**, so token savings sit a point or two
  below character savings. The table carries both.

On small components there is no saving at all: a 17-line component produces a 578-character
contract against a 315-character source. The contract grows with the number of members, the
source with method bodies — and on production code the second wins almost always.

## Measured: rename and diagnose

**Renaming an input across usages.** The grep path an agent actually takes — read the
component file to learn the selector, then grep the selector and the binding spellings
repo-wide — against `ng_component_info` plus `ng_find_usages` with its `input` filter,
which returns only the tags that bind the name, each entry pointing at the binding itself.
On the production monorepo, 6243 files scanned:

| Component | grep path | bridge | saved (o200k) |
|---|---|---|---|
| 577 usages, `mask` bound on 5 tags | 50 527 tokens | 1 035 tokens | **98%** |
| 466 usages, `icon` bound on 463 tags | 41 698 tokens | 22 566 tokens | **46%** |
| 1211 usages, `name` bound on 1134 tags | 129 227 tokens | 30 650 tokens | 76%\* |

\* the tool returns at most 500 entries per answer, and the answer says so.

The saving is decided by how many of the usages actually bind the input: `mask` is bound on
5 of 568 tags, and grep still prints every selector line plus 67 binding-shaped lines from
across the repo — 62 of them somebody else's `mask` — while the bridge answers with exactly
those five sites.

**Diagnosing a template that will not compile.** A whole-project compiler listing costs
**395 tokens and 1321 ms**; one `ng_template_diagnostics` call answers with the asked
file's diagnostics in **81 tokens, 1 ms warm**. The gap only widens with project size: the
listing grows with the project, the answer does not. After an edit, fresh diagnostics
arrive as a 340–400 ms push — against a rebuild.

## Version facts

`ng_version_rules` contains no rule taken from documentation: the data comes from importing
the packages actually installed in each fixture and from running the compiler.

**The zoneless provider is renamed between v19 and v20.**

| API | v17 | v18 | v19 | v20 | v21 | v22 |
|---|---|---|---|---|---|---|
| `provideExperimentalZonelessChangeDetection` | – | yes | yes | – | – | – |
| `provideZonelessChangeDetection` | – | – | – | yes | yes | yes |

Advice to "enable zoneless" without a version breaks on three majors out of six.

**Existing is not the same as ready.** The `@experimental` and `@developerPreview` tags live
only in declaration JSDoc and are invisible at runtime:

| API | v17 | v18 | v19 | v20 | v21 | v22 |
|---|---|---|---|---|---|---|
| `input`, `output`, `model`, `viewChild`, `contentChild` | preview | preview | stable | stable | stable | stable |
| `effect`, `toObservable` | preview | preview | preview | stable | stable | stable |
| `linkedSignal`, `afterRenderEffect` | – | – | preview | stable | stable | stable |
| `resource`, `rxResource`, `httpResource` | – | – | **experimental** | **experimental** | **experimental** | stable |

So "rewrite `@Input()` as `input()`" on a v17 or v18 project means moving to a non-public
API, and `resource()` was experimental all the way through v21. A batch of signal APIs
appears exactly at v19: `linkedSignal`, `resource`, `rxResource`, `httpResource`,
`afterRenderEffect`, `provideAppInitializer`.

**Two documentation claims that measurement contradicted:** `standalone` becomes the default
at **v19**, not v20; and `*ngIf` is not removed in 22.0.8 — it reports hint `NG6385` and
keeps working, with `NgIf` still exported from `@angular/common`.

**Compiler gates**, read in the 22.0.8 bundle and confirmed by running it — all keyed on
`--angularCoreVersion`, and with no version passed the newest semantics are assumed:

| Feature | Gate |
|---|---|
| `@if` / `@for` / `@switch` blocks | ≥ 17.0.0 |
| signals in two-way bindings | ≥ 17.2.0-0 |
| `@let` | ≥ 18.1.0 |
| implicit `standalone` | ≥ 19.0.0 |
| DOM event type assertion | ≥ 20.2.0 |

Also measured: Signal Forms (`@angular/forms/signals`) exist only from v21 and are stable on
22.0.8; `AbstractControl.events` from v18; `TestBed.tick` from v20.

Outside the measured v17–v22 range `ng_version_rules` returns nothing and says so —
extrapolating "it was in v22, so it is in v23" is exactly the failure it exists to prevent.

## Honesty as a feature

An incomplete answer says so, in words, inside the answer:

- A contract merges base-class members and host-directive exposures, resolved statically
  through relative imports, tsconfig aliases and barrels. Where the walk cannot continue —
  a base class from a package, a mixin call — the answer carries `incomplete`, naming the
  class and the file to ask about next.
- `ng_version_rules` reports `notMeasured` topics, and a `caveat` when your minor differs
  from the measured one.
- `ng_find_usages` labels declarations as `declaration`, admits when class-name matches were
  found without resolving imports, and names selector twins — a second declaration of the
  same selector elsewhere in the workspace — instead of silently mixing their usages.
- `ng_template_diagnostics` separates three states that all look like an empty list: the
  template is clean; the server is silently down (caught by a canary probe); or template
  checking is off for this project — then the answer carries `checksDisabled` naming the
  tsconfig responsible. In the measured monorepo `strictTemplates` is off in two of seven
  applications, so the distinction is not theoretical.

## What this is not

- **Not better than a careful `grep` at finding usages.** `grep -rn "<app-widget"` finds the
  same 62 usages. What `ng_find_usages` adds: the selector and class name are derived from
  the file for you, usage kinds are labelled, all four attribute-binding spellings are
  covered, and `path` scopes the scan — 33 selectors in the measured monorepo are declared
  in two applications at once, and an unscoped search would mix them.
- **Not a replacement for the Angular CLI MCP** — a different layer. `ng mcp` covers docs,
  best practices and build orchestration; none of its nine tools touches templates or the
  language server. The two complement each other.
- **Not a type checker of its own.** The LSP-backed tools deliver the project's own compiler
  output, undistorted.

Known gaps are recorded, not hidden: a base class from a package or behind a mixin call
stops the ancestor walk (1 of 1298 components in the measured monorepo), Nx projects with
inferred targets come without `tsConfig`, and pipe twins are not detected.

## Requirements and setup

- **Node ≥ 18.20.8** — the measured floor: the published package answered on clean Node
  18.20.8, 20.20.2 and 22.x. This is about the MCP server process only — **your project
  keeps building on its own Node**. To give just the server a newer runtime, point the
  client config at that binary: `"command": "C:\\node22\\node.exe"`.

**From source** (instead of npm):

- The project's own dependencies: `npm install`, then `npm run build`.
- The shipped language-server branch lives in `tools/servers/ls22` and needs `npm ci` there once.
- In every client config, replace the `ng-token-saver` command with `node <path>/dist/index.js`;
  for Claude Code: `claude mcp add ng-token-saver -- node <path>/dist/index.js`.

`node_modules` folders are not committed, including the twelve inside the stand. To restore
the full measurement environment:

```
npm install && npm run build
cd tools/servers/ls22 && npm ci        # the branch actually shipped
cd fixtures/v22 && npm ci              # repeat per fixture you want to run
```

### Clients

The server is a plain stdio MCP server with no client-specific features, so any MCP client
can launch it; installation and Claude Code registration are in [Quick start](#quick-start).

**Cursor** — the one-click button in Quick start, or the same `mcpServers` JSON as in
Quick start, in `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project).

**Windsurf** — the same JSON, in `~/.codeium/windsurf/mcp_config.json`.

**VS Code (Copilot agent mode)** — `.vscode/mcp.json`; the key is `servers` and the entry
takes a `type`:

```json
{ "servers": { "ng-token-saver": { "type": "stdio", "command": "ng-token-saver" } } }
```

**Codex CLI** — `codex mcp add ng-token-saver -- ng-token-saver`, or `~/.codex/config.toml`:

```toml
[mcp_servers.ng-token-saver]
command = "ng-token-saver"
```

**JetBrains AI Assistant / Junie** — Settings → Tools → AI Assistant → Model Context
Protocol accepts the same JSON as Quick start's; for Junie, additionally enable "Pass
custom MCP servers".

Configuration, both variables optional:

- `NG_TOKEN_SAVER_IDLE_MS` — a language-server session unused this long shuts its ngserver
  down; the next call pays the cold start again. Default 900000 (15 minutes); `0` keeps
  sessions alive until the server exits. A session with a call in flight is never shut down.
- `NG_TOKEN_SAVER_SERVERS_DIR` — where the language-server branch lives, if not in
  `tools/servers` next to the build.

## Reproducing the measurements

```
npm test                                  build plus 162 unit tests (node:test, no dependencies)
npm run smoke                             end-to-end check with a real MCP client over stdio
npm run bench:settle                      whether a pause after didOpen is needed (it is not)
npm run bench:standalone                  where standalone becomes the default (v17..v22)
npm run bench:api                         which Angular APIs exist in which majors, and their stability
npm run bench:contract <project root>     contract size against reading whole files (--tokens adds token counts)
npm run bench:rename <component> <input>  the grep path against the bridge for an input rename
npm run bench:diagnose                    a compiler listing against one diagnostics call
npm run bench:matrix                      resolution probes across a fixture
npm run bench:negative                    what the server returns when things break
npm run bench:didchange                   diagnostics timing after an edit
```

The stand is `fixtures/v17..v22` — six real Angular workspaces, each with its own
`node_modules` and its own pinned TypeScript, plus `fixtures/negative/*` for failure cases.

## Status

All six tools verified on the six fixtures and on two production codebases — 1298 and 407
components, zero parse errors — plus one Angular 16 project to check that out-of-range
refusals are structured rather than silent. 162 unit tests, all green.

Measured latency: the two LSP-backed tools pay 8–28 s of cold start on the first call and
answer in 2–9 ms after it; the four static tools answer in 250–600 ms on the first call and
in milliseconds once the project's TypeScript is cached. A session idle for 15 minutes shuts
its language server down, and the next call pays the cold start again — see
`NG_TOKEN_SAVER_IDLE_MS` above.

`CLAUDE.md` and `angular-mcp-brief.md` in this repository are internal working documents in
Russian: the full measurement log, every dead end, and the reasoning behind each decision.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). Copyright (C) 2026 Alex Ryabov.
Use and modify freely; derivative works must stay open under the same license.
