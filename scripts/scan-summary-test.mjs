#!/usr/bin/env node
import assert from "node:assert/strict";
import { dependencyRiskSummary } from "../src/scan-summary.mjs";

const report = {
  audits: [
    {
      ecosystem: "npm",
      checks: [
        { name: "remotion", version: "4.0.252", verdict: "vulnerable", vulnerability_count: 2, requires_review: true },
        { name: "vite", version: "7.3.2", verdict: "vulnerable", vulnerability_count: 1, requires_review: true },
        { name: "busboy", version: "1.6.0", verdict: "checked_clean", vulnerability_count: 0, requires_review: false }
      ]
    },
    {
      ecosystem: "npm",
      checks: [
        // The same package in a manifest and lockfile is one affected package.
        { name: "remotion", version: "4.0.252", verdict: "vulnerable", vulnerability_count: 2, requires_review: true }
      ]
    }
  ]
};

assert.deepEqual(dependencyRiskSummary(report), {
  vulnerable_package_count: 2,
  advisory_count: 3,
  review_package_count: 2
});
assert.deepEqual(dependencyRiskSummary({ summary: { finding_count: 4 } }), {
  vulnerable_package_count: 4,
  advisory_count: 0,
  review_package_count: 0
});
assert.deepEqual(dependencyRiskSummary(null), {
  vulnerable_package_count: 0,
  advisory_count: 0,
  review_package_count: 0
});

console.log("scan summary test passed");
