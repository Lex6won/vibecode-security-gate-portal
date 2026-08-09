#!/usr/bin/env node
/**
 * Codex public-sector npm package gate for vibecode-checker(gvskb).
 *
 * The Python gate owns policy evaluation. This wrapper keeps npm usage simple:
 *   node shared/enforcement/gvskb_gate.js check react
 *   node shared/enforcement/gvskb_gate.js install react
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const EXIT_USAGE = 64;
const EXIT_NOT_INSTALLED = 65;

function scriptDir() {
  return __dirname;
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
  node shared/enforcement/gvskb_gate.js check <package> [--version <version>] [--mode MONITOR|WARN|ENFORCE] [--env-grade E1|E2|E3] [--json]
  node shared/enforcement/gvskb_gate.js install <package> [--version <version>] [--mode MONITOR|WARN|ENFORCE] [--env-grade E1|E2|E3] [--allow-scripts] [-- <npm args>]
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
      options.envGrade = rest[++i];
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
  process.exit(result.status ?? 1);
}

function verifyManifestCommand(options) {
  const args = ["verify-manifest", options.first, "--ecosystem", "npm"];
  if (options.mode) args.push("--mode", options.mode);
  if (options.envGrade) args.push("--env-grade", options.envGrade);
  if (options.json) args.push("--json");
  const result = runPythonGate(args, false);
  process.exit(result.status ?? 1);
}

function installCommand(options) {
  const { name, version } = splitNpmSpec(options.first, options.version);
  const args = ["check", name, "--ecosystem", "npm", "--json"];
  if (version) args.push("--version", version);
  if (options.mode) args.push("--mode", options.mode);
  if (options.envGrade) args.push("--env-grade", options.envGrade);

  const check = runPythonGate(args, true);
  if (check.status === 2) {
    try {
      const decision = JSON.parse(check.stdout);
      console.error(`[gvskb-gate] BLOCK: ${decision.package} (${decision.ecosystem}, mode=${decision.mode})`);
      for (const reason of (decision.reasons || []).slice(0, 5)) console.error(`- ${reason}`);
      console.error("- 대체 패키지를 선택하거나 체커/레지스트리 검증 후 다시 시도하세요.");
    } catch (_) {
      console.error(check.stdout || "gvskb gate blocked this package.");
    }
    process.exit(2);
  }
  if ((check.status ?? 1) > 2) process.exit(check.status ?? 1);

  if (check.stdout) {
    try {
      const decision = JSON.parse(check.stdout);
      if (decision.action === "warn") {
        console.warn(`[gvskb-gate] WARN: ${decision.package} (${decision.ecosystem}, mode=${decision.mode})`);
        for (const reason of (decision.reasons || []).slice(0, 5)) console.warn(`- ${reason}`);
      }
    } catch (_) {
      process.stdout.write(check.stdout);
    }
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
