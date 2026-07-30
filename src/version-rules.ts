// Copyright (C) 2026 Alex Ryabov
// SPDX-License-Identifier: GPL-3.0-or-later

// Version-correct rules. Everything here was measured on the stand rather than read from the
// docs: `npm run bench:api` (API presence in installed packages) and section 2.14 of the brief
// (compiler gates). An unmeasured rule does not get into this file: rules copied from the docs
// are exactly the reason this product exists.

export type Topic = 'components' | 'control-flow' | 'signals' | 'di' | 'forms' | 'testing';

interface ApiFact {
  name: string;
  module: string;
  topic: Topic;
  /** The major from which the API exists. */
  from: number;
  /** The last major where the API still exists. null means it is in the newest one too. */
  until: number | null;
  /** Up to and including this major the API is marked experimental or developerPreview in its .d.ts. */
  unstableUpTo?: number;
  /** What to use where the API is unavailable. */
  instead?: string;
  /** How it is written when it is not a function call. */
  usage?: string;
}

// Exact stand versions: 'available from v17' means 'available on 17.3.12', not across the whole
// major - inside v17 the signal APIs landed in 17.1..17.3, and the stand cannot tell those apart.
const MEASURED_AT: Record<number, string> = {
  17: '17.3.12',
  18: '18.2.14',
  19: '19.2.25',
  20: '20.3.26',
  21: '21.2.18',
  22: '22.0.8',
};

// Measured on 2026-07-29 against fixtures 17.3.12, 18.2.14, 19.2.25, 20.3.26, 21.2.18 and 22.0.8
// by importing the real packages; forms and testing on 2026-07-30 after installing
// @angular/forms into every fixture. Precision is per major: inside v17 these APIs appeared in
// different minors (17.1..17.3), which the stand cannot distinguish.
const API: ApiFact[] = [
  { name: 'linkedSignal', module: '@angular/core', topic: 'signals', from: 19, until: null, unstableUpTo: 19, instead: 'computed() plus a separate signal for writes' },
  { name: 'resource', module: '@angular/core', topic: 'signals', from: 19, until: null, unstableUpTo: 21, instead: 'toSignal() over an Observable' },
  { name: 'rxResource', module: '@angular/core/rxjs-interop', topic: 'signals', from: 19, until: null, unstableUpTo: 21, instead: 'toSignal() over an Observable' },
  { name: 'httpResource', module: '@angular/common/http', topic: 'signals', from: 19, until: null, unstableUpTo: 21, instead: 'HttpClient plus toSignal()' },
  { name: 'afterRenderEffect', module: '@angular/core', topic: 'components', from: 19, until: null, unstableUpTo: 19, instead: 'afterNextRender()' },
  { name: 'provideAppInitializer', module: '@angular/core', topic: 'di', from: 19, until: null, instead: 'APP_INITIALIZER via provide' },
  { name: 'provideExperimentalZonelessChangeDetection', module: '@angular/core', topic: 'components', from: 18, until: 19, unstableUpTo: 19, instead: 'there is no zoneless mode on this version' },
  { name: 'provideZonelessChangeDetection', module: '@angular/core', topic: 'components', from: 20, until: null, instead: 'provideExperimentalZonelessChangeDetection() on 18-19' },
  { name: 'Service', module: '@angular/core', topic: 'di', from: 22, until: null, instead: '@Injectable({ providedIn: "root" })', usage: '@Service' },
  { name: 'input', module: '@angular/core', topic: 'signals', from: 17, until: null, unstableUpTo: 18 },
  { name: 'output', module: '@angular/core', topic: 'signals', from: 17, until: null, unstableUpTo: 18 },
  { name: 'model', module: '@angular/core', topic: 'signals', from: 17, until: null, unstableUpTo: 18 },
  { name: 'viewChild', module: '@angular/core', topic: 'components', from: 17, until: null, unstableUpTo: 18 },
  { name: 'contentChild', module: '@angular/core', topic: 'components', from: 17, until: null, unstableUpTo: 18 },
  { name: 'effect', module: '@angular/core', topic: 'signals', from: 17, until: null, unstableUpTo: 19 },
  { name: 'toObservable', module: '@angular/core/rxjs-interop', topic: 'signals', from: 17, until: null, unstableUpTo: 19 },
  { name: 'takeUntilDestroyed', module: '@angular/core/rxjs-interop', topic: 'signals', from: 17, until: null, unstableUpTo: 18 },
  // Signal Forms: the subpath itself only exists from v21, experimental there, stable on 22.0.8.
  { name: 'form', module: '@angular/forms/signals', topic: 'forms', from: 21, until: null, unstableUpTo: 21, instead: 'reactive forms: FormControl and FormGroup' },
  { name: 'schema', module: '@angular/forms/signals', topic: 'forms', from: 21, until: null, unstableUpTo: 21, instead: 'reactive forms validators' },
  { name: 'required', module: '@angular/forms/signals', topic: 'forms', from: 21, until: null, unstableUpTo: 21, instead: 'Validators.required' },
  { name: 'submit', module: '@angular/forms/signals', topic: 'forms', from: 21, until: null, unstableUpTo: 21, instead: '(ngSubmit) plus manual status handling' },
  // The selector is measured, not guessed: read from the compiled DirectiveDeclaration in
  // the shipped .d.ts of both v21 and v22 - "[formField]", required signal input `field`.
  { name: 'FormField', module: '@angular/forms/signals', topic: 'forms', from: 21, until: null, unstableUpTo: 21, usage: '[formField]', instead: 'formControlName / [formControl]' },
  // A TestBed static, not an import: presence probed at runtime, and the member-level JSDoc
  // read by hand on v20-v22 (the probe regex only sees top-level declares): @publicApi 20.0.
  { name: 'TestBed.tick', module: '@angular/core/testing', topic: 'testing', from: 20, until: null, usage: 'TestBed.tick()', instead: 'fixture.detectChanges(), or fakeAsync plus tick()' },
];

interface SyntaxFact {
  topic: Topic;
  from: number;
  rule: string;
}

// Compiler gates from section 2.14 (read in the 22.0.8 bundle, confirmed by a run) plus
// runtime-shape facts from section 2.21: instance members and statics probed on live objects.
const SYNTAX: SyntaxFact[] = [
  { topic: 'control-flow', from: 17, rule: 'Blocks @if/@for/@switch are available' },
  { topic: 'signals', from: 17, rule: 'Signals in two-way bindings are type-checked (from 17.2)' },
  { topic: 'control-flow', from: 18, rule: '@let is available (from 18.1)' },
  { topic: 'components', from: 19, rule: 'standalone is the default, writing standalone: true is unnecessary' },
  { topic: 'components', from: 20, rule: 'DOM event type assertion in templates works (from 20.2)' },
  { topic: 'forms', from: 17, rule: 'Reactive forms are available: FormControl, FormBuilder, NonNullableFormBuilder, FormRecord' },
  { topic: 'forms', from: 18, rule: 'AbstractControl.events (unified control events) is available' },
  { topic: 'testing', from: 17, rule: 'TestBed, fakeAsync/tick/flush, waitForAsync, DeferBlockBehavior and TestBed.runInInjectionContext are available' },
  // Member-level JSDoc read by hand: @developerPreview on 17-19, @deprecated from 20, and at
  // runtime the 20+ implementation is literally `return TestBedImpl.INSTANCE.tick()`.
  { topic: 'testing', from: 17, rule: 'TestBed.flushEffects exists across the range: developer preview on 17-19, deprecated in favour of TestBed.tick() from 20' },
];

export interface VersionRules {
  angularVersion: string;
  rules: string[];
  antiPatterns: Array<{ wrong: string; right: string; since: string }>;
  /** Topics with no measurements; null once every topic carries measured rules. */
  notMeasured: Topic[] | null;
  /** In words: what this answer does not know. An unexplained empty list reads as 'anything goes'. */
  caveat: string | null;
}

// Empty since 2026-07-30: forms and testing were the last silent topics, closed by installing
// @angular/forms into all six fixtures and probing runtime shapes (section 2.21).
const NOT_MEASURED: Topic[] = [];

function availableIn(fact: ApiFact, major: number): boolean {
  return major >= fact.from && (fact.until === null || major <= fact.until);
}

const MEASURED_MAJORS = Object.keys(MEASURED_AT).map(Number);

export function versionRules(angularVersion: string, major: number, topic?: Topic): VersionRules {
  // Outside the stand there are no rules. Extrapolating 'it was in v22, so it is in v23' is
  // exactly the kind of lie this whole tool was written against.
  if (!MEASURED_MAJORS.includes(major)) {
    return {
      angularVersion,
      rules: [],
      antiPatterns: [],
      notMeasured: null,
      caveat: `Angular v${major} is outside the measured v17-v22 range, so there are no rules for it and no guesses are offered`,
    };
  }

  const apis = API.filter((fact) => !topic || fact.topic === topic);
  const rules = SYNTAX.filter((fact) => (!topic || fact.topic === topic) && major >= fact.from).map(
    (fact) => fact.rule,
  );

  const missing = apis.filter((fact) => !availableIn(fact, major));
  const present = apis.filter((fact) => availableIn(fact, major));
  // A symbol existing and being production-ready are different things: before stabilisation an
  // API can break without a major bump, so it must not be advised like a stable one.
  const unstable = present.filter((fact) => fact.unstableUpTo !== undefined && major <= fact.unstableUpTo);
  const stable = present.filter((fact) => !unstable.includes(fact));
  if (stable.length > 0) {
    rules.push(`Available: ${stable.map((fact) => fact.name).join(', ')}`);
  }
  if (unstable.length > 0) {
    rules.push(
      `Present but marked experimental or developer preview, so they can change without a major bump: ${unstable
        .map((fact) => `${fact.name} (stable from v${fact.unstableUpTo! + 1})`)
        .join(', ')}`,
    );
  }

  const antiPatterns = missing.map((fact) => ({
    wrong: `${fact.usage ?? `${fact.name}()`} from ${fact.module}`,
    right: fact.instead ?? 'no equivalent exists on this version',
    since: `available from v${fact.from}${fact.until ? ` through v${fact.until}` : ''}`,
  }));

  // Measured on 20.3.26, 21.2.18 and 22.0.8: all three report hint NG6385, not an error.
  if (major >= 20 && (!topic || topic === 'control-flow')) {
    antiPatterns.push({
      wrong: '*ngIf / *ngFor',
      right: '@if / @for',
      since: `deprecated since v20; on ${MEASURED_AT[major]} they still work and report hint NG6385, not an error`,
    });
  }
  if (major < 19 && (!topic || topic === 'components')) {
    antiPatterns.push({
      wrong: 'a component without standalone: true',
      right: 'state standalone: true explicitly',
      since: 'standalone is the default only from v19',
    });
  }
  if (major >= 20 && (!topic || topic === 'testing')) {
    antiPatterns.push({
      wrong: 'TestBed.flushEffects()',
      right: 'TestBed.tick()',
      since: 'deprecated since v20; measured: at runtime it is an alias of tick()',
    });
  }

  const silent = NOT_MEASURED.filter((item) => !topic || item === topic);
  return {
    angularVersion,
    rules,
    antiPatterns,
    notMeasured: silent.length > 0 ? silent : null,
    caveat: caveatFor(angularVersion, major, silent),
  };
}

function caveatFor(angularVersion: string, major: number, silent: Topic[]): string | null {
  const parts: string[] = [];
  const measured = MEASURED_AT[major];
  // We measured specific minors: on an older minor some of the major's APIs may not exist yet,
  // on a newer one they may have arrived, which dates the list of what is missing.
  if (measured && olderThan(angularVersion, measured)) {
    parts.push(
      `measurements were taken on ${measured} while you are on ${angularVersion}, so APIs added within the major may be missing`,
    );
  } else if (measured && olderThan(measured, angularVersion)) {
    parts.push(
      `measurements were taken on ${measured} while you are on ${angularVersion}, so anything added in later minors is not reflected here`,
    );
  }
  if (silent.length > 0) {
    parts.push(
      `topics ${silent.join(', ')} were never measured and no rules are issued for them - an empty list does not mean 'anything goes'`,
    );
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

// Compare down to the minor: new APIs ship in minors, a patch does not bring them.
function olderThan(version: string, than: string): boolean {
  const parse = (value: string): number[] => value.split(/[.-]/).map((part) => Number(part) || 0);
  const left = parse(version);
  const right = parse(than);
  for (let i = 0; i < 2; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) {
      return a < b;
    }
  }
  return false;
}
