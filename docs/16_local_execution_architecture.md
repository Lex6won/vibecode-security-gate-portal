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

- Make the overall `0-100%` progress the primary signal. The active stage and elapsed time are secondary information.
- Use weighted job stages for the overall value: target preparation, code/dependency scan, report rendering, and selected-folder save.
- Do not impose a client polling or checker scan time limit. A user may close the layer, but the local scan continues and the result remains queryable.
- During a long code scan, advance the weighted value smoothly from elapsed local job time, never past the report-rendering range. This is an estimate, not a fabricated completion time.
- Show current stage, next stage, and one short explanation.
- Animate the progress bar and visibly highlight the active stage.
- Distinguish completed, failed, and cancelled states.
- Track GitHub clone, ZIP extraction, code/dependency scan, report rendering, and selected-folder save as separate states.
- During selected-folder save, show the copied-report count. When it completes, show the selected folder label without exposing its full path through the result API.
- Require a selected save folder before a scan starts. The direct `Select save location` action must open the native folder chooser in one step.
- When no save folder was selected, mark the PC-save step as skipped rather than pending.
- If network or installation fails, show the reason and next action instead of appearing to stop.

## Platform boundary

The current local portal is supported and verified on Windows. Its folder/ZIP picker and ZIP extraction use Windows PowerShell and Windows Forms, and the harness validation command is PowerShell-based. macOS is not an end-to-end supported target yet because native selection, ZIP handling, checker discovery, and harness validation have not been validated there. Do not present macOS support as complete until those flows are implemented and tested on macOS.

## Implementation status record (2026-08-09)

| Item | Status | Evidence | Required follow-up |
|---|---|---|---|
| Local portal binding | Implemented | Server listens only on `127.0.0.1`. | Keep. |
| GitHub shallow-clone scan | Implemented | Clone goes to `tmp/scan-targets`, then `gvskb` runs. | Clean temporary clone and add finer progress. |
| Folder scan | Implemented on Windows | Native folder chooser supplies the local path; scenario tests pass it to the checker. | Add macOS-native selection and validation. |
| ZIP scan | Implemented on Windows | Native ZIP chooser, isolated PowerShell extraction, local scan, and temporary-target cleanup are implemented. | Add archive size and extraction-bomb limits before broad release. |
| Selected-folder report save | Implemented on Windows | The native folder chooser is opened directly; generated HTML, JSON, and ZIP files are copied there and only the folder label is returned. | Add a user-visible collision policy. |
| Harness latest comparison | Implemented | Local commit, dirty state, branch, and `origin/main` are compared. | Prefer signed release metadata when the harness publishes it. |
| Checker latest comparison | Partial | Installed version, `gvskb doctor`, and editable checkout `origin/main` are compared when available. | Define a signed package/release-channel manifest for non-editable installs. |
| User-approved update | Partial | Preview requires approval; dirty or non-`main` worktrees are blocked, then eligible Git worktrees use fast-forward pull and rerun validation. | Back up changed tool configuration and add a target-specific installer before enabling automatic configuration changes. |
| Percent progress | Implemented with stage-weighted estimate | `/api/scan/{id}/progress` returns job state, percent, active steps, elapsed code-scan time, and a message; the layer shows a full-width animated overall bar. | Add checker-emitted file/phase progress events for exact throughput-based progress. |
| Central metadata storage | Design only | No Supabase transport is implemented. | Keep external transmission disabled until opt-in Edge Function exists. |

## Verification rules

1. Folder, ZIP, and GitHub targets must each reach a real local checker execution in automated scenario tests.
2. Quick, standard, and submission scans must prove their different options and artifacts.
3. Updating must refuse dirty worktrees and worktrees not on the official `main` branch.
4. API responses, administrator views, and central metadata payloads must not expose original source or full local paths.
5. Reports must be copied to the selected local folder.
6. Progress must not show 100% before completion and must show a failure reason when a job fails.
