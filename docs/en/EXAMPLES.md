# Examples and prompts

[Documentation](README.md) · [中文](../EXAMPLES.md)

These prompts are starting points, not guarantees. Replace bracketed text with real information. Do not ask a model to invent data, names, compliance conclusions or unreadable image content.

## Example 1: turn a written brief into an editable flowchart

> Turn this requirement into an editable flowchart: [paste the requirement]. First identify actors, inputs, decisions and exception paths, then draw the board. Read left to right; use diamonds for decisions and put exception paths below the main flow. Do not invent rules. Mark missing information as “Needs confirmation”.

Check that exceptions return to the right nodes, then give precise follow-up corrections. Provide a written source for amounts, approvals and deadlines.

## Example 2: recreate an image instead of pasting it

Use a vision-capable model for screenshots, photos and old diagrams. See the [image recreation walkthrough](CANVAS_AND_EXPORT.md#example-recreate-a-diagram-image).

> Redraw the attached image as editable nodes and connectors. Keep its reading direction and groups. Mark unreadable content “Needs confirmation”; do not guess. List uncertain details when done.

Without vision, transcribe nodes and relationships into text or Mermaid first.

## Example 3: make three PPT slides from one board

> Organize the current board into three non-overlapping reporting sections: problem context, solution, and next steps. Give each one a title and at most five key points. Do not invent numbers. Keep nodes, text and connectors editable.

After checking content, batch-select regions in slide order and export PPT. See the [multi-slide workflow](CANVAS_AND_EXPORT.md#example-export-a-three-slide-presentation-from-one-board).

## Example 4: improve only one region

1. Select the target with region export and choose Add to chat.
2. Send:

   > Improve only the referenced region: make same-level nodes consistent in size and spacing and reduce connector crossings. Preserve node text, color meaning and everything outside the region. Explain the intended changes first.

3. Review, undo if needed, and narrow the reference or name protected nodes in a follow-up.

A reference communicates scope; it is not a permission boundary. Create a snapshot before important changes.

## Before using vision

- Attach the image in **chat**, not only as a canvas background.
- Select a model that has actually passed a vision test; the configuration flag alone does not prove gateway support.
- Redact private information before sending images to a provider.
- Ask for uncertain details to be listed when images are blurry, small or dense.

See [vision-capable vs text-only models](CONFIGURATION.md#vision-capable-vs-text-only-models).
