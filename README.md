# SVG to Visio Converter

Convert Claude-generated SVG diagrams to editable Visio (.vsdx) files — directly in your browser.

**[Use it now](https://McMarius11.github.io/svgtovisio)**

## How it works

1. Ask Claude to create a diagram (flowchart, architecture, sequence, etc.)
2. Copy the SVG output
3. Paste it into the converter (or drag & drop the `.svg` file)
4. Click **Convert to .vsdx**
5. Open the downloaded file in Microsoft Visio — all shapes and arrows are fully editable

## What gets preserved

- **Shapes** — rectangles, rounded rectangles, circles, ellipses, diamonds, polygons
- **Connectors & Arrows** — lines, polylines, paths with arrowheads, glued to source/target shapes
- **Text** — labels inside shapes, standalone text, multi-line text
- **Styles** — fill colors, stroke colors, line width, dashed lines, opacity, font size, bold
- **Layout** — positions and sizes are accurately converted from SVG to Visio coordinates

## Run locally

```bash
# Just open the HTML file
open index.html

# Or serve it
npx serve .
```

## Run tests

```bash
npm install
npm test
```

## How it works under the hood

The converter runs entirely in the browser — no server needed.

1. **SVG Parser** (`svg-parser.js`) — Parses the SVG DOM and extracts shapes, connectors, text, and styles. Associates text labels with their containing shapes and detects which shapes connectors link to.

2. **VSDX Builder** (`vsdx-builder.js`) — Generates a valid Visio `.vsdx` file (a ZIP archive with XML files following the MS-VSDX/Open Packaging Convention spec). Converts SVG coordinates (top-left origin, pixels) to Visio coordinates (bottom-left origin, inches). Uses [JSZip](https://stuk.github.io/jszip/) via CDN.

3. **App** (`app.js`) — Handles the drag-and-drop UI, SVG preview, and download.

## License

[MIT](LICENSE)
