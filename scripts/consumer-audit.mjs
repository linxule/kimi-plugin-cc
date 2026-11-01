// npm audit exits 1 for advisories; process failures and incomplete reports must
// never be interpreted as a clean audit.
export function auditHighSeverity(result) {
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error(`consumer audit did not complete: ${result.error?.message || result.signal || result.stderr || result.status}`);
  }
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new Error('consumer audit returned invalid JSON'); }
  const counts = report?.metadata?.vulnerabilities;
  const vulnerabilities = report?.vulnerabilities;
  if (report?.error || report?.auditReportVersion !== 2 || !counts ||
      !vulnerabilities || typeof vulnerabilities !== 'object' || Array.isArray(vulnerabilities) ||
      !['info', 'low', 'moderate', 'high', 'critical', 'total'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)) {
    throw new Error('consumer audit returned an incomplete report');
  }
  const entries = Object.entries(vulnerabilities);
  const levels = ['info', 'low', 'moderate', 'high', 'critical'];
  if (entries.some(([, issue]) => !issue || !levels.includes(issue.severity)) ||
      counts.total !== entries.length || levels.some(level => counts[level] !== entries.filter(([, issue]) => issue.severity === level).length) ||
      result.status !== (counts.total > 0 ? 1 : 0)) {
    throw new Error('consumer audit returned inconsistent results');
  }
  return entries.filter(([, issue]) => ['high', 'critical'].includes(issue.severity));
}
