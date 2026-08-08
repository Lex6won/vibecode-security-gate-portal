# 포털 구현 소스 위치

이 폴더는 향후 실제 보안체커 포털 구현 소스를 두는 위치입니다.

현재 `fixtures/checker-negative-fixture`에 있는 코드는 포털 구현체가 아니라 체커 검증용 취약 샘플입니다.

권장 1차 구현:

- Python FastAPI 로컬 백엔드
- 정적 HTML/CSS/JS 또는 가벼운 프론트엔드
- `vibecode-checker/gvskb` CLI 또는 MCP 호출
- 로컬 파일 선택은 데스크톱 앱 런타임 또는 로컬 백엔드에서 처리
- 결과 DB는 SQLite로 시작하고, 기관 포털 확장 시 PostgreSQL로 전환

필수 API 초안:

- `GET /api/local/status`
- `POST /api/scan/start`
- `GET /api/scan/{id}/progress`
- `GET /api/scan/{id}/result`
- `POST /api/report/package`
- `POST /api/update/preview`
- `POST /api/update/apply`
