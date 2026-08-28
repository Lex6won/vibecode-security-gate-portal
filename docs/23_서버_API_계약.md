# 서버 포털 API 계약 (2026-08-12 · 08-24 개정)

> **08-24 개정**: §1-A 인증(이메일 가입), §2-6 점검결과 제출, §2-7 보안성 검토 요청, §4-9 화이트리스트 관리가 추가되었다. §4-5 내보내기는 화이트리스트 저장으로 재해석된다.

> `22_서버기반_재설계.md`의 구현 계약. 이 문서대로 만들면 S1~S5가 완성된다.
> 공통: 모든 응답 `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
> 인증: 세션 쿠키(HttpOnly·Secure·SameSite=Strict) + 상태 변경 요청에 CSRF 토큰 헤더 `X-CSRF-Token`.

---

## 0. 공통 규약

### 오류 형식
```json
{ "error": "코드", "message": "공무원이 읽고 다음 행동을 알 수 있는 한 문장" }
```

| 상태 | 코드 | 의미 |
|---|---|---|
| 401 | `auth_required` | 로그인 필요 |
| 403 | `forbidden` | 남의 자원 접근 — **존재 여부를 알려주지 않기 위해 404와 구분하지 않는 경로도 있음**(§2-2) |
| 403 | `csrf_token_required` | CSRF 토큰 없음/불일치 |
| 409 | `busy` | 사용자당 동시 작업 1건 초과 |
| 413 | `upload_too_large` | 업로드 상한 초과 |
| 422 | `unsafe_archive` | 압축폭탄·경로탈출 등 사전검사 거부 |
| 429 | `rate_limited` | 요청 빈도 초과 |
| 503 | `capacity_exhausted` | 디스크 워터마크 초과로 신규 접수 중단 |

### 판정값 표기 원칙
`checked=false`, `registry_status≠ok`, `unknown`은 **안전이 아니라 "확인하지 못함"** 으로 응답에 그대로 실어 보낸다. 클라이언트가 초록불로 렌더링하지 못하도록 `confidence` 필드를 함께 준다.

---

## 1. 시스템

### `GET /health`
인증 불필요. 로드밸런서용.
```json
{ "status": "ok", "app": "vibecode-security-gate-portal", "version": "0.2.0" }
```

---

## 1-A. 인증 (2026-08-24 신설)

### `POST /api/auth/signup` — 일반 공무원 가입
```json
{ "email": "gg0018@gg.go.kr", "password": "…", "org_code": "6410000", "department_code": "AI산업육성과" }
```
- **기관 메일 도메인 허용 목록만** 받는다(그 외 422). 메일 소유 확인 링크 발송 후 활성화.
- 저장: 이메일 해시·기관·부서코드. 이름·연락처는 받지 않는다.
- B3(통합인증) 확정 시 로그인 수단만 교체되는 **임시 경로**다(22번 §4-4).

### `POST /api/auth/login` / `POST /api/auth/logout`
세션 쿠키(HttpOnly·Secure·SameSite=Strict) 발급/폐기. 연속 실패 잠금.

### 관리자 로그인 — 분리
`POST /api/admin/login` (기존). **일반 계정에 관리자 권한을 얹지 않는다.** 관리자 화면·API는 관리자 세션만 통과.

## 2. 검사 (공무원)

### 2-1. `POST /api/scans` — 업로드 + 검사 시작
`multipart/form-data`. **업로드가 유일한 입력 경로다**(로컬 경로 지정 없음).

| 필드 | 값 |
|---|---|
| `kind` | `folder` \| `archive` |
| `mode` | `quick`(간편점검) \| `standard`(표준점검) |
| `manifest` | JSON 배열 — 상대경로 목록 (`folder`일 때) |
| `file_0..N` | 파일 본문 |

제약: 요청당 500MB · 파일 1만 개 · **사용자당 동시 작업 1건**. `archive`는 ZIP 1개만, 해제 전 사전검사(해제 후 2GB·5만 항목·압축비 200배·경로탈출 거부).

**202 Accepted**
```json
{
  "scan_id": "uuid",
  "status": "queued",
  "queue_position": 3,
  "estimated_wait_seconds": 90,
  "poll_url": "/api/scans/uuid"
}
```

### 2-2. `GET /api/scans/{scan_id}` — 진행률·결과
**소유자만.** 타인 요청은 `404 not_found`로 응답한다(존재 여부 노출 방지).

진행 중:
```json
{
  "scan_id": "uuid", "status": "running", "mode": "standard",
  "percent": 62, "message": "체커가 코드와 의존성을 점검하고 있습니다. (2분 10초 경과)",
  "queue_position": null, "created_at": "2026-08-12T01:00:00Z"
}
```

완료:
```json
{
  "scan_id": "uuid", "status": "completed", "mode": "standard",
  "percent": 100,
  "decision": "needs_review",
  "confidence": "complete",
  "summary": {
    "scanned_file_count": 128, "finding_count": 3,
    "dependency_finding_count": 7, "package_observed_count": 188,
    "coverage_truncated": false, "dependency_incomplete": false,
    "profile_fallback": null
  },
  "reports": [
    { "file_name": "2026-08-12_1030_민원도우미_보안점검.html", "type": "html", "size": 184320,
      "url": "/api/scans/uuid/reports/2026-08-12_1030_민원도우미_보안점검.html" }
  ],
  "retention": { "expires_at": "2026-08-19T01:00:00Z", "policy": "보고서는 7일 후 자동 삭제됩니다." },
  "source_retained": false
}
```

- `decision`: `allow` \| `quick_complete` \| `needs_review` \| `blocked` \| `incomplete`
- `confidence`: `complete` \| `partial`(검사 잘림·의존성 미완) \| `unknown`. **`partial`/`unknown`은 안전 판정이 아니다.**
- `source_retained`: 항상 `false`. 원본을 보관하지 않았음을 응답으로 증명한다.

### 2-3. `GET /api/scans/{scan_id}/reports/{file_name}` — 다운로드
소유자만. 한글 파일명은 `Content-Disposition: attachment; filename*=UTF-8''…`.
**체커가 만든 파일을 그대로 전달한다.** 포털이 보고서를 재가공하지 않는다.

### 2-4. `GET /api/scans` — 내 검사 이력
```json
{ "scans": [ { "scan_id": "uuid", "mode": "standard", "status": "completed",
               "decision": "needs_review", "created_at": "…", "expires_at": "…" } ],
  "total": 12 }
```

### 2-5. `DELETE /api/scans/{scan_id}`
보고서와 메타데이터를 즉시 삭제한다. 이미 제출한 패키지 관측은 익명 집계로 남는다(그 사실을 응답에 명시).
```json
{ "status": "deleted", "note": "보고서를 삭제했습니다. 제출하신 패키지 통계는 익명 집계로만 남습니다." }
```

### 2-6. `POST /api/scans/{scan_id}/submit-observations` — 점검결과 제출 (2026-08-24 신설)
**opt-in.** 소유자만, 완료된 검사만. 서버가 보관 중인 해당 검사의 `dependency_audit.checks`에서 **허용목록 필드만** 추려 `package_observations`에 적재한다(부서코드 포함). 요청 본문 없음 — 클라이언트가 데이터를 만들지 않는다.
```json
{ "status": "submitted", "packages_recorded": 188,
  "note": "라이브러리 목록과 검사 결과만 제출되었습니다. 소스 코드는 포함되지 않습니다." }
```
- 중복 제출은 `409 already_submitted`. 검사 미완/실패는 `409 not_submittable`.
- **소스·경로·개인식별자는 어떤 필드로도 적재되지 않는다**(허용목록 스키마).

### 2-7. `POST /api/scans/{scan_id}/review-request` — 보안성 검토 요청 (2026-08-24 신설)
소유자만. 요청은 관리자 검토 대기열에 오른다.
```json
{ "note": "9월 배포 예정 민원 서비스입니다" }
```
**201** `{ "status": "requested", "review_id": "uuid" }`
- 상태 흐름: `requested → in_review → completed`(관리자 의견 첨부 가능). `GET /api/scans`(내 이력)에 상태가 실린다.
- 포털은 검토를 수행하지 않는다 — 접수와 상태 표시까지다.

---

## 3. 도구 버전 지원

### `GET /api/tools/versions`
```json
{
  "checker": {
    "server_version": "0.3.0",
    "latest_version": "0.3.1",
    "status": "update_available",
    "checked_at": "2026-08-12T01:00:00Z",
    "source": "official_release"
  },
  "harness": { "latest_version": "…", "status": "available" },
  "install_guide_url": "/help/install"
}
```
`status`: `current` \| `update_available` \| `check_unavailable`. **GitHub 조회 실패 시 `check_unavailable`이며 "최신"으로 표시하지 않는다.**

`checker.server_version`은 **서버에 설치된 체커**다. 사용자 PC의 설치 버전이 아니다 — 서버는 그것을 알 수 없다.

### `GET /api/tools/manager/latest` — 도구 관리자 배포 정보
```json
{ "version": "1.2.0", "released_at": "2026-08-12",
  "download_url": "/api/tools/manager/download?os=windows",
  "sha256": "9f3a…c71e", "size_bytes": 25165824, "signed": false }
```
`signed:false`이면 화면에 **"확인값으로 검증하세요"** 를 함께 띄운다. 코드서명(B2) 확보 후 `true`로 바뀐다.

### `GET /api/tools/manager/download?os=windows`
도구 관리자 설치 파일. 응답 헤더에 `X-Artifact-SHA256`.

### `GET /api/tools/support-matrix` — 도구별 지원 범위
사용자가 **"내가 쓰는 도구가 지원되나"** 를 먼저 확인하는 화면용.
```json
{ "tools": [
  { "key": "codex-cli", "label": "Codex CLI · VS Code 확장", "supported": true,
    "applies": ["하네스 지침", "MCP 연결"], "note": null },
  { "key": "claude-code", "label": "Claude Code", "supported": true,
    "applies": ["하네스 지침", "MCP 연결"], "note": null },
  { "key": "codex-desktop", "label": "ChatGPT · Codex 데스크톱", "supported": true,
    "applies": ["MCP 연결"], "note": "지침 파일 적용은 지원하지 않습니다." },
  { "key": "claude-desktop", "label": "Claude Desktop", "supported": true,
    "applies": ["MCP 연결"], "note": null },
  { "key": "lovable", "label": "Lovable", "supported": false,
    "applies": [], "note": "자동 연결을 지원하지 않습니다. 웹에서 올려 점검해 주세요." }
] }
```
> 이 화면의 선택은 **안내용**이다. 실제 적용 대상은 설치기가 PC에서 **감지한 결과**로 정한다.

### `POST /api/tools/enroll-token` — 일회용 등록 토큰 (로그인 필요)
설치 파일을 내려받을 때 함께 발급한다. 설치기가 최초 1회 자기를 등록할 때 쓴다.
```json
{ "enroll_token": "…", "expires_in_seconds": 604800 }
```

### `POST /api/tools/clients/report` — 설치기 상태 보고
**설치기(PC 프로그램)가 서버로 보낸다.** 브라우저는 이 경로를 부르지 않는다. 로컬→서버 아웃바운드이므로 D1 원칙에 저촉되지 않는다.

최초 등록은 `enroll_token`으로, 이후 갱신은 발급받은 `client_id`로 한다.
```json
{ "enroll_token": "…",
  "os_name": "Windows 11",
  "manager_version": "1.2.0",
  "checker_version": "0.3.0",
  "harness_commit": "a4c19f2",
  "tools": { "codex-cli": "connected", "claude-code": "connected",
             "claude-desktop": "not_installed", "codex-desktop": "detected_not_connected" } }
```
**받는 항목은 위가 전부다.** 파일 경로·프로젝트 이름·소스·사용자 이름·PC 이름은 받지 않으며, 오면 무시한다. 저장은 `client_installations` 테이블.

**201**
```json
{ "client_id": "uuid", "status": "enrolled",
  "latest": { "checker": "0.3.1", "harness": "a4c19f2", "manager": "1.2.0" } }
```
응답에 최신 버전을 실어 설치기가 곧바로 비교할 수 있게 한다.

### `GET /api/tools/my-status` — 내 PC 상태 (로그인 필요)
설치기가 보고한 내용을 포털 화면에 보여 준다. **보고가 없으면 아무것도 모른다는 사실을 정직하게 응답한다.**
```json
{ "enrolled": true, "last_reported_at": "2026-08-13T01:38:00Z",
  "checker": { "installed": "0.3.0", "latest": "0.3.1", "status": "update_available" },
  "harness": { "installed": "a4c19f2", "latest": "a4c19f2", "status": "current" },
  "tools": { "codex-cli": "connected", "claude-code": "connected", "claude-desktop": "not_installed" } }
```
미등록이면 `{ "enrolled": false, "note": "도구 관리자를 설치하면 이 자리에 내 PC 상태가 표시됩니다." }`.

> **서버는 스스로 PC를 조사하지 않는다.** 여기 보이는 모든 값은 설치기가 보고한 것이며, 보고가 끊기면 `last_reported_at`이 낡은 채로 남는다. 화면은 **낡은 값을 최신인 것처럼 보여주지 않는다**(3일 이상 미보고 시 "확인된 지 오래됨" 표시).

---

## 4. 관리자 — 패키지 화이트리스트 근거

전 경로 관리자 인증 필수. 모든 조회는 `audit_logs`에 남는다.

### 4-1. `GET /api/admin/packages/candidates` — 화이트리스트 후보
쿼리: `ecosystem`, `min_departments`, `limit`, `offset`
```json
{
  "candidates": [
    { "ecosystem": "npm", "package_name": "busboy", "latest_version": "1.6.0",
      "department_count": 7, "project_count": 23, "observation_count": 41,
      "manifest_count": 12,
      "license": "MIT", "install_scripts": "none", "deprecated": false,
      "first_observed_at": "2026-06-02T…", "last_observed_at": "2026-08-11T…",
      "decision": null }
  ],
  "total": 312,
  "note": "판정이 없고 위험 신호도 없는 패키지입니다. 사용 부서가 많은 순으로 정렬했습니다."
}
```
**정렬 기본값: 사용 부서 수 → 프로젝트 수 → 관측 수.** 위에서부터 승인할수록 커버리지가 빨리 오른다.

### 4-2. `GET /api/admin/packages/risky` — 문제 패키지
`vulnerable`·`malicious`·`not_found`·`deprecated`·`install_scripts` 있음·타이포스쿼팅 의심.
```json
{
  "packages": [
    { "ecosystem": "npm", "package_name": "…", "package_version": "…",
      "risk": ["vulnerable"], "max_cve": "HIGH",
      "in_kev": false, "kev_checked": true,
      "vulnerability_count": 2, "affected_project_count": 4,
      "decision": "rejected", "decision_age_days": 3 }
  ]
}
```
`kev_checked=false`면 `in_kev`는 **"대조 못 함"** 이므로 UI에서 "악용 없음"으로 표시하지 않는다.

### 4-3. `GET /api/admin/packages/{ecosystem}/{name}` — 상세
버전별 관측, 부서 분포, `source_scope` 분포, 취약점 이력, 판정 이력.

### 4-4. `GET /api/admin/packages/coverage` — 판정 현황
```json
{
  "observed_packages": 1840, "decided_packages": 214,
  "coverage_percent": 11.6,
  "approved": 198, "rejected": 16,
  "stale_approvals": 3, "stale_rejections": 1,
  "review_queue_size": 47,
  "note": "심사 대기열에는 직접 선언한 패키지(manifest)만 오릅니다."
}
```

### 4-5. `POST /api/admin/packages/export` — 화이트리스트 후보 내보내기
```json
{ "scope": "candidates", "ecosystem": "pypi",
  "format": "requirements", "package_names": ["openpyxl", "python-dateutil"] }
```
`format`은 넷 중 하나다. 검토 목록에 그치지 않고 **기본 이미지 빌드에 바로 투입**할 수 있어야 한다.

| `format` | 산출물 |
|---|---|
| `requirements` | `openpyxl==3.1.5` 형태의 버전 고정 목록(PyPI) |
| `package_json` | `dependencies` 블록(npm, 버전 고정) |
| `proxy_allowlist` | 사내 저장소 프록시 허용 규칙 |
| `review_csv` / `review_json` | 사람이 검토·결재에 붙이는 표 |

모든 형식에 **소스·파일 경로·개인식별자를 포함하지 않는다**(허용목록 스키마). 망중계로 행정망 전달 가능한 형태로 낸다.

### 4-9. 화이트리스트 관리 (2026-08-24 신설 — 08-13 "내보내기만" 결정을 갱신)

관리자(보안담당) 전용. 모든 변경은 `package_decisions`에 누가·언제·왜로 기록된다.

- `POST /api/admin/whitelist/entries` — 후보를 화이트리스트에 담는다 `{ "ecosystem", "package_name", "package_version", "reason" }`
- `DELETE /api/admin/whitelist/entries/{ecosystem}/{name}` — 제외(사유 필수, 이력은 삭제 아닌 대체 기록)
- `GET /api/admin/whitelist` — 현재 화이트리스트 조회
- `GET /api/admin/whitelist/export?format=requirements|package_json|proxy_allowlist|review_csv` — **저장(다운로드)**. 이 파일이 기본 이미지에 반영된다. 버전 고정, 소스·경로·개인정보 미포함.

### 4-10. `GET /api/admin/review-requests` — 보안성 검토 대기열 (2026-08-24 신설)
요청 목록(검사 메타·요청자 부서·상태). `PATCH /api/admin/review-requests/{id}` 로 `in_review`/`completed` 전환과 의견 첨부. 완료 시 요청자의 내 이력에 반영된다.

### 4-6. `POST /api/admin/decisions/import` — 판정 반입
보안부서가 내린 승인/차단 결과를 반입한다. **서명 검증 후에만 적용**하며, 검증 실패 시 전량 거부한다(부분 적용 금지).
```json
{ "applied": 42, "rejected": 0, "signature": "verified",
  "note": "포털은 판정하지 않습니다. 보안부서 판정을 반영만 합니다." }
```

### 4-7. `GET /api/admin/scans` — 검사 현황(메타데이터)
집계와 메타데이터만. **타인의 보고서 본문은 기본 비열람.**

### 4-8. `GET /api/admin/health` — 운영 상태
```json
{ "queue": { "running": 2, "waiting": 5, "limit": 4 },
  "disk": { "work_area_used_percent": 41, "watermark_percent": 85 },
  "checker": { "version": "0.3.0", "doctor_status": "warn" },
  "retention": { "reports_pending_deletion": 12 } }
```

---

## 5. 구현 시 반드시 지킬 것

### 5-0. 역할 경계 (최우선)

- **판정은 체커가 한다.** 포털은 `decision`을 **더 보수적인 쪽으로만** 바꿀 수 있다.
  허용: `allow` → `incomplete`(검사 잘림·의존성 미완). **금지: `needs_review`/`blocked` → `allow`.**
  판정을 낮춘 경우 응답에 이유를 함께 싣는다(`confidence`, `summary.coverage_truncated` 등).
- **보고서는 체커 산출물을 그대로 전달한다.** 포털이 재생성·재가공하지 않는다.
- **포털은 승인·차단을 만들지 않는다.** 화이트리스트 판정은 보안부서 소관이며, 포털은 근거 축적과 결과 표시만 한다.
- **PC 조작은 하네스가 한다.** 서버 API는 사용자 PC를 조작하는 어떤 경로도 제공하지 않는다.

1. **소유자 검증을 UUID 추측 불가성으로 대체하지 않는다.** 모든 검사 자원 접근에 세션 사용자와 대조한다.
2. **검사 종료 시 업로드본 삭제를 보장한다.** 성공·실패·타임아웃·강제종료 후 재기동 어느 경로로도 남지 않아야 한다.
3. **포털은 판정하지 않는다.** 승인/차단은 보안부서 판정을 표시·반입할 뿐이다.
4. **심사 대기열에는 `single`·`manifest`만 올린다.** `lockfile`·`installed`는 관측만 축적한다.
5. **"확인 못 함"을 "안전"으로 바꾸지 않는다.** `confidence`, `kev_checked`, `registry_status`를 응답에서 생략하지 않는다.
6. **큐 상한 없이 체커를 실행하지 않는다.**
7. **응답·로그·DB에 소스 조각과 로컬 전체 경로를 넣지 않는다.**

---

## 추기 (2026-08-28) — P3 구현 확정 (실구현 기준)

하네스팀 연동합의(28번)에 따라 P3를 구현하며 확정된 실제 계약. 본문과 다른 부분은 이 추기가 우선한다.

**인증 (매직링크, 비밀번호 없음)**
- `POST /api/auth/request-link` `{email, organization?, department?}` — 도메인 허용목록(기본 gg.go.kr·korea.kr, `PORTAL_ALLOWED_EMAIL_DOMAINS`) 검사. 신규 가입은 기관명·부서명 필수(`registration_required`). 이메일당 15분 5회 제한(429). 개발 모드(`PORTAL_AUTH_MODE`≠smtp)는 `dev_login_url` 을 응답에 실어 화면에 표시한다 — SMTP 확정 시 발송 어댑터로 교체.
- `GET /auth/complete?token=` — 1회용·15분 만료. 성공 시 `portal_session` HttpOnly 쿠키(12h) 발급 후 `/scan` 으로. 실패 시 `/scan?auth=expired`.
- `GET /api/auth/session` / `POST /api/auth/logout` / `POST /api/auth/profile` `{organization, department}` (변경 이력 기록).
- 계정 저장: `src/account-store.mjs` (파일 기반, 이메일 평문 — 링크 발송에 필요. DB 전환 시 함수만 교체). 감사 로그 `auth-audit.jsonl`.

**소유자 검증**
- `/api/scan/{id}/progress·result`, `/reports/{file}` — 소유자 또는 관리자만. 그 외 **404**(존재 여부 비공개). 점검 시작·업로드는 로그인 필수(401). 소유자 없는 과거 기록은 관리자 전용.
- 사용자당 동시 점검 1건(`PORTAL_USER_CONCURRENT_SCANS`) 초과 시 409 `user_scan_limit`.
- 점검 생성 시 기관·부서 **스냅샷** 저장 — 이후 프로필 변경에 불변.

**관측 자동 적재 (P2 개정)**
- `POST /api/scan/{id}/submit-observations` **제거(404)**. 완료 시 서버가 자동 적재하고 `observations_submitted_at` 로 표시. 시작 화면이 "서버에 남는 것/남지 않는 것" 을 고지한다. 관측 레코드의 department 는 점검 시점 부서명 스냅샷.

**내 이력·보안성검토 요청**
- `GET /api/my/scans` — 본인 것만. `target_name`(본인 라벨)·`review_request` 포함.
- `POST /api/scan/{id}/request-review` — 완료된 본인 점검만, 중복 409. 요청서 문서 생성(HWPX)은 양식 확정 후 별도.
- 관리자: `GET /api/admin/review-requests`(대기열), summary 에 `accounts`·`pending_review_requests` 추가.

**화면**: `/my`(내 점검 이력·프로필 수정), `/scan` 로그인 게이트(이메일+기관·부서, 개발 모드 링크 표시), 결과 카드 "점검 후 처리"(자동 반영 표시 + 검토 요청 버튼). 메인에 "내 점검 이력" 진입점.

## 추기 (2026-08-28) — P4 구현 확정 (관리자 화이트리스트 근거)

- `GET /api/admin/packages` — 관측 집계 목록(관측 수·부서 수·버전·위험 신호·목록 상태). 응답 note 에 "승인·차단이 아니다"를 명시.
- `POST /api/admin/whitelist` `{ecosystem, package_name, action: include|exclude|reset, reason?}` — **관측 이력 있는 패키지만**(404 `package_not_observed`). 모든 변경은 이전 상태와 함께 감사 기록(whitelist-audit.jsonl). 감사 기록 실패 시 변경 자체를 중단.
- `GET /api/admin/whitelist/export` — 다운로드(JSON). **패키지 식별 정보만** 싣는다: 부서명·이메일·프로젝트 라벨 미포함(회귀 검사로 강제). 내보내기도 감사 기록. 4형식(requirements 등)은 S6(망중계 규격 대기).
- `GET /api/admin/summary` 확장: `queue{running,waiting,limit}`·`disk_free_bytes`·`whitelist{included,excluded}`.
- 저장층 `src/whitelist-store.mjs`(파일 어댑터, `PORTAL_WHITELIST_DIR`). **검사·판정 경로는 이 저장소를 읽지 않는다** — 역할 경계(27번) 구조적 보장.
- 화면(admin.html): 서버 상태 줄(큐·디스크·계정·검토 대기) + 패키지 근거 표(필터: 전체/위험 신호/담김, 담기·제외·해제, 근거 저장 버튼) + 보안성검토 요청 대기열 표.
