#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";

const root = resolve(import.meta.dirname, "..");
const approvedCommit = readFileSync(join(root, "config", "checker.commit"), "utf8").trim();

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`portal exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      return { status: response.status, body: await response.json() };
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
  }
  throw new Error("portal health check timed out");
}

async function runCase(expectedCommit) {
  const port = await freePort();
  const dataRoot = await mkdtemp(join(tmpdir(), "portal-checker-identity-"));
  const child = spawn(process.execPath, [join(root, "src", "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      PORTAL_BIND_HOST: "127.0.0.1",
      PORTAL_EXPECTED_CHECKER_COMMIT: expectedCommit,
      PORTAL_ACCOUNT_DIR: join(dataRoot, "accounts"),
      PORTAL_SCAN_HISTORY_FILE: join(dataRoot, "scan-history.jsonl"),
      PORTAL_OBSERVATION_DIR: join(dataRoot, "observations"),
      PORTAL_WHITELIST_DIR: join(dataRoot, "whitelist"),
      PORTAL_REPORT_DIR: join(dataRoot, "reports"),
      PORTAL_DRAFT_REPORT_DIR: join(dataRoot, "draft-reports"),
      ADMIN_AUTH_FILE: join(dataRoot, "admin-auth.json")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    return await waitForHealth(port, child);
  } catch (error) {
    throw new Error(`${error.message}\n${stderr}`);
  } finally {
    child.kill();
    await Promise.race([once(child, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 2000))]);
    await rm(dataRoot, { recursive: true, force: true });
  }
}

const matching = await runCase(approvedCommit);
assert.equal(matching.status, 200);
assert.equal(matching.body.checker_identity.identity_state, "ok");
assert.equal(matching.body.checker_identity.identity_match, true);

const mismatching = await runCase("0000000");
assert.equal(mismatching.status, 503);
assert.equal(mismatching.body.checker_identity.identity_state, "configuration_error");
assert.equal(mismatching.body.checker_identity.identity_match, false);

console.log("checker identity integration test passed");
