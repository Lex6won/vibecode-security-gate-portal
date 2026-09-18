const DEPLOYMENT_MODES = new Set(["local", "pilot", "production"]);
const AUTH_PROVIDERS = new Set(["local-dev", "cloudflare-access", "smtp"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function setting(value) {
  return String(value || "").trim().toLowerCase();
}

function validateAccessTeamDomain(value) {
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("PORTAL_ACCESS_TEAM_DOMAIN must be a valid origin");
  }
  const localHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("PORTAL_ACCESS_TEAM_DOMAIN must use HTTPS outside loopback tests");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new Error("PORTAL_ACCESS_TEAM_DOMAIN must contain only the Access origin");
  }
}

export function resolvePortalAuthConfig(env, bindHost) {
  const loopback = LOOPBACK_HOSTS.has(String(bindHost || "").trim().toLowerCase());
  const explicitDeploymentMode = setting(env.PORTAL_DEPLOYMENT_MODE);
  const explicitAuthProvider = setting(env.PORTAL_AUTH_PROVIDER);
  const legacyAuthMode = setting(env.PORTAL_AUTH_MODE);

  const deploymentMode = explicitDeploymentMode || (loopback ? "local" : "");
  if (!deploymentMode) {
    throw new Error("PORTAL_DEPLOYMENT_MODE is required when PORTAL_BIND_HOST is not loopback");
  }
  if (!DEPLOYMENT_MODES.has(deploymentMode)) {
    throw new Error(`Unsupported PORTAL_DEPLOYMENT_MODE: ${deploymentMode}`);
  }

  let authProvider = explicitAuthProvider;
  if (!authProvider && legacyAuthMode) {
    authProvider = legacyAuthMode === "smtp" ? "smtp" : "local-dev";
  }
  if (!authProvider && deploymentMode === "local") authProvider = "local-dev";
  if (!authProvider) {
    throw new Error(`PORTAL_AUTH_PROVIDER is required for ${deploymentMode} deployment`);
  }
  if (!AUTH_PROVIDERS.has(authProvider)) {
    throw new Error(`Unsupported PORTAL_AUTH_PROVIDER: ${authProvider}`);
  }
  if (legacyAuthMode && explicitAuthProvider) {
    const legacyProvider = legacyAuthMode === "smtp" ? "smtp" : "local-dev";
    if (legacyProvider !== authProvider) {
      throw new Error("PORTAL_AUTH_MODE conflicts with PORTAL_AUTH_PROVIDER");
    }
  }

  if (deploymentMode === "local") {
    if (!loopback) throw new Error("local deployment must bind to a loopback address");
    if (authProvider !== "local-dev") throw new Error("local deployment requires local-dev authentication");
  } else if (authProvider === "local-dev") {
    throw new Error(`${deploymentMode} deployment cannot use local-dev authentication`);
  }

  if (deploymentMode !== "local") {
    const allowedHosts = String(env.PORTAL_ALLOWED_HOSTS || "").split(",").map((value) => value.trim()).filter(Boolean);
    if (!allowedHosts.length) {
      throw new Error(`${deploymentMode} deployment requires PORTAL_ALLOWED_HOSTS`);
    }
    if (!/^[0-9a-f]{40}$/i.test(String(env.PORTAL_EXPECTED_CHECKER_COMMIT || "").trim())) {
      throw new Error(`${deploymentMode} deployment requires a full PORTAL_EXPECTED_CHECKER_COMMIT`);
    }
  }

  const accessTeamDomain = String(env.PORTAL_ACCESS_TEAM_DOMAIN || "").trim();
  const accessAudience = String(env.PORTAL_ACCESS_AUD || "").trim();
  if (authProvider === "cloudflare-access" && (!accessTeamDomain || !accessAudience)) {
    throw new Error("cloudflare-access requires PORTAL_ACCESS_TEAM_DOMAIN and PORTAL_ACCESS_AUD");
  }
  if (authProvider === "cloudflare-access") validateAccessTeamDomain(accessTeamDomain);
  if (authProvider === "smtp") {
    throw new Error("smtp authentication is not available until a mail delivery adapter is implemented");
  }

  return Object.freeze({
    deploymentMode,
    authProvider,
    localDevelopmentAuth: deploymentMode === "local" && authProvider === "local-dev" && loopback,
    accessEnabled: authProvider === "cloudflare-access",
    inferredLocalDefaults: !explicitDeploymentMode && !explicitAuthProvider && !legacyAuthMode
  });
}
