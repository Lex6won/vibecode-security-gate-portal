// 패키지 관측 저장층 — 화이트리스트 근거 축적 (P2)
//
// 지금은 파일 기반(JSONL + 집계 JSON)이다. DB(db/schema.postgresql.sql 의
// package_observations / package_usage_stats)가 준비되면 이 모듈의 함수 구현만
// 교체한다 — 호출부(server.js)는 인터페이스만 안다.
//
// 절대 규칙 (22번 문서 §5-2, 연동합의):
//  - 허용목록 필드만 적재한다. 소스 조각·파일 경로·개인식별자는 어떤 필드로도 넣지 않는다.
//    (체커 JSON의 audit.manifest 는 로컬 경로이므로 적재 금지)
//  - 이 저장소는 관측이다. 어떤 자동 로직도 이를 근거로 승인하지 않는다.
//  - 같은 패키지의 반복 관측이 곧 사용 빈도이므로 중복 제거하지 않는다.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

let observationsFile = "";
let statsFile = "";
let submissionsFile = "";
let usageStats = {};
let submittedScans = new Set();
let observationRecords = [];

function readJsonFile(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function initObservationStore(directory) {
  mkdirSync(directory, { recursive: true });
  observationsFile = join(directory, "package-observations.jsonl");
  statsFile = join(directory, "package-usage-stats.json");
  submissionsFile = join(directory, "submitted-scans.json");
  usageStats = readJsonFile(statsFile, {});
  submittedScans = new Set(readJsonFile(submissionsFile, []));
  observationRecords = existsSync(observationsFile)
    ? readFileSync(observationsFile, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    })
    : [];
}

// 체커 dependency_audit 의 check 항목에서 허용목록 필드만 추린다.
// 여기 없는 필드는 어떤 이유로도 통과하지 못한다.
export function toObservationRecord(check, context) {
  const meta = check.registry_metadata || {};
  const heuristics = check.heuristics || {};
  return {
    scan_id: context.scanId,
    ecosystem: String(check.ecosystem || context.ecosystem || ""),
    package_name: String(check.name || ""),
    package_version: String(check.version || ""),
    version_exact: check.version_exact === true,
    source_scope: String(check.source_scope || context.sourceScope || "manifest"),
    verdict: String(check.verdict || "unknown"),
    vulnerability_count: Number(check.vulnerability_count || 0),
    max_cve: check.max_cve || null,
    is_malicious_package: check.is_malicious_package === true,
    in_kev: typeof check.in_kev === "boolean" ? check.in_kev : null,
    kev_checked: check.kev_checked === true,
    license: meta.license || null,
    install_scripts: meta.install_scripts || null,
    deprecated: typeof meta.deprecated === "boolean" ? meta.deprecated : null,
    version_age_days: Number.isFinite(meta.version_age_days) ? meta.version_age_days : null,
    typosquat_warning: heuristics.typosquat_warning || null,
    registry_status: check.registry_status || null,
    registry_decision: check.registry_decision || null,
    checker_version: check.engine_version || null,
    checked_at: check.checked_at || null,
    project_label: String(context.projectLabel || ""),
    department_code: context.departmentCode || null,
    observed_at: new Date().toISOString()
  };
}

function statsKey(record) {
  return `${record.ecosystem}:${record.package_name}`;
}

function applyToStats(record) {
  const key = statsKey(record);
  const entry = usageStats[key] || {
    ecosystem: record.ecosystem,
    package_name: record.package_name,
    observation_count: 0,
    manifest_count: 0,
    project_labels: [],
    department_codes: [],
    versions: [],
    latest_version: null,
    has_vulnerable_observation: false,
    has_malicious_observation: false,
    first_observed_at: record.observed_at,
    last_observed_at: record.observed_at
  };
  entry.observation_count += 1;
  if (record.source_scope === "manifest" || record.source_scope === "single") entry.manifest_count += 1;
  if (record.project_label && !entry.project_labels.includes(record.project_label)) entry.project_labels.push(record.project_label);
  if (record.department_code && !entry.department_codes.includes(record.department_code)) entry.department_codes.push(record.department_code);
  if (record.package_version && !entry.versions.includes(record.package_version)) entry.versions.push(record.package_version);
  entry.latest_version = record.package_version || entry.latest_version;
  if (record.vulnerability_count > 0 || record.verdict === "vulnerable") entry.has_vulnerable_observation = true;
  if (record.is_malicious_package || record.verdict === "malicious") entry.has_malicious_observation = true;
  entry.last_observed_at = record.observed_at;
  usageStats[key] = entry;
}

async function saveJsonAtomic(path, value) {
  const temporary = `${path}.writing`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export function hasSubmission(scanId) {
  return submittedScans.has(scanId);
}

export async function recordSubmission(scanId, records) {
  if (!observationsFile) throw new Error("observation store is not initialized");
  const lines = records.map((record) => JSON.stringify(record)).join("\n");
  if (records.length > 0) {
    mkdirSync(dirname(observationsFile), { recursive: true });
    await appendFile(observationsFile, `${lines}\n`, "utf8");
    observationRecords.push(...records);
    for (const record of records) applyToStats(record);
    await saveJsonAtomic(statsFile, usageStats);
  }
  submittedScans.add(scanId);
  await saveJsonAtomic(submissionsFile, [...submittedScans]);
  return records.length;
}

export function observationSummary() {
  const entries = Object.values(usageStats);
  return {
    observed_packages: entries.length,
    total_observations: entries.reduce((sum, entry) => sum + entry.observation_count, 0),
    packages_with_risk_signals: entries.filter((entry) => entry.has_vulnerable_observation || entry.has_malicious_observation).length,
    submitted_scan_count: submittedScans.size
  };
}

// P4(관리자 화면)의 기반 — 지금은 요약만 노출하고 목록 화면은 P4에서 붙인다.
export function usageStatsSnapshot() {
  return usageStats;
}

export function observationRecordsSnapshot() {
  return observationRecords.map((record) => ({ ...record }));
}
