# Show HN: TuGo – an open-source AI canvas that turns editable diagrams into PowerPoint slides

Hi HN — I made TuGo, a local-first desktop canvas where an AI model and the user work on the same diagram.

The idea came from a gap I kept hitting with AI diagram tools: a prompt could produce something visually useful, but it often stopped at an image or a one-shot diagram. I wanted to keep editing the result directly, select only the part I want to discuss next, and turn a board into a deck without rebuilding it somewhere else.

In TuGo, you can:

- ask a configured model to create or revise diagrams on an infinite canvas;
- select one or more regions and add them as explicit chat references;
- continue editing shapes, text, and connectors yourself;
- batch-select regions and export one editable PPTX slide per region.

The project is new and open source. Boards, conversations, and attachments live locally; model calls use the provider you configure, so local-first does not mean nothing ever leaves the device.

The README has real screenshots of the workflow, including region selection and the export dialog: [repository link]. The current desktop focus is macOS Apple Silicon; Windows packaging exists but should be checked against the release notes.

I would especially value feedback on the AI-to-editable-canvas interaction, PPTX export quality, and the model/provider setup. Bug reports, feature ideas, and contributions are welcome.
