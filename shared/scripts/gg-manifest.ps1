param(
  [string]$Workspace = "_workspace",
  [string]$ProjectId = "demo-project",
  [string]$MaturityLevel = "L1",
  [string]$WorkMode = "new-build"
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
$manifest = [ordered]@{
  project_id = $ProjectId
  service_name = $ProjectId
  work_mode = $WorkMode
  maturity_level = $MaturityLevel
  maturity_reason = "initial manifest"
  next_gate = "feature-discovery"
  service_exposure = "unknown"
  network_profile = "unknown"
  institution_profile = @{
    path = "shared/institution-profile.yaml"
    institution_code = "unknown"
    environment = "unknown"
  }
  runtime_external_access = "unknown"
  data_level = "unknown"
  track = "unknown"
  runtime = @{}
  enforcement = @{
    mode = "MONITOR"
    env_grade = "unknown"
    verdict_source = "vibecode-checker/gvskb"
    registry_access = "checker-mediated-only"
    implementation_languages = @("python", "javascript")
    pass_freshness_target = "1 hour"
    ordinary_user_message_policy = "silent-pass-one-line-block"
  }
  plugins = @{}
  dependencies = @{}
  feature_discovery = @{}
  artifacts = @{}
  security_check = @{
    profile = "unknown"
    full_scan_required = $false
    full_scan_completed = $false
    tools_used = @()
    dependency_audit_merged = $false
    checker_saved_reports = @{}
    final_submission_reports = @{
      submission_required = $false
      submission_target = "unknown"
      notice_given = $false
      official_approval_claimed = $false
    }
    conditional_documents = @()
    missing_evidence = @()
  }
  checker_bootstrap = @{
    checker_status = "unknown"
    checker_source = "unknown"
    checker_repository = "https://github.com/Lex6won/vibecode-checker"
    install_user_confirmed = $false
  }
  pilot_metrics = @{}
  exceptions = @()
  overrides = @()
  gates = @{}
}
$path = Join-Path $Workspace "vibecode-manifest.json"
$manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path -Encoding UTF8
Write-Output "MANIFEST=$path"
