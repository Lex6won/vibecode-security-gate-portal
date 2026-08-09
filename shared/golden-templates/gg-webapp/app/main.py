"""gg-webapp 표준 진입점. /health·보안헤더·base_path는 레일 — 변경 금지."""
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

from .config import settings
from .middleware import SecurityHeadersMiddleware
from .routers import items

BASE_DIR = Path(__file__).resolve().parent

# root_path = base_path 주입(하드코딩 금지). nginx가 /apps/<project>/ 로 프록시.
app = FastAPI(title=settings.app_name, root_path=settings.base_path)

app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(SessionMiddleware, secret_key=settings.session_secret or "dev-only-change-me")

# 정적자산은 self-host만(외부 CDN 금지)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")  # 자동 이스케이프(XSS 예방)

app.include_router(items.router)


@app.get("/health")
def health():
    """배포 게이트 필수 헬스체크. 제거 금지."""
    return {"status": "ok"}


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request, "app_name": settings.app_name})
