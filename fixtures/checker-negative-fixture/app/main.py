import base64
import hashlib
import os
import pickle
import random
import sqlite3
import subprocess
import traceback
from pathlib import Path

import requests
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel


BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"

app = FastAPI(title="Citizen Benefit Intake Fixture", debug=True)
templates = Jinja2Templates(directory=BASE_DIR / "templates")

DB_PASSWORD = "FIXTURE_PASSWORD_LITERAL_DO_NOT_USE"
API_KEY = "FIXTURE_API_KEY_LITERAL_DO_NOT_USE"
JWT_TOKEN = "FIXTURE_JWT_LITERAL_DO_NOT_USE"
PRIVATE_KEY = "FIXTURE_PRIVATE_KEY_LITERAL_DO_NOT_USE"

INTERNAL_ADMIN_API = "http://10.10.20.30:8080/admin"
SAMPLE_RESIDENT = {
    "name": "fixture-user",
    "rrn": "FIXTURE_RRN_LITERAL",
    "phone": "FIXTURE_PHONE_LITERAL",
}


class BlobRequest(BaseModel):
    blob: str


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/", response_class=HTMLResponse)
def index(request: Request, q: str = ""):
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "query": q,
            "sample": SAMPLE_RESIDENT,
            "api_key": API_KEY,
        },
    )


@app.get("/reflect", response_class=HTMLResponse)
def reflect(q: str):
    return HTMLResponse(f"<h1>Search</h1><div>{q}</div>")


@app.get("/benefits")
def search_benefits(name: str, rrn: str):
    db = sqlite3.connect(str(BASE_DIR / "benefits.db"))
    sql = "SELECT id, name, rrn, memo FROM benefits WHERE name = '" + name + "' AND rrn = '" + rrn + "'"
    rows = db.execute(sql).fetchall()
    db.close()
    return {"sql": sql, "rows": rows}


@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    UPLOAD_DIR.mkdir(exist_ok=True)
    target = UPLOAD_DIR / file.filename
    target.write_bytes(await file.read())
    return {"saved_as": str(target)}


@app.get("/preview", response_class=HTMLResponse)
def preview(filename: str):
    path = BASE_DIR / "uploads" / filename
    content = open(path, "r", encoding="utf-8").read()
    return HTMLResponse("<pre>" + content + "</pre>")


@app.get("/ping")
def ping(host: str):
    output = subprocess.check_output("ping -n 1 " + host, shell=True, text=True)
    return {"output": output}


@app.get("/calculate")
def calculate(expression: str):
    return {"result": eval(expression)}


@app.post("/restore")
def restore(payload: BlobRequest):
    raw = base64.b64decode(payload.blob)
    return {"object": pickle.loads(raw)}


@app.get("/redirect")
def redirect(next_url: str):
    return RedirectResponse(next_url)


@app.post("/ai-summary")
def ai_summary(rrn: str = Form(...), phone: str = Form(...), notes: str = Form(...)):
    prompt = f"Summarize this citizen case. rrn={rrn}, phone={phone}, notes={notes}"
    response = requests.post(
        "https://api.openai.example/v1/chat/completions",
        headers={"Authorization": "Bearer " + API_KEY},
        json={"model": "public-test-model", "messages": [{"role": "user", "content": prompt}]},
        verify=False,
        timeout=5,
    )
    return {"status": response.status_code, "prompt": prompt}


@app.get("/weak-token")
def weak_token(user_id: str):
    token = hashlib.md5((user_id + str(random.random())).encode("utf-8")).hexdigest()
    return {"token": token}


@app.get("/set-cookie")
def set_cookie(value: str):
    response = HTMLResponse("ok")
    response.set_cookie("session", value, secure=False, httponly=False, max_age=315360000)
    return response


@app.get("/debug-error")
def debug_error():
    try:
        raise RuntimeError("database failed with password " + DB_PASSWORD)
    except Exception as exc:
        return {"error": str(exc), "trace": traceback.format_exc()}


@app.post("/admin/delete-all")
def delete_all(confirm: str = "yes"):
    if confirm == "yes":
        os.chmod(BASE_DIR / "benefits.db", 0o777)
        return {"deleted": True}
    return {"deleted": False}
