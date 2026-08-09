# gg-dashboard (Track S · 내부 대시보드)

경기도 공공 바이브코딩 표준 골든 템플릿. **Streamlit** 기반 내부 현황·분석 대시보드.
**내부 한정** — 시민(외부망) 서비스에는 Track S 금지(`deploy-context.yaml`). 대민이면 gg-webapp/gg-spa로.

## 내장된 레일
- 런타임 고정: Python 3.12 / PostgreSQL 16
- 헬스체크: Streamlit `/_stcore/health` (nginx가 `/health`로 매핑)
- base_path: nginx `/apps/<project>/` 프록시 + WebSocket. `--server.baseUrlPath` 환경변수 주입
- 접근제어: Streamlit 자체 인증 없음 → **nginx 앞단 Keycloak 접근제어 필수**(내부 한정)
- 비밀값: `.env`/환경변수만. DB는 파라미터 바인딩
- 외부통신 금지: CDN·외부 API 없음. 개인정보 평문·실데이터 금지(더미)
- 승인 패키지만: streamlit·pandas·plotly·sqlalchemy·psycopg

## 실행 (L1)
```
cp .env.example .env
pip install -r requirements.txt
streamlit run app.py
```

## 확장
- 페이지 추가: `pages/` 디렉터리(Streamlit 멀티페이지).
- 데이터: SQLAlchemy 파라미터 바인딩으로 조회. 집계는 pandas.
- 차트는 plotly/matplotlib(self-host). 외부 차트 CDN 금지.
