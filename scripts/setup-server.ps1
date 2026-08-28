# 포털 서버 최초 세팅 (Windows) — docs/29 절차서와 함께 사용
# 하는 일: 사전 점검 → 방화벽 규칙 → NSSM 서비스 등록 → 전원 설정 안내
# PowerShell 5.1 호환. 관리자 권한 PowerShell에서 실행할 것.
param(
  [int]$Port = 8787,
  [string]$ServiceName = "VibeCodePortal",
  [string]$NssmPath = "C:\servers\tools\nssm.exe"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

Write-Host "== 1/4 사전 점검 =="
$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) { throw "Node.js 가 없습니다. LTS 버전을 먼저 설치하세요." }
Write-Host ("node: " + $node.Source)

$gvskb = Get-Command gvskb -ErrorAction SilentlyContinue
if ($null -eq $gvskb) {
  Write-Warning "gvskb(체커)가 PATH에 없습니다. 체커 설치 후 다시 확인하세요 (docs/29 §2)."
} else {
  Write-Host ("gvskb: " + $gvskb.Source)
}

if (-not (Test-Path (Join-Path $repo ".env"))) {
  Write-Warning ".env 가 없습니다. config\server.env.example 을 .env 로 복사해 값을 채우세요."
  Write-Warning "  copy config\server.env.example .env"
  Write-Warning ".env 없이 서비스는 로컬 전용(127.0.0.1)으로 뜹니다."
}

Write-Host "== 2/4 방화벽 인바운드 규칙 =="
$ruleName = "VibeCode Portal $Port"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($null -eq $existing) {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
  Write-Host "생성함: $ruleName (Private 프로파일 한정)"
} else {
  Write-Host "이미 있음: $ruleName"
}

Write-Host "== 3/4 NSSM 서비스 등록 =="
if (-not (Test-Path $NssmPath)) {
  Write-Warning "nssm.exe 가 $NssmPath 에 없습니다. https://nssm.cc 에서 받아 두고 -NssmPath 로 지정하세요."
  Write-Warning "서비스 등록은 건너뜁니다. (수동 실행: node src\server.js)"
} else {
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($null -ne $svc) {
    Write-Host "서비스가 이미 있습니다. 재설정하려면 먼저 제거하세요: & `"$NssmPath`" remove $ServiceName confirm"
  } else {
    $logDir = Join-Path $repo "..\portal-logs"
    New-Item -ItemType Directory -Force $logDir | Out-Null
    & $NssmPath install $ServiceName $node.Source (Join-Path $repo "src\server.js")
    & $NssmPath set $ServiceName AppDirectory $repo
    & $NssmPath set $ServiceName AppStdout (Join-Path $logDir "portal.out.log")
    & $NssmPath set $ServiceName AppStderr (Join-Path $logDir "portal.err.log")
    & $NssmPath set $ServiceName AppRotateFiles 1
    & $NssmPath set $ServiceName AppRotateBytes 10485760
    & $NssmPath set $ServiceName AppExit Default Restart
    & $NssmPath set $ServiceName AppRestartDelay 5000
    & $NssmPath set $ServiceName Start SERVICE_AUTO_START
    Start-Service $ServiceName
    Write-Host "서비스 등록·시작 완료: $ServiceName (로그: $logDir)"
  }
}

Write-Host "== 4/4 전원 설정 (노트북을 서버로) =="
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT
Write-Host "전원(AC) 절전 끔 + 덮개 닫아도 계속 실행으로 설정했습니다."
Write-Host ""
Write-Host "확인: 다른 기기 브라우저에서 http://<이 PC IP>:$Port/health 가 열리는지 보세요."
