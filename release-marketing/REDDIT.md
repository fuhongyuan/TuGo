# Reddit post draft

## Title

I built TuGo: a local-first AI canvas where selected diagram regions can become the next prompt — and then a PPTX deck

## Body

I have been working on a small open-source desktop project called TuGo.

I like using AI to get the first version of a diagram, but I do not want the output to be a static image or a dead-end blob of generated text. The workflow I wanted was: make a diagram with AI, edit it normally, point to a specific part when asking for the next change, and export the useful pieces as editable slides.

That is what TuGo is trying to be:

- an infinite canvas with editable shapes, text, and connectors;
- AI creation and revision through a model provider you configure;
- region selection that can be added to chat as explicit context;
- batch selection that makes one PPTX slide per selected region.

The project is local-first: boards, chats, and attachments are stored locally. Model/Web/MCP calls can still send relevant content to the services you choose, so it is not a promise that data never leaves the machine.

The repository and real screenshots are here: [repository link]. I am sharing it as a new project, not as a finished product with a large user base. I would love practical feedback: does region-as-context solve a real problem for you, what fails in your diagram-to-slide workflow today, and what should be tested before you would trust a PPTX export?

Please read the target community's rules before posting; adapt the title and remove any link-only wording if self-promotion rules require a fuller discussion.
