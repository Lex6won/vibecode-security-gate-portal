function numberAtLeastZero(value) {
  return Math.max(0, Number(value) || 0);
}

// gvskb 0.3.x records dependency risk per audit check, not in a top-level summary.
export function dependencyRiskSummary(dependencyAudit) {
  const audits = Array.isArray(dependencyAudit?.audits) ? dependencyAudit.audits : [];
  const vulnerablePackages = new Map();
  const reviewPackages = new Set();

  for (const audit of audits) {
    const checks = Array.isArray(audit?.checks) ? audit.checks : [];
    for (const check of checks) {
      if (!check || typeof check !== "object") continue;
      const ecosystem = String(check.ecosystem || audit?.ecosystem || "unknown");
      const name = String(check.name || "unknown");
      const version = String(check.version || "unknown");
      const key = `${ecosystem}\u0000${name}\u0000${version}`;
      const advisoryCount = numberAtLeastZero(check.vulnerability_count);
      const vulnerable = check.verdict === "vulnerable" || advisoryCount > 0;

      if (vulnerable) {
        const previous = vulnerablePackages.get(key) || 0;
        vulnerablePackages.set(key, Math.max(previous, advisoryCount));
      }
      if (check.requires_review === true) reviewPackages.add(key);
    }
  }

  const legacyCount = numberAtLeastZero(
    dependencyAudit?.summary?.finding_count ?? dependencyAudit?.finding_count
  );
  const vulnerablePackageCount = vulnerablePackages.size || legacyCount;
  const advisoryCount = Array.from(vulnerablePackages.values())
    .reduce((total, count) => total + count, 0);

  return {
    vulnerable_package_count: vulnerablePackageCount,
    advisory_count: advisoryCount,
    review_package_count: reviewPackages.size
  };
}
