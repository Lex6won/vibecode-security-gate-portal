import assert from "node:assert/strict";
import { resolvePortalAuthConfig } from "../src/auth-config.mjs";

function resolves(env, bindHost = "127.0.0.1") {
  return resolvePortalAuthConfig(env, bindHost);
}

function rejects(env, bindHost, pattern) {
  assert.throws(() => resolves(env, bindHost), pattern);
}

const secureDeployment = {
  PORTAL_ALLOWED_HOSTS: "portal.example.go.kr",
  PORTAL_EXPECTED_CHECKER_COMMIT: "a".repeat(40)
};

const inferred = resolves({});
assert.equal(inferred.deploymentMode, "local");
assert.equal(inferred.authProvider, "local-dev");
assert.equal(inferred.localDevelopmentAuth, true);
assert.equal(inferred.inferredLocalDefaults, true);

for (const host of ["127.0.0.1", "localhost", "::1"]) {
  const config = resolves({ PORTAL_DEPLOYMENT_MODE: "local", PORTAL_AUTH_PROVIDER: "local-dev" }, host);
  assert.equal(config.localDevelopmentAuth, true);
}

rejects({}, "0.0.0.0", /PORTAL_DEPLOYMENT_MODE is required/);
rejects({ PORTAL_DEPLOYMENT_MODE: "local", PORTAL_AUTH_PROVIDER: "local-dev" }, "0.0.0.0", /loopback/);
rejects({ ...secureDeployment, PORTAL_DEPLOYMENT_MODE: "pilot", PORTAL_AUTH_PROVIDER: "local-dev" }, "127.0.0.1", /cannot use local-dev/);
rejects({ PORTAL_DEPLOYMENT_MODE: "production" }, "127.0.0.1", /PORTAL_AUTH_PROVIDER is required/);
rejects({ PORTAL_DEPLOYMENT_MODE: "preview", PORTAL_AUTH_PROVIDER: "local-dev" }, "127.0.0.1", /Unsupported PORTAL_DEPLOYMENT_MODE/);
rejects({ PORTAL_DEPLOYMENT_MODE: "pilot", PORTAL_AUTH_PROVIDER: "password" }, "127.0.0.1", /Unsupported PORTAL_AUTH_PROVIDER/);
rejects({ ...secureDeployment, PORTAL_DEPLOYMENT_MODE: "pilot", PORTAL_AUTH_PROVIDER: "cloudflare-access" }, "127.0.0.1", /requires PORTAL_ACCESS_TEAM_DOMAIN/);
rejects({
  ...secureDeployment,
  PORTAL_DEPLOYMENT_MODE: "pilot",
  PORTAL_AUTH_PROVIDER: "cloudflare-access",
  PORTAL_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com"
}, "127.0.0.1", /requires PORTAL_ACCESS_TEAM_DOMAIN/);
rejects({
  ...secureDeployment,
  PORTAL_DEPLOYMENT_MODE: "production",
  PORTAL_AUTH_PROVIDER: "smtp"
}, "127.0.0.1", /mail delivery adapter/);
rejects({
  ...secureDeployment,
  PORTAL_DEPLOYMENT_MODE: "production",
  PORTAL_AUTH_PROVIDER: "cloudflare-access",
  PORTAL_AUTH_MODE: "smtp",
  PORTAL_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  PORTAL_ACCESS_AUD: "audience"
}, "127.0.0.1", /conflicts/);
rejects({
  PORTAL_DEPLOYMENT_MODE: "pilot",
  PORTAL_AUTH_PROVIDER: "cloudflare-access",
  PORTAL_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  PORTAL_ACCESS_AUD: "audience"
}, "127.0.0.1", /requires PORTAL_ALLOWED_HOSTS/);
rejects({
  PORTAL_ALLOWED_HOSTS: "portal.example.go.kr",
  PORTAL_DEPLOYMENT_MODE: "pilot",
  PORTAL_AUTH_PROVIDER: "cloudflare-access",
  PORTAL_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  PORTAL_ACCESS_AUD: "audience"
}, "127.0.0.1", /requires a full PORTAL_EXPECTED_CHECKER_COMMIT/);
rejects({
  ...secureDeployment,
  PORTAL_DEPLOYMENT_MODE: "pilot",
  PORTAL_AUTH_PROVIDER: "cloudflare-access",
  PORTAL_ACCESS_TEAM_DOMAIN: "http://access.example.com",
  PORTAL_ACCESS_AUD: "audience"
}, "127.0.0.1", /must use HTTPS/);

for (const deploymentMode of ["pilot", "production"]) {
  const config = resolves({
    ...secureDeployment,
    PORTAL_DEPLOYMENT_MODE: deploymentMode,
    PORTAL_AUTH_PROVIDER: "cloudflare-access",
    PORTAL_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    PORTAL_ACCESS_AUD: "audience"
  });
  assert.equal(config.deploymentMode, deploymentMode);
  assert.equal(config.authProvider, "cloudflare-access");
  assert.equal(config.accessEnabled, true);
  assert.equal(config.localDevelopmentAuth, false);
}

console.log("auth_config_test: ok");
