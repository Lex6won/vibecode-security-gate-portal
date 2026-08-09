# Codex Public Vibe-Coding Harness

This repository is the Codex-centered public-sector vibe-coding standard operating harness.

## Operating Identity

Codex harness is not only a fast prototype helper. It is the standard operating rail for public-sector vibe coding across multiple AI coding tools, agencies, templates, and review stages.

The user-facing experience must stay beginner-friendly: idea → standard template implementation → proportional security check → final checker report submission guidance.

The internal behavior must stay governance-grade: institution profile → approved tracks → runtime policy → checker/registry verdict → evidence chain → human approval boundary.

## Authority Order

Read these files first, in this order:

1. `shared/harness.yaml`
2. `shared/institution-profile.yaml`
3. `shared/references/permission-model.yaml`
4. `shared/references/service-maturity-model.md`
5. `shared/references/network-profile.yaml`
6. `shared/references/approved-tracks.yaml`
7. `shared/references/runtime-selection-policy.yaml`
8. `shared/references/lifecycle-quality-gates.yaml`
9. `shared/references/harness-enforcement-contract.yaml`
10. `shared/references/package-governance.yaml`
11. `shared/references/package-alternatives.yaml`
12. `shared/references/trusted-registry-integration.yaml`
13. `shared/references/approved-packages.yaml`
14. `shared/references/package-denylist.yaml`
15. `shared/references/package-risk-policy.md`
16. `shared/references/checker-integration.md`
17. `shared/references/checker-bootstrap-policy.md`
18. `shared/assets/coaching-messages.md`
19. `shared/enforcement/gvskb_gate.py`
20. `shared/enforcement/gvskb_gate.js`

The `.claude/` directory is a Claude Code compatibility copy. Do not treat it as the Codex source of truth. For Codex, `AGENTS.md`, `shared/`, and `shared/harness.yaml` are authoritative.

## Operating Rules

- Work in Korean for user-facing public-sector guidance unless the user asks otherwise.
- Ask business questions in plain administrative language. Do not ask civil servants to choose frameworks, DBMS, auth systems, package managers, or deployment platforms.
- Present Codex harness as a standard operating harness: simple on the outside for beginner civil servants, structured on the inside for institutional operators and reviewers.
- Keep the visible L1 flow thin: summarize the idea, select the approved template, build the smallest useful version, run quick checks only when risk or the user asks, and avoid turning the session into a document factory.
- Start by identifying who will use the system: internal staff, other agencies, or citizens.
- Classify the maturity level: L0 idea, L1 prototype, L2 internal tool, L3 release candidate, L4 official operation.
- Use `shared/institution-profile.yaml` for agency-specific development server, production server, language, DBMS, plugin, and library constraints.
- Use `shared/references/runtime-selection-policy.yaml` to recommend language/framework/DBMS from server size, OS, DBMS, exposure, and service type. Do not ask the user to choose a programming language when policy can decide safely.
- Use `shared/references/lifecycle-quality-gates.yaml` to keep idea, design, implementation, test, and release work proportional to maturity level.
- Use `shared/references/harness-enforcement-contract.yaml` before package installation, dependency changes, source checks, and release handoff. The harness enforces checker verdicts; it does not become the checker or registry.
- Before adding or changing Python, JavaScript, or TypeScript packages, use the package gate: `shared/enforcement/gvskb_gate.py` for PyPI and `shared/enforcement/gvskb_gate.js` for npm. Direct `pip install`, `npm install`, `pnpm add`, or `yarn add` for new packages is a harness bypass and must be rerouted through the gate first.
- Implement functional code only in Python, JavaScript, or TypeScript tracks allowed by `shared/institution-profile.yaml`. TypeScript is allowed because `vibecode-checker` scans `.ts` and `.tsx`; TypeScript package changes still use the npm gate.
- Use `shared/references/package-governance.yaml` for package status, review workflow, and future platform handoff. `vibecode-checker` / `gvskb` provides the single package/security verdict that the harness enforces; final approval belongs to a human reviewer, registry service, or package governance platform.
- Use `shared/references/package-alternatives.yaml` before package exceptions. If a package is denied, unknown, or risky, propose a safe replacement or no-new-package implementation path before stopping.
- Use `shared/references/trusted-registry-integration.yaml` for the checker-mediated registry contract. Do not call a registry service directly for normal package decisions; call `vibecode-checker` / `gvskb`, which returns the registry-backed verdict fields.
- Treat `malicious`, `registry_rejected`, `not_found`, and `in_kev=true` as absolute blocks in every mode. Typosquat heuristics for an existing package are warnings in the harness, not standalone block reasons.
- Read gvskb's 2026-08-03 dependency signals correctly: `kev_checked=false` means `in_kev=false` is not proof of no KEV match; `version_exact=false` must not be a standalone block reason; `source_scope` controls whether ENFORCE blocks unknown direct dependencies only; `registry_status` must be `ok` before treating a registry allow decision as usable.
- Start registry-backed rollout in MONITOR unless the institution profile explicitly says otherwise. Recommended transition is MONITOR for 2 weeks, then WARN after security/operations confirmation; ENFORCE requires coverage criteria.
- Determine and record `env_grade` from the target environment: default personal-PC harness work to E1, internal server or CI to E2, and citizen-facing/sensitive operation to E3 evidence-only handoff. Do not let a developer silently downgrade the grade.
- Use `shared/references/checker-bootstrap-policy.md` when `vibecode-checker` is missing. Ask the user before GitHub clone or package installation. The default source is `https://github.com/Lex6won/vibecode-checker`; in offline mode, require a locally imported folder.
- Treat the official GitHub repositories as the distribution and update sources: harness `https://github.com/Lex6won/vibe_harness_codex`, checker `https://github.com/Lex6won/vibecode-checker`. Local folders are working copies. For other agencies, change `shared/institution-profile.yaml` before forking common harness rules.
- For agency onboarding, first edit `shared/institution-profile.yaml` and then package seed policy files such as `shared/references/approved-packages.yaml` and `shared/references/package-denylist.yaml`. Do not ask new agencies to edit common decision logic files first.
- Use `shared/golden-templates/` as the starting point for implementation. Do not create an arbitrary stack outside an approved track.
- Apply checker effort proportionally: quick during coding for risky changes only, standard after implementation completion, and full before deployment/security/AX submission.
- Use checker built-in profiles by default: quick maps to `dev-quick`. Do not rely on relative `GVSKB_POLICIES_DIR`; custom policy directories must be absolute. After `scan_path`, verify that the returned/applied checker profile matches the requested checker profile, or mark validation incomplete.
- The checker MCP command must be `gvskb-server` or `python -m gvskb.server`, never `gvskb mcp`. ChatGPT desktop Codex, Codex CLI, and Codex IDE share `.codex/config.toml` or the user's `~/.codex/config.toml`. Claude Code reads root `.mcp.json` and may use `.claude/.mcp.json` as a compatibility copy. Claude Desktop does not automatically share Claude Code settings; use a Desktop Extension or `.mcpb` package. Do not hard-code `GVSKB_MODE=offline`; set it only for confirmed air-gapped/offline environments. If checker output includes non-null `profile_fallback`, mark validation incomplete.
- Keep `network_profile` separate from checker profiles. `admin-network`, `dmz-public`, and `internet-prototype` are network/deployment classifications, not values for `scan_path(profile=...)`.
- For release readiness, the default final submission is exactly the two files saved by `vibecode-checker`: the human HTML report and the JSON evidence report. Tell the user these two final reports must be submitted to the security team or AX team. Extra deployment forms are conditional.
- Keep generated work inside `_workspace/`, `_workspace/source/`, or `dist/` unless the user explicitly asks otherwise.
- Do not push to GitHub, deploy to production, send external messages, or write to external systems unless the user explicitly asks for that action.
- Do not claim official security approval. The harness may say "ready for submission", "missing evidence", or "requires human approval".
- Never leave a blocked package as a dead end. Record the blocked package, reason, replacement, feature impact, and whether a review or exception is still needed.
- Use `shared/assets/coaching-messages.md` for ordinary-user wording. Blocks should feel like safe rerouting, not rejection.

## Required Output Chain

For L1 prototypes, keep the minimum evidence chain:

- `_workspace/00_feature_brief.md`
- `artifact:work_status`
- `_workspace/source/`
- `_workspace/vibecode-manifest.json`

For L2, add the appropriate structured artifacts from `shared/templates/`, especially:

- PRD
- screen and feature design
- DB table definition when storage is needed
- development stack and runtime environment
- security report
- package review request or exception when a new/unknown/restricted/denied package affects implementation

For L3 release readiness, do not turn the harness into a document factory. The default final submission is:

- vibecode-checker saved HTML report
- vibecode-checker saved JSON evidence report

Create deployment guides, request documents, exception forms, or package review forms only when the institution requires them or unresolved risk needs a reviewer path.

## Security

Security checks are performed through `vibecode-checker` / `gov-vibe-security-kb` when available. Builder steps should prevent common risks in code, but the security-checking step interprets the checker result. If the checker is unavailable, continue planning/design work but mark security validation as incomplete.

If the checker is not installed or connected, tell the user that security/package validation cannot be completed yet and ask whether to install or prepare it from `https://github.com/Lex6won/vibecode-checker`. Do not install silently. A helper exists at `shared/scripts/checker-bootstrap.mjs`; it requires explicit `--yes` before cloning and separate `--install-python` before Python package installation.

For package governance, the checker is the only normal integration point. The registry manages PyPI/npm allow and deny decisions, the checker combines that registry result with vulnerability and malicious-package evidence, and the harness enforces the resulting verdict for users and coding agents. A block must always include the blocked item, verdict, applied mode, env_grade, replacement or safe-version path, and review/exception route when needed.

For package installation, the executable guardrail is:

- Python/PyPI: `python shared/enforcement/gvskb_gate.py check <package> --ecosystem pypi`, then `install` only when not blocked.
- JavaScript/TypeScript npm: `node shared/enforcement/gvskb_gate.js check <package>`, then `install` only when not blocked.
- npm install through the gate adds `--ignore-scripts` by default. Use `--allow-scripts` only when an approved template or reviewer condition requires it.
- Manifest checks through `verify-manifest` are development evidence only. Final submission remains the two checker-saved full reports.

Keep ordinary user security messages short. Passing package checks should normally be silent; blocks should be one action-oriented sentence. Detailed fields such as `kev_checked`, `source_scope`, `registry_stale`, cache state, and `registry_status=item_failed` belong in manifest/report records for staff, not in the civil-servant coding flow.

Before release submission, full checker validation must include `scan_path`, dependency checks, installed-package checks when installed inventories exist, vendor-bundle checks when `vendor_bundles` is returned, and `render_report(format="both", save=true)`. Use the checker-saved report paths; do not rewrite the same report under a new harness filename.
