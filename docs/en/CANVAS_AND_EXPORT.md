# Canvas, images and PowerPoint

[Documentation](README.md) · [中文](../CANVAS_AND_EXPORT.md)

## Images

Use the canvas image-import tool or drag an image onto the board. A canvas image is an element that can be moved and resized; a chat attachment is model input and does not automatically become a canvas element.

Image analysis requires a vision-capable model. Try:

> Recreate the flow in this image as editable nodes and connectors beside the original. Mark unreadable text instead of guessing.

Exporting a screenshot to PPTX does not turn its contents into editable shapes.

### Example: recreate a diagram image

Use this for an old flowchart screenshot, a whiteboard photo, or an architecture image. First verify that the selected chat model has working vision enabled in Settings → Models. Attach the original image in chat. Merely placing an image on the canvas does not make AI see it.

Send a prompt such as:

> Read the attached image and redraw it on the current board as **editable nodes and connectors**. Do not use the original image as the final deliverable. Preserve the main reading direction and groups. Write “Needs confirmation” for unreadable text; do not invent content. Use [English/Chinese] labels and draw it [to the right of the image/on an empty board]. List three details you could not confirm when done.

Review node count, edge direction, group boundaries, decision branches and small labels. Give precise corrections, for example: “Connect payment failure to refund, not shipping.” Remove or retain the source image only after you have verified the editable redraw.

Without vision, first transcribe the title, nodes, relationships and hierarchy into text or Mermaid, then ask the model to draw it. See [Vision-capable vs text-only models](CONFIGURATION.md#vision-capable-vs-text-only-models).

## Select a region as chat context

1. Choose the region export tool and drag a rectangle.
2. Check the region's dimensions and object counts.
3. Choose “Add to chat” and confirm that the reference appears in the composer.
4. Ask: “Improve this region's layout, keep labels unchanged and avoid editing the rest of the board.”

References communicate intent, not a strict editing-permission boundary. Inspect the result and use undo or snapshots when needed.

## Export one region

The export dialog offers PNG, JPEG, WebP, SVG, PDF, PPTX and draw.io. Resolution and transparency options vary by format. Export does not modify the original board.

PPTX converts supported shapes, text and connectors to editable PowerPoint objects. Imported images remain raster images. Complex styles and fonts may differ in the target application.

## Export multiple slides

1. Choose batch selection.
2. Draw regions in the intended slide order.
3. Undo the last region or clear the selection if necessary.
4. Finish selecting and choose PPT export.
5. Open the result and check page order, fonts, clipping and connectors.

Each region becomes one slide. Other batch formats download one file per region; they are not automatically merged into a multi-page PDF.

You can first ask AI to organize the board into a three-page narrative, review the content, then select the three regions for export. Model-generated business facts still require verification.

### Example: export a three-slide presentation from one board

Goal: turn one mixed board into editable “Problem → Solution → Delivery plan” slides.

1. Ask AI or organize manually into three visually separate regions. For example: “Organize this board into three reporting sections: problem context, solution architecture, and delivery plan. Give each one a title and at most five key points. Do not invent data.”
2. Leave slide margins around each region and remove cross-slide connectors or floating labels.
3. Choose batch selection and drag the three regions in this order: Problem, Solution, Delivery plan.
4. Finish selecting and choose PPT export. Each selected region becomes one slide; AI text does not automatically paginate the presentation.
5. Open the PPTX in PowerPoint or Keynote and check order, substituted fonts, editability and clipping. Edit the board and re-export if necessary.

For one slide, use ordinary region export → PPTX. Other batch formats download one separate file per region rather than creating a multi-page PDF.
