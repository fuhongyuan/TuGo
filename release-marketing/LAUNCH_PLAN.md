# TuGo first-launch plan

This plan assumes a first-time open-source maintainer who is not comfortable writing English or using international communities. It does not publish anything automatically. Replace every `[repository link]` with the public repository URL and do not claim a platform build is available until the release contains that installer.

## Before day one: one focused checklist

1. Open `README.md` and `README.en.md` on GitHub while signed out. Confirm every image loads, the language buttons work, and the first screen explains: editable AI canvas, selected context, PPTX delivery, local-first, and bring-your-own model.
2. Read `release-marketing/DEMO_GUIDE.md`. Run `npm run test:electron` and `npm run test:visual` before recording any real-model demo.
3. Configure a real model and capture Demo 1, Demo 2, Demo 3, and the 15–30 second Hero story described in that guide. Keep a clean PNG fallback for each video.
4. Create a GitHub release only after the matching installers, checksums, known limitations, and platform status are clear. Do not attach an untested Windows installer or describe it as verified.
5. Prepare a short disclosure: “TuGo is new; I made it. I am looking for product feedback and bug reports.” It prevents an overly promotional tone.

## Day one: publish one primary discussion, not everything at once

### First: GitHub release and repository page

1. Publish the release only when artifacts are ready.
2. Put the Hero video (or a link to it) and its poster image in the release notes. Link to the README demo section.
3. Enable Issues and Discussions if you are willing to answer them. Add a pinned Discussion called `Feedback and demo workflows` with three prompts: selected-region context, export quality, and model setup.
4. Watch the repository for an hour after release; fix broken links and installer notes before posting elsewhere.

### Second: Hacker News, if the project and demo are ready

Use `SHOW_HN.md`.

- **Title:** `Show HN: TuGo – an open-source AI canvas that turns editable diagrams into PowerPoint slides`
- **Link:** the GitHub repository, not an opaque tracking page.
- **Body:** paste the prepared body, then add the final repository link.
- **Demo:** put the Hero video or its first clear screenshot near the top of the README; do not upload a large autoplaying ad.
- **Reply style:** answer in plain English, cite the exact documentation for privacy or packaging questions, and say “I do not know yet” when you do not know.

Do not post a second HN submission to repeat the same launch. Do not ask friends to manipulate ranking, and do not vote from extra accounts.

### Third: X / LinkedIn only after the primary post is live

Use either the single post or thread in `X.md`, and `LINKEDIN.md`. Link to the same repository and use one clean screenshot or Hero clip. The purpose is to invite people to the project, not to restate every feature.

## Day two or three: community-specific posts

1. **Reddit:** use `REDDIT.md`, but choose a community only after reading its self-promotion and link-post rules. Adapt the opening to the community's topic; do not cross-post identical text to many subreddits in one day.
2. **V2EX:** use `V2EX.md`. Include the real screenshots and invite workflow criticism, not only stars.
3. **知乎:** use `ZHIHU.md` as an article. Add the Hero screenshot after the opening and link to the repository at the end. The article should stand alone as an explanation, not be a copied ad.

Space posts by at least a day when possible. Keep a simple log with date, community, final title, link, and the first useful feedback item.

## How to reply

Use these short answer patterns and adapt them to facts:

- **“Is it private?”** — “Boards, conversations, and attachments are local. A request to an external model, Web, or MCP service can send relevant content to that service. The README links to the privacy notes.”
- **“Does it work with my model?”** — “You configure the provider, model ID, endpoint, and key. I can check a specific provider configuration if you share the non-secret details.”
- **“Can I edit the PowerPoint?”** — “Supported shapes, text, and connectors export as PowerPoint objects. Fonts and complex styles still need checking in PowerPoint or Keynote.”
- **“Does it support Windows/Linux/Intel Mac?”** — “State only the platform status written in the release you published. Do not promise an ETA unless you intend to own it.”
- **Bug report** — thank the person, ask for app version, OS, exact steps, non-secret logs/screenshots, and a minimal board if safe to share. Turn reproducible reports into GitHub issues.

Answer criticism with evidence, not defensiveness. Acknowledge limitations such as model cost, model reliability, non-lossless import/export, and the fact that region references are not hard editing sandboxes.

## Avoid being treated as spam

- Do not buy stars, downloads, votes, comments, or reposts.
- Do not claim users, benchmarks, “best,” or “first” without evidence.
- Do not copy the same post into every community or repeatedly resubmit after removal.
- Do not use unrelated trending topics, fake testimonials, or undisclosed affiliate links.
- Do not tag many strangers asking them to boost it.
- Respect every site's rules, moderators, and requests to remove or revise a post.

## One week later: evaluate and iterate

Create a small issue/feedback summary with actual numbers and dates. Useful signals include:

| Signal | What it tells you | First response |
| --- | --- | --- |
| GitHub stars and traffic | Attention, not product fit | Check which post or demo coincided with the change; do not treat stars as active users. |
| Release downloads by asset | Interest in a platform/build | Compare against installer availability and support questions; investigate failed installs. |
| Issues | Quality and friction | Label reproducible bugs, ask for missing context, and publish fixes with release notes. |
| Discussions and comments | Whether the positioning is understood | Note repeated language; improve README wording or docs where people are confused. |
| Demo feedback | Whether people grasp the selected-context → delivery story | Re-record the Hero if viewers only notice “AI drawing” but miss editability or export. |

At the end of the week, publish a small honest update in GitHub Discussions or release notes: what you heard, what you fixed, and what remains uncertain. Do not manufacture momentum if response is small; a handful of detailed reports is more useful than a large number of empty clicks.
