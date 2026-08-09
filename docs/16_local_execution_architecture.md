# Local execution architecture

## Confirmed service boundary

The public Vibecoding Security Gate is not a central service that uploads and scans original development source.

- The harness and checker are installed on the user's PC.
- The portal runs as a local web screen on `127.0.0.1`, or as a future desktop application screen.
- Folders, archives, and source downloaded from GitHub are scanned only on the user's PC.
- HTML, JSON, and submission ZIP reports are saved to a user-selected folder on that PC.
- The central service receives only opt-in anonymous usage and result-summary metadata.
- Original source, original archives, GitHub tokens, full local paths, report bodies, and code snippets are never sent to the central database.

## Required user flow

```text
PC status check
  -> compare official versions
  -> user-approved update and revalidation
  -> choose folder / ZIP / GitHub source
  -> local checker scan
  -> save reports on the PC
  -> optional anonymous metadata sync
```

## Mandatory capability definition

| Capability | Processing location | Completion criterion |
|---|---|---|
| Harness version check | Local Git checkout | Compare local commit, official main commit, and dirty status. |
| Checker version check | Local gvskb installation | Check installed version, `gvskb doctor`, and approved release channel version. |
| Update | User PC after explicit approval | Backup relevant settings, apply update, then rerun guard/doctor verification. Dirty worktrees and non-`main` worktrees are blocked. |
| Folder scan | User PC | Use a local native folder picker and pass only its local path to the local engine. Browser file-count selection is insufficient. |
| Archive scan | User PC temporary directory | Support ZIP first, extract to an isolated temporary directory, scan it, and clean it after completion. |
| GitHub scan | User PC temporary directory | Allow only HTTPS GitHub owner/repository URLs and use shallow clone. Remove the temporary clone after scanning. |
| Checker execution | User PC | Quick uses `dev-quick`; standard and submission include dependency checks. Zero scanned files must be incomplete, not safe. |
| Report save | User-selected PC folder | Copy HTML, JSON, and submission ZIP to the chosen folder. Central upload is off by default. |
| Metadata sync | Future Supabase Edge Function | Explicit opt-in only; send anonymous client ID, mode, count summaries, versions, and success/failure reason. |

## Progress layer requirements

The progress layer is visible only while an update or scan is running.

- Show actual `0-100%` progress from the local job state.
- Show current stage, next stage, and one short explanation.
- Animate the progress bar and visibly highlight the active stage.
- Distinguish completed, failed, and cancelled states.
- Track GitHub clone, ZIP extraction, code/dependency scan, report rendering, and selected-folder save as separate states.
- If network or installation fails, show the reason and next action instead of appearing to stop.

## Implementation status record (2026-08-09)

| Item | Status | Evidence | Required follow-up |
|---|---|---|---|
| Local portal binding | Implemented | Server listens only on `127.0.0.1`. | Keep. |
| GitHub shallow-clone scan | Implemented | Clone goes to `tmp/scan-targets`, then `gvskb` runs. | Clean temporary clone and add finer progress. |
| Folder scan | Incomplete | Browser selection is deliberately blocked before local engine execution. | Add local native picker or desktop bridge. |
| ZIP scan | Incomplete | Archive API exits as incomplete. | Add ZIP extraction and local scan. |
| Selected-folder report save | Incomplete | UI displays a chosen folder but does not copy engine artifacts. | Add local picker and report copy. |
| Harness latest comparison | Partial | Local commit/status exists; official main comparison is missing. | Add remote main comparison. |
| Checker latest comparison | Partial | Version and doctor exist; approved release comparison is missing. | Add release-channel comparison. |
| User-approved update | Incomplete | Preview exists, apply returns 501. | Add backup, apply, and revalidation. |
| Percent progress | Incomplete | Stage list exists but is not connected to percent or job state. | Add percent/message API and animated layer. |
| Central metadata storage | Design only | No Supabase transport is implemented. | Keep external transmission disabled until opt-in Edge Function exists. |

## Verification rules

1. Folder, ZIP, and GitHub targets must each reach a real local checker execution in automated scenario tests.
2. Quick, standard, and submission scans must prove their different options and artifacts.
3. Updating must refuse dirty worktrees and worktrees not on the official `main` branch.
4. API responses, administrator views, and central metadata payloads must not expose original source or full local paths.
5. Reports must be copied to the selected local folder.
6. Progress must not show 100% before completion and must show a failure reason when a job fails.
