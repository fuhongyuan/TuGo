# FAQ

[Documentation](README.md) · [中文](../FAQ.md)

## Why do I need an API key for an open-source app?

TuGo's license does not include third-party model services. Those services may charge for tests and usage.

## Can I work offline?

Manual canvas editing and local storage do not need a TuGo cloud service. Remote models, Web tools and MCP services may require a network connection. No offline language model is bundled.

## Does my board leave the device?

The Agent can read canvas state through tools; shared context is not necessarily limited to a selected region. Conversations, tool results and attachments may be sent to configured providers. See [Privacy](../../PRIVACY.md).

## Where are credentials stored?

In encrypted records in the local `runtime-secrets.json` file, with references used in database records. This is not an OS keychain or protection against a compromised local account. Never share the file.

## Why does the browser preview lack AI?

The full Runtime and local file/database access are hosted by Electron. Use the installed app or `npm run dev`.

## Why does some Chinese remain after switching language?

Localization is incomplete. Missing translated keys use English, while controls not yet connected to localization may remain Chinese. Existing board text and conversation history are not translated.

## Are imported diagrams and PPT exports lossless?

No. TuGo supports defined portions of each format. Check structure after import and fonts, labels, clipping, connectors and slide order after export. Images do not become editable shapes merely by exporting PPTX.

## Is the backup ZIP enough to migrate?

No. It currently contains two databases, not attachments, credentials or the full app directory. See [Backup and recovery](DATA_RECOVERY.md).

## What about Windows, Intel Mac and Linux?

The initial target is macOS 13+ Apple Silicon. Windows x64 packaging exists, but actual validation and downloadable builds depend on the Release. Intel Mac and Linux desktop support are not promised.

## Is there an interactive tutorial?

Not yet; use the written getting-started and export guides.

## How do I report a problem?

Use the Bug Report issue template with version, OS/architecture, installation source, reproduction steps and sanitized diagnostics. Report vulnerabilities privately through [Security](../../SECURITY.md).
