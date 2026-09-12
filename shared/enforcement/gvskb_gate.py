#!/usr/bin/env python3
"""
Codex public-sector package gate for vibecode-checker(gvskb).

Purpose:
- Check newly added Python/npm packages before installation.
- Keep daily development lightweight.
- Do not create extra final submission documents; final release reporting still belongs
  to vibecode-checker full scans.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


EXIT_PASS = 0
EXIT_WARN = 1
EXIT_BLOCK = 2
EXIT_USAGE = 64
EXIT_NOT_INSTALLED = 65

VALID_MODES = {"MONITOR", "WARN", "ENFORCE"}
VALID_ECOSYSTEMS = {"pypi", "npm"}

# 기관 프로파일이 쓰는 실행환경 등급 전체.
VALID_ENV_GRADES = ("E0", "E1", "E2", "E3")

# 체커(gvskb)가 **실제로 판정할 수 있는** 등급.
#
# 체커는 E3 를 의도적으로 받지 않는다 — MCP 도구 정의에 그렇게 적혀 있다:
# "E3(대민·개인정보)는 바이브코딩 대상이 아니므로 받지 않음". CLI 도 `--env`
# choices 를 E0~E2 로 제한한다.
#
# 문제는 이 게이트가 CLI·MCP 가 아니라 **파이썬 함수를 직접 호출**한다는 점이다
# (import_checker). 두 경계의 문지기를 모두 지나치므로 E3 가 그대로 들어갔고,
# 체커는 모르는 등급을 조용히 기본값(E1, 개인 PC)으로 바꿔 쿨다운을 적용하면서
# 결과 최상위에는 전달받은 "E3" 를 그대로 적었다. 그래서 한 문서 안에서
# "E3 로 점검함"과 "E1 쿨다운 적용"이 공존했다 — 대민 서비스를 개인 PC 기준으로
# 검사해 놓고 기록만 대민으로 남는 상태다.
#
# 검사를 느슨하게 하고 기록을 세게 남기는 것보다, **자동 판정을 거부하고
# 사람 심사로 넘기는 것**이 맞다. 기관 프로파일도 같은 말을 한다:
# "E2/E3 package auto-approval is not allowed; human/platform review is required."
CHECKER_SUPPORTED_ENV_GRADES = ("E0", "E1", "E2")

# 검사 결과가 깨끗해도 **자동 설치를 허용하지 않는** 등급.
#
# 기관 정책이 두 문서에 명시돼 있다:
#   institution-profile.yaml:46
#     "E2/E3 package auto-approval is not allowed; human/platform review is required."
#   references/harness-enforcement-contract.yaml (environment_grades.E2)
#     auto_approval_possible: false / requires_human_review: true
#
# E3 는 체커가 판정 자체를 못 하므로 위 `env_grade_block` 에서 먼저 끝난다.
# 여기서 다루는 것은 **체커가 정상 판정할 수 있는 E2**다 — 검사는 정상 수행하고,
# 결과가 깨끗하더라도 마지막에 사람 확인을 요구한다. "위험해서 막는 것"이 아니라
# "내부 서버·공용 환경에 새 외부 패키지가 들어오는 순간은 사람이 한 번 본다"는
# 절차이므로, 사유 문구도 그렇게 쓴다.
HUMAN_REVIEW_ENV_GRADES = ("E2",)

# 사람 검토가 **이미 끝난** 것으로 볼 수 있는 근거.
#
# 기관 승인 목록에 있거나 레지스트리가 이 버전을 승인했다면 그 승인이 곧 사람
# 검토 결과다. 여기서 한 번 더 막으면 승인 목록이 무의미해지고, 무의미한 게이트는
# 우회되거나 꺼진다. 같은 정책 문서의 다른 규칙과도 이렇게 해야 앞뒤가 맞는다:
#   references/harness-enforcement-contract.yaml (local_catalog_and_registry_priority)
#     "If local allow and checker returns registry_approved/checked_clean, pass."
PRIOR_REVIEW_CATALOG_STATUSES = ("local_approved",)
PRIOR_REVIEW_CHECKER_VERDICTS = ("registry_approved",)


def shared_root() -> Path:
    return Path(__file__).resolve().parents[1]


def load_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        import yaml  # type: ignore
    except Exception:
        return {}
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def normalize_name(name: str) -> str:
    return name.strip().lower().replace("_", "-")


def normalize_ecosystem(ecosystem: str) -> str:
    eco = ecosystem.strip().lower()
    if eco == "python":
        return "pypi"
    if eco in {"javascript", "node", "nodejs"}:
        return "npm"
    return eco


def default_mode(profile: dict[str, Any]) -> str:
    env_mode = os.environ.get("GVSKB_GATE_MODE", "").strip().upper()
    if env_mode in VALID_MODES:
        return env_mode
    mode = (
        profile.get("harness_enforcement", {})
        .get("default_mode", "MONITOR")
    )
    mode = str(mode).strip().upper()
    return mode if mode in VALID_MODES else "MONITOR"


def default_env_grade(profile: dict[str, Any]) -> str:
    env_grade = os.environ.get("GVSKB_GATE_ENV_GRADE", "").strip().upper()
    if env_grade:
        return env_grade
    defaults = profile.get("harness_enforcement", {}).get("env_grade_defaults", {})
    if os.environ.get("CI"):
        return str(defaults.get("internal_server_or_ci", "E2")).upper()
    return str(defaults.get("personal_pc_harness", "E1")).upper()


def listify(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def package_list_to_set(items: list[Any]) -> set[str]:
    result: set[str] = set()
    for item in items:
        if isinstance(item, str):
            result.add(normalize_name(item))
        elif isinstance(item, dict):
            name = item.get("name") or item.get("package")
            if name:
                result.add(normalize_name(str(name)))
    return result


def collect_catalog(profile: dict[str, Any]) -> dict[str, dict[str, set[str]]]:
    root = shared_root()
    approved = load_yaml(root / "references" / "approved-packages.yaml")
    denied = load_yaml(root / "references" / "package-denylist.yaml")
    libraries = profile.get("libraries", {}) if isinstance(profile.get("libraries"), dict) else {}

    catalog = {
        "pypi": {"approved": set(), "restricted": set(), "denied": set()},
        "npm": {"approved": set(), "restricted": set(), "denied": set()},
    }

    py = approved.get("python", {}) if isinstance(approved.get("python"), dict) else {}
    catalog["pypi"]["approved"].update(package_list_to_set(listify(py.get("core"))))
    catalog["pypi"]["restricted"].update(package_list_to_set(listify(py.get("restricted"))))

    for section_name in ("npm_frontend", "npm_backend"):
        section = approved.get(section_name, {}) if isinstance(approved.get(section_name), dict) else {}
        catalog["npm"]["approved"].update(package_list_to_set(listify(section.get("core"))))
        catalog["npm"]["restricted"].update(package_list_to_set(listify(section.get("restricted"))))

    denied_packages = denied.get("denied_packages", {}) if isinstance(denied.get("denied_packages"), dict) else {}
    catalog["npm"]["denied"].update(package_list_to_set(listify(denied_packages.get("npm"))))
    catalog["pypi"]["denied"].update(package_list_to_set(listify(denied_packages.get("python"))))
    catalog["pypi"]["denied"].update(package_list_to_set(listify(denied_packages.get("pypi"))))

    for item in listify(libraries.get("additional_approved")):
        if isinstance(item, dict):
            eco = normalize_ecosystem(str(item.get("ecosystem", "")))
            name = item.get("name") or item.get("package")
            if eco in catalog and name:
                catalog[eco]["approved"].add(normalize_name(str(name)))
    for item in listify(libraries.get("additional_restricted")):
        if isinstance(item, dict):
            eco = normalize_ecosystem(str(item.get("ecosystem", "")))
            name = item.get("name") or item.get("package")
            if eco in catalog and name:
                catalog[eco]["restricted"].add(normalize_name(str(name)))
    for item in listify(libraries.get("additional_denied")):
        if isinstance(item, dict):
            eco = normalize_ecosystem(str(item.get("ecosystem", "")))
            name = item.get("name") or item.get("package")
            if eco in catalog and name:
                catalog[eco]["denied"].add(normalize_name(str(name)))

    return catalog


def catalog_status(name: str, ecosystem: str, catalog: dict[str, dict[str, set[str]]]) -> str:
    normalized = normalize_name(name)
    eco = catalog.get(ecosystem, {})
    if normalized in eco.get("denied", set()):
        return "local_denied"
    if normalized in eco.get("restricted", set()):
        return "local_restricted"
    if normalized in eco.get("approved", set()):
        return "local_approved"
    return "not_listed"


def import_checker():
    try:
        from gvskb.tools.check_package import audit_manifest  # type: ignore
    except Exception as exc:
        raise RuntimeError(
            "vibecode-checker(gvskb)가 설치되어 있지 않습니다. "
            "https://github.com/Lex6won/vibecode-checker 기반 설치 후 다시 실행하세요."
        ) from exc
    return audit_manifest


def severity_rank(severity: str | None) -> int:
    order = {"none": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}
    return order.get(str(severity or "none").strip().lower(), 0)


def action_rank(action: str) -> int:
    return {"pass": 0, "warn": 1, "block": 2}.get(action, 0)


def stronger_action(left: str, right: str) -> str:
    return left if action_rank(left) >= action_rank(right) else right


def mode_action_for_vulnerability(mode: str, severity: str | None, version_exact: bool) -> str:
    if not severity or str(severity).strip().lower() in {"", "unknown", "null"}:
        return "block" if mode == "ENFORCE" and version_exact else "warn"
    rank = severity_rank(severity)
    if rank >= 3:
        if mode == "MONITOR":
            return "warn"
        return "block" if version_exact else "warn"
    if rank >= 1:
        if mode == "MONITOR":
            return "pass"
        if mode == "WARN":
            return "warn"
        return "block" if version_exact else "warn"
    return "pass"


def mode_action_for_unknown(mode: str, source_scope: str) -> str:
    if mode == "MONITOR":
        return "pass"
    if mode == "WARN":
        return "warn"
    return "block" if source_scope in {"single", "direct", "manifest_direct", ""} else "warn"


def evaluate_package(
    *,
    name: str,
    ecosystem: str,
    version: str | None,
    mode: str,
    env_grade: str,
    catalog: dict[str, dict[str, set[str]]],
    checker_result: dict[str, Any] | None,
    checker_error: str | None = None,
    source_scope: str = "single",
) -> dict[str, Any]:
    status = catalog_status(name, ecosystem, catalog)
    reasons: list[str] = []
    action = "pass"

    if status == "local_denied":
        return {
            "action": "block",
            "reasons": ["기관/하네스 불허 목록에 있는 패키지입니다. 대체 패키지 또는 구현 방식을 선택하세요."],
            "package": name,
            "ecosystem": ecosystem,
            "version": version,
            "mode": mode,
            "env_grade": env_grade,
            "catalog_status": status,
            "checker_verdict": None,
            "source_scope": source_scope,
        }

    if checker_error:
        action = mode_action_for_unknown(mode, source_scope)
        reasons.append(checker_error)
        return {
            "action": action,
            "reasons": reasons,
            "package": name,
            "ecosystem": ecosystem,
            "version": version,
            "mode": mode,
            "env_grade": env_grade,
            "catalog_status": status,
            "checker_verdict": "checker_unavailable",
            "source_scope": source_scope,
        }

    result = checker_result or {}
    verdict = str(result.get("verdict") or "unknown").lower()
    checked = bool(result.get("checked", False))
    in_kev = bool(result.get("in_kev", False))
    kev_checked = result.get("kev_checked")
    max_cve = result.get("max_cve") or result.get("verdict_severity")
    version_exact = bool(result.get("version_exact", True))
    heuristics = result.get("heuristics") if isinstance(result.get("heuristics"), dict) else {}
    typosquat_warning = heuristics.get("typosquat_warning")

    if verdict in {"malicious", "registry_rejected", "not_found"}:
        action = "block"
        reasons.append(f"체커 판정이 '{verdict}'입니다. 설치하지 마세요.")
    if in_kev:
        action = "block"
        reasons.append("CISA KEV 등 알려진 악용 취약점 신호가 있어 설치를 차단합니다.")

    if verdict == "vulnerable":
        vulnerability_action = mode_action_for_vulnerability(mode, str(max_cve or ""), version_exact)
        action = stronger_action(action, vulnerability_action)
        reasons.append(
            f"취약점 신호가 있습니다(max_cve={max_cve or 'unknown'}, "
            f"version_exact={version_exact})."
        )
    elif verdict == "cooldown_hold":
        cooldown_action = {"MONITOR": "pass", "WARN": "warn", "ENFORCE": "block"}[mode]
        action = stronger_action(action, cooldown_action)
        reasons.append("신규/쿨다운 대상 패키지입니다. 검증 또는 대체 패키지 검토가 필요합니다.")
    elif verdict == "checked_stale":
        stale_action = {"MONITOR": "pass", "WARN": "warn", "ENFORCE": "warn"}[mode]
        action = stronger_action(action, stale_action)
        reasons.append("검사 결과가 오래되었습니다. 배포 전 전체 점검에서 다시 확인하세요.")
    elif verdict in {"unknown", "error", "checker_unavailable"}:
        unknown_action = mode_action_for_unknown(mode, source_scope)
        action = stronger_action(action, unknown_action)
        reasons.append("체커가 안전 판정을 확정하지 못했습니다.")
    elif verdict in {"registry_approved", "checked_clean", "ok", "pass"}:
        if verdict == "registry_approved" and not checked:
            unverified_action = {"MONITOR": "pass", "WARN": "warn", "ENFORCE": "warn"}[mode]
            action = stronger_action(action, unverified_action)
            reasons.append("레지스트리 승인 상태이나 최신 검사 완료 신호가 없습니다.")

    if typosquat_warning:
        action = stronger_action(action, "warn")
        reasons.append(f"타이포스쿼팅 의심 신호가 있습니다: {typosquat_warning}")

    if version is None and source_scope in {"single", "manifest", "manifest_direct"} and action == "pass":
        action = stronger_action(action, "warn")
        reasons.append("정확한 버전이 지정되지 않았습니다. 설치 후 lockfile 또는 exact version으로 다시 점검하세요.")

    if kev_checked is False and action == "pass" and mode in {"WARN", "ENFORCE"}:
        action = stronger_action(action, "warn")
        reasons.append("KEV 확인이 완료되지 않았습니다. 배포 전 전체 점검에서 재확인하세요.")

    if status == "local_restricted" and action == "pass":
        action = "warn"
        reasons.append("기관 제한 목록의 패키지입니다. 사용 목적과 보완조치를 코드 리뷰에 남기세요.")
    elif status == "not_listed" and action == "pass" and mode == "ENFORCE":
        action = "warn"
        reasons.append("기관 승인 목록에는 없지만 체커 차단 사유는 없습니다. 담당자 검토 대상으로 남기세요.")

    # 실행환경 등급에 따른 사람 검토 — **맨 마지막에** 판단한다.
    # 위의 모든 검사가 통과해도(깨끗해도) E2 는 자동 설치되지 않는다.
    requires_human_review = False
    if (
        env_grade in HUMAN_REVIEW_ENV_GRADES
        and status not in PRIOR_REVIEW_CATALOG_STATUSES
        and verdict not in PRIOR_REVIEW_CHECKER_VERDICTS
    ):
        requires_human_review = True
        action = stronger_action(action, "block")
        reasons.append(
            f"실행환경 등급 {env_grade}(내부 서버·공용 환경·CI)에서는 새 외부 패키지의 "
            "자동 설치를 허용하지 않습니다 — 검사 결과와 무관한 절차 요건입니다."
        )
        reasons.append(
            "조치: 보안담당자 확인을 받거나, 기관 승인 목록(approved-packages.yaml) 또는 "
            "레지스트리 승인을 거친 뒤 다시 시도하세요."
        )

    if not reasons:
        reasons.append("체커와 하네스 정책 기준에서 설치 차단 사유가 없습니다.")

    return {
        "action": action,
        "reasons": reasons,
        "package": name,
        "ecosystem": ecosystem,
        "version": version,
        "mode": mode,
        "env_grade": env_grade,
        # 차단의 **성격**을 구분한다 — 위험해서 막은 것과 절차상 사람 확인이
        # 필요한 것은 담당자가 할 행동이 다르다.
        "requires_human_review": requires_human_review,
        "catalog_status": status,
        "checker_verdict": verdict,
        "checked": checked,
        "in_kev": in_kev,
        "kev_checked": kev_checked,
        "max_cve": max_cve,
        "version_exact": version_exact,
        "source_scope": source_scope,
    }


def package_manifest_text(name: str, ecosystem: str, version: str | None) -> tuple[str, str]:
    if ecosystem == "pypi":
        return (f"{name}=={version}\n" if version else f"{name}\n"), "requirements.txt"
    npm_manifest = {
        "name": "gvskb-gate-single-package-check",
        "private": True,
        "dependencies": {
            name: version or "latest"
        },
    }
    return json.dumps(npm_manifest, ensure_ascii=False), "package.json"


async def run_package_audit(name: str, ecosystem: str, version: str | None, env_grade: str) -> dict[str, Any]:
    audit_manifest = import_checker()
    text, filename = package_manifest_text(name, ecosystem, version)
    audit = await audit_manifest(text, ecosystem=ecosystem, env_grade=env_grade, filename=filename)
    checks = audit.get("checks")
    if isinstance(checks, list) and checks:
        first = checks[0] if isinstance(checks[0], dict) else {}
        first.setdefault("source_scope", "manifest")
        return first
    return {
        "name": name,
        "version": version,
        "verdict": audit.get("verdict") or "unknown",
        "registry_status": audit.get("registry_status"),
        "checked": False,
        "source_scope": "manifest",
    }


async def run_manifest_audit(path: Path, ecosystem: str, limit: int | None, env_grade: str) -> dict[str, Any]:
    audit_manifest = import_checker()
    text = path.read_text(encoding="utf-8")
    return await audit_manifest(
        text,
        ecosystem=ecosystem,
        limit=limit,
        env_grade=env_grade,
        filename=path.name,
    )


def parse_package_spec(spec: str, ecosystem: str, version: str | None) -> tuple[str, str | None]:
    if version:
        return spec, version
    if ecosystem == "pypi" and "==" in spec:
        name, parsed_version = spec.split("==", 1)
        return name, parsed_version
    if ecosystem == "npm":
        if spec.startswith("@"):
            tail = spec.rsplit("@", 1)
            if len(tail) == 2 and "/" in tail[0]:
                return tail[0], tail[1]
        elif "@" in spec:
            name, parsed_version = spec.rsplit("@", 1)
            return name, parsed_version
    return spec, None


def print_text(decision: dict[str, Any]) -> None:
    action = decision.get("action", "pass").upper()
    package = decision.get("package", "manifest")
    ecosystem = decision.get("ecosystem", "")
    mode = decision.get("mode", "")
    print(f"[gvskb-gate] {action}: {package} ({ecosystem}, mode={mode})")
    for reason in decision.get("reasons", [])[:5]:
        print(f"- {reason}")
    if decision.get("requires_human_review"):
        # 위험 차단과 절차 차단은 담당자가 할 행동이 다르다 — 문구를 섞지 않는다.
        print("- 이 차단은 위험 판정이 아니라 절차 요건입니다. 보안담당자 확인 후 진행하세요.")
    elif decision.get("action") == "block":
        print("- 대체 패키지를 선택하거나 체커/레지스트리 검증 후 다시 시도하세요.")
    elif decision.get("action") == "warn":
        print("- 개발은 계속할 수 있지만, 배포 전 체커 전체 점검과 최종 리포트 제출 대상입니다.")


def exit_for_action(action: str) -> int:
    return {"pass": EXIT_PASS, "warn": EXIT_WARN, "block": EXIT_BLOCK}.get(action, EXIT_WARN)


def resolve_env_grade(args_env_grade: str | None, profile: dict[str, Any]) -> str:
    """요청된 실행환경 등급을 정규화한다(대소문자·공백 무관).

    소문자 ``e2`` 는 체커에서 목록에 없는 값으로 취급돼 조용히 E1 으로 떨어졌다.
    등급은 판정 기준을 바꾸는 값이므로 **여기서 한 번 정규화**해 아래로 내린다.

    CLI ``--env-grade`` 는 argparse 의 ``type=str.upper`` 가 먼저 처리하므로 이
    함수까지 소문자가 오지 않는다. 여기서 정규화가 실제로 쓰이는 입력은
    환경변수 ``GVSKB_GATE_ENV_GRADE`` 와 기관 프로파일의 기본값이다.
    """
    return (args_env_grade or default_env_grade(profile)).strip().upper()


def env_grade_block(env_grade: str, *, name: str, ecosystem: str,
                    version: str | None, mode: str,
                    source_scope: str = "single") -> dict[str, Any] | None:
    """체커가 판정할 수 없는 등급이면 **자동 판정을 거부**하는 결정을 돌려준다.

    ``None`` 이면 자동 판정을 계속 진행해도 되는 등급이다.

    거부는 '위험하다'는 뜻이 아니라 **'이 도구가 답할 자격이 없다'** 는 뜻이다.
    그래서 사유에 사람 심사 경로를 함께 적는다 — 막기만 하고 다음 행동을 알려
    주지 않는 게이트는 우회되거나 꺼진다.
    """
    if env_grade in CHECKER_SUPPORTED_ENV_GRADES:
        return None

    if env_grade == "E3":
        reasons = [
            "E3(대민·개인정보·인증·핵심 행정정보) 등급은 자동 판정 대상이 아닙니다.",
            "체커는 E3 를 지원하지 않습니다 — 이대로 진행하면 개인 PC 기준(E1)으로 "
            "검사되면서 기록만 E3 로 남습니다.",
            "기관 프로파일 규칙: E2/E3 패키지는 자동승인 금지, 보안담당자 검토가 필요합니다.",
            "조치: 패키지검토요청서(shared/templates/11)를 작성해 보안담당자 심사로 진행하세요.",
        ]
    else:
        reasons = [
            f"알 수 없는 실행환경 등급입니다: {env_grade!r}. "
            f"허용 값은 {', '.join(VALID_ENV_GRADES)} 입니다.",
            "등급이 쿨다운 기준을 바꾸므로, 값을 확인하기 전에는 판정하지 않습니다.",
        ]

    return {
        "action": "block",
        "reasons": reasons,
        "package": name,
        "ecosystem": ecosystem,
        "version": version,
        "mode": mode,
        "env_grade": env_grade,
        "catalog_status": "not_listed",
        # 체커에 물어보지 않았다는 사실을 값으로 남긴다 — '검사했는데 막았다'와
        # '검사 자체를 하지 않았다'는 감사에서 전혀 다른 기록이다.
        "checker_verdict": "unsupported_env_grade",
        "requires_human_review": True,
        "source_scope": source_scope,
    }


def install_pypi_package(name: str, version: str | None, extra_args: list[str]) -> int:
    spec = f"{name}=={version}" if version else name
    command = [sys.executable, "-m", "pip", "install", spec, *extra_args]
    return subprocess.call(command)


async def command_check(args: argparse.Namespace) -> int:
    profile = load_yaml(shared_root() / "institution-profile.yaml")
    mode = (args.mode or default_mode(profile)).upper()
    env_grade = resolve_env_grade(args.env_grade, profile)
    ecosystem = normalize_ecosystem(args.ecosystem)
    name, version = parse_package_spec(args.package, ecosystem, args.version)

    blocked = env_grade_block(env_grade, name=name, ecosystem=ecosystem,
                              version=version, mode=mode)
    if blocked is not None:
        if args.json:
            print(json.dumps(blocked, ensure_ascii=False, indent=2))
        else:
            print_text(blocked)
        return exit_for_action(blocked["action"])

    catalog = collect_catalog(profile)

    checker_result: dict[str, Any] | None = None
    checker_error: str | None = None
    if catalog_status(name, ecosystem, catalog) != "local_denied":
        try:
            checker_result = await run_package_audit(name, ecosystem, version, env_grade)
        except Exception as exc:
            checker_error = str(exc)

    decision = evaluate_package(
        name=name,
        ecosystem=ecosystem,
        version=version,
        mode=mode,
        env_grade=env_grade,
        catalog=catalog,
        checker_result=checker_result,
        checker_error=checker_error,
        source_scope=str((checker_result or {}).get("source_scope") or "manifest"),
    )
    if args.json:
        print(json.dumps(decision, ensure_ascii=False, indent=2))
    else:
        print_text(decision)
    return exit_for_action(decision["action"])


async def command_install(args: argparse.Namespace) -> int:
    if normalize_ecosystem(args.ecosystem) != "pypi":
        print("gvskb_gate.py install은 Python/pip 전용입니다. npm은 gvskb_gate.js install을 사용하세요.", file=sys.stderr)
        return EXIT_USAGE

    profile = load_yaml(shared_root() / "institution-profile.yaml")
    mode = (args.mode or default_mode(profile)).upper()
    env_grade = resolve_env_grade(args.env_grade, profile)
    name, version = parse_package_spec(args.package, "pypi", args.version)

    blocked = env_grade_block(env_grade, name=name, ecosystem="pypi",
                              version=version, mode=mode)
    if blocked is not None:
        # 설치 경로에서는 특히 중요하다 — 판정하지 못한 채 설치가 진행되면
        # 게이트가 있으나 마나다.
        if args.json:
            print(json.dumps(blocked, ensure_ascii=False, indent=2))
        else:
            print_text(blocked)
        return exit_for_action(blocked["action"])

    catalog = collect_catalog(profile)

    checker_result: dict[str, Any] | None = None
    checker_error: str | None = None
    if catalog_status(name, "pypi", catalog) != "local_denied":
        try:
            checker_result = await run_package_audit(name, "pypi", version, env_grade)
        except Exception as exc:
            checker_error = str(exc)

    decision = evaluate_package(
        name=name,
        ecosystem="pypi",
        version=version,
        mode=mode,
        env_grade=env_grade,
        catalog=catalog,
        checker_result=checker_result,
        checker_error=checker_error,
        source_scope=str((checker_result or {}).get("source_scope") or "manifest"),
    )

    print_text(decision)
    # `action` 이 block 이 아니어도 사람 검토 요건이 걸려 있으면 설치하지 않는다.
    # 두 조건을 따로 두는 이유: 판정 로직이 바뀌어 action 매핑이 달라져도 절차
    # 요건이 조용히 통과되면 안 된다(게이트의 마지막 문은 이중으로 잠근다).
    if decision["action"] == "block" or decision.get("requires_human_review"):
        return EXIT_BLOCK
    return install_pypi_package(name, version, args.pip_args)


async def command_verify_manifest(args: argparse.Namespace) -> int:
    profile = load_yaml(shared_root() / "institution-profile.yaml")
    mode = (args.mode or default_mode(profile)).upper()
    env_grade = resolve_env_grade(args.env_grade, profile)
    ecosystem = normalize_ecosystem(args.ecosystem)
    path = Path(args.path).resolve()

    blocked = env_grade_block(env_grade, name=str(path.name), ecosystem=ecosystem,
                              version=None, mode=mode, source_scope="manifest")
    if blocked is not None:
        if args.json:
            print(json.dumps(blocked, ensure_ascii=False, indent=2))
        else:
            print_text(blocked)
        return exit_for_action(blocked["action"])

    catalog = collect_catalog(profile)

    if not path.exists():
        print(f"매니페스트 파일을 찾을 수 없습니다: {path}", file=sys.stderr)
        return EXIT_USAGE

    try:
        audit = await run_manifest_audit(path, ecosystem, args.limit, env_grade)
    except Exception as exc:
        decision = {
            "action": mode_action_for_unknown(mode, "manifest"),
            "reasons": [str(exc)],
            "package": path.name,
            "ecosystem": ecosystem,
            "mode": mode,
            "env_grade": env_grade,
            "checker_verdict": "checker_unavailable",
        }
        if args.json:
            print(json.dumps(decision, ensure_ascii=False, indent=2))
        else:
            print_text(decision)
        return exit_for_action(decision["action"])

    aggregate_action = "pass"
    reasons: list[str] = []
    package_decisions: list[dict[str, Any]] = []
    for check in audit.get("checks", []) if isinstance(audit.get("checks"), list) else []:
        if not isinstance(check, dict):
            continue
        name = str(check.get("name") or check.get("package") or "")
        if not name:
            continue
        decision = evaluate_package(
            name=name,
            ecosystem=ecosystem,
            version=check.get("version"),
            mode=mode,
            env_grade=env_grade,
            catalog=catalog,
            checker_result=check,
            checker_error=None,
            source_scope=str(check.get("source_scope") or "manifest_direct"),
        )
        package_decisions.append(decision)
        aggregate_action = stronger_action(aggregate_action, decision["action"])
        if decision["action"] != "pass":
            reasons.append(f"{name}: {decision['reasons'][0]}")

    if audit.get("unchecked_count"):
        aggregate_action = stronger_action(aggregate_action, "warn")
        reasons.append(f"미확인 패키지 {audit.get('unchecked_count')}건이 있습니다.")
    if audit.get("truncated_count"):
        aggregate_action = stronger_action(aggregate_action, "warn")
        reasons.append(f"검사 제한으로 생략된 패키지 {audit.get('truncated_count')}건이 있습니다.")
    if not reasons:
        reasons.append("매니페스트 기준 차단/경고 사유가 없습니다.")

    decision = {
        "action": aggregate_action,
        "reasons": reasons,
        "package": path.name,
        "ecosystem": ecosystem,
        "mode": mode,
        "env_grade": env_grade,
        "checker_verdict": audit.get("verdict"),
        "registry_status": audit.get("registry_status"),
        "package_decisions": package_decisions,
        "summary": {
            "checked_count": len(package_decisions),
            "unchecked_count": audit.get("unchecked_count", 0),
            "truncated_count": audit.get("truncated_count", 0),
        },
    }

    if args.json:
        print(json.dumps(decision, ensure_ascii=False, indent=2))
    else:
        print_text(decision)
    return exit_for_action(decision["action"])


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Lightweight gvskb package gate for Codex harness.")
    sub = parser.add_subparsers(dest="command", required=True)

    def add_common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--ecosystem", choices=sorted(VALID_ECOSYSTEMS), default="pypi")
        p.add_argument("--mode", choices=sorted(VALID_MODES))
        # type=str.upper 가 choices 검사보다 **먼저** 돈다 — `--env-grade e2` 처럼
        # 소문자로 넣어도 받는다. 이게 없으면 argparse 가 먼저 거절해서
        # `resolve_env_grade` 의 정규화가 이 경로에서는 아무 일도 하지 않는다.
        # E3 는 선택지에 남긴다 — argparse 오류보다 "왜 안 되는지" 설명이 낫다.
        p.add_argument("--env-grade", type=str.upper, choices=["E0", "E1", "E2", "E3"])
        p.add_argument("--json", action="store_true")

    check = sub.add_parser("check", help="Check one package before adding it.")
    check.add_argument("package")
    check.add_argument("--version")
    add_common(check)

    install = sub.add_parser("install", help="Check and then pip install a Python package if not blocked.")
    install.add_argument("package")
    install.add_argument("--version")
    install.add_argument("--pip-args", nargs=argparse.REMAINDER, default=[])
    add_common(install)

    manifest = sub.add_parser("verify-manifest", help="Check requirements.txt/package.json without creating final reports.")
    manifest.add_argument("path")
    manifest.add_argument("--limit", type=int)
    add_common(manifest)

    return parser


async def main_async(argv: list[str]) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "check":
        return await command_check(args)
    if args.command == "install":
        return await command_install(args)
    if args.command == "verify-manifest":
        return await command_verify_manifest(args)
    return EXIT_USAGE


def main() -> int:
    try:
        return asyncio.run(main_async(sys.argv[1:]))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
