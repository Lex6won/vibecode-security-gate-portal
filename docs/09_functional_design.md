# 기능설계서: 공공 바이브코딩 보안 체커 포털

## 설계 기준

로컬 실행, 원본·보고서 저장 경계, 익명 메타데이터 전송, 세 가지 필수 기능의 완료 기준은 [16_local_execution_architecture.md](./16_local_execution_architecture.md)를 기준으로 한다. 원본 소스와 보고서는 중앙 서버에 기본 저장하지 않는다.

1차 제품은 웹 UI 기반 로컬 웹앱이다. 화면은 브라우저에서 열리지만, 실제 검사와 PC 상태 확인은 사용자 PC의 로컬 백엔드가 수행한다.

Supabase는 2차 중앙 포털 연계 대상으로 둔다. 처음부터 DB 모델과 API 응답은 Supabase PostgreSQL로 옮기기 쉬운 구조로 설계한다.

핵심 업무 화면은 스크롤 없는 단일 화면으로 설계한다. 검사 진행, 업데이트 미리보기, 설치 승인, 오류 안내, 상세 결과는 별도 페이지나 본문 하단 영역이 아니라 레이어 팝업으로 표시한다.

## 기능 모듈

| 모듈 | 설명 | 1차 | Supabase 연계 |
|---|---|---:|---:|
| 홈 | 서비스 목적, 빠른 점검, 표준 점검, MCP 등록, 관리자 진입 | 포함 | 일부 |
| 검사 대상 선택 | 폴더, 압축파일, GitHub URL 선택 | 포함 | 메타데이터만 |
| 검사 실행 | 체커 CLI/MCP 호출, 진행 상태 수집 | 포함 | 결과 요약만 |
| 검사 결과 | 제출 가능 여부, 수정 필요, 사람 검토, 의존성 위험 표시 | 포함 | 메타데이터만 |
| 보고서 저장 | HTML, JSON, ZIP 저장 위치 선택 | 포함 | 파일 해시만 |
| 하네스 설치 | 공식 저장소 또는 검증된 릴리스 기반 설치 | 포함 | 상태 요약 |
| MCP 등록 | Codex, Claude Code 체커 MCP 등록과 연결 검증 | 포함 | 상태 요약 |
| 업데이트 확인 | 하네스, 체커, 룰셋, 인텔 최신 여부 확인 | 포함 | 안정 채널 조회 |
| 관리자 현황 | 익명 검사 통계, 반복 룰, 오탐 후보 확인 | 로컬 관리자 화면 | 중앙 포털 |
| 체커 개선 피드백 | 오탐 후보, 과탐 후보, 미탐 후보 기록 | 선택 | 포함 |

## 사용자 시나리오별 기능

### 빠른 점검

목적:

개발 중 위험 신호를 빠르게 확인한다.

흐름:

1. 사용자가 `빠른 점검`을 누른다.
2. 폴더, 압축파일, GitHub URL 중 하나를 선택한다.
3. 대상이 선택되면 바로 검사를 시작한다.
4. 진행상황 레이어는 실행 중에만 표시한다.
5. 결과는 `위험 신호`, `사람 검토 후보`, `검사 실패` 중심으로 보여준다.

결과물:

- 화면 요약
- 선택적 HTML 보고서
- 제출 패키지는 생성하지 않음

### 표준 점검

목적:

개발 완료 소스의 코드와 의존성을 함께 검사한다.

흐름:

1. 사용자가 `표준 점검 시작` 또는 보안 점검 화면의 `표준 점검`을 누른다.
2. 검사 대상을 선택한다.
3. 로컬 백엔드가 코드 검사와 의존성 검사를 실행한다.
4. 체커 HTML/JSON 보고서를 생성한다.
5. 사용자는 저장 위치를 선택해 결과를 저장한다.

결과물:

- 체커 HTML 보고서
- 체커 JSON evidence
- 검사 요약
- 수정 필요 항목 목록
- 의존성 취약점 목록

### 제출 점검

목적:

제출 전에 검사 범위 누락 없이 증거 파일을 만든다.

흐름:

1. 사용자가 `제출 점검`을 누른다.
2. 검사 대상을 선택한다.
3. 로컬 백엔드가 코드 검사, 의존성 검사, 보고서 생성, 제출 패키지 생성을 순서대로 실행한다.
4. 검사 실패 또는 검사 대상 0건이면 `제출 가능`으로 표시하지 않는다.
5. ZIP 생성 후 파일 해시와 포함 파일 목록을 보여준다.

결과물:

- HTML 보고서
- JSON evidence
- 제출 manifest
- 제출 패키지 ZIP

### 하네스 설치 및 MCP 등록

목적:

개발 중에도 보안 점검을 호출할 수 있게 AI 개발 도구와 체커를 연결한다.
하네스 파일 설치와 개발 중 강제 게이트 활성화는 별도 상태로 본다.

흐름:

1. 사용자가 `MCP 등록` 또는 `하네스 설치 및 MCP 등록`을 누른다.
2. 앱이 현재 PC 상태를 읽기 전용으로 점검한다.
3. 사용자가 설치 대상을 선택한다.
4. 하네스 설치가 필요하면 설치 위치와 출처를 보여주고 승인받는다.
5. 체커 MCP 등록이 필요하면 설정 파일 백업 후 등록한다.
6. `npm run guard` 같은 실행 게이트와 커밋 전 훅 활성화 여부를 확인한다.
7. 연결 검증을 실행한다.

지원 대상:

- Codex용 하네스
- Claude Code용 하네스
- Codex 체커 MCP
- Claude Code 체커 MCP
- 실행 게이트: `guard`, `pre-commit`, 패키지 게이트

ChatGPT 데스크톱 앱과 Claude Desktop은 “앱 자체가 하네스를 자동 적용한다”가 아니라, 각 앱이 지원하는 MCP 설정 방식에 맞춰 체커 MCP를 등록하는 대상으로 본다.

## 로컬 백엔드 API

### 상태 점검

```text
GET /api/local/status
```

응답:

```json
{
  "harness": {
    "installed": true,
    "status": "current",
    "path": "C:\\projects\\vibe_harness_codex",
    "commit": "a58ae62",
    "dirty": false
  },
  "checker": {
    "installed": true,
    "version": "0.3.0",
    "server_path": "C:\\Users\\...\\gvskb-server.exe",
    "doctor_status": "ok"
  },
  "mcp": {
    "codex_user": "registered",
    "project": "registered",
    "claude_code": "unknown"
  },
  "network": {
    "github": "ok",
    "osv": "ok",
    "pypi": "ok",
    "npm": "ok"
  }
}
```

### 검사 시작

```text
POST /api/scan/start
```

요청:

```json
{
  "target_type": "folder",
  "target_ref": "local-selection-token",
  "scan_mode": "standard",
  "save_dir": "user-selected-save-token",
  "send_anonymous_metrics": true
}
```

응답:

```json
{
  "scan_id": "uuid",
  "status": "queued",
  "progress_url": "/api/scan/{scan_id}/progress"
}
```

### 검사 진행

```text
GET /api/scan/{scan_id}/progress
```

응답:

```json
{
  "scan_id": "uuid",
  "status": "running",
  "current_step": "dependency_scan",
  "percent": 54,
  "message": "의존성 취약점을 확인하고 있습니다.",
  "warnings": []
}
```

### 검사 결과

```text
GET /api/scan/{scan_id}/result
```

응답:

```json
{
  "scan_id": "uuid",
  "status": "completed",
  "decision": "needs_fix",
  "summary": {
    "scanned_file_count": 3028,
    "finding_count": 3,
    "dependency_finding_count": 1,
    "needs_review_count": 1
  },
  "reports": [
    {
      "type": "html",
      "file_name": "security-report.html",
      "sha256": "..."
    }
  ]
}
```

### MCP 등록

```text
POST /api/local/mcp/register
```

요청:

```json
{
  "tool": "codex",
  "scope": "user",
  "backup_existing_config": true
}
```

응답:

```json
{
  "status": "registered",
  "backup_file": "settings.backup.json",
  "verify_status": "ok"
}
```

### 업데이트 미리보기

```text
POST /api/local/update/preview
```

요청:

```json
{
  "targets": ["harness", "checker", "ruleset", "mcp"],
  "channel": "stable"
}
```

응답:

```json
{
  "status": "update_available",
  "items": [
    {
      "target": "checker",
      "current_version": "0.3.0",
      "stable_version": "0.3.2",
      "source": "official_release",
      "validation_status": "passed",
      "summary": "오탐 완화 3건, 의존성 룰 보강 2건"
    }
  ],
  "requires_admin_validation": false
}
```

이 API는 설치를 수행하지 않는다.

### 업데이트 적용

```text
POST /api/local/update/apply
```

요청:

```json
{
  "targets": ["checker"],
  "channel": "stable",
  "approval_token": "user-confirmed",
  "backup_settings": true
}
```

응답:

```json
{
  "status": "applied",
  "backup_files": ["codex-config.backup.toml"],
  "post_checks": {
    "gvskb_doctor": "ok",
    "harness_validate": "ok",
    "mcp_verify": "ok"
  }
}
```

`approval_token` 없이 업데이트를 적용하지 않는다.

## 상태 모델

### scan_jobs.status

| 상태 | 의미 | 다음 상태 |
|---|---|---|
| `queued` | 검사 대기 | `running`, `cancelled`, `failed` |
| `running` | 검사 중 | `completed`, `failed`, `cancelled` |
| `completed` | 검사 완료 | 없음 |
| `failed` | 검사 실패 | 없음 |
| `cancelled` | 사용자 취소 | 없음 |

### scan_jobs.decision

| 판정 | 의미 |
|---|---|
| `submittable` | 제출 전 전체 점검이 끝났고 차단 항목이 없음 |
| `needs_fix` | 수정해야 할 항목이 있음 |
| `needs_review` | 자동 확정이 어려워 사람 검토가 필요함 |
| `blocked` | 차단 위험 또는 검사 실패가 있음 |
| `incomplete` | 검사 범위 누락, 0개 파일, 의존성 미검사 등으로 판정 불가 |

### report_status

| 상태 | 의미 |
|---|---|
| `pending` | 생성 대기 |
| `generated` | 생성 완료 |
| `saved` | 사용자가 선택한 위치에 저장 |
| `failed` | 생성 실패 |

## 체커 호출 매핑

| 검사 방식 | 코드 검사 | 의존성 검사 | 보고서 생성 | 제출 ZIP |
|---|---:|---:|---:|---:|
| `quick` | 예 | 아니오 | 선택 | 아니오 |
| `standard` | 예 | 예 | 예 | 선택 |
| `submission` | 예 | 예 | 예 | 예 |

`submission`은 검사 누락이 있으면 `submittable`이 될 수 없다.

## 이벤트 기록

익명 사용량 산정을 위해 다음 이벤트만 기록한다.

- `open_home`
- `select_scan_mode`
- `select_target`
- `start_scan`
- `scan_completed`
- `scan_failed`
- `download_report`
- `create_submission_zip`
- `open_mcp_setup`
- `run_status_check`
- `register_mcp`

이벤트에는 담당자명, 부서명, 원본 경로, 소스 내용, 토큰을 포함하지 않는다.

## 오류 처리

| 오류 | 화면 문구 | 판정 |
|---|---|---|
| 검사 파일 0개 | 검사할 파일을 찾지 못했습니다. 대상과 확장자를 확인하세요. | `incomplete` |
| 의존성 manifest 없음 | 의존성 파일을 찾지 못했습니다. 코드 검사는 완료됐지만 의존성 점검은 제외됐습니다. | `incomplete` 또는 `needs_review` |
| GitHub clone 실패 | GitHub 저장소를 가져오지 못했습니다. 주소와 네트워크를 확인하세요. | `failed` |
| 체커 실행 실패 | 체커 실행이 끝나지 않았습니다. 로그를 확인하세요. | `failed` |
| 보고서 저장 실패 | 검사는 끝났지만 보고서를 저장하지 못했습니다. 저장 위치를 다시 선택하세요. | `needs_review` |
| MCP 등록 실패 | 설정 파일을 바꾸지 못했습니다. 권한과 백업 파일을 확인하세요. | 해당 없음 |

## 관리자 기능

총괄 관리자만 로그인한다.

관리자 화면 기능:

- 최근 검사 목록
- 기간별 검사 건수
- 검사 방식별 사용량
- 결과별 건수
- 반복 발생 룰
- 오탐 후보 룰
- 검사 실패 사유
- 체커 버전별 결과 분포
- 보고서 생성 여부
- 오탐/과탐 검토 메모

관리자는 원본 소스와 로컬 전체 경로를 볼 수 없다.

## 구현 우선순위

1. 로컬 상태 점검 API
2. 검사 대상 선택과 검사 시작 API
3. 진행 상태 API
4. 결과 요약 API
5. 보고서 저장 위치 선택
6. 제출 ZIP 생성
7. MCP 등록과 연결 검증
8. 익명 이벤트 저장
9. Supabase 메타데이터 동기화
10. 총괄 관리자 화면
