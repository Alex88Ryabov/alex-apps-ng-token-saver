# ng-token-saver

`@alex-apps/ng-token-saver` — an MCP server that lets an AI agent understand Angular
**templates** by asking the same compiler that builds the project, instead of guessing from
file text. The token saving is measured, not promised: see the numbers below.

Angular ships a first-class language server, but no official AI integration exposes it: the
Angular CLI MCP (`ng mcp`, since CLI 20.1) works at the docs-and-build level — nine tools,
none of which touches templates or the language server (verified by running it, July 2026).
This server is that missing layer, and it adds what the language server alone cannot give:
answers that are correct **for the Angular version this project actually runs**.

Everything below marked as measured was produced by running code against six real Angular
workspaces (17.3.12, 18.2.14, 19.2.25, 20.3.26, 21.2.18, 22.0.8) and two production projects.
Every number can be reproduced with the commands in [Reproducing the measurements](#reproducing-the-measurements).

## The two problems it solves

**1. No template awareness.** `grep` over an `.html` file cannot tell you where
`{{ user().fullName }}` is declared, and no amount of reading gives you `NG2339 Property
'emailAddress' does not exist on type 'UserVm'`. That is compiler output, not text.

**2. Version drift.** The AI context files on angular.dev (`llms.txt`) carry no version
markers and describe the newest major, and the versioned archive sites serve none at all
(checked July 2026: `v17.angular.io/llms.txt` is a 404). On v17–v21 they hand the agent
instructions that produce APIs which do not exist. Measured examples are in
[Version facts](#version-facts-measured-not-read).

## Tools

Six tools, 1093 characters of descriptions in total. Answers are dense JSON with no markdown.

| Tool | What it answers | Needs the language server |
|---|---|---|
| `ng_template_definition` | where a symbol under this template position is declared | yes |
| `ng_template_diagnostics` | Angular compiler errors for this template | yes |
| `ng_component_info` | the public contract of a component or directive | no |
| `ng_workspace_map` | projects, versions, `strictTemplates` and zone.js per project | no |
| `ng_version_rules` | what exists and what does not in this project's Angular version | no |
| `ng_find_usages` | where a component, directive or pipe is used; with `input` — where that input is bound | no |

Four of the six never start the language server, so they answer in milliseconds and keep
working on workspaces where the server refuses to load.

## Measured: contract instead of the whole file

`ng_component_info` returns the public contract of a component rather than its source. Measured
across two production codebases through a real MCP client (`npm run bench:contract`):

| | Nx monorepo | CLI workspace |
|---|---|---|
| Angular / TypeScript | 19.2.18 / 5.8.3 | 17.3.8 / 5.3.3 |
| Components in the tally | 1298 | 407 |
| Parse errors | 0 | 0 |
| Sources | 5 404 314 chars | 1 735 223 chars |
| Contracts (base-class members included) | 1 870 205 chars | 463 563 chars |
| **Saved** | **65%** | **73%** |
| **Saved in tokens** (o200k_base proxy) | **64%** (cl100k 65%) | **71%** (cl100k 71%) |
| Contract shorter than source | 1173 of 1298 (90%) | 386 of 407 (95%) |
| Ratio, median | 0.44 (p10 0.21, p90 0.99) | 0.33 (p10 0.19, p90 0.83) |
| Token ratio, median | 0.47 (p10 0.21, p90 1.05) | 0.35 (p10 0.20, p90 0.93) |
| Flagged as partial | 1 of 1298 | 3 of 407 |
| First call (loads the project's TypeScript) | 300 ms | 564 ms |

The largest component in the monorepo shrinks from **177 863 to 10 693 characters** while
listing 119 contract members. Contracts now include members inherited from base classes —
the extends chain is resolved through relative imports and tsconfig path aliases, barrels
included — which is why the saving is a few points lower than a contract that stopped at
the class's own body: those members were previously missing, not saved. Before the
resolver, 91 of 1298 monorepo contracts were flagged as partial; now 1 is (a base the
static resolver refuses to guess about). In the CLI workspace 29 more files sit in a
sibling app with no `node_modules` installed and are refused with an error saying exactly
that.

Three caveats that must travel with these numbers:

- **Tokens are counted through a proxy.** Claude's tokenizer is not public, so token counts use
  OpenAI's `o200k_base` via gpt-tokenizer — the bench installs it into a temp cache, the product
  itself stays dependency-free — with `cl100k_base` as a cross-check. The two agree within one
  point on this data. Characters are exact.
- **The baseline is reading the whole file**, which is what an agent does by default when asked
  what a component accepts.
- **JSON tokenizes slightly worse than TypeScript**: the median contract/source ratio on the
  monorepo is 0.47 in tokens against 0.44 in characters. The table carries both.

On small components there is no saving at all: a 17-line component produces a 578-character
contract against a 315-character source. The contract grows with the number of members while
the source grows with method bodies, and on production code the second wins almost always.

## Measured: the other two scenarios

**Renaming an input across usages** (`npm run bench:rename <component> <input>`). The grep path
an agent actually takes — read the component file to learn the selector, then grep the selector
and the binding spellings of the input repo-wide — against `ng_component_info` plus
`ng_find_usages` with its `input` filter: only the tag usages that bind the name come back, and
each entry points at the binding itself (in a multi-line tag that is a different line than the
tag's). Both sides deliver binding-shaped locations, so the comparison is like-for-like; what
still differs is attribution, and it favours the bridge in correctness: grep's binding lines
are repo-wide and unattributed, the bridge's are scoped to this component's tags. On the
production monorepo, 6243 files scanned:

| Component | grep path | bridge | saved (o200k) |
|---|---|---|---|
| 577 usages, `mask` bound on 5 tags | 50 527 tokens | 1 035 tokens | **98%** |
| 466 usages, `icon` bound on 463 tags | 41 698 tokens | 22 566 tokens | **46%** |
| 1211 usages, `name` bound on 1134 tags | 129 227 tokens | 30 650 tokens | 76%\* |

\* the tool returns at most 500 entries per answer, and the answer says so.

The spread is the finding: the saving is decided by how many of the component's usages actually
bind the input. `mask` is bound on 5 of 568 tags — grep still prints every selector line plus
67 binding-shaped lines from across the repo, 62 of them somebody else's `mask`, while the
bridge answers with exactly those five sites. On `icon`, bound on practically every tag, both
paths carry similar volume and the bridge wins by a third.

**Diagnosing a template that will not compile** (`npm run bench:diagnose`). The compiler listing
— ngc over the whole fixture, ANSI stripped, which is a conservative floor for a real `ng build`
— against one `ng_template_diagnostics` call: **395 tokens, 5 errors, 1321 ms** for the listing
versus **81 tokens, the two diagnostics of the asked file, 1 ms warm**. 79% fewer tokens on a
deliberately tiny project, and the gap only widens with size: the listing grows with the
project, the answer does not. After an edit the loop repeats — a rebuild against a 340–400 ms
diagnostics push.

## Version facts, measured not read

`ng_version_rules` contains no rule taken from documentation. The data comes from importing the
real packages installed in each fixture (`npm run bench:api`) and from running the compiler
(`npm run bench:standalone`). Some of what that turned up:

**The zoneless provider is renamed between v19 and v20.**

| API | v17 | v18 | v19 | v20 | v21 | v22 |
|---|---|---|---|---|---|---|
| `provideExperimentalZonelessChangeDetection` | – | yes | yes | – | – | – |
| `provideZonelessChangeDetection` | – | – | – | yes | yes | yes |

Advice to "enable zoneless" without a version breaks on three majors out of six.

**A batch of signal APIs appears exactly at v19**: `linkedSignal`, `resource`, `rxResource`,
`httpResource`, `afterRenderEffect`, `provideAppInitializer`. The `@Service` decorator exists
only in 22.0.8.

**Existing is not the same as ready.** The `@experimental` and `@developerPreview` tags live
only in declaration JSDoc and are invisible at runtime:

| API | v17 | v18 | v19 | v20 | v21 | v22 |
|---|---|---|---|---|---|---|
| `input`, `output`, `model`, `viewChild`, `contentChild` | preview | preview | stable | stable | stable | stable |
| `effect`, `toObservable` | preview | preview | preview | stable | stable | stable |
| `linkedSignal`, `afterRenderEffect` | – | – | preview | stable | stable | stable |
| `resource`, `rxResource`, `httpResource` | – | – | **experimental** | **experimental** | **experimental** | stable |

So "rewrite `@Input()` as `input()`" on a v17 or v18 project means moving to a non-public API,
and `resource()` was experimental all the way through v21.

**Two documentation claims that measurement contradicted:** `standalone` becomes the default at
**v19**, not v20; and `*ngIf` is not removed in 22.0.8 — it reports hint `NG6385` with severity 4
and keeps working, with `NgIf` still exported from `@angular/common`.

**Compiler gates**, read in the 22.0.8 bundle and confirmed by running it. All five are keyed on
`--angularCoreVersion`, and with no version passed the newest semantics are assumed:

| Feature | Gate |
|---|---|
| `@if` / `@for` / `@switch` blocks | ≥ 17.0.0 |
| signals in two-way bindings | ≥ 17.2.0-0 |
| `@let` | ≥ 18.1.0 |
| implicit `standalone` | ≥ 19.0.0 |
| DOM event type assertion | ≥ 20.2.0 |

Outside the measured v17–v22 range `ng_version_rules` returns nothing and says so. Extrapolating
"it was in v22, so it is in v23" is exactly the failure this tool exists to prevent.

## Honesty as a feature

Every answer that is incomplete says so, in words, inside the answer:

- a component contract merges the members of its base classes and the exposed inputs/outputs
  of its host directives, typed from their classes (resolved statically through relative
  imports and tsconfig aliases; a bare host-directive reference exposes nothing bindable, which
  is Angular's own rule); when a link leads into a package or a mixin call, the walk stops and
  the answer says so:
  `incomplete: "inputs, outputs and members of base class CdkTree (imported from
  '@angular/cdk/tree') are not collected here — ask ng_component_info about their files"`;
- `ng_version_rules` reports `notMeasured` topics and a `caveat` when your minor differs from the
  measured one;
- `ng_find_usages` labels a declaration as `declaration` rather than a usage, and admits that
  class-name matches were found without resolving imports;
- `ng_template_diagnostics` separates three states that all look like an empty list: the template
  is clean, the server is not answering (caught by a canary probe, because three of the four ways
  this server fails are completely silent), and template checking is switched off for this project
  — in which case the answer carries `checksDisabled` naming the tsconfig responsible.

That last one is not theoretical. In the measured monorepo `strictTemplates` is **off in two of
seven applications and on in the other five**, so an empty list means "checks are disabled" in one
app and "the template is clean" in the next. Verified against both.

## What this is not

- **`ng_find_usages` is not better than a careful `grep`.** Measured: `grep -rn "<app-widget"`
  finds exactly the same 62 usages. What the tool adds is that you do not need to know the
  selector (it is derived from the file), that element/attribute/pipe/class/declaration kinds are
  labelled, that all four attribute spellings are covered, and that a closing tag is not counted
  as a second usage.
- **Not a replacement for the Angular CLI MCP** — a different layer. Verified by running it
  in July 2026: nine tools (docs search, best practices, project listing, build and devserver
  orchestration, an OnPush migration), none touching templates or the language server. It
  launches fine even inside a v17 workspace via `npx @angular/cli@latest mcp`, but its
  answers follow the CLI that runs it, not the Angular version the project uses. The two
  servers complement each other.
- **Not a type checker of its own.** Everything the LSP-backed tools report comes from the same
  compiler that builds the project. The value is in delivering it undistorted.

Known gaps, all recorded rather than hidden: an exposure on a host directive from a package
keeps its name but not its type, and nested host directives are not expanded (the answer says
so); a base class from a package or behind a mixin call stops the ancestor walk (1 of 1298
components in the measured monorepo); Nx repositories with inferred targets yield projects
without `tsConfig`; an attribute selector inside a CSS rule in `styles: [...]` counts as a
directive usage.

## Requirements and setup

- **Node ≥ 22.22.3.** The lower bound comes from the newest language-server branch, not the oldest.

**From npm** — the language server ships as a regular dependency, nothing else to install:

```
npm install -g @alex-apps/ng-token-saver
```

After that every client config below shortens to `"command": "ng-token-saver"` with no args.
The installed layout is verified by running: the packed tarball (75 kB, dist only) was
installed into a clean prefix and all four tool kinds answered through a real MCP client.

**From source:**

- The project's own dependencies: `npm install`, then `npm run build`.
- The shipped language-server branch lives in `tools/servers/ls22` and needs `npm ci` there once.

`node_modules` folders are not committed, including the twelve inside the stand. To restore the
full measurement environment:

```
npm install && npm run build
cd tools/servers/ls22 && npm ci        # the branch actually shipped
cd fixtures/v22 && npm ci              # repeat per fixture you want to run
```

Registering the server with an MCP client:

```json
{
  "mcpServers": {
    "ng-token-saver": {
      "command": "node",
      "args": ["<path>/dist/index.js"]
    }
  }
}
```

With Claude Code that is one command:

```
claude mcp add ng-token-saver -- node <path>/dist/index.js
```

The server is a plain stdio MCP server with no client-specific features, so any MCP client
can launch it. Two more clients, with configs taken from their documentation (not from a run
of ours — protocol compatibility itself is verified by the benches, which talk to the server
through a real MCP client over stdio):

**Codex CLI** — `~/.codex/config.toml`:

```toml
[mcp_servers.ng-token-saver]
command = "node"
args = ["<path>/dist/index.js"]
```

**JetBrains AI Assistant / Junie** — Settings → Tools → AI Assistant → Model Context
Protocol accepts the same JSON as above (the format deliberately mirrors Claude Desktop's);
for Junie, additionally enable "Pass custom MCP servers".

Configuration, both variables optional:

- `NG_TOKEN_SAVER_IDLE_MS` — a language-server session unused this long shuts its ngserver
  down, and the next call pays the cold start again. Default 900000 (15 minutes — chosen,
  not measured); `0` keeps sessions alive until the server exits. A session with a call in
  flight is never shut down.
- `NG_TOKEN_SAVER_SERVERS_DIR` — where the language-server branch lives, if not in
  `tools/servers` next to the build.

## Reproducing the measurements

```
npm test                                  build plus 145 unit tests (node:test, no dependencies)
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

The stand is `fixtures/v17..v22` — six real Angular workspaces, each with its own `node_modules`
and its own pinned TypeScript, plus `fixtures/negative/*` for failure cases. Two components in
the fixtures are probes rather than examples: `standalone-probe.component.ts` measures the
standalone boundary, and `fixtures/v17/src/app/legacy-card.component.ts` checks that the contract
does not lose members declared in legacy shapes.

## Status

All six tools work. 145 tests, all green. Every topic of `ng_version_rules` is measured and
no timing constant is eyeballed anymore: the post-open settle pause turned out to be
unnecessary (90+ measured opens, zero empty answers) and was removed, making cold per-file
calls ~1 s faster. Verified on six fixtures and on two production
codebases (1298 and 407 components, zero parse errors), plus one project running Angular 16 to
check that out-of-range refusals are structured rather than silent.

Measured latency on both production workspaces: the language-server tools pay 8–28 s of cold
start on the first call and answer in 2–9 ms after it; the four tools that need no server answer
in 250–600 ms on the first call and in milliseconds once the project's TypeScript is cached.
A session idle for 15 minutes shuts its ngserver down (verified against the OS process list),
so a returning agent pays the cold start again — see `NG_TOKEN_SAVER_IDLE_MS` above.

Signal Forms, measured: the `@angular/forms/signals` entry point exists only from v21, is
experimental there, and is stable on 22.0.8; `AbstractControl.events` exists from v18;
`TestBed.tick` from v20. All of it came from importing the installed packages and probing
live objects, not from release notes.

`CLAUDE.md` and `angular-mcp-brief.md` in this repository are internal working documents in
Russian: the full measurement log, every dead end, and the reasoning behind each decision.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). Copyright (C) 2026 Alex Ryabov.
Use and modify freely; derivative works must stay open under the same license.
