#!/usr/bin/env node
/**
 * 패키지 게이트 래퍼 **두 축이 실제로 실행되는지** 확인한다.
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
 * 그 결함이 npm 축에서만 생길 이유는 없다. 이 포털은 **PyPI 와 npm 을 둘 다
 * 1급 생태계로** 다루고 게이트도 한 쌍(`gvskb_gate.py` · `gvskb_gate.js`)이다.
 * 한쪽만 실행해 보는 것은 절반만 확인하고 둘 다 확인했다고 말하는 것이다.
 * 그래서 여기서 두 축을 모두 띄운다.
 *
 * 체커 설치가 필요한 판정은 여기서 다루지 않는다. 대신 **체커에 묻기 전에**
 * 게이트가 스스로 내리는 판정(E3 자동판정 거부)을 확인한다 — 실행·설정·정책
 * 로딩이 모두 살아 있어야만 그 결론이 나오므로, 설치 없이도 의미 있는 검증이다.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const enforcement = join(root, "shared", "enforcement");

/** 게이트가 둘 다 쓰는 종료 코드. 여기서 갈라지면 차단이 경고로 읽힌다. */
const EXIT_WARN = 1;
const EXIT_BLOCK = 2;

/**
 * "체커가 없는 환경"을 만든다.
 *
 * 처음에는 PATH 에서 체커를 빼는 식으로 했다가 원격 CI 에서 깨졌다. 두 가지가
 * 틀렸다. 게이트는 체커를 PATH 가 아니라 **모듈 import** 로 찾으므로 PATH 로는
 * 없는 상태를 만들 수 없고, 그 필터는 Windows 디렉터리 이름을 전제해 Linux 에서
 * PATH 를 통째로 비워 인터프리터조차 띄우지 못했다.
 *
 * 그래서 게이트가 제공하는 명시적 이음매를 쓴다: 가져올 모듈 이름을 바꿔 실제
 * ImportError 를 일으킨다. 실제 "미설치"와 같은 경로를 같은 방식으로 지난다.
 */
const WITHOUT_CHECKER = { ...process.env, GVSKB_GATE_CHECKER_MODULE: "gvskb_intentionally_missing_for_smoke_test" };

/** CI 는 이 스위치로 "인터프리터가 없어 못 했다"를 실패로 바꾼다. */
const REQUIRE_CHECKER = process.env.PORTAL_REQUIRE_CHECKER === "1";
const skipped = [];

function skip(reason) {
  if (REQUIRE_CHECKER) {
    console.error(`package gate smoke test FAILED — ${reason}`);
    console.error("  PORTAL_REQUIRE_CHECKER=1 에서는 건너뛸 수 없습니다 — 런타임을 설치하세요.");
    process.exit(1);
  }
  skipped.push(reason);
}

function textOf(result) {
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function assertLoaded(output, label) {
  // 콘솔 인코딩 때문에 죽는 경우는 원인을 따로 짚어 준다. 스택만 보면
  // '게이트가 안 돈다'로만 읽히는데, 실제로는 판정까지 다 해 놓고
  // **그 판정을 화면에 쓰다가** 죽는 것이라 고칠 곳이 전혀 다르다.
  assert.ok(
    !/UnicodeEncodeError/.test(output),
    `${label} 게이트가 판정을 출력하다가 죽습니다(콘솔 인코딩).\n`
    + "    한글 Windows 기본 콘솔(cp949)에서 재현됩니다. 게이트 출력에는 '—' 같은\n"
    + "    cp949 에 없는 문자가 들어 있습니다. 사용자는 이 게이트를 터미널에서\n"
    + "    직접 실행하므로(AGENTS.md 안내), 이대로면 그 환경에서 쓸 수 없습니다.\n"
    + "    고칠 곳은 게이트 자신입니다 — 출력 스트림을 UTF-8 로 고정하세요:\n"
    + "      sys.stdout.reconfigure(encoding=\"utf-8\", errors=\"replace\")\n"
    + "      sys.stderr.reconfigure(encoding=\"utf-8\", errors=\"replace\")\n"
    + "    (환경변수 PYTHONIOENCODING 로 덮는 것은 회피입니다 — 사용자의 터미널은 그대로입니다.)\n"
    + `\n${output}`
  );
  // 모듈 로딩 실패는 이번 결함의 핵심이다. 문법 검사로는 잡히지 않는다.
  assert.ok(
    !/ReferenceError|ERR_REQUIRE_ESM|Cannot use import statement|ModuleNotFoundError|SyntaxError|Traceback/.test(output),
    `${label} 게이트가 실행되지 않습니다:\n${output}`
  );
}

// ---------------------------------------------------------------------------
// npm 축 — gvskb_gate.js
// ---------------------------------------------------------------------------

const npmGate = join(enforcement, "gvskb_gate.js");
const npmResult = spawnSync(process.execPath, [npmGate], { encoding: "utf8" });
const npmOutput = textOf(npmResult);

assertLoaded(npmOutput, "npm");

// 인자가 없으면 사용법을 내고 EXIT_USAGE(64) 로 끝나야 한다.
assert.equal(npmResult.status, 64, `종료 코드 64를 기대했지만 ${npmResult.status} 였습니다:\n${npmOutput}`);
assert.match(npmOutput, /Usage:/, "사용법이 출력되지 않았습니다");
assert.match(npmOutput, /gvskb_gate\.js check/, "check 명령 안내가 없습니다");

// 사용법이 안내하는 등급은 체커가 실제로 받는 값이어야 한다.
// E3 는 체커가 지원하지 않으므로 사용법에 남아 있으면 안 된다.
assert.ok(
  !/--env-grade [^\]]*E3/.test(npmOutput),
  "사용법이 E3 를 유효한 선택지처럼 안내하고 있습니다 — 체커는 E3 를 지원하지 않습니다"
);

// ---------------------------------------------------------------------------
// PyPI 축 — gvskb_gate.py
// ---------------------------------------------------------------------------

const pypiGate = join(enforcement, "gvskb_gate.py");

/** 이 PC 의 인터프리터. 없으면(CI 밖) 건너뛰되 통과로 바꿔 말하지 않는다. */
function interpreter() {
  const candidates = process.platform === "win32"
    ? ["python.exe", "python3.exe", "py.exe"]
    : ["python3", "python"];
  for (const command of candidates) {
    const probe = spawnSync(command, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return command;
  }
  return null;
}

const command = interpreter();
if (command === null) {
  skip("PyPI 게이트 실행 — 이 PC 에서 인터프리터를 찾지 못했습니다");
} else {
  // 1) 사용법이 나온다 = 모듈·argparse·정책 로딩이 살아 있다.
  const help = spawnSync(command, [pypiGate, "--help"], { encoding: "utf8" });
  const helpOutput = textOf(help);
  assertLoaded(helpOutput, "PyPI");
  assert.equal(help.status, 0, `--help 는 0 으로 끝나야 합니다(${help.status}):\n${helpOutput}`);
  assert.match(helpOutput, /check/, "check 명령이 안내되지 않았습니다");
  assert.match(helpOutput, /install/, "install 명령이 안내되지 않았습니다");

  // 2) 체커에 묻기 전에 내리는 판정 — E3 는 자동판정을 거부해야 한다.
  //    이 결론이 나오려면 기관 프로파일 로딩과 등급 정규화가 모두 살아 있어야 한다.
  const e3 = spawnSync(command, [pypiGate, "check", "requests", "--version", "2.32.3", "--env-grade", "E3", "--json"], { encoding: "utf8" });
  const e3Output = textOf(e3);
  assertLoaded(e3Output, "PyPI");
  let decision;
  try {
    decision = JSON.parse(e3Output.slice(e3Output.indexOf("{")));
  } catch {
    assert.fail(`E3 판정 JSON 을 읽을 수 없습니다:\n${e3Output}`);
  }
  assert.equal(decision.action, "block", "E3 는 자동판정 대상이 아니므로 막아야 합니다");
  assert.equal(
    decision.checker_verdict, "unsupported_env_grade",
    "'검사했는데 막았다'와 '검사 자체를 하지 않았다'는 감사에서 전혀 다른 기록이다"
  );
  assert.equal(decision.requires_human_review, true, "사람 심사 경로가 값으로 남아야 합니다");
  assert.ok(Array.isArray(decision.reasons) && decision.reasons.length > 0, "막기만 하고 사유가 없으면 게이트는 우회된다");
  assert.equal(e3.status, EXIT_BLOCK, `E3 는 BLOCK(2)으로 끝나야 합니다(${e3.status})`);

  // 3) 두 게이트가 같은 결론에 이르러야 한다.
  //    npm 래퍼는 판정을 Python 게이트에 위임하므로, 여기서 갈라지면 생태계에
  //    따라 정책이 달라진다. 한쪽만 막히는 상태는 막지 않는 것과 같다.
  const npmE3 = spawnSync(process.execPath, [npmGate, "check", "lodash", "--version", "4.17.21", "--env-grade", "E3", "--json"], { encoding: "utf8" });
  const npmE3Output = textOf(npmE3);
  assertLoaded(npmE3Output, "npm→PyPI 위임");
  assert.equal(npmE3.status, EXIT_BLOCK, `npm 축 E3 도 BLOCK(2)이어야 합니다(${npmE3.status})`);

  // 4) 체커가 없어도 실행환경 등급 요건은 적용된다.
  //    예전에는 checker_error 경로가 일찍 돌아가 E2 사람검토 판단에 닿지 못했고,
  //    기본 모드(MONITOR)와 겹쳐 **E2 인데 action=pass · 종료 코드 0** 이 나왔다.
  //    체커가 답을 못 할 때야말로 절차 요건이 적용돼야 한다.
  const e2 = spawnSync(command, [pypiGate, "check", "requests", "--version", "2.32.3", "--env-grade", "E2", "--json"], { encoding: "utf8", env: WITHOUT_CHECKER });
  const e2Output = textOf(e2);
  assertLoaded(e2Output, "PyPI");
  let e2Decision;
  try {
    e2Decision = JSON.parse(e2Output.slice(e2Output.indexOf("{")));
  } catch {
    assert.fail(`E2 판정 JSON 을 읽을 수 없습니다:\n${e2Output}`);
  }
  // 이음매가 실제로 작동했는지부터 확인한다 — 체커가 있는 PC 에서 정상 판정이
  // 나와 버리면 이 테스트는 '체커 없음' 경로를 본 것이 아니다.
  assert.equal(e2Decision.checker_verdict, "checker_unavailable", `체커 없음 경로를 타지 않았습니다: ${e2Decision.checker_verdict}`);
  assert.equal(e2Decision.requires_human_review, true, "체커가 없어도 E2 사람검토 요건은 남아야 합니다");
  assert.equal(e2Decision.action, "block", "체커가 없다고 E2 를 통과시키면 안 됩니다");
  assert.equal(e2.status, EXIT_BLOCK, `E2(체커 없음)는 BLOCK(2)이어야 합니다(${e2.status})`);
}

// ---------------------------------------------------------------------------

for (const note of skipped) console.log(`  · 건너뜀: ${note}`);
console.log(`package gate smoke test passed${REQUIRE_CHECKER ? " (체커 필수 모드)" : ""}`);
