#!/usr/bin/env node
/**
 * 체커(gvskb) JSON ↔ 포털 판정 계약 테스트.
 *
 * 왜 있는가: 포털이 체커 결과에서 **없는 필드를 읽어** 조용히 틀린 값을 표시한
 * 사고가 두 번 반복됐다.
 *
 *   1차(2026-08-30) 없는 `dependency_audit.summary.finding_count` 를 읽어
 *        취약 패키지 7종을 "0건"으로 표시 (docs/36)
 *   2차(2026-09-12) 없는 `report.decision` 을 읽고 `summary.blocked`(소스 전용
 *        옛 필드)로 폴백해 **배포 판정이 양방향으로 뒤집힘**
 *
 * 두 번 다 원인이 같다 — 두 시스템이 맞물리는지 자동으로 확인하는 장치가 없었다.
 * 아래 견본(golden fixture)은 체커가 실제로 내보내는 모양이며, 판정이 바뀌면
 * 여기서 먼저 실패한다.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanDecision,
  coverageTruncated,
  dependencyIncomplete,
  suppressionSummary,
  engineStatus,
  DECISION_SOURCE_GATE,
  SUPPORTED_SCAN_SCHEMA_VERSION
} from "../src/scan-summary.mjs";

const failures = [];
const skipped = [];
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}\n    ${String(error.message).split("\n")[0]}`);
  }
}

/** 체커 ScanReport 의 최소 골격. 시나리오별로 필요한 부분만 덮어쓴다. */
function report(overrides = {}) {
  return {
    target: "C:/work/sample",
    profile: "public-default-strict",
    engine_version: "0.3.0",
    ruleset_version: "2026.09.01a",
    summary: {
      finding_count: 0,
      by_severity: {},
      by_decision: {},
      highest_severity: null,
      blocked: false,
      location_count: 0,
      block_location_count: 0
    },
    findings: [],
    scanned_files: ["app.py"],
    skipped_files: [],
    gate: null,
    ...overrides
  };
}

function gate(verdict, extra = {}) {
  return {
    verdict,
    blocked: verdict === "blocked",
    conditional: verdict === "conditional",
    requires_action: verdict === "blocked" || verdict === "conditional",
    block_reasons: [],
    conditional_criteria: [],
    exposure: { secret: 0, pii: 0 },
    blocked_source: false,
    blocked_dependency: verdict === "blocked",
    source_block_count: 0,
    dependency_vulnerable: 0,
    dependency_unchecked: 0,
    reason: "",
    ...extra
  };
}

// ---------------------------------------------------------------------------
// 1. 회귀의 핵심 — 옛 코드가 틀렸던 두 시나리오
// ---------------------------------------------------------------------------

// 코드는 깨끗하고 패키지에 CVSS CRITICAL 취약점만 있는 경우.
// 체커 HTML 보고서는 "배포 미승인"을 찍는데, 옛 포털은 summary.blocked=false 만
// 보고 **allow(승인)** 를 표시했다. 위험을 승인으로 바꿔 말하던 자리다.
check("코드 정상 + 패키지 CRITICAL → blocked", () => {
  const input = report({
    summary: { ...report().summary, blocked: false, finding_count: 0 },
    gate: gate("blocked", {
      block_reasons: [{
        package: "pyyaml",
        version: "5.3.1",
        criteria: ["critical"],
        labels: ["CVSS CRITICAL 취약점"],
        recommended_version: "5.4"
      }],
      dependency_vulnerable: 1,
      reason: "배포 불가 — CVSS CRITICAL 취약점에 해당하는 패키지가 있습니다(pyyaml 5.3.1)."
    }),
    dependency_audit: {
      audits: [{
        ecosystem: "pypi",
        parsed_count: 1,
        checked_count: 1,
        unchecked_count: 0,
        truncated_count: 0,
        checks: [{ name: "pyyaml", version: "5.3.1", verdict: "vulnerable", vulnerability_count: 2, max_cve: "CRITICAL" }]
      }]
    }
  });
  const result = scanDecision(input, { mode: "standard" });
  assert.equal(result.decision, "blocked");
  assert.equal(result.gate_verdict, "blocked");
  assert.equal(result.decision_source, DECISION_SOURCE_GATE);
});

// 소스에 block 등급 발견이 있고 패키지는 정상인 경우.
// 체커 정책상 소스는 보조(conditional)인데, 옛 포털은 summary.blocked=true 만
// 보고 **blocked(차단)** 로 과장했다.
check("소스 block 발견 + 패키지 정상 → needs_review", () => {
  const input = report({
    summary: { ...report().summary, blocked: true, finding_count: 9, by_decision: { block: 9 } },
    gate: gate("conditional", {
      blocked_source: true,
      source_block_count: 9,
      conditional_criteria: ["source"],
      reason: "차단 사유는 없습니다. 확인이 필요한 항목이 있습니다(소스 높은 위험 9건)."
    })
  });
  const result = scanDecision(input, { mode: "standard" });
  assert.equal(result.decision, "needs_review");
  assert.equal(result.gate_verdict, "conditional");
});

// summary.blocked 가 더 이상 판정을 끌고 가지 않는다는 것을 못 박는다.
check("summary.blocked=true 라도 gate=approved 면 allow", () => {
  const input = report({
    summary: { ...report().summary, blocked: true, finding_count: 3 },
    gate: gate("approved", { reason: "조치할 항목이 없습니다." })
  });
  assert.equal(scanDecision(input, { mode: "standard" }).decision, "allow");
});

// ---------------------------------------------------------------------------
// 2. 판정 표 전체
// ---------------------------------------------------------------------------

check("approved → allow (표준점검)", () => {
  assert.equal(scanDecision(report({ gate: gate("approved") }), { mode: "standard" }).decision, "allow");
});

check("approved → quick_complete (간편점검)", () => {
  // 축소 룰셋으로 본 결과를 "전체 승인"으로 말하지 않는다.
  assert.equal(scanDecision(report({ gate: gate("approved") }), { mode: "quick" }).decision, "quick_complete");
});

check("blocked 는 간편점검에서도 blocked", () => {
  assert.equal(scanDecision(report({ gate: gate("blocked") }), { mode: "quick" }).decision, "blocked");
});

check("undetermined → incomplete", () => {
  const input = report({ scanned_files: [], gate: gate("undetermined") });
  assert.equal(scanDecision(input, { mode: "standard" }).decision, "incomplete");
});

// ---------------------------------------------------------------------------
// 3. 계약 미달은 통과가 아니다 (fail-safe)
// ---------------------------------------------------------------------------

check("gate 없음(구버전 체커) → incomplete + 안내 사유", () => {
  const result = scanDecision(report({ gate: null }), { mode: "standard" });
  assert.equal(result.decision, "incomplete");
  assert.ok(result.incomplete_reasons.includes("gate_missing"));
  assert.match(result.reason, /체커/);
});

check("모르는 verdict 값 → incomplete", () => {
  const result = scanDecision(report({ gate: gate("weird_new_value") }), { mode: "standard" });
  assert.equal(result.decision, "incomplete");
  assert.ok(result.incomplete_reasons.includes("gate_verdict_unknown"));
});

check("보고서 자체가 없음(파싱 실패) → incomplete", () => {
  assert.equal(scanDecision(null, { mode: "standard" }).decision, "incomplete");
});

// ---------------------------------------------------------------------------
// 3b. 계약 버전 — 모르는 형식을 넘겨짚지 않는다
// ---------------------------------------------------------------------------

check("아는 계약 버전은 정상 판정", () => {
  const input = report({ schema_version: SUPPORTED_SCAN_SCHEMA_VERSION, gate: gate("approved") });
  const result = scanDecision(input, { mode: "standard" });
  assert.equal(result.decision, "allow");
  assert.equal(result.schema_version, SUPPORTED_SCAN_SCHEMA_VERSION);
});

check("모르는(더 높은) 계약 버전 → incomplete", () => {
  // 체커가 필드의 뜻을 바꾸면 버전을 올린다. 그대로 읽으면 조용히 틀린 판정이 된다.
  const input = report({ schema_version: SUPPORTED_SCAN_SCHEMA_VERSION + 1, gate: gate("approved") });
  const result = scanDecision(input, { mode: "standard" });
  assert.equal(result.decision, "incomplete");
  assert.ok(result.incomplete_reasons.includes("schema_version_unsupported"));
  assert.match(result.reason, /포털을 갱신/);
});

check("모르는 계약 버전은 blocked 도 덮지 않는다", () => {
  // 형식을 모르면 'blocked' 라는 읽기조차 믿을 수 없다 — 판정 불가가 맞다.
  const input = report({ schema_version: 99, gate: gate("blocked") });
  assert.equal(scanDecision(input, { mode: "standard" }).decision, "incomplete");
});

check("schema_version 없는 구버전 결과는 gate 로 판정한다", () => {
  // 여기서 막으면 기존 설치본 전부가 재점검 대상이 된다. 판정에 필요한 것은
  // gate 이고, 그쪽이 없으면 이미 gate_missing 으로 걸린다.
  const input = report({ gate: gate("approved") });
  const result = scanDecision(input, { mode: "standard" });
  assert.equal(result.decision, "allow");
  assert.equal(result.schema_version, null, "'없음'과 '검증해서 1이었음'은 구분되어야 한다");
});

check("schema_version 이 숫자가 아니면 없는 것으로 본다", () => {
  const input = report({ schema_version: "1", gate: gate("approved") });
  assert.equal(scanDecision(input, { mode: "standard" }).schema_version, null);
});

// ---------------------------------------------------------------------------
// 4. 검사가 온전하지 않으면 판정하지 않는다
// ---------------------------------------------------------------------------

check("시간 초과 → incomplete", () => {
  const result = scanDecision(report({ gate: gate("approved") }), { mode: "standard", timedOut: true });
  assert.equal(result.decision, "incomplete");
  assert.ok(result.incomplete_reasons.includes("scan_timeout"));
});

check("프로파일 폴백 → incomplete", () => {
  const input = report({
    gate: gate("approved"),
    profile_fallback: { requested: "web-civil-service", applied: "", reason: "정책 파일 없음", available: [] }
  });
  assert.equal(scanDecision(input, { mode: "standard" }).decision, "incomplete");
});

check("범위 절단(구조화 필드) → incomplete", () => {
  const input = report({ gate: gate("approved"), coverage: { truncated: true, over_limit_count: 70 } });
  assert.equal(scanDecision(input, { mode: "standard" }).decision, "incomplete");
});

check("범위 절단(구버전 문장 폴백) → incomplete", () => {
  // 체커가 `coverage` 를 붙이기 전 보고서. 문장 폴백이 살아 있어야 한다.
  const input = report({
    gate: gate("approved"),
    skipped_files: [{ path: "C:/work/sample", reason: "max_files=20000 reached — 70개 파일이 검사되지 않았습니다" }]
  });
  assert.equal(scanDecision(input, { mode: "standard" }).decision, "incomplete");
});

check("구조화 필드가 문장보다 우선한다", () => {
  // 문장은 남아 있어도 구조화 필드가 false 면 절단이 아니다.
  const input = report({
    coverage: { truncated: false, over_limit_count: 0 },
    skipped_files: [{ path: "x", reason: "설명문에 max_files= 라는 글자가 들어간 경우" }]
  });
  assert.equal(coverageTruncated(input), false);
});

check("의존성 판정 불가 → incomplete", () => {
  const input = report({
    gate: gate("approved"),
    dependency_audit: { audits: [{ ecosystem: "npm", unchecked_count: 3, truncated_count: 0, checks: [] }] }
  });
  assert.equal(dependencyIncomplete(input), true);
  assert.equal(scanDecision(input, { mode: "standard" }).decision, "incomplete");
});

check("의존성 상한 절단 → incomplete", () => {
  const input = report({
    gate: gate("approved"),
    dependency_audit: { audits: [{ ecosystem: "npm", unchecked_count: 0, truncated_count: 12, checks: [] }] }
  });
  assert.equal(scanDecision(input, { mode: "standard" }).decision, "incomplete");
});

// ---------------------------------------------------------------------------
// 5. 면제·엔진 상태는 '미상'과 '없음'을 구분한다
// ---------------------------------------------------------------------------

check("면제 요약 — 체커가 준 값을 그대로 센다", () => {
  const input = report({
    suppression_summary: {
      applied: 2,
      expired: [{ rule_id: "GOV-FLASK-DEBUG-001", file: "app.py" }],
      invalid: ["승인자 누락"],
      inline_ignored: 5
    }
  });
  assert.deepEqual(suppressionSummary(input), {
    applied: 2, expired: 1, invalid: 1, inline_ignored: 5
  });
});

check("면제 요약 — 인라인 집계가 없으면 0 이 아니라 null(미상)", () => {
  const input = report({ suppression_summary: { applied: 1, expired: [], invalid: [] } });
  assert.equal(suppressionSummary(input).inline_ignored, null);
});

check("면제 요약 — 예외가 아예 없으면 0", () => {
  assert.deepEqual(suppressionSummary(report()), {
    applied: 0, expired: 0, invalid: 0, inline_ignored: null
  });
});

check("엔진 상태 — 목록이 없으면 known:false(미상)", () => {
  const status = engineStatus(report());
  assert.equal(status.known, false);
  assert.deepEqual(status.used, []);
});

check("엔진 상태 — semgrep 미가용이 그대로 드러난다", () => {
  const input = report({
    engines: {
      used: ["regex", "python-ast", "js-taint"],
      unavailable: [{ name: "semgrep", reason: "네이티브 Windows 미지원 — JS/TS 정밀 분석 미수행" }],
      failed: []
    }
  });
  const status = engineStatus(input);
  assert.equal(status.known, true);
  assert.ok(!status.used.includes("semgrep"));
  assert.equal(status.unavailable[0].name, "semgrep");
});

// ---------------------------------------------------------------------------
// 6. 골든 파일 — **실제 체커가 만든 JSON**으로 검증한다
//
// 위 시나리오들은 손으로 만든 객체라, 포털의 해석이 일관되는지는 보여줘도
// **체커가 정말 그 모양을 내보내는지**는 증명하지 못한다. 두 번의 사고가 전부
// 그 틈에서 났다(없는 필드를 읽음). 그래서 진짜 산출물을 하나 고정해 둔다.
//
// fixtures/checker-reports/gate-blocked-by-kev.json
//   gvskb 0.3.0 자체 실행 결과(합성 테스트 데이터: a.py · kevpkg).
//   **소스는 깨끗한데(summary.blocked=false, 발견 0건) 패키지가 CISA KEV 등재라
//   gate.verdict=blocked** — 옛 포털이 `allow` 로 뒤집던 바로 그 상황이다.
//
// 체커를 올릴 때 이 파일도 새 산출물로 갱신할 것. 갱신했더니 아래가 깨지면,
// 그건 계약이 바뀌었다는 뜻이고 포털도 함께 고쳐야 한다는 신호다.
// ---------------------------------------------------------------------------

const fixtureDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "fixtures", "checker-reports");
const golden = JSON.parse(readFileSync(join(fixtureDir, "gate-blocked-by-kev.json"), "utf8"));

check("골든: 실제 산출물에 포털이 읽는 필드가 모두 있다", () => {
  // 포털이 의존하는 최상위 필드 목록. 체커가 하나라도 빼면 여기서 먼저 깨진다.
  for (const field of [
    "schema_version", "summary", "findings", "scanned_files", "skipped_files",
    "gate", "coverage", "engines", "dependency_audit",
    "engine_version", "ruleset_version", "profile_fallback", "suppression_summary"
  ]) {
    assert.ok(field in golden, `체커 산출물에 '${field}' 가 없습니다 — 포털이 읽는 필드입니다`);
  }
  for (const field of ["verdict", "blocked", "requires_action", "block_reasons", "reason"]) {
    assert.ok(field in golden.gate, `gate 에 '${field}' 가 없습니다`);
  }
  for (const field of ["truncated", "over_limit_count", "scanned_count"]) {
    assert.ok(field in golden.coverage, `coverage 에 '${field}' 가 없습니다`);
  }
  for (const field of ["used", "unavailable", "failed"]) {
    assert.ok(field in golden.engines, `engines 에 '${field}' 가 없습니다`);
  }
});

check("골든: 계약 버전이 포털이 아는 범위 안이다", () => {
  assert.equal(typeof golden.schema_version, "number");
  assert.ok(
    golden.schema_version <= SUPPORTED_SCAN_SCHEMA_VERSION,
    `골든 파일의 계약 버전(${golden.schema_version})이 포털(${SUPPORTED_SCAN_SCHEMA_VERSION})보다 높습니다 — 포털을 먼저 올리세요`
  );
});

check("골든: 소스는 깨끗한데 패키지가 KEV — 실제 산출물에서도 blocked", () => {
  // 이 세 줄이 이번 수정의 핵심이다.
  assert.equal(golden.summary.blocked, false, "전제: 소스 기준 옛 필드는 false");
  assert.equal(golden.summary.finding_count, 0, "전제: 소스 발견 0건");
  assert.equal(golden.gate.verdict, "blocked", "전제: 체커는 차단으로 판정");

  const result = scanDecision(golden, { mode: "standard" });
  assert.equal(result.decision, "blocked", "옛 로직은 여기서 allow 를 냈다");
  assert.equal(result.decision_source, DECISION_SOURCE_GATE);
});

check("골든: 간편점검에서도 blocked 는 낮춰지지 않는다", () => {
  assert.equal(scanDecision(golden, { mode: "quick" }).decision, "blocked");
});

check("골든: 차단 사유를 화면에 옮길 수 있다", () => {
  // 결론만 옮기고 근거를 버리면 담당자가 무엇을 고쳐야 할지 알 수 없다.
  const [first] = golden.gate.block_reasons;
  assert.equal(first.package, "kevpkg");
  assert.ok(first.labels.length > 0, "차단 사유 라벨이 있어야 한다");
});

check("골든: 엔진 상태가 실제로 채워져 있다(semgrep 미가용이 드러난다)", () => {
  const status = engineStatus(golden);
  assert.equal(status.known, true, "실제 산출물이면 엔진 목록이 있어야 한다");
  assert.ok(status.used.includes("regex"));
  assert.equal(
    status.unavailable[0].name, "semgrep",
    "이 산출물은 Windows 에서 만들어졌다 — semgrep 미수행이 값으로 드러나야 한다"
  );
  assert.ok(status.unavailable[0].reason, "무엇을 잃었는지 사유가 있어야 한다");
});

check("골든: fixture 가 설치된 체커 버전과 일치한다(낡은 fixture 방지)", () => {
  // fixture 는 한 번 만들어 두면 **조용히 낡는다.** 체커를 올렸는데 fixture 가
  // 옛 형식이면, 계약 테스트는 통과하는데 실제 연동은 깨져 있는 상태가 된다 —
  // 이 테스트가 막으려는 바로 그 실패 유형이 테스트 자신에게 생기는 것이다.
  //
  // 체커가 설치돼 있으면 버전을 대조한다. 없으면(체커 없는 개발 PC) 건너뛴다 —
  // 대조하지 못한 것을 '일치'로 바꿔 말하지는 않는다.
  // shell:true 는 인자가 이스케이프되지 않아 쓰지 않는다(Node 가 경고하는 그 패턴).
  // Windows 는 pip 콘솔 스크립트가 .exe 또는 .cmd 로 깔리므로 후보를 순서대로 시도한다.
  const candidates = process.platform === "win32"
    ? ["gvskb.exe", "gvskb.cmd", "gvskb"]
    : ["gvskb"];
  let probe = null;
  for (const command of candidates) {
    const attempt = spawnSync(command, ["version"], { encoding: "utf8" });
    if (attempt.status === 0) { probe = attempt; break; }
  }
  if (probe === null) {
    skipped.push("fixture 버전 대조 — 이 PC 에 gvskb 가 없어 확인하지 못했습니다");
    return;
  }
  const installed = String(probe.stdout || "").trim().split(/\s+/).pop();
  assert.equal(
    golden.engine_version, installed,
    `fixture 가 낡았습니다(fixture ${golden.engine_version} ≠ 설치 ${installed}).\n`
    + "    체커 저장소에서 새 산출물을 만들어 교체하세요:\n"
    + "      gvskb scan <대상> --format json --check-deps -o tmp/golden\n"
    + "      cp tmp/golden.json fixtures/checker-reports/gate-blocked-by-kev.json\n"
    + "    (소스는 깨끗한데 패키지가 차단되는 대상을 쓰세요 — 그 조합이 이 fixture 의 요점입니다.)"
  );
});

check("골든: 범위·면제 파싱이 실제 산출물에서 동작한다", () => {
  assert.equal(coverageTruncated(golden), false);
  assert.equal(dependencyIncomplete(golden), false);
  assert.deepEqual(suppressionSummary(golden), {
    applied: 0, expired: 0, invalid: 0, inline_ignored: null
  });
});

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`checker contract test FAILED (${failures.length}건)`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
// 확인하지 못한 것은 통과로 바꿔 말하지 않는다 — 건너뛴 항목은 드러낸다.
for (const note of skipped) console.log(`  · 건너뜀: ${note}`);
console.log("checker contract test passed");
