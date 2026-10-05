# Third-party notices

ModelDock's original code and its original application mark are covered by the
[MIT license](LICENSE). This does not replace the licenses of third-party
artwork, dependencies or source portions, or grant rights to their trademarks.
Keep the original copyright and license notices when redistributing them.

## Artwork

| Material | Source | License and local records |
| --- | --- | --- |
| Material Symbols Rounded | [Google material-design-icons](https://github.com/google/material-design-icons), revision `737e3324305806514d7909874fa1818ae1808232` | Apache-2.0; [license](src/renderer/assets/material-symbols/LICENSE-Apache-2.0.txt), [notice](src/renderer/assets/material-symbols/NOTICE.md), [manifest](src/renderer/assets/material-symbols/manifest.json) |
| Codex / OpenAI and VS Code identification marks | [Microsoft vscode-codicons](https://github.com/microsoft/vscode-codicons) | CC-BY-4.0; [license](src/renderer/assets/tool-icons/LICENSE-codicons.txt), [notice](src/renderer/assets/tool-icons/NOTICE.md) |
| OpenCode identification mark | [anomalyco/opencode](https://github.com/anomalyco/opencode) | MIT; [license](src/renderer/assets/tool-icons/LICENSE-opencode.txt), [notice](src/renderer/assets/tool-icons/NOTICE.md) |
| DSH / DeepSeek identification mark | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | MIT; [license](src/renderer/assets/tool-icons/LICENSE-deepseek-harness.txt), [notice](src/renderer/assets/tool-icons/NOTICE.md), [brand guidance](https://github.com/deepseek-ai/deepseek-harness/blob/master/BRAND_GUIDELINES.md) |
| GitHub Copilot identification mark | [GitHub Octicons](https://github.com/github/octicons) | MIT; [license](src/renderer/assets/tool-icons/LICENSE-octicons.txt), [notice](src/renderer/assets/tool-icons/NOTICE.md) |

The artwork identifies compatible products and does not imply endorsement.
SVG geometry is preserved; ModelDock renders it in its theme colors. Material
Symbols are converted into a local React path registry. Their notice and
manifest record these changes, fixed source revisions and content hashes. Tool
marks have a separate [verified manifest](src/renderer/assets/tool-icons/manifest.json).
Source SVGs and third-party licenses remain separate from ModelDock's own mark.

## Protocol and schema references

The authorization, configuration and usage adapters reference
[CC Switch](https://github.com/farion1231/cc-switch), principally v4.0.0,
v4.0.3 and revision `d455dd85720a4e48a59d02396539b480d9767902`, together with
first-party documentation and source. The referenced CC Switch license is MIT,
with `Copyright (c) 2025 Jason Young`; its [license text](https://github.com/farion1231/cc-switch/blob/v4.0.0/LICENSE)
remains authoritative. Source links are recorded
in the relevant adapters and README; reference checkouts under `work/` are
excluded from Git and application packages.

Protocol facts or a compatible API shape do not license an entire implementation
under another project's license. When adding a copied or adapted source portion,
record its fixed revision and changes, and retain its actual copyright and
license text. Do not remove required public attribution during secret cleanup.

## Dependencies and distributed application

Installed versions are pinned by `package-lock.json`. React, React DOM,
scheduler, jsonc-parser and sql.js are MIT licensed; yaml and @iarna/toml are
ISC licensed in the current locked tree. Each dependency retains its own
license; its package's license text is authoritative. Runtime package
licenses are included with their files in `resources/app.asar`, including React,
React DOM, scheduler, yaml, jsonc-parser, sql.js and @iarna/toml. Electron and
Chromium's notices are distributed alongside the executable.

Electron packages additionally carry tool-icon and Material notices under
`resources/licenses/`. A release must preserve these files and include
ModelDock's LICENSE and this index. Do not assume a source package's MIT license
relicenses every dependency or image in the application.
