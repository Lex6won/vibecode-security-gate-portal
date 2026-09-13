#!/usr/bin/env node
import assert from "node:assert/strict";
import { dependencyRiskSummary, engineGate, scanDecision } from "../src/scan-summary.mjs";

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

// ---------------------------------------------------------------------------
// 필수 엔진 fail-closed — 엔진이 빠진 검사는 allow 가 될 수 없다.
//
// 체커(f1117d8 이후)가 `engines.required` 를 준다: regex 는 항상, Python 소스가
// 있으면 python-ast, JS/TS 소스가 있으면 js-taint. semgrep 은 보조다.
// ---------------------------------------------------------------------------
function engineReport(engines, { verdict = "approved", findings = [] } = {}) {
  return {
    schema_version: 1,
    summary: { finding_count: findings.length, blocked: false, by_decision: {} },
    findings,
    engines,
    gate: { verdict, blocked: verdict === "blocked", requires_action: false, block_reasons: [], reason: "조치할 항목이 없습니다." }
  };
}

const finding = { rule_id: "KISA-PY-INPUT-05", severity: "high", decision: "block", location: { file: "a.py", line: 3 } };

// 필수 엔진 정상 → 기존 판정 유지(allow), degraded 없음
{
  const r = scanDecision(engineReport({ used: ["regex", "python-ast", "js-taint", "semgrep"], unavailable: [], failed: [],
    required: ["regex", "python-ast"] }), { mode: "standard" });
  assert.equal(r.decision, "allow");
  assert.deepEqual(r.missing_required_engines, []);
  assert.deepEqual(r.degraded_engines, []);
}
// 필수 엔진 실행 실패 → incomplete, 사유 engine_required_failed, findings 는 보존
{
  const report = engineReport({ used: ["regex"], unavailable: [], failed: [{ name: "python-ast", reason: "RuntimeError: boom" }],
    required: ["regex", "python-ast"] }, { findings: [finding] });
  const r = scanDecision(report, { mode: "standard" });
  assert.equal(r.decision, "incomplete");
  assert.ok(r.incomplete_reasons.includes("engine_required_failed"));
  assert.deepEqual(r.missing_required_engines, ["python-ast"]);
  assert.ok(r.reason.includes("python-ast"), "사유에 빠진 엔진 이름이 있어야 한다");
  assert.equal(report.findings.length, 1, "엔진 실패가 있어도 발견 정보는 지워지지 않는다");
}
// 필수 엔진 미설치(unavailable) → incomplete, 사유 engine_required_unavailable
{
  const r = scanDecision(engineReport({ used: ["regex"], unavailable: [{ name: "js-taint", reason: "미설치" }], failed: [],
    required: ["regex", "js-taint"] }), { mode: "standard" });
  assert.equal(r.decision, "incomplete");
  assert.ok(r.incomplete_reasons.includes("engine_required_unavailable"));
}
// 간편점검에서도 필수 엔진 실패면 quick_complete 가 아니라 incomplete
{
  const r = scanDecision(engineReport({ used: ["regex"], unavailable: [], failed: [{ name: "python-ast", reason: "x" }],
    required: ["regex", "python-ast"] }), { mode: "quick" });
  assert.equal(r.decision, "incomplete");
}
// semgrep 만 미설치 → 판정 유지(allow) + degraded 에 semgrep 이 남는다(조용히 숨기지 않음)
{
  const r = scanDecision(engineReport({ used: ["regex", "python-ast"], unavailable: [{ name: "semgrep", reason: "네이티브 Windows 미지원" }],
    failed: [], required: ["regex", "python-ast"] }), { mode: "standard" });
  assert.equal(r.decision, "allow");
  assert.deepEqual(r.degraded_engines, ["semgrep"]);
  assert.deepEqual(r.missing_required_engines, []);
}
// semgrep 실행 중 비정상 실패 → 판정은 유지하되 degraded 로 드러난다
{
  const r = scanDecision(engineReport({ used: ["regex", "python-ast"], unavailable: [], failed: [{ name: "semgrep", reason: "crash" }],
    required: ["regex", "python-ast"] }), { mode: "standard" });
  assert.equal(r.decision, "allow");
  assert.deepEqual(r.degraded_engines, ["semgrep"]);
}
// required 가 없는 구버전 보고서 — 보수적으로: 실패(failed)는 판정 불가, 미설치는 degraded
{
  const legacyFailed = scanDecision(engineReport({ used: ["regex"], unavailable: [], failed: [{ name: "python-ast", reason: "x" }] }), { mode: "standard" });
  assert.equal(legacyFailed.decision, "incomplete");
  const legacyUnavailable = scanDecision(engineReport({ used: ["regex", "python-ast"], unavailable: [{ name: "semgrep", reason: "x" }], failed: [] }), { mode: "standard" });
  assert.equal(legacyUnavailable.decision, "allow");
  assert.deepEqual(legacyUnavailable.degraded_engines, ["semgrep"]);
}
// engines 자체가 없는 아주 옛 보고서 — 엔진 사유 없이 기존 계약대로(gate 만 본다)
{
  const gate = engineGate({ gate: { verdict: "approved" } });
  assert.equal(gate.known, false);
  assert.deepEqual(gate.missing_required, []);
}
// 필수 엔진 실패 + 게이트 blocked → 여전히 incomplete 가 아니라... 차단은 차단이다? 아니다:
// 판정 불가가 우선한다 — 어떤 엔진이 빠졌는지 모르는 채 "차단"도 "승인"도 말하지 않는다.
{
  const r = scanDecision(engineReport({ used: ["regex"], unavailable: [], failed: [{ name: "python-ast", reason: "x" }],
    required: ["regex", "python-ast"] }, { verdict: "blocked" }), { mode: "standard" });
  assert.equal(r.decision, "incomplete");
  assert.equal(r.gate_verdict, "blocked", "체커 원본 판정은 그대로 보존해 기록한다");
}

console.log("scan summary test passed");
