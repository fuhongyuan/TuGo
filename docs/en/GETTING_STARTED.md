# Getting started

[Documentation](README.md) · [中文](../GETTING_STARTED.md)

## Start the desktop app

Download an installer matching your OS and architecture from Releases. For macOS DMG, drag TuGo to Applications and launch it there; unpack ZIP downloads first. The initial target is macOS 13+ Apple Silicon.

Check the download source, checksum and release-specific signing/notarization information if macOS blocks launch. Do not disable system security globally. GitHub's Source code ZIP is not an installer.

To develop from source, install Node.js 25.2.1 and npm 11.6.2, then run from the cloned or extracted project root:

```bash
npm ci
npm run dev
```

The web preview (`npm run dev:web`) does not provide the full desktop Runtime.

## Connect a model

1. Open Settings → Models and add a connection.
2. Choose the correct provider protocol and enter the model ID supplied by the service.
3. Configure the endpoint and API key. Check advanced context/output limits against the actual model specification.
4. Enable vision only when the model and endpoint support images.
5. Test, save and select the default model. Testing sends a real request and may cost credits.

See [Configuration](CONFIGURATION.md) for troubleshooting and [Privacy](../../PRIVACY.md) for credential-storage limitations.

## Make a diagram

Create a board and ask:

> Draw an order-processing flow with payment, stock checks and shipping. Refund the customer if stock is unavailable. Use clear decision branches.

Review the result, then refine it:

> Arrange the main flow left to right and place refunds below it. Keep the meaning of every node.

You can also draw shapes, notes and connectors manually, double-click text to edit, and undo or redo changes. Save a version snapshot before significant revisions.

## Select, discuss and export

Use the region export tool to drag a selection, then choose “Add to chat” and ask for a specific change. A reference communicates scope; it is not a hard permission boundary. Review changes outside the region too.

For a single slide, select a region and export PPTX. For multiple slides, use batch selection in slide order, finish selecting and export PPT. Supported shapes, text and connectors remain editable; images remain images.

See [Canvas and PPT workflows](CANVAS_AND_EXPORT.md) and [Backup and recovery](DATA_RECOVERY.md).
