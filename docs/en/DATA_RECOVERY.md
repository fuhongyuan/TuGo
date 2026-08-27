# Backup and recovery

[Documentation](README.md) · [中文](../DATA_RECOVERY.md)

Autosave, board snapshots and database backups serve different purposes. None should be confused with a verified, complete migration archive.

## What “Export full backup” contains

Settings → Data & Recovery exports a ZIP containing:

```text
manifest.json
data/tugo.sqlite
data/runtime.sqlite
```

Despite the current UI label, this does **not** include attachment files, app configuration or `runtime-secrets.json`. There is no one-click full-archive import UI. Do not delete your original data after exporting only this ZIP.

A diagnostics package contains status, configuration summaries and logs, not a restorable backup. Automatic redaction is not guaranteed to remove all private information; inspect before sharing.

## Restore inside the app

Export a backup first. Select a backup in the relevant App or Runtime list and confirm. TuGo will restart and replace the selected database. Backups of the two databases from different times may not match; check boards, conversations, attachments and model connections afterward.

## Keep a complete local copy

Use “Open directory” in Data & Recovery to locate the actual data folder. Fully quit TuGo, then copy the entire folder to a secure location. Keep databases, runtime files, attachments, database backups, configuration and credential files together.

Credentials are encrypted using local user/path context and may not decrypt after a move or on another computer; be prepared to configure them again. A full directory copy is not a supported automatic cross-device migration workflow.

If the app cannot start, preserve the data before repeated reinstalls or restores. Report the version, system and sanitized error through [Support](../../SUPPORT.md), never by publishing full databases or credential files.
