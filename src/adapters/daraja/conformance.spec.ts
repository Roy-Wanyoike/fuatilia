/**
 * Conformance-harness spec (issue #25, F15).
 *
 * The report is the deliverable: every built-in scenario must pass, and the
 * harness itself must be honest (unknown scenarios refused, reports
 * deterministic, structure stable).
 */
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../domain/shared';
import { CONFORMANCE_SCENARIOS, runConformance, runScenario, type ConformanceScenario } from './conformance';
import { DARAJA_ERRORS } from './codes';
import { simulate } from './simulator';

describe('the built-in conformance suite', () => {
  const report = runConformance();

  it('runs every built-in scenario and passes them all', () => {
    expect(report.scenarios.map((s) => s.scenarioId)).toEqual([
      'c2b.at-least-once-idempotent',
      'c2b.reconciliation-targets-payment',
      'c2b.multi-invoice-conservation',
      'c2b.tampered-amount-dead-lettered',
      'c2b.unidentified-money-parks-c4',
      'stk.result-code-matrix',
      'transport.gap-no-callback-no-money',
      'transport.out-of-order-arrival',
    ]);
    expect(report.pass).toBe(true);
    for (const scenario of report.scenarios) {
      expect(scenario.pass, `${scenario.scenarioId}: ${JSON.stringify(scenario.checks.filter((c) => !c.pass))}`).toBe(true);
      expect(scenario.checks.length, scenario.scenarioId).toBeGreaterThanOrEqual(3);
      for (const check of scenario.checks) {
        expect(check.requirement, `${scenario.scenarioId}/${check.id}`).toMatch(/(K1|K5|C1|C4|C5|R1|R2|R5|R9|SPEC|docs|at-least)/);
        expect(check.pass, `${scenario.scenarioId}/${check.id}: ${check.detail}`).toBe(true);
      }
    }
  });

  it('is deterministic — two reports are identical', () => {
    expect(JSON.stringify(runConformance())).toBe(JSON.stringify(report));
  });

  it('every scenario pins a SPEC/review requirement and a human-readable note', () => {
    for (const scenario of CONFORMANCE_SCENARIOS) {
      expect(scenario.id).toMatch(/^[a-z0-9.-]+$/);
      expect(scenario.requirement.length).toBeGreaterThan(15);
      expect(scenario.note.length).toBeGreaterThan(15);
    }
  });
});

describe('the harness contract', () => {
  it('evaluates a custom scenario from its run — additive, no rewrite', () => {
    const custom: ConformanceScenario = {
      id: 'custom.probe',
      requirement: 'harness extensibility check',
      note: 'a caller-defined scenario over the real simulator with one failing and one passing check',
      run: () => simulate([], {}, { clock: { startMs: 0 } }),
      evaluate: (run) => [
        { id: 'empty-run-has-no-money', requirement: 'C5', pass: run.payments.length === 0, detail: `payments=${run.payments.length}` },
        { id: 'deliberate-failure', requirement: 'R9', pass: false, detail: 'deliberate' },
      ],
    };
    const result = runScenario(custom);
    expect(result.scenarioId).toBe('custom.probe');
    expect(result.pass).toBe(false); // one deliberate failure
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0]!.pass).toBe(true);
  });

  it('surfaces scenario build failures instead of swallowing them', () => {
    const broken: ConformanceScenario = {
      id: 'broken.scenario',
      requirement: 'misuse surfaces',
      note: 'the schedule references an unknown fixture',
      run: () => {
        throw new DomainError(DARAJA_ERRORS.FIXTURE_NOT_FOUND, 'nope');
      },
      evaluate: () => [],
    };
    expect(() => runScenario(broken)).toThrow(DomainError);
  });
});
