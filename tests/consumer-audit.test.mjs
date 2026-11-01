import { describe, expect, test } from 'bun:test';
import { auditHighSeverity } from '../scripts/consumer-audit.mjs';

function result(vulnerabilities = {}) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const issue of Object.values(vulnerabilities)) { counts[issue.severity]++; counts.total++; }
  return { status: counts.total ? 1 : 0, stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: counts } }) };
}

describe('consumer audit gate', () => {
  test('accepts a completed clean audit and reports high and critical advisories', () => {
    expect(auditHighSeverity(result())).toEqual([]);
    expect(auditHighSeverity(result({ low: { severity: 'low' } }))).toEqual([]);
    expect(auditHighSeverity(result({ zod: { severity: 'high' }, other: { severity: 'critical' } })).map(([name]) => name)).toEqual(['zod', 'other']);
  });

  test('rejects timeout and process failure even with clean JSON', () => {
    for (const overrides of [{ error: new Error('timeout') }, { signal: 'SIGTERM' }, { status: null }, { status: 2 }]) {
      expect(() => auditHighSeverity({ ...result(), ...overrides })).toThrow('did not complete');
    }
  });

  test('rejects service errors, missing reports, malformed JSON, and inconsistent counts', () => {
    for (const stdout of ['{}', '{', JSON.stringify({ error: { code: 'E503' } }), result().stdout.replace('"high":0', '"high":1')]) {
      expect(() => auditHighSeverity({ status: 0, stdout })).toThrow();
    }
    expect(() => auditHighSeverity({ ...result(), status: 1 })).toThrow('inconsistent');
    expect(() => auditHighSeverity({ ...result({ zod: { severity: 'high' } }), status: 0 })).toThrow('inconsistent');
  });
});
