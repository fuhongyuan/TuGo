---
name: tugo-draw
description: Create and edit diagrams in the local TuGo desktop application through its CLI, including folders, boards, imports, exports, and snapshots. Use when the user asks to draw or manage content in TuGo.
---

Use `node <this-skill-directory>/scripts/tugo.cjs` as the TuGo command. The installer supplies that script. A `tugo` executable may also be on PATH.

Start with `status`; TuGo must be running on the same computer. Do not open or modify TuGo's SQLite files directly. The CLI uses TuGo's existing profile; development instances require `--data-dir`.

Run `--help` for commands and `schema` for the editable operation schema. Commands return `{ok,result,requestId}` JSON; nonzero exit means failure. Use returned IDs, never guessed IDs. Pass Chinese text and multiline DSL through files or JSON stdin to avoid shell escaping problems.

For drawing, create or identify a project, then import Mermaid/PlantUML/draw.io or apply native JSON operations. Imports append by default. Preserve editability. Read `board get` before editing existing content and pass its revision with `--if-revision`. A conflict means reread and reconcile, not force an overwrite. Operations within one apply are atomic, up to 256 per call.

Examples (`tugo` below can be replaced by the script command):

```sh
tugo projects list
tugo projects create --name "架构图"
tugo board import --project PROJECT_ID --format mermaid --file diagram.mmd
tugo board get --project PROJECT_ID
tugo board apply --project PROJECT_ID --file operations.json --if-revision REVISION
tugo snapshots create --project PROJECT_ID --name "修改前"
tugo board export --project PROJECT_ID --format png --out diagram.png
```

Read and visually inspect an exported PNG after substantial drawing changes. A successful CLI response proves execution, not visual quality. SVG/PPTX/JSON exports are available for delivery. Prefer `.tugo-snapshot` exports for portable snapshots with embedded image assets; board JSON alone contains attachment references, not image bytes.

Only delete or replace user content when requested. Removal, snapshot restore, and `board import --replace` require `--confirm`. Export refuses to overwrite a file unless `--force` is supplied. Snapshot restore creates a recovery snapshot first. Folder removal moves its projects to root; it does not delete those projects.

If a request times out, its outcome is unknown. Check board state before retrying. Reuse the returned/requested `--request-id` only with identical arguments; replay protection lasts for the running app's most recent 256 commands, not across restarts. Do not expose `cli-endpoint.json` or its token.
