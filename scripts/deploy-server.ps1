# 포털 서버 배포 — 태그 단위 배포와 롤백 (docs/29 §5)
# 사용: .\scripts\deploy-server.ps1 -Tag v0.3.0
# 롤백: 이전 태그로 같은 명령을 다시 실행
# PowerShell 5.1 호환.
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [string]$ServiceName = "VibeCodePortal",
  [int]$Port = 8787
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

Write-Host "== 1/5 태그 받기: $Tag =="
git fetch --tags origin
if (-not $?) { throw "git fetch 실패" }
git rev-parse --verify ("refs/tags/" + $Tag) | Out-Null
if (-not $?) { throw "태그가 없습니다: $Tag" }

Write-Host "== 2/5 체크아웃 =="
git checkout --detach $Tag
if (-not $?) { throw "checkout 실패" }

Write-Host "== 3/5 의존성 설치 =="
npm ci
if (-not $?) { throw "npm ci 실패" }

Write-Host "== 4/5 배포 전 검증 (문법·화면 계약) =="
node --check src\server.js
if (-not $?) { throw "server.js 문법 오류" }
npm run button:test
if (-not $?) { throw "버튼 계약 테스트 실패 — 배포 중단" }

Write-Host "== 5/5 서비스 재시작·확인 =="
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -ne $svc) {
  Restart-Service $ServiceName
  Start-Sleep -Seconds 3
} else {
  Write-Warning "서비스($ServiceName)가 없어 재시작을 건너뜁니다. 수동 실행 중이면 직접 재시작하세요."
}
try {
  $health = Invoke-RestMethod ("http://127.0.0.1:" + $Port + "/health")
  Write-Host ("health: " + ($health | ConvertTo-Json -Compress))
  Write-Host ("배포 완료: " + $Tag)
} catch {
  throw "health 확인 실패 — 서비스 로그를 확인하세요 (portal-logs\portal.err.log)"
}
