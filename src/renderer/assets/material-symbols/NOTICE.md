# Google Material Symbols

These SVG icons and derived React path registry originate from [Google Material Symbols](https://fonts.google.com/icons), published by Google LLC under the Apache License, Version 2.0.

Official source: https://github.com/google/material-design-icons
Pinned commit: `737e3324305806514d7909874fa1818ae1808232`
Style: Rounded; weight 400; optical size 24; grade 0; fill 0. The nine main navigation icons additionally include the official fill 1 variant.

SVG geometry is retained without modification. The React wrapper uses currentColor and local path arrays in place of Google Fonts; it makes no runtime font or icon network request. All SVG source URLs, SHA-256 hashes, viewBoxes, path counts and component aliases are recorded in manifest.json. Repository uses the generic account_tree symbol, which is not a GitHub logo. ModelDock and third-party tool brand artwork are separate assets.

Regenerate only after reviewing a source revision: `node scripts/update-material-symbols.mjs <40-character-commit>`.
