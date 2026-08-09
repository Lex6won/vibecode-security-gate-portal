# 설계 대비 구현 점검 리포트

점검일: 2026-08-09

## 결론

현재 산출물은 화면 시안이 아니라 실행 가능한 1차 로컬 웹앱 MVP다.
다만 PRD와 기능설계서의 1차 범위를 모두 충족한 완성본은 아니다.

가장 잘 맞는 부분은 GitHub URL 또는 서버가 접근 가능한 로컬 경로를 대상으로 `gvskb` 점검을 실행하고, 결과 보고서와 제출 ZIP을 생성하는 흐름이다.

가장 큰 차이는 브라우저만으로 로컬 폴더·압축파일의 실제 경로를 서버에 전달할 수 없다는 점이다. 이 기능은 데스크톱 앱 또는 로컬 브리지 없이 완전 구현으로 볼 수 없다.

## 점검 기준 문서

- `docs/01_PRD.md`
- `docs/02_screen_function_spec.md`
- `docs/03_database_design.md`
- `docs/07_web_portal_architecture.md`
- `docs/09_functional_design.md`
- `docs/10_supabase_design.md`
- `docs/14_service_implementation_status.md`

## 구현 확인 결과

| 설계 항목 | 구현 상태 | 확인 내용 |
|---|---|---|
| 웹 UI 기반 로컬 웹앱 | 구현 | `src/server.js`가 정적 화면과 API를 제공한다. |
| 첫 화면 서비스 선택 허브 | 구현 | `main page.html`에서 빠른 점검, 표준 점검, MCP 등록, 관리자 진입을 제공한다. |
| GitHub URL 검사 | 구현 | `/api/scan/start`가 `git clone --depth 1` 후 `gvskb scan`을 실행한다. |
| 로컬 폴더 검사 | 부분 구현 | API는 서버가 접근 가능한 경로를 검사할 수 있지만, 브라우저 폴더 선택은 실제 로컬 절대 경로를 서버에 전달하지 못한다. |
| 압축파일 검사 | 미구현 | UI 선택은 있으나 서버의 `archive` 처리와 안전한 압축 해제 검증이 없다. |
| 빠른/표준/제출 점검 선택 | 구현 | `quick`, `standard`, `submission` 모드가 API에 연결되어 있다. |
| 의존성 검사 | 부분 구현 | `standard`, `submission`에서 `--check-deps`를 붙인다. 설치 패키지와 vendor bundle 전체 점검은 아직 별도 구현이 아니다. |
| HTML/JSON/Markdown 보고서 | 구현 | `gvskb scan`, `gvskb report` 결과를 `reports/`에 저장한다. |
| 제출 ZIP 생성 | 구현 | `submission` 모드에서 HTML, JSON, Markdown, manifest를 ZIP으로 묶는다. |
| 저장 위치 선택 | 부분 구현 | 화면에는 저장 위치 선택 UI가 있으나 실제 파일은 서버 `reports/` 폴더에 저장된다. 사용자가 고른 위치로 쓰는 기능은 아직 없다. |
| 검사 진행 레이어 | 구현 | 실행 중에만 진행 모달을 보여주는 구조다. |
| 하네스 상태 점검 | 구현 | `/api/local/status`가 하네스, 체커, MCP, 실행 게이트 상태를 읽는다. |
| 업데이트 미리보기 | 부분 구현 | `/api/local/update/preview`는 제공하지만 실제 적용은 승인·백업·재검증 구현 전까지 차단한다. |
| 하네스 설치 실행 | 미구현 | 화면은 있으나 공식 저장소 설치, 백업, 적용, 재검증 실행은 없다. |
| MCP 등록 | 부분 구현 | `/api/local/mcp/register`는 현재 상태와 사용자 승인 필요 여부만 반환한다. 실제 설정 파일 변경은 하지 않는다. |
| 관리자 로그인 | 미구현 | 로그인 화면은 있으나 인증·세션·권한 검증 없이 관리자 화면으로 이동한다. |
| 관리자 현황 | 부분 구현 | 현재 서버 프로세스의 메모리 기반 검사 이력과 보고서 URL을 보여준다. 영속 DB는 없다. |
| Supabase 연계 | 설계 완료, 미구현 | `supabase/schema.sql`과 설계 문서는 있으나 런타임 연계는 없다. |
| LLM API 미사용 | 충족 | 보안 판정과 설명 생성에 LLM API를 사용하지 않는다. |
| 새 패키지 최소화 | 충족 | 런타임 의존성은 비어 있고 ZIP 생성도 Node 내장 Buffer로 구현했다. |

## 사용자 시나리오 검증

`npm run guard`를 다시 실행했고 통과했다.

검증된 흐름:

- 주요 페이지 로드
- 주요 버튼·링크 계약 검증
- 빠른 점검
- 제출 점검과 ZIP 생성
- 하네스/MCP 상태 확인
- 관리자 현황 API 조회
- `gvskb scan src --profile dev-quick` 결과 findings 0건

버튼·링크 계약 테스트:

- `/`, `/scan`, `/harness`, `/help`, `/admin/login`, `/admin`의 내부 링크가 200 응답으로 이어지는지 확인한다.
- `href="#"` placeholder 링크를 금지한다.
- 외부 GitHub 링크는 새 탭과 `rel=noreferrer` 조건을 확인한다.
- 버튼은 `id`, `data-*`, class 기반 스크립트 연결 중 하나가 있어야 한다.
- API 기반 버튼은 `/api/local/status`, `/api/local/update/preview`, `/api/local/mcp/register` 응답을 확인한다.

확인된 WARN:

- `gvskb doctor`가 Semgrep 미설치 등으로 WARN 1개를 반환한다.
- 개발 게이트에서는 ERROR가 아니므로 통과시키되, 릴리스 전 검증 기록에는 계속 표시해야 한다.

## 설계와 다른 점

1. 1차 범위가 MVP 구현보다 넓다.
   PRD는 로컬 폴더 검사, 압축파일 검사, 하네스 설치, MCP 등록까지 1차 포함으로 적고 있지만 현재는 GitHub URL 점검과 상태 확인 중심이다.

2. 브라우저 파일 선택 UX와 실제 검사 실행 사이에 기술적 간극이 있다.
   브라우저는 사용자가 선택한 로컬 폴더의 실제 경로를 서버에 넘겨주지 않는다. 데스크톱 앱, 로컬 브리지, 또는 사용자가 경로를 직접 입력하는 방식을 별도로 결정해야 한다.

3. 보고서 저장 위치 선택이 실제 저장 위치와 다르다.
   화면은 저장 위치를 고르는 듯 보이지만 서버는 `reports/`에 저장한다. 사용자가 선택한 위치로 복사하거나 다운로드하는 흐름이 필요하다.

4. 관리자 로그인은 설계보다 약하다.
   총괄 관리자 로그인 화면은 있으나 실제 ID/PW 검증, 세션, 접근제어가 없다.

5. 관리자 화면의 데이터 범위는 현재 세션으로 제한된다.
   설계상 익명 사용 현황과 점검 결과를 누적해야 하지만, 현재는 메모리 기반이라 서버 재시작 시 사라진다.

6. 검사 화면의 ZIP 표시 문구가 구현과 어긋날 수 있다.
   서버는 제출 점검 시 ZIP을 생성하지만, 화면의 `setResultDone`은 제출 ZIP 항목을 `추가 구현 필요`로 표시한다. 문구를 `생성됨`으로 고쳐야 한다.

7. 포털 내부 하네스 사본이 최신 원본 하네스와 아직 동기화되지 않았다.
   원본 `vibe_harness_codex`에는 `core-process-enforcement.yaml`을 추가했지만, 포털 내부 `shared/`에는 아직 없다.

## 체커 개선 기록

하네스 원본에 `core-process-enforcement.yaml`을 추가한 뒤 체커로 적대적 검증을 수행했다.

초기 문구:

- 완료 보고 문장 안의 `final answer`, `user scenarios`, `checker/harness gates` 표현

체커 반응:

- `GOV-LLM-OUTPUT-HANDLING-001`
- severity `high`
- decision `block`
- YAML 정책 문서인데 LLM 출력 실행 위험으로 오탐

실제 판단:

- 실행 코드가 아니다.
- HTML 렌더링, eval, shell, SQL sink가 없다.
- 따라서 실제 취약점이 아니라 문서·정책 맥락 오탐이다.

조치:

- 문장형 설명을 `completion_evidence_required` 구조화 필드로 바꿔 오탐을 제거했다.
- 이 사례를 `docs/04_checker_improvement_backlog.md`의 P0 오탐 억제 항목에 추가했다.

체커 수정 후보:

- YAML/Markdown/fixture 문서와 실행 코드를 구분한다.
- LLM 출력 보안 룰은 실제 sink가 있을 때 차단한다.
- sink가 없는 정책 문서는 `false_positive_candidate` 또는 문서 맥락 경고로 낮춘다.
- 이 사례를 회귀 fixture로 추가한다.

## 다음 구현 우선순위

1. 검사 화면의 제출 ZIP 표시 문구 수정
2. 포털 내부 `shared/`를 최신 하네스 원본과 동기화
3. 로컬 폴더/압축파일 검사용 데스크톱 브리지 또는 경로 입력 방식 결정
4. 저장 위치 선택과 실제 다운로드/복사 흐름 연결
5. 관리자 로그인 인증과 세션 처리
6. 현재 세션 메모리 이력을 SQLite 또는 로컬 파일 DB에 저장
7. Supabase 연계는 2차 중앙 포털 단계에서 Edge Function/API 경유로 연결
