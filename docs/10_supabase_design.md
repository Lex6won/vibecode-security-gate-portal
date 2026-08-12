# Supabase 연계 DB 설계

> **[폐기 예정 2026-08-12]** 경기도 기관 제약(Supabase 금지·인증 직접구현 금지)에 따라 이 문서의 Supabase Auth/Edge Function/RLS/Storage 경로는 채택하지 않는다. 확정 스키마는 `db/schema.postgresql.sql`, 개정 고지는 `03_database_design.md` 상단 참조. 데이터 최소화 원칙(아래 '결론')만 유효하다.

## 결론

중앙 DB에는 원본 소스, 원본 압축파일, GitHub 토큰, 로컬 전체 경로, 보고서 본문을 저장하지 않는다. 로컬 실행 및 옵트인 메타 전송의 확정 기준은 [16_local_execution_architecture.md](./16_local_execution_architecture.md)를 따른다.

Supabase는 2차 중앙 포털의 메타데이터 저장소로 사용한다. 1차 로컬 웹앱은 SQLite 또는 로컬 파일 DB로 동작하고, 나중에 같은 테이블 구조를 Supabase PostgreSQL로 옮긴다.

Supabase에는 원본 소스코드, 압축파일 원본, GitHub 토큰, 로컬 전체 경로, 담당자명, 부서명을 저장하지 않는다.

## 연계 방식

권장 방식:

1. 로컬 웹앱이 검사를 수행한다.
2. 로컬 웹앱이 익명 메타데이터를 만든다.
3. 사용자가 사용 통계 전송에 동의하면 중앙 포털 API로 보낸다.
4. 중앙 포털 API 또는 Supabase Edge Function이 service role로 DB에 저장한다.
5. 총괄 관리자는 Supabase Auth로 로그인해 관리자 화면을 본다.

브라우저에서 Supabase anon key로 `scan_jobs`, `scan_findings`에 직접 쓰는 방식은 권장하지 않는다. 남용, 조작, 스팸 입력을 제어하기 어렵기 때문이다.

## Supabase 구성요소

| 구성요소 | 사용 |
|---|---|
| PostgreSQL | 검사 메타데이터, 익명 이벤트, 관리자 검토 기록 |
| Auth | 총괄 관리자 로그인 |
| Row Level Security | 관리자만 조회, Edge Function만 쓰기 |
| Storage | 선택 업로드 보고서 저장. 기본은 미사용 |
| Edge Functions | 메타데이터 수집, 관리자 통계 API, 업데이트 채널 API |

## RLS 원칙

- `anon` 사용자는 직접 조회 권한이 없다.
- `authenticated` 사용자는 기본적으로 자기 권한만 확인한다.
- `admin_profiles.role = 'super_admin'`인 사용자만 관리자 데이터를 조회한다.
- insert는 Edge Function service role 또는 보안 함수로 제한한다.
- 보고서 파일은 private bucket에 저장하고, 짧은 만료 시간의 signed URL로만 내려받는다.

## 테이블 구성

### admin_profiles

Supabase `auth.users`와 연결되는 관리자 프로필이다.

- `id`: `auth.users.id`
- `login_id`
- `display_name`
- `role`: `super_admin`
- `is_active`
- `last_login_at`

### client_installations

로컬 웹앱 설치 또는 실행 환경의 익명 상태다.

- `id`
- `anonymous_client_id`
- `client_type`: `local_web`, `desktop`, `mcp`
- `os_name`
- `app_version`
- `checker_version`
- `harness_commit`
- `last_seen_at`

### scan_jobs

검사 1건의 기준 테이블이다.

- 대상 원문 대신 `target_label`, `target_fingerprint_hash`만 저장한다.
- 로컬 전체 경로는 저장하지 않는다.
- GitHub URL은 공개 URL이라도 전체 저장 대신 owner/repo 수준 표시명과 해시 저장을 기본으로 한다.

### scan_steps

검사 단계별 진행과 실패 원인을 저장한다.

- `prepare_target`
- `code_scan`
- `dependency_scan`
- `render_report`

### scan_reports

보고서 파일의 메타데이터만 저장한다.

- `report_type`: `html`, `json`, `markdown`, `sarif`
- `sha256`
- `file_size`
- `storage_object_path`: 사용자가 명시 업로드한 경우만 저장

### scan_findings

코드/설정 탐지 결과다.

- 원본 코드 snippet은 저장하지 않는다.
- `evidence_summary`는 체커가 만든 짧은 요약만 저장한다.
- 파일 경로는 `file_path_hash`, `file_ext`, `path_depth` 수준으로 저장한다.

### dependency_findings

의존성 취약점 결과다.

- 패키지명, 버전, ecosystem, CVE/GHSA/OSV ID 저장
- 도달성은 `reachable`, `not_reachable`, `unknown`으로 분리

### rule_feedback

체커 개선을 위한 피드백이다.

- 오탐 후보
- 과탐 후보
- 미탐 후보
- 문구 개선 후보
- 의존성 도달성 판단 개선 후보

### usage_events

익명 사용량 이벤트다.

- 기능 사용량 산정
- UX 개선
- 오류 빈도 분석

### audit_logs

총괄 관리자 행위 기록이다.

- 로그인
- 조회
- 보고서 다운로드
- 피드백 상태 변경

## Storage 정책

기본값:

- 중앙 Supabase Storage에 보고서 업로드하지 않음
- 보고서는 사용자 PC 선택 위치에 저장

선택 업로드를 허용하는 경우:

- private bucket `scan-reports`
- 원본 소스 포함 금지
- 업로드 전 사용자 확인
- object path에는 개인정보나 로컬 경로 포함 금지
- 다운로드는 관리자 signed URL만 허용

## 데이터 보존 기간

| 데이터 | 보존 |
|---|---:|
| usage_events | 12개월 |
| scan_jobs 메타데이터 | 24개월 |
| findings 메타데이터 | 24개월 |
| uploaded reports | 기관 정책에 따름. 기본 90일 |
| audit_logs | 36개월 |

## 동기화 정책

로컬 앱은 네트워크가 없거나 Supabase 연결이 실패해도 검사를 계속 수행한다.

동기화 상태:

- `not_enabled`: 사용자가 통계 전송을 켜지 않음
- `pending`: 전송 대기
- `synced`: 전송 완료
- `failed`: 전송 실패

동기화 실패는 검사 실패가 아니다. 다만 관리자 통계에는 반영되지 않는다.

## 보안 주의사항

- Supabase service role key는 로컬 앱이나 브라우저에 넣지 않는다.
- 관리자 화면은 Supabase Auth 세션과 RLS를 모두 확인한다.
- Edge Function은 입력 크기, enum 값, 해시 길이, 날짜 범위를 검증한다.
- 익명 ID는 사용자를 추적하기 위한 식별자가 아니라 중복 집계를 줄이기 위한 임의 ID로만 사용한다.
- IP는 원문 저장하지 않고 필요한 경우 salted hash로만 저장한다.
