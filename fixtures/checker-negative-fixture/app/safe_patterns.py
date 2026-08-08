import html
import json
import re
import secrets
import shlex
import sqlite3
import subprocess
from pathlib import Path
from typing import Literal


BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
ALLOWED_REPORTS = {
    "weekly": BASE_DIR / "reports" / "weekly.txt",
    "monthly": BASE_DIR / "reports" / "monthly.txt",
}
ALLOWED_HOSTS = {"intranet.example.go.kr", "helpdesk.example.go.kr"}


def safe_parameterized_query(name: str):
    db = sqlite3.connect(str(BASE_DIR / "benefits.db"))
    rows = db.execute(
        "SELECT id, name, memo FROM benefits WHERE name = ?",
        (name,),
    ).fetchall()
    db.close()
    return rows


def safe_allowlisted_command(action: Literal["status", "version"]):
    commands = {
        "status": ["git", "status", "--short"],
        "version": ["git", "--version"],
    }
    return subprocess.run(commands[action], check=False, capture_output=True, text=True)


def safe_quoted_diagnostic(host: str):
    if not re.fullmatch(r"[A-Za-z0-9.-]{1,253}", host):
        raise ValueError("invalid host")
    command = "nslookup " + shlex.quote(host)
    return subprocess.run(command, shell=True, check=False, capture_output=True, text=True)


def safe_path_lookup(report_id: str):
    path = ALLOWED_REPORTS.get(report_id)
    if path is None:
        raise ValueError("unknown report")
    resolved = path.resolve()
    if not resolved.is_relative_to(BASE_DIR.resolve()):
        raise ValueError("outside base dir")
    return resolved.read_text(encoding="utf-8")


def safe_html_fragment(message: str):
    return "<p>" + html.escape(message, quote=True) + "</p>"


def safe_json_parse(raw: str):
    return json.loads(raw)


def safe_token():
    return secrets.token_urlsafe(32)


def safe_ai_prompt(case_text: str):
    redacted = re.sub(r"\d{6}-\d{7}", "[RRN-REDACTED]", case_text)
    redacted = re.sub(r"010-\d{4}-\d{4}", "[PHONE-REDACTED]", redacted)
    return {
        "system": "Summarize only non-sensitive civil service workflow notes.",
        "user": redacted,
    }


def safe_secret_reference():
    api_key = "${CIVIL_AI_API_KEY}"
    password = "${DB_PASSWORD}"
    return {"api_key_env": api_key, "password_env": password}


def safe_internal_url_reference():
    return "https://intranet.example.go.kr/helpdesk"
