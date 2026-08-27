<p align="center"><img src="assets/tugo-logo.png" width="144" alt="TuGo dog logo"></p>

# TuGo · 图狗

**Turn ideas into diagrams, then turn your canvas into editable slides.**

TuGo is a local-first, AI-powered infinite-canvas desktop app. Draw manually, ask AI to create and revise diagrams, select canvas regions as chat context, and export images, PDF, or PowerPoint.

English · [简体中文](README.md) · [Documentation](docs/en/README.md) · [Getting started](docs/en/GETTING_STARTED.md)

## Features

- Shapes, notes, text, images, connectors, grouping, zoom, pan, undo and redo.
- AI-assisted flowcharts, architecture diagrams and mind maps using your own model provider.
- Selected canvas regions as explicit chat references.
- PNG, JPEG, WebP, SVG, PDF, PPTX and draw.io export. Batch selection can produce one slide per region.
- Mermaid import and compatible subsets of PlantUML and draw.io XML.
- Local projects, folders, multiple conversations, autosave, snapshots and database backups.
- Multiple model connections, Skills and external MCP tools.
- Theme, language and drawing-cursor preferences, with the TuGo dog as the default companion.

AI requires a separately configured model service, which may charge usage fees. TuGo does not include model credits or a bundled offline language model. Review generated content and exports before using them.

## Install and start

Choose an attachment matching your operating system and architecture from this repository's **Releases** page. If no installer is available, run from source. GitHub's Source code ZIP is not an installer.

The initial desktop target is macOS 13+ on Apple Silicon. Windows x64 packaging is available in source, but actual Windows validation, published installers, signing and notarization status must be checked in the individual release notes. Intel Mac and Linux desktop support are not promised.

1. Open **Settings → Models**, add your provider, model ID, endpoint and API key, then test and save.
2. Create a board and ask: “Draw an order-processing flow with payment, stock checks, shipping and refunds.”
3. Use the region export tool to select content, then add it to chat or export it.
4. For a multi-slide presentation, select several regions in slide order with the batch-selection tool, then export PPT.

See [Getting started](docs/en/GETTING_STARTED.md) and [Canvas and PPT workflows](docs/en/CANVAS_AND_EXPORT.md). An interactive onboarding tour is not yet included.

## Run from source

Use Node.js `25.2.1` and npm `11.6.2` (see `.nvmrc` and `package.json`). Clone or download the repository using its **Code** menu, then run in the project root:

```bash
npm ci
npm run dev
```

Installed desktop builds do not require a separate Node.js or Python installation.

`npm run dev:web` previews the renderer only. It does not provide Electron's local databases, attachment access or Agent Runtime.

## Privacy and limitations

Boards, conversations and attachments are stored locally. Model, Web and MCP calls may send relevant prompts, conversation history, canvas content or attachments to external services. **Local-first does not mean that no data leaves your device.**

Credentials currently use a local encrypted file, **not an OS keychain**. This is not a security boundary against a compromised local account. The UI's “Export full backup” currently includes only the App and Runtime databases, not attachments or credentials; it is not a complete migration package. Read [Privacy](PRIVACY.md) and [Backup and recovery](docs/en/DATA_RECOVERY.md).

Language choices include English, Simplified/Traditional Chinese, Japanese, Korean, Spanish, French, German, Brazilian Portuguese and Russian. Localization is partial: translated keys fall back to English, while some controls, dialogs and status messages remain Chinese. Built-in prompts use Simplified Chinese, Traditional Chinese or English.

No cloud sync, collaborative editing or MCP OAuth login is provided. Imported DSL and complex PPTX styles are not guaranteed to round-trip losslessly. See [FAQ](docs/en/FAQ.md).

## Documentation and contribution

- [English documentation](docs/en/README.md) · [中文文档](docs/README.md)
- [Development](docs/DEVELOPMENT.md) · [Packaging](release-docs/PACKAGING.md) · [Release checklist](docs/RELEASING.md)
- [Contributing](CONTRIBUTING.md) · [Support](SUPPORT.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

**TuGo 1.0.0 is the first public release.**

Licensed under [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) and [third-party notices](THIRD_PARTY_NOTICES.md); dependencies retain their own licenses.
