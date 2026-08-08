param(
  [string]$Root = ".",
  [string]$CheckerPath = "",
  [switch]$Json
)

$ErrorActionPreference = "SilentlyContinue"

function Resolve-OptionalPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  $resolved = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
  if ($resolved) { return $resolved.Path }
  return $Path
}

function Get-GitRepoStatus([string]$Path, [string]$ExpectedRemote) {
  $result = [ordered]@{
    path = $Path
    exists = $false
    is_git_repo = $false
    remote = $null
    branch = $null
    local_commit = $null
    remote_commit = $null
    dirty = $false
    latest = $null
    status = "missing"
    note = ""
  }

  if (-not (Test-Path -LiteralPath $Path)) {
    $result.note = "경로가 없습니다."
    return $result
  }

  $result.exists = $true
  git -C $Path rev-parse --is-inside-work-tree *> $null
  if ($LASTEXITCODE -ne 0) {
    $result.status = "not-git"
    $result.note = "Git 저장소가 아닙니다."
    return $result
  }

  $result.is_git_repo = $true
  $result.remote = (git -C $Path remote get-url origin 2>$null)
  $result.branch = (git -C $Path branch --show-current 2>$null)
  $result.local_commit = (git -C $Path rev-parse HEAD 2>$null)
  $dirtyText = (git -C $Path status --short 2>$null)
  $result.dirty = -not [string]::IsNullOrWhiteSpace(($dirtyText -join ""))

  $remoteCommit = (git -C $Path ls-remote origin refs/heads/main 2>$null)
  if (-not [string]::IsNullOrWhiteSpace($remoteCommit)) {
    $result.remote_commit = ($remoteCommit -split "\s+")[0]
    $result.latest = ($result.local_commit -eq $result.remote_commit)
    $result.status = if ($result.latest) { "current" } else { "update-available" }
  } else {
    $result.status = "unknown"
    $result.note = "GitHub 원격 확인에 실패했습니다."
  }

  if ($ExpectedRemote -and $result.remote -and ($result.remote -ne $ExpectedRemote)) {
    $result.note = "공식 저장소 URL과 다릅니다."
  }

  return $result
}

function Get-CheckerStatus([string]$CheckerPath) {
  $command = Get-Command gvskb -ErrorAction SilentlyContinue
  $server = Get-Command gvskb-server -ErrorAction SilentlyContinue
  $version = $null
  if ($command) {
    $version = (gvskb version 2>$null)
  }

  $repoPath = Resolve-OptionalPath $CheckerPath
  if (-not $repoPath -and (Test-Path -LiteralPath "$HOME\vibecode-checker")) {
    $repoPath = "$HOME\vibecode-checker"
  }

  [ordered]@{
    cli_found = [bool]$command
    cli_path = if ($command) { $command.Source } else { $null }
    server_found = [bool]$server
    server_path = if ($server) { $server.Source } else { $null }
    version = $version
    repository = if ($repoPath) { Get-GitRepoStatus $repoPath "https://github.com/Lex6won/vibecode-checker.git" } else { $null }
  }
}

function Get-McpStatus([string]$RootPath) {
  $codexConfig = "$HOME\.codex\config.toml"
  $projectCodexConfig = Join-Path $RootPath ".codex\config.toml"
  $commonMcp = Join-Path $RootPath ".mcp.json"

  [ordered]@{
    codex_user_config = [ordered]@{
      path = $codexConfig
      exists = Test-Path -LiteralPath $codexConfig
      has_checker = if (Test-Path -LiteralPath $codexConfig) { (Get-Content -LiteralPath $codexConfig -Raw) -match "\[mcp_servers\.vibecode-checker\]" } else { $false }
    }
    codex_project_config = [ordered]@{
      path = $projectCodexConfig
      exists = Test-Path -LiteralPath $projectCodexConfig
      has_checker = if (Test-Path -LiteralPath $projectCodexConfig) { (Get-Content -LiteralPath $projectCodexConfig -Raw) -match "\[mcp_servers\.vibecode-checker\]" } else { $false }
    }
    common_mcp_json = [ordered]@{
      path = $commonMcp
      exists = Test-Path -LiteralPath $commonMcp
      has_checker = if (Test-Path -LiteralPath $commonMcp) { (Get-Content -LiteralPath $commonMcp -Raw) -match '"vibecode-checker"' } else { $false }
    }
  }
}

$rootPath = Resolve-OptionalPath $Root
$checkerStatus = Get-CheckerStatus $CheckerPath
$checkerUpdatePath = "<vibecode-checker path>"
if ($checkerStatus.repository -and $checkerStatus.repository.path) {
  $checkerUpdatePath = $checkerStatus.repository.path
}

$status = [ordered]@{
  checked_at = (Get-Date).ToString("s")
  harness = Get-GitRepoStatus $rootPath "https://github.com/Lex6won/vibe_harness_codex.git"
  checker = $checkerStatus
  mcp = Get-McpStatus $rootPath
  update_commands = [ordered]@{
    harness = "git -C `"$rootPath`" pull origin main"
    checker = "git -C `"$checkerUpdatePath`" pull origin main"
    validate = "powershell -ExecutionPolicy Bypass -File `"$rootPath\shared\scripts\gg-validate.ps1`""
  }
}

if ($Json) {
  $status | ConvertTo-Json -Depth 8
  exit 0
}

Write-Output "harness_status: $($status.harness.status)"
Write-Output "harness_path: $($status.harness.path)"
Write-Output "harness_dirty: $($status.harness.dirty)"
Write-Output "checker_cli: $(if ($status.checker.cli_found) { $status.checker.version } else { 'missing' })"
Write-Output "checker_server: $(if ($status.checker.server_found) { $status.checker.server_path } else { 'missing' })"
Write-Output "checker_repo_status: $(if ($status.checker.repository) { $status.checker.repository.status } else { 'unknown' })"
Write-Output "codex_user_mcp: $(if ($status.mcp.codex_user_config.has_checker) { 'registered' } else { 'missing' })"
Write-Output "project_mcp: $(if ($status.mcp.common_mcp_json.has_checker) { 'registered' } else { 'missing' })"
Write-Output "validate_command: $($status.update_commands.validate)"
