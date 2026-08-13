# 서버 포털 API 계약 (2026-08-12)

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
보고서와 메타데이터를 즉시 삭제한다. 패키지 관측은 이미 익명 집계로 넘어갔으므로 남는다(그 사실을 응답에 명시).
```json
{ "status": "deleted", "note": "보고서를 삭제했습니다. 패키지 사용 통계는 익명 집계로만 남습니다." }
```

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

### `GET /api/tools/install-script?target=harness|checker&os=windows`
사용자가 자기 PC에서 실행할 설치 스크립트를 내려준다(§22-7 A안). 응답 헤더에 `X-Script-SHA256`을 실어 무결성 확인이 가능하게 한다.

> 서버는 사용자 PC에 설치하지 않는다. 설치 여부 확인 방식(A/B/C)은 미확정 — `22_서버기반_재설계.md` §9-3.

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

### 4-5. `POST /api/admin/packages/export` — 보안부서 검토용 내보내기
```json
{ "scope": "candidates", "ecosystem": "npm", "limit": 200 }
```
→ 서명된 JSON 번들. 망중계로 행정망 전달 가능한 형태. **소스·경로·개인식별자 미포함**(허용목록 스키마).

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

1. **소유자 검증을 UUID 추측 불가성으로 대체하지 않는다.** 모든 검사 자원 접근에 세션 사용자와 대조한다.
2. **검사 종료 시 업로드본 삭제를 보장한다.** 성공·실패·타임아웃·강제종료 후 재기동 어느 경로로도 남지 않아야 한다.
3. **포털은 판정하지 않는다.** 승인/차단은 보안부서 판정을 표시·반입할 뿐이다.
4. **심사 대기열에는 `single`·`manifest`만 올린다.** `lockfile`·`installed`는 관측만 축적한다.
5. **"확인 못 함"을 "안전"으로 바꾸지 않는다.** `confidence`, `kev_checked`, `registry_status`를 응답에서 생략하지 않는다.
6. **큐 상한 없이 체커를 실행하지 않는다.**
7. **응답·로그·DB에 소스 조각과 로컬 전체 경로를 넣지 않는다.**
