# SVG to Visio, Draw.io & LibreOffice

Convert SVG diagrams and Draw.io files to editable Visio (`.vsdx`), Draw.io (`.drawio`) and LibreOffice Draw (`.fodg`) files — directly in your browser. No server, no upload, no installation.

**[Use it now](https://McMarius11.github.io/svgtovisio)**

## Features

- **SVG support** — Paste SVG markup or drag & drop `.svg` files
- **Draw.io support** — Import `.drawio` and `.xml` files (including compressed diagrams)
- **Live preview** — See your diagram rendered before converting
- **Fully client-side** — Everything runs in the browser, your data never leaves your machine
- **Three exports** — `.vsdx` (Visio), `.drawio` (draw.io / diagrams.net), `.fodg` (LibreOffice Draw)
- **Editable output** — Shapes, groups and connectors, not a flattened picture

## How to use

1. Open the [converter](https://McMarius11.github.io/svgtovisio)
2. Drag & drop a file (`.svg`, `.drawio`, `.xml`) or paste the markup
3. Check the live preview
4. Click **Convert to .vsdx**, **.drawio** or **.fodg**
5. Open the file in Visio, draw.io or LibreOffice Draw — shapes, groups and arrows stay editable

## What gets preserved

- **Shapes** — rectangles, rounded rectangles, circles, ellipses, diamonds, polygons
- **Connectors & Arrows** — lines, polylines, paths with arrowheads on either or both ends, as real Visio 1-D connectors glued to their source and target, so moving a box takes its arrows along
- **Text** — labels inside shapes, standalone text, multi-line text, `<tspan>` lines, per-line font size, weight, colour and alignment
- **Styles** — CSS `<style>` blocks and `class` attributes, inherited properties, fill and stroke colours, line width, dash patterns (dashed / dotted / dash-dot), fill and stroke opacity, font size, bold
- **Frames** — a box drawn around other shapes becomes a Visio group that declares itself a container, so dragging a subnet or a VNet moves everything inside it
- **Layout** — positions and sizes converted to Visio coordinates, including the `viewBox` origin; shapes stay resizable because their geometry is written as formulas over `Width` and `Height`
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
                          >  Scene  ->  SceneLayout  ->  VsdxBuilder    -> .vsdx
 .drawio -> DrawioParser /                         \->  DrawioBuilder  -> .drawio
                                                   \->  OdgBuilder     -> .fodg
```

| File | Role | Needs a DOM |
|------|------|-------------|
| `scene-model.js` | The contract: JSDoc types, `normalise()`, `validate()` | no |
| `svg-transform.js` | Affine transform maths | no |
| `svg-style.js` | The CSS cascade, inheritance and paint servers | yes |
| `svg-parser.js` | Walks the SVG DOM and produces a scene | yes |
| `drawio-parser.js` | Walks the Draw.io model and produces a scene | yes |
| `scene-layout.js` | Frame detection, label assignment, nesting, connector gluing | no |
| `vsdx-builder.js` | Scene to an OPC package | no |
| `drawio-builder.js` | Scene to native mxGraph XML | no |
| `odg-builder.js` | Scene to flat ODG (`.fodg`) | no |
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
npm run build        # regenerate dist/index.html
npm run preview -- diagram.svg out.svg   # render what Visio will show
node tools/export.js diagram.svg outdir  # write .vsdx, .drawio and .fodg
```

To try a change in the browser, open `dist/index.html` directly after a build,
or serve the project with `npm start`.

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

`test-export.js` builds a `.drawio` and a `.fodg` for every sample and checks
that edges are glued, frames are groups, and polyline waypoints survive.

## License

[MIT](LICENSE) — Third-party licenses: [THIRD-PARTY-LICENSES](THIRD-PARTY-LICENSES)

Uses [JSZip](https://stuk.github.io/jszip/) (MIT) and [pako](https://github.com/nodeca/pako) (MIT/Zlib).
