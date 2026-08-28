# LinkedIn post draft

I have open-sourced TuGo, a local-first AI-native canvas for diagrams that need to remain editable and deliverable.

The problem I wanted to solve was not “how can AI draw one more diagram?” It was what happens after the first diagram: people need to refine it, ask AI to work on one specific area, and bring the result into a presentation without starting again.

TuGo combines those steps in one desktop workflow:

- AI creates and revises editable canvas content using a model provider you configure.
- Selected regions can be added to the next chat request as explicit visual context.
- Multiple selected regions can be exported as a PowerPoint deck, one region per slide.

The project is new, open source, and still looking for sharp real-world feedback. The README includes real workflow screenshots: [repository link].

Boards, conversations, and attachments are stored locally. External model, Web, and MCP calls may still send relevant information to the services you configure, so please review the privacy notes and validate AI output before delivery.

If you work with architecture diagrams, process maps, or presentation-heavy planning, I would appreciate a bug report, workflow feedback, or contribution.
