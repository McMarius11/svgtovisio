# SVG & Draw.io to Visio Converter

Convert SVG diagrams and Draw.io files to editable Visio (.vsdx) files — directly in your browser. No server, no upload, no installation.

**[Use it now](https://McMarius11.github.io/svgtovisio)**

## Features

- **SVG support** — Paste SVG markup or drag & drop `.svg` files
- **Draw.io support** — Import `.drawio` and `.xml` files (including compressed diagrams)
- **Live preview** — See your diagram rendered before converting
- **Fully client-side** — Everything runs in the browser, your data never leaves your machine
- **Editable output** — Shapes, connectors, and text in the `.vsdx` are fully editable in Microsoft Visio

## How to use

1. Open the [converter](https://McMarius11.github.io/svgtovisio)
2. Drag & drop a file (`.svg`, `.drawio`, `.xml`) or paste the markup
3. Check the live preview
4. Click **Convert to .vsdx**
5. Open the downloaded file in Microsoft Visio — all shapes and arrows are fully editable

## What gets preserved

- **Shapes** — rectangles, rounded rectangles, circles, ellipses, diamonds, polygons
- **Connectors & Arrows** — lines, polylines, paths with arrowheads, glued to source/target shapes
- **Text** — labels inside shapes, standalone text, multi-line text
- **Styles** — fill colors, stroke colors, line width, dashed lines, opacity, font size, bold
- **Layout** — positions and sizes are accurately converted to Visio coordinates

## Run locally

```bash
# Just open the standalone build
open dist/index.html

# Or serve the project
npx serve .
```

## Build & test

```bash
npm install

# Build standalone dist/index.html (all dependencies inlined)
node build.js

# Run tests
npm test
```

## Architecture

The converter runs entirely in the browser — no server needed.

1. **SVG Parser** (`svg-parser.js`) — Parses the SVG DOM and extracts shapes, connectors, text, and styles. Associates text labels with their containing shapes and detects connector endpoints.

2. **Draw.io Parser** (`drawio-parser.js`) — Parses Draw.io XML (mxGraphModel), including compressed diagrams. Extracts vertices, edges, styles, and labels into the same format as the SVG parser.

3. **VSDX Builder** (`vsdx-builder.js`) — Generates a valid `.vsdx` file (ZIP with XML following the MS-VSDX/Open Packaging Convention spec). Converts coordinates to Visio's bottom-left origin system in inches. Uses [JSZip](https://stuk.github.io/jszip/).

4. **App** (`app.js`) — Handles drag-and-drop, file detection, live preview rendering, and download.

## License

[MIT](LICENSE) — Third-party licenses: [THIRD-PARTY-LICENSES](THIRD-PARTY-LICENSES)

Uses [JSZip](https://stuk.github.io/jszip/) (MIT) and [pako](https://github.com/nodeca/pako) (MIT/Zlib).
