#!/usr/bin/env node
/**
 * 재생성한 산출물과 저장된 골든 fixture 를 대조한다.
 *
 * 체커 저장소의 `scripts/regenerate_portal_fixture.py` 가 방금 만든 결과를
 * 인자로 받는다. 확인하는 것은 세 가지다.
 *
 *  1. **재생성이 지금도 되는가** — 되지 않으면 fixture 가 낡은 날 고칠 방법이
 *     없다. 그 사실은 낡은 날이 아니라 오늘 알아야 한다.
 *  2. **fixture 가 낡지 않았는가** — 저장된 것과 방금 만든 것의 체커 버전이
 *     다르면, 계약 테스트는 통과하는데 실제 연동은 옛 형식으로 검증된 상태다.
 *  3. **계약이 줄지 않았는가** — 저장된 fixture 에 있던 필드가 새 산출물에서
 *     사라졌다면, 포털이 읽던 것이 없어진 것이다.
 *
 * 바이트 단위로 같은지는 보지 않는다. `generated_at` 처럼 실행할 때마다 달라지는
 * 값이 있어서 애초에 같을 수 없고, 같기를 요구하면 의미 없는 실패만 쌓인다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const goldenPath = join(root, "fixtures", "checker-reports", "gate-blocked-by-kev.json");

const regeneratedPath = process.argv[2];
if (!regeneratedPath) {
  console.error("사용법: node scripts/fixture-regeneration-check.mjs <재생성된 JSON 경로>");
  process.exit(64);
}

function load(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`${label} 을(를) 읽을 수 없습니다: ${path}\n  ${error.message}`);
    process.exit(1);
  }
}

const golden = load(goldenPath, "저장된 골든 fixture");
const fresh = load(regeneratedPath, "재생성된 산출물");

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}\n    ${String(error.message).split("\n").slice(0, 6).join("\n    ")}`);
  }
}

// ---------------------------------------------------------------------------
// 1. 재생성 결과가 fixture 로서 의미가 있는가
//
// 이 fixture 의 요점은 한 조합이다: 소스는 깨끗한데 패키지 때문에 막힌다.
// 포털이 예전에 summary.blocked 만 보고 판정하던 시절 바로 이 조합을 통과로
// 읽었다. 조합이 유지되지 않으면 fixture 는 이름만 남는다.
// ---------------------------------------------------------------------------

check("재생성: 소스는 깨끗하다", () => {
  assert.equal(fresh.summary?.finding_count, 0);
  assert.equal(fresh.summary?.blocked, false);
});

check("재생성: 패키지 때문에 막힌다", () => {
  assert.equal(fresh.gate?.verdict, "blocked");
  assert.equal(fresh.gate?.blocked_source, false);
  assert.equal(fresh.gate?.blocked_dependency, true);
  assert.ok(fresh.gate?.block_reasons?.length > 0, "차단 근거가 비어 있습니다");
});

// ---------------------------------------------------------------------------
// 2. 저장된 fixture 가 낡지 않았는가
// ---------------------------------------------------------------------------

check("저장된 fixture 가 지금 체커와 같은 세대다", () => {
  assert.equal(
    golden.engine_version, fresh.engine_version,
    `fixture 가 낡았습니다(저장 ${golden.engine_version} ≠ 재생성 ${fresh.engine_version}).\n`
    + `교체하세요: python <체커>/scripts/regenerate_portal_fixture.py --out ${goldenPath}`
  );
  assert.equal(
    golden.schema_version, fresh.schema_version,
    `계약 버전이 달라졌습니다(저장 v${golden.schema_version} ≠ 재생성 v${fresh.schema_version}).\n`
    + "포털의 지원 계약 버전을 먼저 올린 뒤 fixture 를 교체하세요."
  );
});

// ---------------------------------------------------------------------------
// 3. 계약이 줄지 않았는가
// ---------------------------------------------------------------------------

check("저장된 fixture 에 있던 필드가 사라지지 않았다", () => {
  const missing = Object.keys(golden).filter((key) => !(key in fresh));
  assert.deepEqual(
    missing, [],
    `체커 산출물에서 사라진 필드가 있습니다: ${missing.join(", ")}\n`
    + "포털이 읽던 값일 수 있습니다 — 없어진 이유를 확인한 뒤 판정 코드를 함께 고치세요."
  );
});

// ---------------------------------------------------------------------------
// 4. 같은 버전 안에서 판정 내용이 바뀌지 않았는가
//
// 버전·스키마·최상위 필드 존재만 보면, 같은 0.3.0 안에서 gate 값이나 차단 사유
// 형식이 바뀌어도 저장된 fixture 가 통과한다 — 낡았는데 낡지 않은 것처럼.
// 그래서 실행마다 달라지는 값과 만든 PC 에 좌우되는 값을 빼고, 나머지는
// **값 자체**를 비교한다.
// ---------------------------------------------------------------------------

/** 실행 시각·인텔 기준일·엔진 가용성처럼 판정의 내용이 아니라 환경인 값들. */
const VOLATILE_FIELDS = new Set([
  "generated_at",        // 실행 시각
  "engines",             // semgrep 유무 등 — 만든 PC 의 사정
  "intel_freshness",     // 인텔 캐시 기준일
  "scan_mode",           // online/offline
  "source_snapshot",     // 작업 트리 지문
  "reproduce_command"    // 실행 경로가 섞일 수 있다
]);

function stableView(report) {
  const view = {};
  for (const key of Object.keys(report).sort()) {
    if (!VOLATILE_FIELDS.has(key)) view[key] = report[key];
  }
  return view;
}

check("변동 필드를 뺀 나머지는 값이 같다", () => {
  const goldenView = stableView(golden);
  const freshView = stableView(fresh);
  const differing = Object.keys({ ...goldenView, ...freshView })
    .filter((key) => JSON.stringify(goldenView[key]) !== JSON.stringify(freshView[key]));
  assert.deepEqual(
    differing, [],
    `같은 체커 버전인데 판정 내용이 다릅니다: ${differing.join(", ")}\n`
    + "저장된 fixture 가 낡았거나, 체커가 버전을 올리지 않고 판정을 바꿨습니다.\n"
    + `교체하세요: python <체커>/scripts/regenerate_portal_fixture.py --out ${goldenPath}`
  );
});

// ---------------------------------------------------------------------------
// 5. 어느 커밋에서 만들어졌는가
//
// 버전은 같은데 코드가 다를 수 있다. 재생성 스크립트는 산출물 옆에 만든 체커
// 커밋을 .meta.json 으로 남기고, 여기서는 저장된 것과 방금 만든 것이 같은
// 커밋인지 본다. CI 는 체커를 고정된 커밋으로 받으므로, 다르면 저장된
// fixture 가 그 커밋에서 나온 것이 아니라는 뜻이다.
// ---------------------------------------------------------------------------

function metadataPathFor(path) {
  return path.replace(/\.json$/, ".meta.json");
}

function loadOptional(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

check("저장된 fixture 는 지금 검사에 쓰인 체커 커밋에서 만들어졌다", () => {
  const goldenMeta = loadOptional(metadataPathFor(goldenPath));
  const freshMeta = loadOptional(metadataPathFor(regeneratedPath));
  assert.ok(goldenMeta, `저장된 fixture 옆에 .meta.json 이 없습니다: ${metadataPathFor(goldenPath)}\n재생성 스크립트로 다시 만들면 함께 생깁니다.`);
  assert.ok(freshMeta, `재생성 결과 옆에 .meta.json 이 없습니다: ${metadataPathFor(regeneratedPath)}`);
  assert.ok(goldenMeta.checker_commit, "저장된 fixture 의 체커 커밋이 비어 있습니다 — 저장소 밖에서 만들어졌습니다.");
  assert.ok(freshMeta.checker_commit, "재생성 결과의 체커 커밋이 비어 있습니다 — 체커를 git 으로 받아 실행해야 합니다.");
  assert.equal(
    goldenMeta.checker_commit, freshMeta.checker_commit,
    `저장된 fixture 는 다른 체커 커밋에서 만들어졌습니다(저장 ${goldenMeta.checker_commit.slice(0, 12)} ≠ 지금 ${freshMeta.checker_commit.slice(0, 12)}).\n`
    + `교체하세요: python <체커>/scripts/regenerate_portal_fixture.py --out ${goldenPath}`
  );
  assert.equal(freshMeta.checker_worktree_dirty, false, "커밋되지 않은 변경이 섞인 체커로 만든 결과는 재현할 수 없습니다.");
});

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`fixture 재생성 대조 FAILED (${failures.length}건)`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

// 새로 생긴 필드는 실패로 다루지 않는다 — 포털이 아직 읽지 않는 값이므로
// 판정이 틀어지지는 않는다. 다만 계약이 늘어난 것은 드러내 둔다.
const added = Object.keys(fresh).filter((key) => !(key in golden));
if (added.length > 0) {
  console.log(`  · 새 필드: ${added.join(", ")}`);
  console.log("    체커 산출물에 없던 값이 생겼습니다. fixture 를 교체해 두면 계약 테스트가 이 값들까지 보게 됩니다.");
}
console.log(`fixture 재생성 대조 passed (체커 ${fresh.engine_version}, 계약 v${fresh.schema_version})`);
