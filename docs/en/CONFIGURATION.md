# Configuration

[Documentation](README.md) · [中文](../CONFIGURATION.md)

## Models

TuGo can save multiple connections, select a default and choose a model in the chat panel.

- **Display name:** a local label; it is not the model ID.
- **Provider:** the API protocol, not just the service's brand name.
- **Model:** the exact ID accepted by the endpoint.
- **Service URL / request path:** follow the provider or gateway instructions; avoid duplicating paths.
- **API key:** supplied by your model service. TuGo does not provide credits.
- **Context and output limits:** use the actual model specification.
- **Vision:** enable only when image input is supported.

Adapters include OpenAI-compatible, OpenAI Responses, Anthropic and Google/Gemini. Protocol fixtures do not guarantee that every hosted model or gateway works. Test tool calling, streaming and vision with your actual service.

Check errors, model IDs, URLs, permissions, account balance and rate limits before reporting a connection issue. Do not disable TLS verification to bypass certificate errors.

## Vision-capable vs text-only models

“Vision” is a capability flag for **this model connection**. It does not give every model image understanding. The model, selected provider/gateway, and account must all support image input. A wrongly enabled connection can still be rejected by the service.

| Scenario | Vision enabled | Vision disabled |
| --- | --- | --- |
| PNG/JPEG/WebP attached in chat | The image is sent as visual model input | Runtime rejects the image-understanding request instead of pretending the model saw it |
| Agent checks the rendered board | It can create a controlled board screenshot and use image-viewing capability | Screenshot/image-viewing tools are unavailable; it reasons from structured nodes, edges and text only |
| Recreate a screenshot, photo or diagram image | It can inspect layout, shapes, visible text and hierarchy, then redraw editable objects | Provide a textual brief, node list or Mermaid first; it cannot extract the image content |
| Text, code and text-extractable documents | Available | Still available; this does not require vision |
| Cost and context | Images add provider context and may add cost | Images are not sent, usually saving context but preventing visual tasks |

A text-only model can still create diagrams very well from a clear brief, Mermaid, tables, or node/edge lists. A vision model can misread small text, blurry images and dense screenshots; provide textual constraints and review critical results.

If an image is only a board background, use the canvas image-import tool; vision is unnecessary. To have AI understand it, attach the image to chat and select a tested vision-capable model for that turn. See [Examples and prompts](EXAMPLES.md).

## External MCP tools

In Settings → MCP, add a connection:

- Remote servers: choose the matching Streamable HTTP or SSE transport and endpoint.
- stdio servers: configure the executable, arguments and environment. Install any runtime required by that server separately.
- Save and test, review the discovered tools, then choose the allowed tools and whether to bind them to the board Agent.

MCP OAuth login is not currently provided. Headers/environment variables recognized as sensitive are stored as local credential references; do not embed secrets in URLs, arguments or arbitrary unrecognized fields. A stdio server runs with your local user's permissions. Third-party MCP tools do not necessarily share TuGo's built-in attachment restrictions.

## Skills

Use Settings → Skills to view built-ins, import or create a Skill, and maintain its instructions/resources through the editor assistant. Control the available Skills for a board and mention available Skills with `@` in chat.

Review imported instructions and resources. Skills guide the model; they do not guarantee correctness and should not contain secrets.

## Appearance and language

Settings → Appearance controls themes, language and drawing cursors. TuGo's dog is the default cursor.

Available preferences: English, Simplified/Traditional Chinese, Japanese, Korean, Spanish, French, German, Brazilian Portuguese and Russian. System mode selects a supported language from OS preferences, or English if none match. Localization is partial, so some controls and messages remain Chinese.

Built-in prompts use Simplified Chinese, Traditional Chinese or English; non-Chinese UI languages use English prompts. User content and external service responses are not automatically translated.
