# vibecode-checker / gvskb 연계 기준

하네스는 보안점검 엔진이 아니다. `vibecode-checker(gvskb)`가 코드와 패키지를 검사하고, 레지스트리 서비스가 패키지 허용·불허·보류 결정을 관리한다. 하네스의 역할은 체커가 돌려준 결과를 공무원과 코딩 에이전트가 실제로 지키게 만드는 것이다.

## 1. 기본 호출 원칙

1. MCP가 연결되어 있으면 `vibecode-checker` MCP를 우선 사용한다.
2. MCP가 없고 CLI가 가능하면 `gvskb` CLI를 사용한다.
3. 둘 다 없으면 `shared/references/checker-bootstrap-policy.md`에 따라 사용자에게 설치/준비 여부를 확인한다.
4. 사용자가 동의하면 GitHub `https://github.com/Lex6won/vibecode-checker` 기반 설치 또는 로컬 반입 경로 지정으로 진행한다. 사용자 확인 전에는 clone, pip install, MCP 설정 변경을 하지 않는다.
5. 체커가 끝내 연결되지 않으면 기획·설계는 계속할 수 있지만, 패키지 설치·운영 이관·보안검증 완료 처리는 하지 않는다.
6. 패키지 결정은 레지스트리에 직접 묻지 않는다. 하네스는 `scan_dependencies` 또는 동등한 gvskb 기능을 호출하고, gvskb가 레지스트리 판정까지 포함한 단일 verdict를 반환한다고 본다.
7. 소스 보안점검은 `_workspace` 문서가 아니라 실제 소스 경로인 `_workspace/source/` 또는 사용자가 지정한 코드 경로를 대상으로 한다.
8. `render_report`가 저장한 보고서는 에이전트가 다른 위치나 다른 이름으로 다시 저장하지 않는다. 체커가 반환한 `saved.markdown`, `saved.html`, `saved.json` 경로를 그대로 사용자와 manifest에 기록한다.
9. 하네스는 기본적으로 체커 내장 표준 프로파일을 사용한다. 기관 고유 정책이 생기기 전에는 하네스가 별도 `references/policies/` 사본을 유지하거나 `GVSKB_POLICIES_DIR` 상대경로에 의존하지 않는다.
10. 기관 고유 정책 때문에 `GVSKB_POLICIES_DIR`을 써야 한다면 반드시 설치/부트스트랩 단계에서 절대경로로 지정한다. MCP 서버의 작업 디렉터리는 하네스 저장소 루트가 아니라 사용자가 연 프로젝트 폴더일 수 있다.

## 1-1. 단계별 체커 사용 강도

하네스는 체커를 많이 호출하는 것이 목적이 아니다. 사용자의 흐름을 막지 않으면서, 위험이 커지는 단계에서만 검사 강도를 올린다.

| 단계 | 프로파일 | 체커 사용 | 사용자 경험 |
|---|---|---|---|
| 코딩 중 | quick(`dev-quick`) | 변경 파일, 새 패키지, 핵심 위험만 확인 | 통과는 조용히, 차단은 한 줄 조치 |
| 개발 완료 후 | standard | 전체 source와 선언된 의존성 점검 | 보안점검 요약과 수정 경로 |
| 배포 전 | full | 전체 소스, 의존성, 설치본, 벤더 번들, 최종 리포트 저장 | 최종 제출 리포트 2종 경로 안내 |

### quick — 코딩 중 간소화 점검

quick은 모든 룰을 매번 적용하는 흐름이 아니다. 다음 경우에만 실행하거나 예약한다.

- 새 패키지를 추가하거나 `requirements.txt`, `package.json`, lockfile을 바꾼 경우
- 인증/권한, 개인정보/민감정보, 파일 업로드, 외부 API/CDN/LLM/MCP, SQL/DB 쿼리, 명령 실행, `eval` 계열 코드를 바꾼 경우
- 사용자가 “중간 점검”, “커밋 전 확인”, “저장 전 확인”, “안전한지 봐줘”라고 요청한 경우

quick에서 반드시 보는 안전장치는 아래로 제한한다.

- 비밀값 하드코딩
- 개인정보·민감정보 샘플 또는 평문 저장
- denied, `not_found`, `registry_rejected`, `malicious`, `in_kev=true` 패키지
- SQL Injection, 파일 업로드 경로/확장자/크기 위험
- `eval`, 명령 실행, unsafe deserialization
- 기관 정책 밖 외부통신 또는 CDN
- 기관 프로파일 밖 구현언어, DBMS, 런타임, 운영서버 사양 위반

단순 UI 문구, 문서, 스타일 수정에는 자동 full scan을 하지 않는다.

새 패키지 설치는 quick의 가장 작은 실행 단위다. 하네스는 새 패키지를 먼저 설치한 뒤 나중에 검사하지 않는다.

- Python/PyPI: `shared/enforcement/gvskb_gate.py check/install`
- JavaScript/npm: `shared/enforcement/gvskb_gate.js check/install`
- 단일 패키지 확인도 임시 manifest를 만들어 `audit_manifest` 기반으로 점검한다. `check_package_impl` 같은 이름 단위 단독 점검은 버전·manifest·기관 레지스트리 맥락이 빠질 수 있으므로 설치 게이트의 기준으로 쓰지 않는다.
- npm 설치는 기본적으로 `--ignore-scripts`를 붙인다.
- `verify-manifest`는 개발 중 확인용이며, 배포 전 제출 리포트를 대신하지 않는다.

### 1-2. 체커 프로파일 적용 검증

`network_profile`과 `checker profile`은 이름공간이 다르다.

- `network_profile`: `admin-network`, `dmz-public`, `internet-prototype` 같은 망/배포 구분값
- `checker profile`: `dev-quick`, `internal-db-query`, `web-civil-service`, `civil-complaint-chatbot`, `public-default-strict` 같은 체커 룰 프로파일

하네스는 `network_profile` 값을 `scan_path(profile=...)`에 그대로 넣지 않는다. 보안검사 호출 전에는 작업 단계와 서비스 유형으로 checker profile을 따로 결정한다.

검사 호출 후에는 반드시 적용 여부를 확인한다.

1. 요청한 checker profile을 manifest에 `requested_checker_profile`로 기록한다.
2. `scan_path` 결과의 `profile` 값을 `applied_checker_profile`로 기록한다.
3. 두 값이 다르면 검증을 완료 처리하지 않는다. 체커가 기본값으로 대체 실행한 결과는 보조 정보일 뿐, quick/standard/full 게이트 통과 증거가 아니다.
4. 이 경우 사용자에게는 내부 필드명을 길게 보여주지 않고 “요청한 보안 프로파일이 실제 적용되지 않아 검증을 완료하지 못했습니다. 체커 설정 또는 정책 경로를 확인해야 합니다.”라고 안내한다.
5. 체커 결과에 `profile_fallback`이 있으면 `null`일 때만 정상 적용으로 본다. `{requested, applied, ...}` 객체가 있으면 요청 프로파일이 실제 적용되지 않은 것이므로 검증 미완료로 처리한다.

특히 quick에서 `dev-quick`을 요청했는데 체커가 알 수 없는 프로파일로 처리하거나 `public-default-strict` 등으로 폴백하면 “더 엄격하게 검사했으니 통과”로 보지 않는다. 하네스가 의도한 단계별 경량 검사 증거가 아니므로 체커 업데이트 또는 절대경로 정책 설정을 먼저 요구한다.

### standard — 개발 완료 후 점검

개발 완료 후에는 `_workspace/source/` 또는 사용자가 지정한 실제 소스 경로 전체를 대상으로 `scan_path`를 실행한다. 의존성 파일이나 lockfile이 있으면 `scan_dependencies`를 실행하고, 결과를 `dependency_audit`에 병합해 보고서에 포함한다.

standard는 배포 제출이 아니라 “배포 후보가 될 수 있는지”를 보는 단계다. critical/high/block이 남아 있으면 배포 준비로 넘기지 않는다.

### full — 배포 전 최종 점검과 제출 리포트

배포, 공식 개발환경 이관, 보안성검토, AX/보안팀 제출 전에는 full을 반드시 수행한다.

full 흐름:

1. `scan_path`로 실제 소스 경로를 검사한다.
2. `requirements.txt`, `package.json`, lockfile이 있으면 `scan_dependencies`를 실행한다.
3. `.venv`, `node_modules`, wheel 등 설치 흔적이 있으면 `scan_installed_packages`를 실행한다.
4. `scan_path` 결과에 `vendor_bundles`가 있으면 `scan_vendor_bundles`를 실행한다.
5. 의존성, 설치본, 벤더 번들 결과를 `dependency_audit`에 병합한다.
6. `render_report(format="both", save=true)`를 호출한다.
7. 체커가 저장한 `.html`과 `.json` 경로를 사용자에게 알려주고 manifest에 기록한다.

배포 전 기본 제출자료는 체커가 저장한 두 파일이다.

- 사람용 최종 보안점검 리포트: `saved.html`
- 증적용 원본 JSON 리포트: `saved.json`

하네스는 이 두 파일을 보안팀 또는 AX 전담팀에 제출해야 한다는 사실을 반드시 안내한다. 이 리포트는 공식 승인서가 아니라 보안 검토를 요청하기 위한 증적이다.

배포신청서, 예외신청서, 패키지 검토요청서, 서버설치 가이드는 기본 생성물이 아니다. 기관 양식 요구, 미해결 예외, 패키지 검토, 운영팀 설치 인계가 있을 때만 조건부로 만든다.

## 2. 하네스가 읽어야 하는 필드

패키지 단위로는 다음 필드를 우선 읽는다.

- `verdict`
- `verdict_severity`
- `requires_review`
- `checked`
- `is_malicious_package`
- `in_kev`
- `kev_checked`
- `max_cve`
- `cooldown.ok`
- `version_exact`
- `source_scope`
- `registry_status`
- `registry_decision`
- `registry_stale`
- `heuristics.typosquat_warning`

manifest/lockfile 단위로는 다음 필드를 기록한다.

- `truncated_count`
- `unchecked_count`
- `intel_cache.state`
- `registry_status`
- `source_kind`

필드가 없으면 “안전”이 아니라 “판정 근거 부족”으로 본다. 특히 `checked=false`, `unknown`, `error`, `item_failed`는 안전 통과가 아니다.

### 2-1. 2026-08-03 gvskb 신호 변경

`in_kev=false`만으로 “실제 악용 중 아님”이라고 해석하지 않는다. 반드시 `kev_checked`를 같이 본다.

| 신호 | 하네스 해석 |
|---|---|
| `in_kev=true` | 모든 모드에서 차단 |
| `kev_checked=false` + `in_kev=false` | KEV 대조를 못 한 상태. `in_kev=false`를 통과 근거로 쓰지 않음 |
| `version_exact=false` | 경계값/범위 제약 기반 추정. 이것만으로 차단하지 않음 |
| `source_scope=single/manifest` | 사람이 직접 고른 의존성. ENFORCE에서 unknown 차단 대상 |
| `source_scope=lockfile/installed` | 전이/관측 의존성. ENFORCE에서도 unknown만으로는 차단하지 않음 |
| `registry_stale=true` | 낡은 차단 또는 열화 상태. 차단을 경고로 낮추지 않음 |

`registry_status`는 `ok`일 때만 기관 판정을 받은 것으로 본다. `unreachable`, `rejected`, `item_failed`, `unauthorized`, `disabled` 및 앞으로 추가될 알 수 없는 값은 “기관 판정 없음”으로 처리한다. 값을 하나씩 허용 처리하면 새 enum이 추가될 때 모르는 값이 통과로 떨어질 수 있다.

`kev_checked`가 없던 과거 결과를 읽어야 한다면 `cache_sources_used`에 `cisa-kev`가 있을 때만 KEV 대조가 된 것으로 본다. `osv-malicious` 같은 다른 인텔 소스가 있어도 KEV 대조를 했다는 뜻은 아니다.

## 3. verdict 우선순위

동일 패키지에 여러 신호가 있으면 아래 순서가 강하다.

1. `malicious`
2. `registry_rejected`
3. `not_found`
4. `vulnerable`
5. `cooldown_hold`
6. `checked_stale`
7. `registry_approved`
8. `checked_clean`
9. `unknown`
10. `error`

다음은 운영 모드와 관계없이 무조건 차단한다.

- `verdict == malicious`
- `verdict == registry_rejected`
- `verdict == not_found`
- `in_kev == true`

`not_found`는 단순 경고가 아니다. 공식 PyPI/npm 저장소에 없는 이름이면 AI가 지어낸 패키지명일 수 있고, 공격자가 나중에 같은 이름을 등록하는 slopsquatting 위험이 있으므로 설치 전에 막는다.

## 4. enforcement mode 해석

하네스는 기관 프로파일의 `harness_enforcement.default_mode`를 따른다. 레지스트리 실데이터가 적거나 0건인 초기 도입 기본값은 `MONITOR`다. 권장 운영안은 MONITOR 2주 관찰 후 보안·운영 확인을 거쳐 WARN으로 전환하는 것이다.

| 상태 | MONITOR | WARN | ENFORCE |
|---|---|---|---|
| malicious / registry_rejected / not_found / in_kev | block | block | block |
| vulnerable CRITICAL/HIGH | warn | block | block |
| vulnerable MEDIUM/LOW | log | warn | block |
| vulnerable UNKNOWN | warn | warn | block |
| cooldown_hold | log | warn | block |
| checked_stale | log | warn | warn |
| unknown / error, source_scope 없음 | log | warn | block |
| unknown, source_scope single/manifest | log | warn | block |
| unknown, source_scope lockfile/installed | log | warn | warn |
| registry_approved + checked=true | pass | pass | pass |
| registry_approved + checked=false | pass | warn | warn |
| checked_clean | pass | pass | pass |
| 기존 패키지 typosquat warning | warn | warn | warn |

MONITOR는 도입 초기 관찰 모드, WARN은 운영 기본값 후보, ENFORCE는 체커와 레지스트리 커버리지가 충분할 때 사용한다. 운영 모드 선택은 보안·운영팀 정책이다.

타이포스쿼팅 신호는 휴리스틱이다. 하네스에서는 기존 패키지에 대한 단독 차단 근거로 쓰지 않고 경고로만 제시한다. 다만 레지스트리는 같은 신호를 자동 승인 보류(`UNDER_REVIEW`) 근거로 쓸 수 있다. 공식 저장소에 없는 `not_found`는 휴리스틱이 아니라 사실 확인이므로 절대 차단이다.

`version_exact=false`인 취약점 판정은 “이 제약이 취약한 버전을 허용할 수 있다”는 신호이지 실제 설치본 관측이 아니다. 따라서 이 신호만으로 설치를 막지 않는다. 다만 안전 버전 고정, lockfile 생성, 재검사를 제안한다. `malicious`, `registry_rejected`, `not_found`, `in_kev=true` 같은 절대 규칙은 `version_exact`와 무관하게 적용한다.

## 5. env_grade

체커 호출 시 가능한 경우 `env_grade`를 전달한다. 하네스가 환경을 판단하며, 개발자에게 낮은 등급을 직접 고르게 하지 않는다.

- E0: 개인 PC 1회성, 공개/더미 데이터. cooldown 기본 3일.
- E1: 개인 PC 반복 사용, 내부 문서/자료. cooldown 기본 7일.
- E2: 내부 서버, 공용 환경, 행정정보, CI/CD. cooldown 기본 14일, 자동 승인 금지.
- E3: 대민, 개인정보, 인증, 핵심 행정정보. 하네스는 증거와 산출물을 준비할 수 있지만 운영 승인을 단독 처리하지 않는다.

개인 PC 하네스 기본값은 E1, 내부 서버나 CI는 E2, 대민·민감정보 운영은 E3로 기록한다. E1에서 E2로 올리는 것은 자유롭지만, E1에서 E0로 낮추려면 사유와 승인 기록이 필요하다.

## 6. 레지스트리와 로컬 카탈로그 우선순위

- 로컬 denylist는 항상 로컬 allowlist보다 강하다.
- gvskb가 `registry_rejected`를 반환하면 로컬 allowlist에 있어도 차단한다.
- 로컬 denylist가 차단하면 레지스트리 승인 여부와 무관하게 차단한다.
- 로컬 allowlist와 gvskb의 `registry_approved` 또는 `checked_clean`이 함께 있으면 통과할 수 있다.
- 로컬 allowlist가 있어도 gvskb가 `unknown`, `error`, `cooldown_hold`, `checked_stale`, `checked=false`를 반환하면 enforcement mode로 판단한다.
- 로컬 항목이 없어도 gvskb가 `registry_approved` 또는 `checked_clean`을 반환하면 mode와 성숙도에 따라 통과 또는 proposed-approved로 기록한다.

오래된 registry rejected 캐시는 경고로 낮추지 않는다. “거절 이력은 있으나 현재 레지스트리 확인이 오래됨/불가”라고 표시하고 계속 차단한다.

### 6-1. 카탈로그 반입 원칙

하네스의 `approved-packages.yaml`은 “이 이름은 하네스 범위 안에서 사용할 수 있다”는 이름 단위 scope다. 레지스트리의 `APPROVED`는 `(생태계, 이름, 버전)`에 대한 버전 단위 판정이다. 따라서 버전 없는 approved 항목을 레지스트리 `APPROVED`로 반입하지 않는다.

| 하네스 카탈로그 | 레지스트리 반입 |
|---|---|
| approved/core 이름 | scope_catalog로만 전달. exact version + checker clean 후 자동 승인 가능 |
| restricted 이름 | scope_catalog + 조건으로 전달. 조건이 집행 가능할 때만 조건부 승인 후보 |
| denied package 이름 | `REJECTED` 반입 가능 |
| denied/restricted pattern | 레지스트리 반입 대상 아님. 하네스 게이트 영역 |

이 원칙 때문에 초기 레지스트리 승인 목록이 비어 있을 수 있다. 그래서 MONITOR 시작과 매번 gvskb 호출이 더 중요하다.

## 6-2. 판정 신선도 비대칭 규칙

통과 방향과 차단 방향은 freshness를 다르게 적용한다.

| 방향 | 신선도 미달 | 재호출 실패 시 |
|---|---|---|
| 통과/허용 | 재호출 필요 | 통과시키지 않고 `unknown`/`error` 모드 규칙 적용 |
| 차단/불허 | 가능하면 재호출 | 오래된 차단 유지, `stale` 표기 |

즉, 느슨해지는 방향에는 최신 근거를 요구하고, 엄격해지는 방향에는 최신 근거가 없어도 기존 차단을 유지한다. 통과 방향 freshness 기준값은 기본 1시간이다. 특히 오래된 `registry_rejected`는 fresh한 비거절 판정이 나오기 전까지 계속 차단한다.

## 7. 조건부 승인과 무결성

체커나 레지스트리가 조건을 반환하면 하네스는 조건을 실제로 지킬 수 있을 때만 허용한다.

예시:

- 특정 버전 고정
- lockfile 필수
- 내부 미러만 사용
- `npm ci --ignore-scripts`
- 개발 전용 사용
- 외부 API 호출 금지
- 브라우저 직접 DB/외부 BaaS SDK 사용 금지

조건을 강제할 수 없으면 `needs-review` 또는 `block`으로 처리한다. 이름과 버전은 같은데 hash가 다르면 WARN/ENFORCE에서는 차단하고 담당자 검토로 보낸다.

## 8. 사용자에게 보여줄 메시지

필드가 늘어도 사용자 화면은 복잡해지면 안 된다. 공무원 사용자는 보안 필드를 읽으러 온 것이 아니라 코드를 만들러 온 것이다.

| 상황 | 사용자 화면 |
|---|---|
| 통과 | 아무 말도 하지 않음 |
| 차단 | 한 줄로 “무엇을 할 수 없고 무엇을 하면 되는지”만 제시 |
| 시스템 문제(레지스트리 도달 실패, 인텔/KEV 캐시 없음 등) | 일반 사용자에게 내부 필드명을 보여주지 않고 담당자/보고서 경로에 기록 |
| 판정 불가(`unknown`, `item_failed`) | 사용자에게 해석을 묻지 않고 mode에 따라 조용히 통과/경고/차단 |
| 우회 | 기관 정책이 허용할 때만 짧은 선택지로 제시 |

사용자에게 `kev_checked=false`, `intel_cache.state=missing`, `registry_status=item_failed`, `source_scope=installed` 같은 필드명을 노출하지 않는다. 이 정보는 `_workspace/vibecode-manifest.json`, 보안점검보고서, 담당자용 로그에 남긴다.

차단은 “안 됩니다”로 끝나면 안 된다. 사용자에게는 예를 들어 “이 패키지는 지금 확인할 수 없어 설치를 보류했습니다. 다른 승인 패키지를 쓰거나 담당자 검토를 요청하세요.”처럼 조치 중심으로 말한다.

## 9. 감사 메타데이터

체커가 지원하면 다음 값을 보낸다.

- `caller: harness:auto`
- `request_type: AUTO` 또는 `MANUAL`
- `project_id`
- `maturity_level`
- `env_grade`
- `track`
- `requested_package`

우회가 기관 정책상 허용되는 경우에는 자유문자 대신 구조화된 `override`를 남긴다.

```json
{
  "override": {
    "reason_code": "SECURITY_REVIEW_TICKET_OPENED",
    "approval_ref": "보안-2026-0173",
    "mode": "ENFORCE"
  }
}
```

`approval_ref`는 문서번호나 티켓번호여야 하며 사람 이름, 이메일, 사번을 넣지 않는다. `reason_code` 목록은 기관/레지스트리/체커 3자 합의에 맞춰 제한한다.

현재 사전 승인 reason_code는 다음 3종이다.

- `DEV_ONLY_NO_RUNTIME_USE`
- `OFFLINE_EVIDENCE_PENDING`
- `SECURITY_REVIEW_TICKET_OPENED`

허용목록 밖 reason_code는 우회 사실을 잃지 않기 위해 기록하되 경고 로그로 남긴다. 그러나 `approval_ref`에 이메일, IP, 개인 이름, 사번 등 개인식별자가 있으면 기록 자체를 거부한다.

다음은 보내지 않는다.

- 개인 이름
- 개인 이메일
- 사번
- 주민등록번호
- 비밀값
- private registry token

## 10. 한계

`scan_dependencies` 결과가 깨끗하다는 말은 “현재 룰과 데이터에서 차단 증거를 찾지 못했다”는 뜻이지 안전을 증명한다는 뜻이 아니다. 정확도는 취약점 DB, 악성 패키지 인텔리전스, 레지스트리 메타데이터, lockfile 품질, transitive dependency 가시성, 오프라인 캐시 신선도에 좌우된다.

하네스도 다음을 완전히 막을 수는 없다.

- 사용자가 하네스 패키지 게이트 밖 터미널에서 직접 `pip install` 또는 `npm install` 하는 행위
- 이미 설치된 패키지의 과거 사용
- 하네스를 우회하는 IDE/코딩 에이전트
- 사용자가 로컬 정책 파일을 임의 수정하는 행위

따라서 L2/L3/L4 이관 시에는 반드시 다시 체커 결과와 manifest evidence를 확인한다.
