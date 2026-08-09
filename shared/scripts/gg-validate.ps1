param(
  [string]$Root = ".",
  [string]$Workspace = "_workspace",
  [ValidateSet("L1","L2","L3")][string]$Level = "L1"
)

$ErrorActionPreference = "Stop"
$failures = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

function Fail($message) { $failures.Add($message) | Out-Null }
function Warn($message) { $warnings.Add($message) | Out-Null }
function Check-File($path, $label) {
  if (!(Test-Path -LiteralPath $path)) { Fail "MISSING ${label}: $path" } else { Write-Output "OK $label" }
}
function Check-TemplateCode($dir, $name) {
  if (!(Test-Path -LiteralPath $dir)) { Fail "MISSING golden template: $name"; return }
  $files = Get-ChildItem -LiteralPath $dir -Recurse -File | Where-Object { $_.Name -ne "README.md" }
  if ($files.Count -eq 0) { Fail "EMPTY golden template: $name has README only" } else { Write-Output "OK golden template $name ($($files.Count) files)" }
}

$rootPath = Resolve-Path -LiteralPath $Root
Check-File (Join-Path $rootPath "AGENTS.md") "Codex root AGENTS.md"
Check-File (Join-Path $rootPath "shared\harness.yaml") "harness declaration"
Check-File (Join-Path $rootPath "shared\institution-profile.yaml") "institution profile"
Check-File (Join-Path $rootPath "shared\templates\institution-profile.schema.json") "institution profile schema"
Check-File (Join-Path $rootPath "shared\templates\harness.schema.json") "harness schema"
Check-File (Join-Path $rootPath "shared\references\permission-model.yaml") "permission model"
Check-File (Join-Path $rootPath "shared\references\runtime-selection-policy.yaml") "runtime selection policy"
Check-File (Join-Path $rootPath "shared\references\lifecycle-quality-gates.yaml") "lifecycle quality gates"
Check-File (Join-Path $rootPath "shared\references\harness-enforcement-contract.yaml") "harness enforcement contract"
Check-File (Join-Path $rootPath "shared\references\package-governance.yaml") "package governance"
Check-File (Join-Path $rootPath "shared\references\package-alternatives.yaml") "package alternatives"
Check-File (Join-Path $rootPath "shared\references\trusted-registry-integration.yaml") "trusted registry integration"
Check-File (Join-Path $rootPath "shared\references\checker-bootstrap-policy.md") "checker bootstrap policy"
Check-File (Join-Path $rootPath "shared\scripts\checker-bootstrap.mjs") "checker bootstrap helper"
Check-File (Join-Path $rootPath "shared\scripts\package-catalog-export.mjs") "package catalog export helper"
Check-File (Join-Path $rootPath "shared\enforcement\gvskb_gate.py") "Python package install gate"
Check-File (Join-Path $rootPath "shared\enforcement\gvskb_gate.js") "npm package install gate"
Check-File (Join-Path $rootPath ".mcp.json") "common MCP config"
Check-File (Join-Path $rootPath ".codex\config.toml") "Codex project MCP config"
Check-File (Join-Path $rootPath "shared\scripts\harness-final-smoke.mjs") "final harness smoke test"
Check-File (Join-Path $rootPath "shared\references\network-profile.yaml") "canonical network profile"
Check-File (Join-Path $rootPath "shared\references\thin-l1-policy.md") "thin L1 policy"
Check-File (Join-Path $rootPath "shared\references\user-experience-policy.md") "user experience policy"
Check-File (Join-Path $rootPath "shared\assets\coaching-messages.md") "coaching messages"
Check-File (Join-Path $rootPath "shared\references\agent-handoff-contract.md") "handoff contract"
Check-File (Join-Path $rootPath "shared\templates\11_패키지검토요청서.template.md") "package review request template"

# Claude Code files are compatibility artifacts, not the Codex source of truth.
$claudeDir = Join-Path $rootPath ".claude"
if (Test-Path -LiteralPath $claudeDir) {
  Check-File (Join-Path $rootPath ".claude\README.md") "Claude compatibility README"
  Check-File (Join-Path $rootPath ".claude\CLAUDE.md") "Claude compatibility CLAUDE.md"
  Check-File (Join-Path $rootPath ".claude\skills\gg-vibecode\skill.md") "Claude compatibility gg-vibecode skill"
}

# Institution profile is the single agency-specific override file.
$institutionProfile = Join-Path $rootPath "shared\institution-profile.yaml"
if (Test-Path -LiteralPath $institutionProfile) {
  $profile = Get-Content -LiteralPath $institutionProfile -Encoding UTF8 -Raw
  $requiredProfileMarkers = @(
    "profile_version:",
    "institution:",
    "environment:",
    "server_profiles:",
    "development:",
    "production:",
    "allowed_languages:",
    "allowed_dbms:",
    "plugins:",
    "libraries:",
    "harness_enforcement:"
  )
  foreach ($marker in $requiredProfileMarkers) {
    if ($profile -notmatch [regex]::Escape($marker)) { Fail "institution-profile.yaml missing required marker: $marker" }
  }
  if ($profile -notmatch "vibecode-checker") { Warn "institution-profile.yaml should declare vibecode-checker MCP policy" }
  if ($profile -notmatch [regex]::Escape("https://github.com/Lex6won/vibe_harness_codex")) { Fail "institution-profile.yaml must declare canonical harness GitHub repository" }
  if ($profile -notmatch [regex]::Escape("https://github.com/Lex6won/vibecode-checker")) { Fail "institution-profile.yaml must declare canonical checker GitHub repository" }
  if ($profile -notmatch "production:\s*\r?\n\s+server:") { Fail "institution-profile.yaml must define production.server" }
  if ($profile -notmatch "development:\s*\r?\n\s+server:") { Fail "institution-profile.yaml must define development.server" }
  if ($profile -notmatch "allowed_function_implementation_languages:\s*\r?\n\s+- python\s*\r?\n\s+- javascript") { Fail "institution-profile.yaml must limit implementation languages to python and javascript" }
  if ($profile -notmatch "registry_access:\s*`"checker-mediated-only`"") { Fail "institution-profile.yaml must declare checker-mediated registry access" }
  if ($profile -notmatch "default_mode:\s*MONITOR") { Fail "institution-profile.yaml must default enforcement mode to MONITOR during registry rollout" }
  if ($profile -notmatch "checker_bootstrap:") { Fail "institution-profile.yaml must declare checker bootstrap policy" }
  if ($profile -match "supabase:\s*\r?\n\s+status:\s*allowed") { Fail "Supabase must not be allowed directly in institution profile" }
  if ($profile -match "firebase:\s*\r?\n\s+status:\s*allowed") { Fail "Firebase must not be allowed directly in institution profile" }
}

$enforcementContract = Join-Path $rootPath "shared\references\harness-enforcement-contract.yaml"
if (Test-Path -LiteralPath $enforcementContract) {
  $contractText = Get-Content -LiteralPath $enforcementContract -Encoding UTF8 -Raw
  foreach ($marker in @("harness_enforcement_contract_version:", "role_separation:", "implementation_language_policy:", "checker_call_contract:", "verdict_priority:", "absolute_block:", "enforcement_modes:", "environment_grades:", "local_catalog_and_registry_priority:", "block_response_contract:")) {
    if ($contractText -notmatch [regex]::Escape($marker)) { Fail "harness-enforcement-contract.yaml missing required marker: $marker" }
  }
  foreach ($marker in @("freshness_policy:", "typosquat_policy:", "bypass_policy:", "default_mode: MONITOR")) {
    if ($contractText -notmatch [regex]::Escape($marker)) { Fail "harness-enforcement-contract.yaml missing required enforcement update: $marker" }
  }
  foreach ($marker in @("kev_checked", "version_exact", "source_scope", "registry_stale", "ordinary_user_message", "structured_override_shape")) {
    if ($contractText -notmatch [regex]::Escape($marker)) { Fail "harness-enforcement-contract.yaml missing gvskb 2026-08-03 signal policy: $marker" }
  }
  foreach ($marker in @("malicious", "registry_rejected", "not_found", "checker-mediated", "python", "javascript")) {
    if ($contractText -notmatch [regex]::Escape($marker)) { Fail "harness-enforcement-contract.yaml missing required policy text: $marker" }
  }
  foreach ($marker in @("gvskb_gate.py", "gvskb_gate.js", "--ignore-scripts", "verify-manifest")) {
    if ($contractText -notmatch [regex]::Escape($marker)) { Fail "harness-enforcement-contract.yaml missing package gate marker: $marker" }
  }
}

$checkerBootstrap = Join-Path $rootPath "shared\references\checker-bootstrap-policy.md"
if (Test-Path -LiteralPath $checkerBootstrap) {
  $bootstrapText = Get-Content -LiteralPath $checkerBootstrap -Encoding UTF8 -Raw
  foreach ($marker in @("https://github.com/Lex6won/vibecode-checker", "사용자", "확인", "checker-bootstrap.mjs", "--yes", "--install-python", ".mcp.json", ".codex/config.toml", "망분리/offline")) {
    if ($bootstrapText -notmatch [regex]::Escape($marker)) { Fail "checker-bootstrap-policy.md missing required marker: $marker" }
  }
  if ($bootstrapText -notmatch [regex]::Escape("https://github.com/Lex6won/vibe_harness_codex")) { Fail "checker-bootstrap-policy.md must declare the canonical harness GitHub repository" }
  foreach ($marker in @("dev-quick", "GVSKB_POLICIES_DIR", "절대경로", "상대경로")) {
    if ($bootstrapText -notmatch [regex]::Escape($marker)) { Fail "checker-bootstrap-policy.md missing checker profile path marker: $marker" }
  }
}

$runtimePolicy = Join-Path $rootPath "shared\references\runtime-selection-policy.yaml"
if (Test-Path -LiteralPath $runtimePolicy) {
  $runtimeText = Get-Content -LiteralPath $runtimePolicy -Encoding UTF8 -Raw
  foreach ($marker in @("runtime_selection_version:", "server_profiles:", "recommendations:", "decision_rules:", "output_requirements:")) {
    if ($runtimeText -notmatch [regex]::Escape($marker)) { Fail "runtime-selection-policy.yaml missing required marker: $marker" }
  }
}

$packageGovernance = Join-Path $rootPath "shared\references\package-governance.yaml"
if (Test-Path -LiteralPath $packageGovernance) {
  $governanceText = Get-Content -LiteralPath $packageGovernance -Encoding UTF8 -Raw
  foreach ($marker in @("package_governance_version:", "source_of_truth:", "statuses:", "checker_verdict_mapping:", "absolute_block:", "promotion_rules:", "replacement_rules:", "future_platform_integration:", "checker_limitations:")) {
    if ($governanceText -notmatch [regex]::Escape($marker)) { Fail "package-governance.yaml missing required marker: $marker" }
  }
  foreach ($marker in @("checker_signal_handling:", "kev_checked", "version_exact", "source_scope", "structured_override:")) {
    if ($governanceText -notmatch [regex]::Escape($marker)) { Fail "package-governance.yaml missing checker signal marker: $marker" }
  }
  foreach ($marker in @("runtime_gate:", "gvskb_gate.py", "gvskb_gate.js", "final_submission_impact")) {
    if ($governanceText -notmatch [regex]::Escape($marker)) { Fail "package-governance.yaml missing package gate marker: $marker" }
  }
}

$lifecycleGates = Join-Path $rootPath "shared\references\lifecycle-quality-gates.yaml"
if (Test-Path -LiteralPath $lifecycleGates) {
  $lifecycleText = Get-Content -LiteralPath $lifecycleGates -Encoding UTF8 -Raw
  foreach ($marker in @("lifecycle_quality_gates_version:", "stages:", "idea:", "design:", "implementation:", "test:", "release:", "balance_checks:")) {
    if ($lifecycleText -notmatch [regex]::Escape($marker)) { Fail "lifecycle-quality-gates.yaml missing required marker: $marker" }
  }
  foreach ($marker in @("checker_profiles:", "quick:", "standard:", "full:", "two_report_release_default", "full_checker_html_and_json_saved", "user_notice.final_reports_must_be_submitted")) {
    if ($lifecycleText -notmatch [regex]::Escape($marker)) { Fail "lifecycle-quality-gates.yaml missing final harness marker: $marker" }
  }
}

$packageAlternatives = Join-Path $rootPath "shared\references\package-alternatives.yaml"
if (Test-Path -LiteralPath $packageAlternatives) {
  $altText = Get-Content -LiteralPath $packageAlternatives -Encoding UTF8 -Raw
  foreach ($marker in @("package_alternatives_version:", "selection_order:", "mandatory_rule:", "patterns:", "preferred_replacement:", "output_template:")) {
    if ($altText -notmatch [regex]::Escape($marker)) { Fail "package-alternatives.yaml missing required marker: $marker" }
  }
}

$trustedRegistry = Join-Path $rootPath "shared\references\trusted-registry-integration.yaml"
if (Test-Path -LiteralPath $trustedRegistry) {
  $registryText = Get-Content -LiteralPath $trustedRegistry -Encoding UTF8 -Raw
  foreach ($marker in @("trusted_registry_integration_version:", "integration_model:", "current_mode:", "future_mode:", "registry_status_mapping:", "checker_verdicts:", "harness_rules:", "audit_metadata:")) {
    if ($registryText -notmatch [regex]::Escape($marker)) { Fail "trusted-registry-integration.yaml missing required marker: $marker" }
  }
  if ($registryText -notmatch "direct_registry_calls_by_harness:\s*`"not allowed") { Fail "trusted-registry-integration.yaml must forbid direct registry calls by harness" }
}

# Harness declaration and permission model must point at the agency profile and safe outputs.
$harness = Join-Path $rootPath "shared\harness.yaml"
if (Test-Path -LiteralPath $harness) {
  $harnessText = Get-Content -LiteralPath $harness -Encoding UTF8 -Raw
  if ($harnessText -notmatch "canonical_repositories:") { Fail "harness.yaml must declare canonical_repositories" }
  if ($harnessText -notmatch [regex]::Escape("https://github.com/Lex6won/vibe_harness_codex")) { Fail "harness.yaml must declare canonical harness GitHub repository" }
  if ($harnessText -notmatch [regex]::Escape("https://github.com/Lex6won/vibecode-checker")) { Fail "harness.yaml must declare canonical checker GitHub repository" }
  if ($harnessText -notmatch "institution-profile.yaml") { Fail "harness.yaml must point to shared/institution-profile.yaml" }
  if ($harnessText -notmatch "permission-model.yaml") { Fail "harness.yaml must point to permission-model.yaml" }
  if ($harnessText -notmatch "runtime-selection-policy.yaml") { Fail "harness.yaml must point to runtime-selection-policy.yaml" }
  if ($harnessText -notmatch "package-governance.yaml") { Fail "harness.yaml must point to package-governance.yaml" }
  if ($harnessText -notmatch "harness-enforcement-contract.yaml") { Fail "harness.yaml must point to harness-enforcement-contract.yaml" }
  if ($harnessText -notmatch "checker-bootstrap-policy.md") { Fail "harness.yaml must point to checker-bootstrap-policy.md" }
  if ($harnessText -notmatch "lifecycle-quality-gates.yaml") { Fail "harness.yaml must point to lifecycle-quality-gates.yaml" }
  if ($harnessText -notmatch "package-alternatives.yaml") { Fail "harness.yaml must point to package-alternatives.yaml" }
  if ($harnessText -notmatch "trusted-registry-integration.yaml") { Fail "harness.yaml must point to trusted-registry-integration.yaml" }
  if ($harnessText -notmatch "standard operating harness") { Fail "harness.yaml must declare standard operating harness identity" }
  if ($harnessText -notmatch "coaching-messages.md") { Fail "harness.yaml must point to coaching messages" }
  if ($harnessText -notmatch "common_mcp_config") { Fail "harness.yaml must point to root .mcp.json" }
  if ($harnessText -notmatch "codex_project_config") { Fail "harness.yaml must point to .codex/config.toml" }
  if ($harnessText -notmatch "gvskb_gate.py") { Fail "harness.yaml must point to Python package gate" }
  if ($harnessText -notmatch "gvskb_gate.js") { Fail "harness.yaml must point to npm package gate" }
  if ($harnessText -notmatch "final_submission_impact") { Fail "harness.yaml must state package gate does not add final submission artifacts" }
  if ($harnessText -notmatch "agency_onboarding:") { Fail "harness.yaml must declare agency onboarding guidance" }
  if ($harnessText -notmatch "codex:\s*`"AGENTS.md`"") { Fail "harness.yaml must point Codex at root AGENTS.md" }
  if ($harnessText -notmatch "registry_access:\s*`"checker-mediated-only`"") { Fail "harness.yaml must declare checker-mediated-only registry access" }
  foreach ($marker in @("checker_profile_policy:", "quick_profile: `"dev-quick`"", "custom_policies_dir: `"absolute-path-only`"", "network_profile_is_not_checker_profile: true", "verify_applied_profile: true")) {
    if ($harnessText -notmatch [regex]::Escape($marker)) { Fail "harness.yaml missing checker profile policy marker: $marker" }
  }
  if ($harnessText -notmatch "default_mode:\s*`"MONITOR`"") { Fail "harness.yaml must default enforcement mode to MONITOR for rollout" }
  if ($harnessText -notmatch "checker-bootstrap.mjs") { Fail "harness.yaml must point to checker-bootstrap.mjs" }
  if ($harnessText -notmatch "package-catalog-export.mjs") { Fail "harness.yaml must point to package-catalog-export.mjs" }
  if ($harnessText -notmatch "harness-final-smoke.mjs") { Fail "harness.yaml must point to harness-final-smoke.mjs" }
  if ($harnessText -notmatch "implementation_languages:\s*\r?\n\s+- `"python`"\s*\r?\n\s+- `"javascript`"") { Fail "harness.yaml must declare python/javascript implementation languages" }
  if ($harnessText -notmatch "safe_outputs:") { Fail "harness.yaml must declare safe_outputs" }
}

$pythonGate = Join-Path $rootPath "shared\enforcement\gvskb_gate.py"
if (Test-Path -LiteralPath $pythonGate) {
  $gateText = Get-Content -LiteralPath $pythonGate -Encoding UTF8 -Raw
  foreach ($marker in @("audit_manifest", "verify-manifest", "GVSKB_GATE_MODE", "GVSKB_GATE_ENV_GRADE", "package_manifest_text", "max_cve", "heuristics", "typosquat_warning", "local_denied", "registry_rejected", "not_found", "in_kev")) {
    if ($gateText -notmatch [regex]::Escape($marker)) { Fail "gvskb_gate.py missing required marker: $marker" }
  }
  if ($gateText -match "check_package_impl") { Fail "gvskb_gate.py must use audit_manifest instead of check_package_impl" }
}

$npmGate = Join-Path $rootPath "shared\enforcement\gvskb_gate.js"
if (Test-Path -LiteralPath $npmGate) {
  $gateText = Get-Content -LiteralPath $npmGate -Encoding UTF8 -Raw
  foreach ($marker in @("GVSKB_GATE_PYTHON", "gvskb_gate.py", "--ignore-scripts", "verify-manifest", "npm", "install")) {
    if ($gateText -notmatch [regex]::Escape($marker)) { Fail "gvskb_gate.js missing required marker: $marker" }
  }
}

$mcpConfig = Join-Path $rootPath ".mcp.json"
if (Test-Path -LiteralPath $mcpConfig) {
  try {
    $mcpBytes = [System.IO.File]::ReadAllBytes($mcpConfig)
    if ($mcpBytes.Length -ge 3 -and $mcpBytes[0] -eq 0xEF -and $mcpBytes[1] -eq 0xBB -and $mcpBytes[2] -eq 0xBF) {
      Fail ".mcp.json must be UTF-8 without BOM"
    }
    $mcpJson = Get-Content -LiteralPath $mcpConfig -Encoding UTF8 -Raw | ConvertFrom-Json
    $checkerServer = $mcpJson.mcpServers.'vibecode-checker'
    if (-not $checkerServer) { Fail ".mcp.json must define mcpServers.vibecode-checker" }
    $checkerCommand = [string]$checkerServer.command
    $checkerArgs = @($checkerServer.args)
    $usesGvskbServer = $checkerCommand -eq "gvskb-server" -and $checkerArgs.Count -eq 0
    $usesPythonModule = $checkerCommand -eq "python" -and $checkerArgs.Count -eq 2 -and $checkerArgs[0] -eq "-m" -and $checkerArgs[1] -eq "gvskb.server"
    if (-not ($usesGvskbServer -or $usesPythonModule)) {
      Fail ".mcp.json checker command must be gvskb-server or python -m gvskb.server"
    }
    if ($checkerCommand -eq "gvskb" -and $checkerArgs -contains "mcp") {
      Fail ".mcp.json must not use invalid command gvskb mcp"
    }
    foreach ($envMarker in @("PYTHONUTF8", "PYTHONIOENCODING")) {
      if (-not ($checkerServer.env -and ($checkerServer.env.PSObject.Properties.Name -contains $envMarker))) {
        Fail ".mcp.json missing required checker env: $envMarker"
      }
    }
    if ($checkerServer.env -and ($checkerServer.env.PSObject.Properties.Name -contains "GVSKB_MODE")) {
      Fail ".mcp.json must not hard-code GVSKB_MODE"
    }
    if ($checkerServer -and $checkerServer.env -and ($checkerServer.env.PSObject.Properties.Name -contains "GVSKB_POLICIES_DIR")) {
      $policyDir = [string]$checkerServer.env.GVSKB_POLICIES_DIR
      if (-not [System.IO.Path]::IsPathRooted($policyDir)) {
        Fail ".mcp.json GVSKB_POLICIES_DIR must be an absolute path or omitted"
      }
    }
  } catch {
    Fail "INVALID .mcp.json: $($_.Exception.Message)"
  }
}

$codexConfig = Join-Path $rootPath ".codex\config.toml"
if (Test-Path -LiteralPath $codexConfig) {
  $codexConfigText = Get-Content -LiteralPath $codexConfig -Encoding UTF8 -Raw
  foreach ($marker in @("[mcp_servers.vibecode-checker]", "command = `"gvskb-server`"", "PYTHONUTF8", "PYTHONIOENCODING")) {
    if ($codexConfigText -notmatch [regex]::Escape($marker)) { Fail ".codex/config.toml missing marker: $marker" }
  }
  if ($codexConfigText -match "GVSKB_MODE") { Fail ".codex/config.toml must not hard-code GVSKB_MODE" }
}

$claudeMcpConfig = Join-Path $rootPath ".claude\.mcp.json"
if (Test-Path -LiteralPath $claudeMcpConfig) {
  $claudeMcpText = Get-Content -LiteralPath $claudeMcpConfig -Encoding UTF8 -Raw
  if ($claudeMcpText -match "GVSKB_MODE") { Fail ".claude/.mcp.json must not hard-code GVSKB_MODE" }
}

$readme = Join-Path $rootPath "README.md"
if (Test-Path -LiteralPath $readme) {
  $readmeText = Get-Content -LiteralPath $readme -Encoding UTF8 -Raw
  foreach ($marker in @("https://github.com/Lex6won/vibe_harness_codex", "https://github.com/Lex6won/vibecode-checker", "git clone https://github.com/Lex6won/vibe_harness_codex.git", "git clone https://github.com/Lex6won/vibecode-checker.git")) {
    if ($readmeText -notmatch [regex]::Escape($marker)) { Fail "README.md missing GitHub distribution marker: $marker" }
  }
  if ($readmeText -notmatch "harness-final-smoke.mjs") { Fail "README.md must document final harness smoke test" }
  foreach ($marker in @("표준 운영 하네스", "초보 공무원", "구상 → 표준 템플릿 구현", "처음에는 아래 파일을 수정 대상으로 보지 않는 것이 좋습니다", "shared/assets/coaching-messages.md")) {
    if ($readmeText -notmatch [regex]::Escape($marker)) { Fail "README.md missing operating-harness UX marker: $marker" }
  }
  foreach ($marker in @("dev-quick", "GVSKB_POLICIES_DIR", "network_profile", "검증 미완료", "profile_fallback", "gvskb-server")) {
    if ($readmeText -notmatch [regex]::Escape($marker)) { Fail "README.md missing checker profile integration marker: $marker" }
  }
}

$coachingMessages = Join-Path $rootPath "shared\assets\coaching-messages.md"
if (Test-Path -LiteralPath $coachingMessages) {
  $coachingText = Get-Content -LiteralPath $coachingMessages -Encoding UTF8 -Raw
  foreach ($marker in @("패키지 차단", "보안 점검", "체커 미설치", "배포 전 제출", "안 됩니다")) {
    if ($coachingText -notmatch [regex]::Escape($marker)) { Fail "coaching-messages.md missing marker: $marker" }
  }
}

$finalSmoke = Join-Path $rootPath "shared\scripts\harness-final-smoke.mjs"
if (Test-Path -LiteralPath $finalSmoke) {
  $finalSmokeText = Get-Content -LiteralPath $finalSmoke -Encoding UTF8 -Raw
  foreach ($marker in @("HARNESS FINAL SMOKE PASSED", "canonical_repositories", "quick during coding", "release full checker reports", "submit two final reports")) {
    if ($finalSmokeText -notmatch [regex]::Escape($marker)) { Fail "harness-final-smoke.mjs missing final test marker: $marker" }
  }
}

$catalogExportScript = Join-Path $rootPath "shared\scripts\package-catalog-export.mjs"
if (Test-Path -LiteralPath $catalogExportScript) {
  $catalogScriptText = Get-Content -LiteralPath $catalogExportScript -Encoding UTF8 -Raw
  foreach ($marker in @("scope_catalog", "DO_NOT_IMPORT_AS_APPROVED_WITHOUT_VERSION", "registry_import_entries", "Name-only approved/restricted entries")) {
    if ($catalogScriptText -notmatch [regex]::Escape($marker)) { Fail "package-catalog-export.mjs missing registry response marker: $marker" }
  }
}

$permissionModel = Join-Path $rootPath "shared\references\permission-model.yaml"
if (Test-Path -LiteralPath $permissionModel) {
  $permissionText = Get-Content -LiteralPath $permissionModel -Encoding UTF8 -Raw
  foreach ($marker in @("planning:", "development:", "security_check:", "release:", "safe_output_policy:")) {
    if ($permissionText -notmatch [regex]::Escape($marker)) { Fail "permission-model.yaml missing required marker: $marker" }
  }
  if ($permissionText -notmatch "repository_push") { Fail "permission-model.yaml must address repository push restrictions" }
}

# deploy-context must be compatibility pointer, not second source of truth.
$deployContext = Join-Path $rootPath ".claude\references\deploy-context.yaml"
if (Test-Path -LiteralPath $deployContext) {
  $dc = Get-Content -LiteralPath $deployContext -Encoding UTF8 -Raw
  if ($dc -notmatch "deprecated_alias" -or $dc -notmatch "network-profile.yaml") { Fail "deploy-context.yaml must be deprecated alias to network-profile.yaml" } else { Write-Output "OK deploy-context alias" }
}

# Manifest schema must parse.
$schema = Join-Path $rootPath "shared\templates\vibecode-manifest.schema.json"
try { Get-Content -LiteralPath $schema -Encoding UTF8 -Raw | ConvertFrom-Json | Out-Null; Write-Output "OK manifest schema" } catch { Fail "INVALID manifest schema: $($_.Exception.Message)" }
try {
  $schemaText = Get-Content -LiteralPath $schema -Encoding UTF8 -Raw
  foreach ($marker in @("final_submission_reports", "html_report", "json_evidence", "submission_required", "notice_given", "scan_installed_packages", "scan_vendor_bundles")) {
    if ($schemaText -notmatch [regex]::Escape($marker)) { Fail "vibecode-manifest.schema.json missing final report marker: $marker" }
  }
} catch {
  Fail "Unable to inspect manifest schema markers: $($_.Exception.Message)"
}
foreach ($schemaPath in @("shared\templates\institution-profile.schema.json", "shared\templates\harness.schema.json")) {
  $fullSchemaPath = Join-Path $rootPath $schemaPath
  try { Get-Content -LiteralPath $fullSchemaPath -Encoding UTF8 -Raw | ConvertFrom-Json | Out-Null; Write-Output "OK $schemaPath" } catch { Fail "INVALID ${schemaPath}: $($_.Exception.Message)" }
}

# Eval cases must parse.
$evalDir = Join-Path $rootPath "evals"
if (Test-Path -LiteralPath $evalDir) {
  foreach ($case in Get-ChildItem -LiteralPath $evalDir -Filter "*.json" -File) {
    try {
      $eval = Get-Content -LiteralPath $case.FullName -Encoding UTF8 -Raw | ConvertFrom-Json
      if (-not $eval.name) { Fail "eval case missing name: $($case.Name)" }
      if (-not $eval.expect -or $eval.expect.Count -eq 0) { Fail "eval case missing expect[]: $($case.Name)" }
    } catch {
      Fail "INVALID eval case $($case.Name): $($_.Exception.Message)"
    }
  }
  Write-Output "OK eval cases"
}

# Golden templates must have real files.
$gold = Join-Path $rootPath "shared\golden-templates"
@("gg-webapp","gg-dashboard","gg-upload","gg-node-api","gg-spa","gg-rag") | ForEach-Object { Check-TemplateCode (Join-Path $gold $_) $_ }

# Workspace artifact checks by maturity level.
$workspacePath = Join-Path $rootPath $Workspace
if (Test-Path -LiteralPath $workspacePath) {
  $required = @("00_feature_brief.md", "00_작업현황.md", "vibecode-manifest.json")
  if ($Level -in @("L2","L3")) { $required += @("01_PRD_서비스기획서.md", "04_개발스택_운영환경.md", "05_보안점검보고서.md") }
  if ($Level -eq "L3") { $required += @("source\.check-reports") }
  foreach ($f in $required) { if (!(Test-Path -LiteralPath (Join-Path $workspacePath $f))) { Warn "workspace artifact not found for ${Level}: $f" } }
}

if ($warnings.Count -gt 0) {
  Write-Output "WARNINGS:"
  $warnings | ForEach-Object { Write-Output "- $_" }
}
if ($failures.Count -gt 0) {
  Write-Output "FAILURES:"
  $failures | ForEach-Object { Write-Output "- $_" }
  exit 1
}
Write-Output "VALIDATION PASSED"
exit 0

