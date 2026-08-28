# TuGo Demo capture guide

This guide separates what is automated today from what should be captured with a configured real model. It is deliberately not a claim that the repository can autonomously record a product demo.

## What the repository verifies today

`npm run test:electron` launches the Electron app against a local deterministic model fixture. It exercises desktop UI, local storage, import/export, and conversation flows, then writes machine-readable pass/fail reports. `npm run test:visual` renders a fixed export fixture and checks a PPTX visual baseline.

Neither command records a screen video, and the E2E fixture returns canned text rather than generating a real diagram. That is appropriate for reliable regression testing, but it cannot truthfully demonstrate an AI model creating and revising a useful canvas. The repository also does not bundle a video encoder.

Before a release, run:

```bash
npm ci
npm run test:electron
npm run test:visual
```

This proves the supporting flows before recording the real-model demos below.

## Shared setup for real-model capture

1. Start the desktop app with `npm run dev`, or use a release build.
2. In **Settings → Models**, configure a working model that can use the canvas tools.
3. Create a fresh board, hide unrelated personal data, and set the window to a readable size.
4. Use macOS Screenshot/Screen Recording or another recorder already installed on the capture machine. Record only the app window, at 1440p or 1080p.
5. Keep the cursor movements deliberate and pauses short. Do not speed up or edit out a failed model response in a way that suggests it succeeded.

Use the final clean frame as a PNG in README. If you later encode a video, use a 15–30 second H.264 MP4 or WebM with a poster PNG. GitHub README video support varies by context, so keep a linked MP4/GitHub release asset and a readable static image fallback.

## Demo 1 — AI creates an architecture diagram (10–20 seconds)

**Prompt**

```text
Draw an AI Agent Runtime architecture with Agent, Runtime, Model, Tools, Memory and Sandbox. Group the components, add labeled arrows for the main request path, and keep every node editable.
```

**Capture sequence**

1. Show the empty board and prompt for about 2 seconds.
2. Send the prompt and show the visible task status briefly.
3. Let the generated architecture settle, then pan or zoom once to show editable nodes and connectors.

**Success check**: all named components are visible, labels are legible, and the board—not a raster image—is shown.

## Demo 2 — selected region becomes the next AI context (10–25 seconds)

Start from the finished Demo 1 board.

1. Use region selection to surround the Runtime area.
2. Choose **Add to chat** and show the reference appearing in the composer.
3. Send:

```text
Change this selected Runtime area to an event-driven design. Add an event queue, preserve the other components, and update the affected connections.
```

4. Show the result and briefly pan only enough to demonstrate that the rest of the diagram remains available for inspection.

**Success check**: the selection reference is visible before sending; the changed Runtime area and event queue are visible afterward. Review the full board before publishing because a reference expresses intent, not a hard edit boundary.

## Demo 3 — canvas regions become a PowerPoint deck (10–20 seconds)

Use a board with three visually separate areas, for example: Context, Architecture, and Rollout plan.

1. Use batch selection to draw three regions in slide order.
2. Click **Finish → Export PPT**.
3. Show the completed download/export notification, then open the PPTX in PowerPoint or Keynote and show its three slide thumbnails.

**Success check**: the selection count matches the slide count; check fonts, clipping, order, connectors, and editability in the target presentation application.

## Hero demo (15–30 seconds)

The clearest hero narrative is the same board moving through one continuous story:

```text
Prompt → AI creates architecture → select Runtime → add to chat → event-driven revision → select three regions → export PPTX
```

Use no feature-carousel overlays. A viewer should be able to see the prompt, the evolving editable board, the selected context, and the export outcome without reading narration. Until that video is captured, the README hero is intentionally a real static screenshot at `assets/readme/ai-creates-editable-canvas.png`, followed by real workflow screenshots.

## Replacing the README media

Keep the static fallback in `assets/readme/`. If a final hero video is ready:

1. Add a compressed video plus a first-frame PNG under `assets/readme/` or attach the video to the GitHub release.
2. Check it from the repository page while signed out, especially on mobile.
3. Update both `README.md` and `README.en.md` with the same asset and descriptive alt text.
4. Keep the PNG immediately below or linked from the video so the story remains clear where video playback is unavailable.
