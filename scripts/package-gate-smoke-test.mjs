#!/usr/bin/env node
/**
 * 패키지 게이트 래퍼가 **실제로 실행되는지** 확인한다.
 *
 * 왜 있는가: `shared/enforcement/gvskb_gate.js` 는 포털이 `"type": "module"` 인데
 * CommonJS(`require`)로 작성돼 있어 **실행 즉시 죽고 있었다**.
 *
 *     ReferenceError: require is not defined in ES module scope
 *
 * AGENTS.md 는 npm 패키지를 추가할 때 이 스크립트를 거치라고 안내한다. 즉 npm
 * 쪽 패키지 게이트가 한 번도 동작하지 않았는데, 아무도 몰랐다 — **아무도 실행해
 * 보지 않았기 때문이다.** 문법 검사(`node --check`)는 이 결함을 잡지 못한다.
 * 모듈 로딩은 런타임에 실패하므로, 실제로 프로세스를 띄워 봐야 한다.
 *
 * 여기서는 Python 체커가 없는 환경에서도 돌 수 있는 경로만 확인한다
 * (인자 없음 → usage). 판정 로직 자체는 Python 게이트의 책임이다.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const gate = join(root, "shared", "enforcement", "gvskb_gate.js");

const result = spawnSync(process.execPath, [gate], { encoding: "utf8" });
const output = `${result.stdout || ""}${result.stderr || ""}`;

// 1) 모듈이 로딩돼야 한다 — 이 한 줄이 이번 결함의 핵심이다.
assert.ok(
  !/ReferenceError|ERR_REQUIRE_ESM|Cannot use import statement/.test(output),
  `게이트 래퍼가 실행되지 않습니다:\n${output}`
);

// 2) 인자가 없으면 사용법을 내고 EXIT_USAGE(64) 로 끝나야 한다.
assert.equal(result.status, 64, `종료 코드 64를 기대했지만 ${result.status} 였습니다:\n${output}`);
assert.match(output, /Usage:/, "사용법이 출력되지 않았습니다");
assert.match(output, /gvskb_gate\.js check/, "check 명령 안내가 없습니다");

// 3) 사용법이 안내하는 등급은 체커가 실제로 받는 값이어야 한다.
//    E3 는 체커가 지원하지 않으므로 사용법에 남아 있으면 안 된다.
assert.ok(
  !/--env-grade [^\]]*E3/.test(output),
  "사용법이 E3 를 유효한 선택지처럼 안내하고 있습니다 — 체커는 E3 를 지원하지 않습니다"
);

console.log("package gate smoke test passed");
