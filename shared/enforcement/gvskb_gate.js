#!/usr/bin/env node
/**
 * Codex public-sector npm package gate for vibecode-checker(gvskb).
 *
 * The Python gate owns policy evaluation. This wrapper keeps npm usage simple:
 *   node shared/enforcement/gvskb_gate.js check react
 *   node shared/enforcement/gvskb_gate.js install react
 */

// ESM 입니다 — 포털 package.json 이 "type": "module" 이라 CommonJS(`require`)로는
// **실행 즉시 죽습니다**(ReferenceError: require is not defined in ES module scope).
// 실측(2026-09-12): 이 파일은 그 상태로 방치돼 있었고, AGENTS.md 는 npm 패키지를
// 추가할 때 이 스크립트를 거치라고 안내하고 있었다 — 즉 **npm 쪽 패키지 게이트가
// 한 번도 동작하지 않았다.** 아무 에러 보고도 없었던 이유는 아무도 실행해 보지
// 않았기 때문이다. 그래서 `npm run check` 에 실제 실행 테스트를 넣었다.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Python 게이트와 같은 값을 쓴다(gvskb_gate.py). 두 곳에서 다르면 차단이
// 경고로 읽히는 종류의 사고가 난다.
const EXIT_WARN = 1;
const EXIT_BLOCK = 2;
const EXIT_USAGE = 64;
const EXIT_NOT_INSTALLED = 65;

function scriptDir() {
  // ESM 에는 __dirname 이 없다.
  return path.dirname(fileURLToPath(import.meta.url));
}

function pythonGatePath() {
  return path.join(scriptDir(), "gvskb_gate.py");
}

function candidatePythons() {
  const candidates = [];
  if (process.env.GVSKB_GATE_PYTHON) candidates.push(process.env.GVSKB_GATE_PYTHON);
  if (process.platform === "win32") {
    candidates.push("C:\\Python313\\python.exe");
    candidates.push("C:\\Python312\\python.exe");
    candidates.push("python");
    candidates.push("py");
  } else {
    candidates.push("python3");
    candidates.push("python");
  }
  return [...new Set(candidates)];
}

function resolvePython() {
  for (const candidate of candidatePythons()) {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status === 0) return candidate;
  }
  return null;
}

function splitNpmSpec(spec, explicitVersion) {
  if (explicitVersion) return { name: spec, version: explicitVersion };
  if (spec.startsWith("@")) {
    const index = spec.lastIndexOf("@");
    if (index > 0 && spec.slice(0, index).includes("/")) {
      return { name: spec.slice(0, index), version: spec.slice(index + 1) };
    }
    return { name: spec, version: null };
  }
  const index = spec.lastIndexOf("@");
  if (index > 0) {
    return { name: spec.slice(0, index), version: spec.slice(index + 1) };
  }
  return { name: spec, version: null };
}

function usage() {
  console.error(`Usage:
  node shared/enforcement/gvskb_gate.js check <package> [--version <version>] [--mode MONITOR|WARN|ENFORCE] [--env-grade E0|E1|E2] [--json]
  node shared/enforcement/gvskb_gate.js install <package> [--version <version>] [--mode MONITOR|WARN|ENFORCE] [--env-grade E0|E1|E2] [--allow-scripts] [-- <npm args>]
  node shared/enforcement/gvskb_gate.js verify-manifest <package.json> [--mode MONITOR|WARN|ENFORCE] [--json]

Set GVSKB_GATE_PYTHON if Windows python alias points to Microsoft Store.`);
}

function parseArgs(argv) {
  const [command, first, ...rest] = argv;
  if (!command || !first || !["check", "install", "verify-manifest"].includes(command)) {
    usage();
    process.exit(EXIT_USAGE);
  }

  const options = {
    command,
    first,
    version: null,
    mode: null,
    envGrade: null,
    json: false,
    allowScripts: false,
    passthrough: [],
  };

  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i];
    if (item === "--") {
      options.passthrough = rest.slice(i + 1);
      break;
    }
    if (item === "--version") {
      options.version = rest[++i];
    } else if (item === "--mode") {
      options.mode = rest[++i];
    } else if (item === "--env-grade") {
      // 대소문자만 달라도 체커가 목록에 없는 값으로 보고 조용히 기본 등급으로
      // 떨어뜨린다. 등급은 판정 기준을 바꾸는 값이므로 여기서 정규화한다.
      // 유효성 판단(E3 거부 포함)은 Python 게이트 한 곳에서만 한다 — 정책을
      // 두 언어에 복제하면 갈라진다.
      options.envGrade = String(rest[++i] ?? "").trim().toUpperCase();
    } else if (item === "--json") {
      options.json = true;
    } else if (item === "--allow-scripts") {
      options.allowScripts = true;
    } else {
      options.passthrough.push(item);
    }
  }

  return options;
}

/**
 * 게이트를 실행하지 못했거나 죽었으면 **막는 쪽**으로 끝낸다.
 *
 * 예전에는 `result.status ?? 1` 이었다. 1 은 WARN 이라 "판정을 받지 못했다"가
 * "경고지만 진행해도 된다"로 읽혔다. 판정을 받지 못한 것은 통과가 아니다.
 */
function exitStatusOf(result, label) {
  if (typeof result.status === "number") return result.status;
  console.error(`[gvskb-gate] ${label}: 게이트를 실행하지 못했습니다. 판정 없이 진행하지 않습니다.`);
  return EXIT_BLOCK;
}

function runPythonGate(args, capture = false) {
  const python = resolvePython();
  if (!python) {
    console.error("Python 실행 파일을 찾을 수 없습니다. GVSKB_GATE_PYTHON을 설정하세요.");
    process.exit(EXIT_NOT_INSTALLED);
  }
  const gate = pythonGatePath();
  if (!fs.existsSync(gate)) {
    console.error(`Python gate를 찾을 수 없습니다: ${gate}`);
    process.exit(EXIT_NOT_INSTALLED);
  }
  return spawnSync(python, [gate, ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    windowsHide: true,
  });
}

function checkCommand(options) {
  const { name, version } = splitNpmSpec(options.first, options.version);
  const args = ["check", name, "--ecosystem", "npm"];
  if (version) args.push("--version", version);
  if (options.mode) args.push("--mode", options.mode);
  if (options.envGrade) args.push("--env-grade", options.envGrade);
  if (options.json) args.push("--json");
  const result = runPythonGate(args, false);
  process.exit(exitStatusOf(result, "BLOCK"));
}

function verifyManifestCommand(options) {
  const args = ["verify-manifest", options.first, "--ecosystem", "npm"];
  if (options.mode) args.push("--mode", options.mode);
  if (options.envGrade) args.push("--env-grade", options.envGrade);
  if (options.json) args.push("--json");
  const result = runPythonGate(args, false);
  process.exit(exitStatusOf(result, "BLOCK"));
}

function installCommand(options) {
  const { name, version } = splitNpmSpec(options.first, options.version);
  const args = ["check", name, "--ecosystem", "npm", "--json"];
  if (version) args.push("--version", version);
  if (options.mode) args.push("--mode", options.mode);
  if (options.envGrade) args.push("--env-grade", options.envGrade);

  const check = runPythonGate(args, true);

  // 설치를 진행하려면 **판정이 있어야 한다.** 예전에는 종료 코드만 봤고,
  // 2(BLOCK)와 2 초과만 막고 나머지는 그대로 npm install 로 내려갔다. 그래서
  // Python 게이트가 죽었을 때(종료 코드 1) 그것이 WARN 과 구별되지 않아
  // **크래시가 설치 허가로 바뀌었다.** 실제로 한글 Windows 에서 그 일이 있었다.
  //
  // 그래서 순서를 뒤집는다. 판정을 읽지 못하면 진행하지 않는다.
  let decision = null;
  try {
    decision = JSON.parse(check.stdout);
  } catch (_) {
    decision = null;
  }

  if (decision === null) {
    console.error("[gvskb-gate] BLOCK: 패키지 게이트의 판정을 읽지 못했습니다. 설치를 진행하지 않습니다.");
    if (check.stdout) process.stderr.write(check.stdout);
    console.error(`- 게이트 종료 코드: ${check.status ?? "실행 실패"}`);
    console.error("- 위 오류를 해결한 뒤 다시 시도하세요. 판정 없이 설치하지 않습니다.");
    process.exit(EXIT_BLOCK);
  }

  // 사람 검토 요건은 위험 판정과 별개의 절차 요건이다 — action 이 무엇이든 막는다.
  if (decision.action === "block" || decision.requires_human_review === true) {
    const label = decision.requires_human_review === true && decision.action !== "block" ? "HOLD" : "BLOCK";
    console.error(`[gvskb-gate] ${label}: ${decision.package} (${decision.ecosystem}, mode=${decision.mode})`);
    for (const reason of (decision.reasons || []).slice(0, 5)) console.error(`- ${reason}`);
    if (decision.requires_human_review === true) {
      console.error("- 이 차단은 위험 판정이 아니라 절차 요건입니다. 보안담당자 확인 후 진행하세요.");
    } else {
      console.error("- 대체 패키지를 선택하거나 체커/레지스트리 검증 후 다시 시도하세요.");
    }
    process.exit(EXIT_BLOCK);
  }

  // 판정은 받았는데 종료 코드가 통과/경고가 아니면, 모르는 상태다 — 진행하지 않는다.
  if (typeof check.status !== "number" || check.status > EXIT_WARN) {
    console.error(`[gvskb-gate] BLOCK: 게이트가 알 수 없는 상태로 끝났습니다(종료 코드 ${check.status ?? "실행 실패"}).`);
    process.exit(EXIT_BLOCK);
  }

  if (decision.action === "warn") {
    console.warn(`[gvskb-gate] WARN: ${decision.package} (${decision.ecosystem}, mode=${decision.mode})`);
    for (const reason of (decision.reasons || []).slice(0, 5)) console.warn(`- ${reason}`);
  }

  const spec = version ? `${name}@${version}` : name;
  const npmArgs = ["install", spec, ...options.passthrough];
  if (!options.allowScripts && !npmArgs.includes("--ignore-scripts")) {
    npmArgs.push("--ignore-scripts");
  }
  const install = spawnSync("npm", npmArgs, {
    stdio: "inherit",
    windowsHide: true,
  });
  process.exit(install.status ?? 1);
}

const options = parseArgs(process.argv.slice(2));
if (options.command === "check") checkCommand(options);
if (options.command === "verify-manifest") verifyManifestCommand(options);
if (options.command === "install") installCommand(options);
