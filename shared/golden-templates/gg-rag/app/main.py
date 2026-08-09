import os
from pathlib import Path
from fastapi import FastAPI
from pydantic import BaseModel, Field

APP_NAME = os.getenv("APP_NAME", "gg-rag")
DOC_DIR = Path(os.getenv("DOC_DIR", "./docs"))
app = FastAPI(title=APP_NAME)


@app.middleware("http")
async def _security_headers(request, call_next):
    # 보안헤더 레일(제거·약화 금지).
    resp = await call_next(request)
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Content-Security-Policy"] = "default-src 'self'; object-src 'none'; frame-ancestors 'none'"
    resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return resp

# 주의(레일): 현재는 외부 LLM 없는 로컬 텍스트 검색만. LLM 연동은 행정망에서
# 직접 호출 금지 → 망연계/내부 sLLM + 프롬프트 인젝션 방어(신뢰경계 분리) 전제로만 승격.

class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=100)

@app.get("/health")
def health():
    return {"status": "ok", "service": APP_NAME}

@app.post("/search")
def search(req: SearchRequest):
    results = []
    if DOC_DIR.exists():
        for path in DOC_DIR.glob("*.txt"):
            text = path.read_text(encoding="utf-8", errors="ignore")
            if req.query.lower() in text.lower():
                results.append({"file": path.name, "preview": text[:160]})
    return {"query": req.query, "results": results[:10]}
