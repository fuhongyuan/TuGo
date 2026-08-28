# Third-party software / 第三方许可

TuGo project files use [Apache License 2.0](LICENSE), with attribution in [NOTICE](NOTICE). Dependencies retain their own copyrights and licenses. This inventory is not a substitute for original license texts or a claim that a full distribution audit has passed.

## Direct component inventory

Identifiers below were checked against installed package manifests. Exact versions must come from package-lock.json and the final build.

| Component | Declared license |
| --- | --- |
| Electron | MIT; bundled Chromium has additional third-party notices |
| React / React DOM | MIT |
| Lucide React | ISC |
| Mermaid | MIT |
| PptxGenJS | MIT |
| jsPDF | MIT |
| react-markdown / remark-gfm | MIT |
| @modelcontextprotocol/sdk | MIT |
| Ajv | MIT |
| JSZip | MIT OR GPL-3.0-or-later; TuGo uses the MIT option |
| PDF.js (pdfjs-dist) | Apache-2.0 |
| sql.js | MIT |
| Undici | MIT |
| Vite (build tooling) | MIT |
| TypeScript (build tooling) | Apache-2.0 |

Transitive dependencies and assets can add notices. Frontend packages in devDependencies are compiled into the renderer and must not be omitted from review.

## Distribution checklist

- Preserve upstream LICENSE, COPYING and NOTICE files for shipped packages.
- Preserve legal files distributed with Electron/Chromium.
- Collect applicable license text and attribution for packages compiled into frontend JavaScript.
- Generate an SBOM/inventory from the final build; review missing or changed licenses.
- An SBOM is not a replacement for license text.
- Review contributed images, examples, Skills and other assets for provenance and rights.

这是清单与检查说明，不是全量合规认证。实际发布前按 [发布清单](docs/RELEASING.md) 完成依赖和资源审查。

The standard Apache-2.0 text remains intact: bracketed example fields in its appendix are part of the standard text. Project attribution is supplied separately in NOTICE. See the [official license](https://www.apache.org/licenses/LICENSE-2.0.txt) and [application guidance](https://www.apache.org/foundation/license-faq.html#Apply-My-Software).
