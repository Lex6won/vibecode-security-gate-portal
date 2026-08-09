"""예시 라우터. 새 화면은 이 패턴을 복제해 추가한다.

SQLAlchemy ORM/파라미터 바인딩만 사용 — 문자열 조립 쿼리 금지(SQLi 예방 레일).
개인정보 컬럼 평문 저장 금지 — 여기 item은 더미(업무 메모) 예시.
"""
from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates
from pathlib import Path
from sqlalchemy import Column, Integer, String, select
from sqlalchemy.orm import Session

from ..db import Base, engine, get_db

router = APIRouter(prefix="/items", tags=["items"])
templates = Jinja2Templates(directory=Path(__file__).resolve().parent.parent / "templates")


class Item(Base):
    __tablename__ = "items"
    id = Column(Integer, primary_key=True)
    title = Column(String(200), nullable=False)


Base.metadata.create_all(bind=engine)


@router.get("")
def list_items(request: Request, db: Session = Depends(get_db)):
    # 파라미터 바인딩 쿼리(문자열 조립 아님)
    rows = db.execute(select(Item).order_by(Item.id.desc())).scalars().all()
    return templates.TemplateResponse("items.html", {"request": request, "items": rows})


@router.post("")
def create_item(title: str = Form(...), db: Session = Depends(get_db)):
    db.add(Item(title=title))  # ORM 바인딩 — 이스케이프/파라미터화 자동
    db.commit()
    return RedirectResponse(url="items", status_code=303)
