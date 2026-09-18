import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = resolve(import.meta.dirname, "..");
const TOKEN = "auth-mode-test-token";

function childEnvironment(port, root, overrides = {}) {
  return {
    ...process.env,
    PORT: String(port),
    PORTAL_BIND_HOST: "127.0.0.1",
    PORTAL_LOCAL_API_TOKEN: TOKEN,
    PORTAL_DEV_AUTO_LOGIN_EMAIL: "auth-test@gg.go.kr",
    PORTAL_SCAN_HISTORY_FILE: join(root, "scan-history.jsonl"),
    PORTAL_REPORT_DIR: join(root, "reports"),
    PORTAL_DRAFT_REPORT_DIR: join(root, "drafts"),
    PORTAL_ACCOUNT_FILE: join(root, "accounts.json"),
    PORTAL_AUTH_AUDIT_FILE: join(root, "auth-audit.jsonl"),
    ADMIN_AUTH_FILE: join(root, "admin-auth.json"),
    PORTAL_EXPECTED_CHECKER_COMMIT: "",
    ...overrides
  };
}

function startPortal(port, root, overrides) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: childEnvironment(port, root, overrides),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  return { child, output: () => output };
}

async function waitUntilReady(baseUrl, child, output) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`portal exited before readiness: ${output()}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { "X-VibeCode-Local-Token": TOKEN }
      });
      if (response.ok) return;
    } catch {}
    await delay(50);
  }
  throw new Error(`portal readiness timeout: ${output()}`);
}

async function stopPortal(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    delay(2000).then(() => child.kill("SIGKILL"))
  ]);
}

async function api(baseUrl, path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "X-VibeCode-Local-Token": TOKEN,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
}

async function expectStartupFailure(root, overrides, pattern) {
  const port = 18940 + Math.floor(Math.random() * 100);
  const { child, output } = startPortal(port, root, overrides);
  const exitCode = await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    delay(3000).then(() => null)
  ]);
  if (exitCode === null) {
    await stopPortal(child);
    assert.fail(`portal unexpectedly started: ${output()}`);
  }
  assert.notEqual(exitCode, 0);
  assert.match(output(), pattern);
}

const scratch = await mkdtemp(join(tmpdir(), "portal-auth-mode-"));
try {
  await expectStartupFailure(scratch, {
    PORTAL_BIND_HOST: "0.0.0.0",
    PORTAL_DEPLOYMENT_MODE: "local",
    PORTAL_AUTH_PROVIDER: "local-dev"
  }, /loopback/);
  await expectStartupFailure(scratch, {
    PORTAL_ALLOWED_HOSTS: "portal.example.go.kr",
    PORTAL_EXPECTED_CHECKER_COMMIT: "a".repeat(40),
    PORTAL_DEPLOYMENT_MODE: "production",
    PORTAL_AUTH_PROVIDER: "local-dev"
  }, /cannot use local-dev/);
  await expectStartupFailure(scratch, {
    PORTAL_ALLOWED_HOSTS: "portal.example.go.kr",
    PORTAL_EXPECTED_CHECKER_COMMIT: "a".repeat(40),
    PORTAL_DEPLOYMENT_MODE: "pilot",
    PORTAL_AUTH_PROVIDER: "cloudflare-access",
    PORTAL_ACCESS_TEAM_DOMAIN: "",
    PORTAL_ACCESS_AUD: ""
  }, /requires PORTAL_ACCESS_TEAM_DOMAIN/);

  const localPort = 18871;
  const localBase = `http://127.0.0.1:${localPort}`;
  const local = startPortal(localPort, scratch, {
    PORTAL_DEPLOYMENT_MODE: "local",
    PORTAL_AUTH_PROVIDER: "local-dev",
    PORTAL_ACCESS_TEAM_DOMAIN: "",
    PORTAL_ACCESS_AUD: ""
  });
  try {
    await waitUntilReady(localBase, local.child, local.output);
    let response = await api(localBase, "/api/auth/session");
    let result = await response.json();
    assert.equal(result.deployment_mode, "local");
    assert.equal(result.auth_provider, "local-dev");

    response = await api(localBase, "/api/auth/development-login", { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
    response = await api(localBase, "/api/auth/request-link", {
      method: "POST",
      body: JSON.stringify({ email: "auth-test@gg.go.kr" })
    });
    result = await response.json();
    assert.equal(response.status, 200);
    assert.match(result.dev_login_url, /^\/auth\/complete\?token=/);

    const startedAt = performance.now();
    const responses = await Promise.all(Array.from({ length: 200 }, () => api(localBase, "/api/auth/session")));
    const elapsedMs = Math.round(performance.now() - startedAt);
    assert.equal(responses.every((item) => item.status === 200), true);
    assert.ok(elapsedMs < 10000, `200 session requests took ${elapsedMs}ms`);
    console.log(`auth_session_parallel_200_ms: ${elapsedMs}`);
  } finally {
    await stopPortal(local.child);
  }

  const accessPort = 18872;
  const accessBase = `http://127.0.0.1:${accessPort}`;
  const access = startPortal(accessPort, scratch, {
    PORTAL_DEPLOYMENT_MODE: "pilot",
    PORTAL_AUTH_PROVIDER: "cloudflare-access",
    PORTAL_ALLOWED_HOSTS: `127.0.0.1:${accessPort}`,
    PORTAL_EXPECTED_CHECKER_COMMIT: "a".repeat(40),
    PORTAL_ACCESS_TEAM_DOMAIN: "http://127.0.0.1:1",
    PORTAL_ACCESS_AUD: "test-audience"
  });
  try {
    await waitUntilReady(accessBase, access.child, access.output);
    let response = await api(accessBase, "/api/auth/session");
    const result = await response.json();
    assert.equal(result.deployment_mode, "pilot");
    assert.equal(result.auth_provider, "cloudflare-access");

    response = await api(accessBase, "/api/auth/development-login", { method: "POST", body: "{}" });
    assert.equal(response.status, 404);
    response = await api(accessBase, "/api/auth/request-link", {
      method: "POST",
      body: JSON.stringify({ email: "auth-test@gg.go.kr" })
    });
    assert.equal(response.status, 404);
    response = await api(accessBase, "/api/auth/access-login", { method: "POST", body: "{}" });
    assert.equal(response.status, 401);
  } finally {
    await stopPortal(access.child);
  }

  console.log("auth_mode_integration_test: ok");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
