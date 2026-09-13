#!/usr/bin/env node
import assert from "node:assert/strict";
import { jobTag, reportStemForJob } from "../src/report-naming.mjs";

/**
 * 보고서 이름이 동시 점검에서 겹치지 않는지.
 *
 * 예전 방식은 파일 존재 여부로만 _2 를 붙였다. 파일은 점검이 끝난 뒤 생기므로,
 * 같은 대상을 같은 분에 두 번 점검하면 둘 다 "아직 없음"을 보고 같은 이름을
 * 골랐다. 여기서는 그 상황을 그대로 만든다 — 시각을 고정하고, 존재 검사는
 * 언제나 '없음'이라고 답하게 한다.
 */

const failures = [];
function check(name, fn) {
  try { fn(); } catch (error) { failures.push(`${name}\n    ${String(error.message).split("\n")[0]}`); }
}

const fixedNow = new Date("2026-09-13T01:25:00+09:00");
const nothingExists = () => false;

function job(id, overrides = {}) {
  return { id, target_type: "local_folder", target_ref: "C:/work/sample", target_label: "민원처리", mode: "standard", ...overrides };
}

check("같은 대상·같은 분·같은 방식의 동시 점검 두 건은 다른 이름을 받는다", () => {
  const first = reportStemForJob(job("11111111-aaaa-4bbb-8ccc-000000000001"), "C:/work/sample", { now: fixedNow, exists: nothingExists });
  const second = reportStemForJob(job("22222222-aaaa-4bbb-8ccc-000000000002"), "C:/work/sample", { now: fixedNow, exists: nothingExists });
  assert.notEqual(first, second, "파일이 아직 없어도 이름이 갈려야 한다");
  assert.match(first, /^민원처리_2026-09-13_0125_표준점검_11111111$/);
  assert.match(second, /^민원처리_2026-09-13_0125_표준점검_22222222$/);
});

check("같은 작업은 몇 번 계산해도 같은 이름이다", () => {
  const a = reportStemForJob(job("33333333-aaaa-4bbb-8ccc-000000000003"), "C:/work/sample", { now: fixedNow, exists: nothingExists });
  const b = reportStemForJob(job("33333333-aaaa-4bbb-8ccc-000000000003"), "C:/work/sample", { now: fixedNow, exists: nothingExists });
  assert.equal(a, b);
});

check("점검 방식이 이름에 남는다", () => {
  const quick = reportStemForJob(job("44444444-0000-4000-8000-000000000004", { mode: "quick" }), "C:/work/sample", { now: fixedNow, exists: nothingExists });
  assert.match(quick, /_간편점검_/);
});

check("GitHub 대상은 저장소 이름을 쓴다", () => {
  const stem = reportStemForJob(
    job("55555555-0000-4000-8000-000000000005", { target_type: "github_url", target_ref: "https://github.com/org/my-service.git", target_label: "" }),
    "", { now: fixedNow, exists: nothingExists }
  );
  assert.match(stem, /^my-service_/);
});

check("id 가 없는 구식 작업도 이름은 만들어지고 존재 검사가 안전망으로 남는다", () => {
  const seen = new Set(["민원처리_2026-09-13_0125_표준점검"]);
  const stem = reportStemForJob(job(undefined), "C:/work/sample", { now: fixedNow, exists: (candidate) => seen.has(candidate) });
  assert.equal(stem, "민원처리_2026-09-13_0125_표준점검_2");
});

check("id 꼬리표는 파일 이름에 안전한 글자만 쓴다", () => {
  assert.equal(jobTag("AB-cd:ef/12345678"), "abcdef12");
  assert.equal(jobTag(""), "");
  assert.equal(jobTag(null), "");
});

if (failures.length) {
  console.error(`report naming test FAILED (${failures.length}건)`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log("report naming test passed");
