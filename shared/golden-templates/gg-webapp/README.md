# gg-webapp (Track A · 기본형)

경기도 공공 바이브코딩 표준 골든 템플릿. **Python 3.12 + FastAPI + Jinja2/HTMX** 내부 업무 웹앱의 기준 구조.
gg-platform-coder는 **이 구조 안에서만** 기능을 추가한다(임의 확장 금지).

## 내장된 레일 (건드리지 말 것)
- **런타임 고정**: Python 3.12, PostgreSQL 16 (`runtime-env.yaml`)
- **`/health`**: 헬스체크 엔드포인트 (배포 필수)
- **base_path**: `/apps/<project>/` — `APP_BASE_PATH` 환경변수로 주입, 하드코딩 금지
- **보안 헤더**: HSTS·X-Frame-Options·CSP 등 미들웨어 기본 적용
- **비밀값**: `.env`/환경변수만. 코드 리터럴 금지. `.env.example`만 커밋
- **DB 접근**: SQLAlchemy 파라미터 바인딩만 (문자열 조립 쿼리 금지 → SQLi 예방)
- **인증**: Keycloak OIDC (`app/auth.py`). 직접 구현 금지
- **외부통신 금지**: CDN·외부 API 없음. 정적자산 self-host(`app/static/`)
- **승인 패키지만**: `requirements.txt`는 `approved-packages.yaml` 카탈로그 내에서만

## 실행 (로컬 시제품 L1)
```
cp .env.example .env        # 값 채우기 (실개인정보 금지, 더미만)
pip install -r requirements.txt
uvicorn app.main:app --reload
# http://localhost:8000/health , /apps/gg-webapp/
```

## 확장 방법
- 새 화면: `app/routers/`에 라우터 추가 + `app/templates/`에 템플릿.
- DB 테이블: SQLAlchemy 모델 추가, 개인정보 컬럼은 red 패턴 회피·더미.
- 기능은 1개씩. 표준을 벗어나야 풀리는 요구는 platform-architect에 설계 조정 요청.

## 배포 (L3+)
`Dockerfile`은 `FROM gg-python-web:3.12`(내부 Harbor) 기준. 반입 시 소스+Dockerfile만.
`tests/test_smoke.py`가 `/health`를 확인. 배포 산출물은 gg-release/gg-submit이 생성.
