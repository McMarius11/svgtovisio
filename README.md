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
- **Connectors & Arrows** — lines, polylines, paths with arrowheads on either or both ends, glued to source/target shapes
- **Text** — labels inside shapes, standalone text, multi-line text, `<tspan>` lines, per-line font size, weight, colour and alignment
- **Styles** — CSS `<style>` blocks and `class` attributes, inherited properties, fill and stroke colours, line width, dash patterns (dashed / dotted / dash-dot), fill and stroke opacity, font size, bold
- **Layout** — positions and sizes converted to Visio coordinates, including the `viewBox` origin
- **Transforms** — `translate`, `scale`, `rotate`, `skew` and `matrix`, composed correctly through nested groups
- **References** — `<use>` is expanded; gradients are flattened to a single colour

## What it cannot do

The converter reports these in the preview rather than dropping them silently:

- `<image>` and `<foreignObject>` are skipped
- `<textPath>` text is placed at its anchor instead of along the path
- `clip-path`, `mask` and `filter` are ignored — shapes are converted unclipped
- gradients and patterns become a flat colour

## How it works

The pipeline is `parse -> scene -> build`, and the scene model is the contract
between the stages:

```
 .svg  ->  SvgParser     \
                          >  Scene  ->  SceneLayout  ->  VsdxBuilder  ->  .vsdx
 .drawio -> DrawioParser /
```

| File | Role | Needs a DOM |
|------|------|-------------|
| `scene-model.js` | The contract: JSDoc types, `normalise()`, `validate()` | no |
| `svg-transform.js` | Affine transform maths | no |
| `svg-style.js` | The CSS cascade, inheritance and paint servers | yes |
| `svg-parser.js` | Walks the SVG DOM and produces a scene | yes |
| `drawio-parser.js` | Walks the Draw.io model and produces a scene | yes |
| `scene-layout.js` | Frame detection, label assignment, connector gluing | no |
| `vsdx-builder.js` | Scene to an OPC package | no |
| `app.js` | Browser UI | yes |

Two rules keep this honest:

- **Both parsers must produce the same scene.** `SceneModel.validate()` runs
  over every sample in the golden-file tests, so a parser that drifts from the
  contract fails loudly instead of producing a subtly wrong `.vsdx`.
- **`SceneLayout` fills gaps, it never overwrites.** Draw.io knows its own edge
  endpoints and labels exactly; guessing geometrically would be strictly worse.
  The layout stage only derives what a parser left as `null`.

Every layout threshold lives in `SceneLayout.TUNING`. When a drawing converts
badly, that is the first place to look.

## Development

```bash
npm ci
npm run check        # lint + type-check + both test suites
npm test             # unit/integration tests and golden-file snapshots
npm run preview -- diagram.svg out.svg   # render what Visio will show
node build.js        # regenerate dist/index.html
```

There is no bundler and no transpiler: the browser loads the sources directly,
and `build.js` inlines them into a single self-contained `dist/index.html`.
TypeScript is used as a **checker only** (`npm run typecheck`) — the types live
in JSDoc comments, so the files stay plain JavaScript.

### Tests

- `test.js` — unit and integration tests, including building a real `.vsdx`
  and validating every XML part in the package.
- `test-golden.js` — snapshots the parsed scene of every sample under
  `test-samples/` into `test-golden/`. Any change to a parser or a heuristic
  shows up as a reviewable diff:

  ```bash
  UPDATE_GOLDEN=1 npm run test:golden   # after an intended change
  ```

`tools/preview.js` renders the generated Visio page back to SVG, which is the
only way to see what Visio will draw without owning Visio.

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
