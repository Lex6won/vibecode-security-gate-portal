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

// ---------------------------------------------------------------------------
// 배포 판정 — 체커의 `gate` 가 단일 권위다.
//
// 실측 결함(2026-09-12): 포털은 존재하지 않는 `report.decision` 을 읽고, 없으면
// `summary.blocked` 로 폴백했다. `summary.blocked` 는 **소스 발견만** 보는 옛
// 필드라 판정이 양쪽으로 뒤집혔다.
//
//   코드 정상 + 패키지 CRITICAL/KEV → 체커 blocked, 포털 allow   (위험을 승인)
//   소스 block 발견 + 패키지 정상   → 체커 conditional, 포털 blocked (과장 차단)
//
// 같은 점검의 첨부 HTML 보고서와 화면이 서로 다른 말을 했다. 판정은 체커가
// `gate.verdict` 한 곳에서만 계산하므로(gvskb gate.py), 포털은 그것을 옮겨
// 적기만 한다. 파생 추론은 두지 않는다 — 두는 순간 또 갈라진다.
// ---------------------------------------------------------------------------

/** 체커 게이트 판정 → 포털 화면 판정. 이 표 밖의 값은 신뢰하지 않는다. */
export const GATE_VERDICT_TO_DECISION = Object.freeze({
  blocked: "blocked",
  conditional: "needs_review",
  undetermined: "incomplete",
  approved: "allow"
});

/**
 * 이 포털이 해석할 수 있는 체커 결과 계약의 최대 버전.
 *
 * 체커는 **필드를 없애거나 뜻을 바꿀 때** `schema_version` 을 올린다(필드 추가는
 * 역호환이라 올리지 않는다). 그러므로:
 *
 *   - 이 값보다 **높은** 버전 = 포털이 모르는 뜻으로 바뀐 필드가 있을 수 있다.
 *     그대로 읽으면 조용히 틀린 판정을 낸다 → `incomplete` 로 막는다.
 *   - `schema_version` **없음** = 이 필드가 생기기 전 체커. 필드의 뜻은 지금과
 *     같으므로 그대로 읽어도 된다. 다만 요약에 드러내 구분은 남긴다.
 *     (여기서 막으면 기존 설치본 전부가 재점검 대상이 된다 — 판정에 필요한 것은
 *      `gate` 이고, 그쪽이 없으면 이미 `gate_missing` 으로 걸린다.)
 */
export const SUPPORTED_SCAN_SCHEMA_VERSION = 1;

/** 새 규칙으로 내린 판정임을 기록에 남기는 표식. 과거 기록과 섞이지 않게 한다. */
export const DECISION_SOURCE_GATE = "gate_v1";
/** `gate` 가 없던 시절에 저장된 기록. 값은 보존하고 재계산하지 않는다. */
export const DECISION_SOURCE_LEGACY = "legacy";

/**
 * 검사 범위가 잘렸는가.
 *
 * 체커가 `coverage.truncated` 를 주면 그것을 쓴다. 구버전 보고서는 사람이 읽는
 * 한국어 문장으로만 알리므로 문자열 폴백을 남긴다 — 그 문장이 바뀌면 두 시스템이
 * 동시에 "전부 검사 완료"로 착각하던 결함이라, 구조화 필드가 원천이다.
 */
export function coverageTruncated(report) {
  const coverage = report?.coverage;
  if (coverage && typeof coverage === "object" && typeof coverage.truncated === "boolean") {
    return coverage.truncated;
  }
  return (report?.skipped_files || []).some(
    (item) => String(item?.reason || "").includes("max_files=")
  );
}

/** 의존성 감사가 일부라도 판정하지 못했는가(판정 불가·상한 절단). */
export function dependencyIncomplete(report) {
  return (report?.dependency_audit?.audits || []).some(
    (audit) => numberAtLeastZero(audit?.unchecked_count) > 0
      || numberAtLeastZero(audit?.truncated_count) > 0
  );
}

/**
 * 승인된 예외·인라인 무시 요약.
 *
 * 면제가 심사 화면에 보이지 않으면, 지적을 끄고 "이상 없음"을 받아 결재에 올릴
 * 수 있다. 숨기지 말고 **세어서 보이게** 한다. `inline_ignored` 는 체커가 집계를
 * 붙이기 전 보고서에서는 null 이며, 화면은 '미상'으로 구분해 표시해야 한다.
 */
export function suppressionSummary(report) {
  const raw = report?.suppression_summary;
  if (!raw || typeof raw !== "object") {
    return { applied: 0, expired: 0, invalid: 0, inline_ignored: null };
  }
  const countOf = (value) => (Array.isArray(value) ? value.length : numberAtLeastZero(value));
  const inline = raw.inline_ignored;
  return {
    applied: numberAtLeastZero(raw.applied),
    expired: countOf(raw.expired),
    invalid: countOf(raw.invalid),
    inline_ignored: inline === undefined || inline === null ? null : numberAtLeastZero(inline)
  };
}

/**
 * 어떤 검사 엔진이 실제로 돌았는가.
 *
 * semgrep 은 네이티브 Windows 를 지원하지 않아 기관 PC 에서 조용히 빠진다.
 * regex·taint 검사는 남지만 JS/TS 정밀 분석 한 겹이 사라지는데, 보고서에는
 * 그 사실이 없어 "검사했는데 깨끗함"과 "그 검사는 안 돌았음"이 같은 초록으로
 * 보였다. 체커가 목록을 주기 전 보고서는 `known: false` 로 구분한다.
 */
export function engineStatus(report) {
  const engines = report?.engines;
  if (!engines || typeof engines !== "object") {
    return { known: false, used: [], unavailable: [], failed: [], required: [], required_known: false };
  }
  const list = (value) => (Array.isArray(value) ? value : []);
  return {
    known: true,
    used: list(engines.used).map((item) => String(item)),
    unavailable: list(engines.unavailable),
    failed: list(engines.failed),
    // 체커(f1117d8 이후)가 대상 언어로 계산해 주는 필수 엔진. 구버전 보고서에는 없다.
    required: list(engines.required).map((item) => String(item)),
    required_known: Array.isArray(engines.required)
  };
}

/**
 * 필수 엔진이 빠진 검사인가 — fail-closed 의 근거.
 *
 * 시험운영 기준: regex 는 항상, Python 소스가 있으면 python-ast, JS/TS 소스가
 * 있으면 js-taint 가 필수다. 이 판정은 체커가 `engines.required` 로 준다(언어별
 * 필수 엔진을 포털이 하드코딩하지 않는다). 필수 엔진이 `failed` 나 `unavailable`
 * 이면 `missing_required` — 이 검사로는 판정할 수 없다. 필수가 아닌 엔진(semgrep)
 * 이 빠지면 `degraded` — 판정은 하되 화면에 경고로 남긴다.
 *
 * `required` 가 없는 구버전 보고서는 보수적으로 다룬다: 어떤 엔진이든 **실행 중
 * 실패(failed)** 했으면 필수 실패로 본다(무엇이 필수였는지 모르므로), 단순
 * 미설치(unavailable)는 degraded 로 둔다(semgrep 이 Windows 에서 늘 그렇다).
 */
export function engineGate(report) {
  const status = engineStatus(report);
  const nameOf = (item) => (typeof item === "string" ? item : String(item?.name || "unknown"));
  const failed = status.failed.map(nameOf);
  const unavailable = status.unavailable.map(nameOf);
  if (!status.known) {
    return { known: false, missing_required: [], degraded: [], failed, unavailable };
  }
  let missingRequired;
  let degraded;
  if (status.required_known) {
    const required = new Set(status.required);
    missingRequired = [...failed, ...unavailable].filter((name) => required.has(name));
    degraded = [...failed, ...unavailable].filter((name) => !required.has(name));
  } else {
    missingRequired = [...failed];
    degraded = [...unavailable];
  }
  const unique = (items) => Array.from(new Set(items));
  return { known: true, missing_required: unique(missingRequired), degraded: unique(degraded), failed, unavailable };
}

/**
 * 이 점검의 최종 판정.
 *
 * 반환: `{ decision, decision_source, gate_verdict, incomplete_reasons, reason }`
 *
 * 우선순위
 *   1. 검사 자체가 온전하지 않으면(시간초과·프로파일 폴백·범위 절단·의존성 미완)
 *      판정하지 않고 `incomplete`. "판정 불가"는 "안전"이 아니다.
 *   2. 그 외에는 `gate.verdict` 를 그대로 옮긴다.
 *   3. `gate` 가 없거나 모르는 값이면 **`incomplete`**. 구버전 체커나 계약 미달을
 *      통과로 바꾸지 않는다(조용히 느슨해지는 쪽을 막는다).
 *   4. 간편점검에서 `allow` 는 `quick_complete` 로 낮춘다 — 축소 룰셋으로 본
 *      결과를 전체 승인으로 말하지 않기 위해서다(기존 규칙 유지).
 */
export function scanDecision(report, { mode = "standard", timedOut = false } = {}) {
  const incompleteReasons = [];
  if (timedOut) incompleteReasons.push("scan_timeout");
  // 계약 버전이 이 포털보다 높으면 필드의 뜻이 달라졌을 수 있다 — 읽지 않는다.
  const schemaVersion = Number.isInteger(report?.schema_version) ? report.schema_version : null;
  if (schemaVersion !== null && schemaVersion > SUPPORTED_SCAN_SCHEMA_VERSION) {
    incompleteReasons.push("schema_version_unsupported");
  }
  if (report?.profile_fallback) incompleteReasons.push("profile_fallback");
  if (coverageTruncated(report)) incompleteReasons.push("coverage_truncated");
  if (dependencyIncomplete(report)) incompleteReasons.push("dependency_incomplete");
  // 필수 엔진이 빠진 검사는 판정하지 않는다 — "안 돌아간 검사의 초록불"이 바로
  // 이 도구가 막으려는 침묵이다. 발견(findings)은 그대로 보존된다(보고서는 남는다).
  const engineGateResult = engineGate(report);
  if (engineGateResult.missing_required.length > 0) {
    const failedSet = new Set(engineGateResult.failed);
    const anyFailed = engineGateResult.missing_required.some((name) => failedSet.has(name));
    incompleteReasons.push(anyFailed ? "engine_required_failed" : "engine_required_unavailable");
  }

  const gateVerdict = typeof report?.gate?.verdict === "string" ? report.gate.verdict : null;
  const mapped = gateVerdict ? GATE_VERDICT_TO_DECISION[gateVerdict] : undefined;

  if (!mapped) incompleteReasons.push(gateVerdict ? "gate_verdict_unknown" : "gate_missing");

  let decision;
  let reason;
  if (incompleteReasons.length > 0) {
    decision = "incomplete";
    if (incompleteReasons.includes("schema_version_unsupported")) {
      reason = `체커 결과 형식(버전 ${schemaVersion})이 이 포털이 아는 범위(${SUPPORTED_SCAN_SCHEMA_VERSION})를 넘습니다 — `
        + "포털을 갱신한 뒤 다시 점검하세요. 형식을 넘겨짚어 판정하지 않습니다.";
    } else if (incompleteReasons[0] === "gate_missing") {
      reason = "체커 결과에 배포 판정(gate)이 없습니다 — 체커를 최신 버전으로 갱신한 뒤 다시 점검하세요.";
    } else if (incompleteReasons.includes("engine_required_failed") || incompleteReasons.includes("engine_required_unavailable")) {
      reason = `필수 검사 엔진(${engineGateResult.missing_required.join(", ")})이 수행되지 않아 판정할 수 없습니다 — `
        + "서버 체커 설치 상태를 확인한 뒤 다시 점검하세요. 엔진이 빠진 결과를 통과로 읽지 않습니다.";
    } else {
      reason = "";
    }
  } else {
    decision = mode === "quick" && mapped === "allow" ? "quick_complete" : mapped;
    reason = String(report?.gate?.reason || "");
  }

  return {
    decision,
    decision_source: DECISION_SOURCE_GATE,
    gate_verdict: gateVerdict,
    // null = 이 필드가 생기기 전 체커. '검증했는데 1이었다'와 구분해서 기록한다.
    schema_version: schemaVersion,
    incomplete_reasons: incompleteReasons,
    // 판정에는 영향 없이 화면·보고서에 남길 경고(보조 엔진 미수행 등).
    degraded_engines: engineGateResult.degraded,
    missing_required_engines: engineGateResult.missing_required,
    reason
  };
}
