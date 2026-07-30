// Version rules. The data comes from measurements (npm run bench:api and section 2.14); the
// tests check not the facts themselves but that the answer is honest about its own limits.

import assert from 'node:assert/strict';
import test from 'node:test';
import { versionRules } from '../dist/version-rules.js';

test('on v17 what is unavailable is named as such rather than silently skipped', () => {
  const rules = versionRules('17.3.12', 17);
  const wrong = rules.antiPatterns.map((item) => item.wrong);
  assert.ok(wrong.some((item) => item.includes('linkedSignal')));
  assert.ok(wrong.some((item) => item.includes('provideZonelessChangeDetection')));
  assert.ok(wrong.some((item) => item.includes('provideExperimentalZonelessChangeDetection')));
  assert.ok(rules.rules.some((item) => item.includes('@if/@for/@switch')));
  // @let landed in 18.1, so it must not appear in the v17 rules.
  assert.equal(rules.rules.some((item) => item.includes('@let')), false);
});

test('zoneless: the provider name changes between v19 and v20, and both sides are visible', () => {
  const v19 = versionRules('19.2.25', 19);
  assert.ok(v19.rules.some((item) => item.includes('provideExperimentalZonelessChangeDetection')));
  assert.ok(
    v19.antiPatterns.some((item) => item.wrong.includes('provideZonelessChangeDetection() from')),
  );

  const v20 = versionRules('20.3.26', 20);
  assert.ok(v20.rules.some((item) => item.includes('provideZonelessChangeDetection')));
  assert.ok(
    v20.antiPatterns.some((item) => item.wrong.includes('provideExperimentalZonelessChangeDetection')),
  );
});

test('the *ngIf deprecation is called a hint, not an error, and only from v20', () => {
  const v19 = versionRules('19.2.25', 19).antiPatterns.filter((item) => item.wrong.includes('*ngIf'));
  assert.deepEqual(v19, []);
  const v22 = versionRules('22.0.8', 22).antiPatterns.find((item) => item.wrong.includes('*ngIf'));
  assert.match(v22.since, /deprecated since v20.*still work.*NG6385/);
});

test('a minor below the measured one is flagged: the measurement does not cover the whole major', () => {
  // On the exact measured version, with every topic now measured, there is nothing to caveat.
  assert.equal(versionRules('17.3.12', 17).caveat, null);
  // A patch below the measured one is no reason to caveat: APIs ship in minors.
  assert.equal(versionRules('19.2.18', 19, 'signals').caveat, null);
  const older = versionRules('17.0.5', 17);
  assert.match(older.caveat, /measurements were taken on 17\.3\.12 while you are on 17\.0\.5/);
});

// Measured 2026-07-30 (section 2.21): reactive forms exist across the range, control.events
// from v18, Signal Forms only from v21 and experimental there, stable on 22.0.8.
test('forms: signal forms are refused below v21 and marked unstable on v21', () => {
  const v19 = versionRules('19.2.25', 19, 'forms');
  assert.ok(v19.rules.some((rule) => rule.includes('Reactive forms are available')));
  assert.ok(v19.rules.some((rule) => rule.includes('AbstractControl.events')));
  assert.ok(v19.antiPatterns.some((item) => item.wrong.includes('@angular/forms/signals')));
  assert.equal(v19.notMeasured, null);

  const v17 = versionRules('17.3.12', 17, 'forms');
  assert.ok(!v17.rules.some((rule) => rule.includes('AbstractControl.events')), 'events exists only from v18');

  const v21 = versionRules('21.2.18', 21, 'forms');
  assert.ok(v21.rules.some((rule) => rule.includes('experimental') && rule.includes('form')));

  const v22 = versionRules('22.0.8', 22, 'forms');
  assert.ok(v22.rules.some((rule) => rule.startsWith('Available:') && rule.includes('form')));
});

test('testing: TestBed.tick exists only from v20, flushEffects is deprecated there', () => {
  const v19 = versionRules('19.2.25', 19, 'testing');
  assert.ok(v19.rules.some((rule) => rule.includes('TestBed.flushEffects')));
  assert.ok(v19.antiPatterns.some((item) => item.wrong.includes('TestBed.tick()')));
  assert.ok(!v19.antiPatterns.some((item) => item.wrong.includes('flushEffects')));

  const v20 = versionRules('20.3.26', 20, 'testing');
  assert.ok(v20.rules.some((rule) => rule.startsWith('Available:') && rule.includes('TestBed.tick')));
  assert.ok(v20.antiPatterns.some((item) => item.wrong === 'TestBed.flushEffects()'));
  assert.equal(v20.notMeasured, null);
});

test('a topic narrows the answer without mixing in neighbouring ones', () => {
  const signals = versionRules('17.3.12', 17, 'signals');
  assert.equal(
    signals.antiPatterns.every((item) => !item.wrong.includes('standalone')),
    true,
  );
  assert.ok(signals.antiPatterns.some((item) => item.wrong.includes('linkedSignal')));
});

test('outside the v17-v22 range no rules are issued, and that is said in words', () => {
  for (const major of [16, 23]) {
    const rules = versionRules(`${major}.0.0`, major);
    assert.deepEqual(rules.rules, []);
    assert.deepEqual(rules.antiPatterns, []);
    assert.match(rules.caveat, new RegExp(`v${major} is outside the measured`));
  }
});

test('unstable APIs are separated from stable ones rather than lumped together', () => {
  const v19 = versionRules('19.2.25', 19, 'signals');
  const stable = v19.rules.find((item) => item.startsWith('Available:'));
  const unstable = v19.rules.find((item) => item.includes('experimental'));
  assert.ok(stable.includes('input'));
  assert.equal(stable.includes('resource'), false);
  assert.match(unstable, /resource \(stable from v22\)/);
  assert.match(unstable, /linkedSignal \(stable from v20\)/);

  // On v17 signal inputs are still developer preview, and that must be said, not omitted.
  const v17 = versionRules('17.3.12', 17, 'signals');
  assert.match(v17.rules.find((item) => item.includes('developer preview')), /input \(stable from v19\)/);

  // On v22 all of it is stable already, so there must be no separate line.
  const v22 = versionRules('22.0.8', 22, 'signals');
  assert.equal(v22.rules.some((item) => item.includes('experimental')), false);
});

test('the *ngIf deprecation cites the measurement for its own major, not someone else\'s', () => {
  const v20 = versionRules('20.3.26', 20).antiPatterns.find((item) => item.wrong.includes('*ngIf'));
  assert.match(v20.since, /on 20\.3\.26 they still work/);
  const v22 = versionRules('22.0.8', 22).antiPatterns.find((item) => item.wrong.includes('*ngIf'));
  assert.match(v22.since, /on 22\.0\.8 they still work/);
});

test('a minor newer than the measured one is caveated too: the missing list may be stale', () => {
  assert.match(versionRules('22.6.0', 22, 'signals').caveat, /anything added in later minors/);
});
