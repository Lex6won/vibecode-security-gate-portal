# gg-spa — 프로젝트 AI 규칙 (골든 템플릿, Track B)

- React(Vite)+TS 정적 빌드. 산출물은 nginx가 서빙(보안헤더는 nginx), 데이터는 내부 API가 담당.
- **데이터 호출은 `src/lib/api.js` 한 곳으로만**(레일). 컴포넌트에서 직접 fetch/외부 SDK 호출 금지.
- 외부 BaaS(supabase-js·firebase) 직접 호출 금지 → 내부 API(FastAPI/Express)만.
- 외부 CDN 금지. 의존성은 승인 npm_frontend 카탈로그만. lockfile 필수, `npm ci --ignore-scripts`.
- base_path는 `vite.config.js`의 base(VITE_BASE)로 주입. 하드코딩 금지.
- 인증·DB·비밀값은 프런트에 두지 않는다(백엔드 API가 담당). 개인정보 브라우저 저장 금지.
- 검증은 게이트(security-checker/gvskb).
