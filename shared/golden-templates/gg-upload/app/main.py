import os
from pathlib import Path
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

APP_NAME = os.getenv("APP_NAME", "gg-upload")
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "10"))
ALLOWED_EXTENSIONS = {x.strip().lower() for x in os.getenv("ALLOWED_EXTENSIONS", ".csv,.xlsx,.pdf,.txt").split(",")}

app = FastAPI(title=APP_NAME)
templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))


@app.middleware("http")
async def _security_headers(request, call_next):
    # 보안헤더 레일(제거·약화 금지). 외부 CDN 금지 → self 출처만.
    resp = await call_next(request)
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Content-Security-Policy"] = "default-src 'self'; object-src 'none'; frame-ancestors 'none'"
    resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return resp

@app.get("/health")
def health():
    return {"status": "ok", "service": APP_NAME}

@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request, "allowed": sorted(ALLOWED_EXTENSIONS)})

@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="허용되지 않은 파일 형식입니다.")
    data = await file.read(MAX_UPLOAD_MB * 1024 * 1024 + 1)
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail="파일 크기 제한을 초과했습니다.")
    return {"accepted": True, "size": len(data), "extension": suffix}
