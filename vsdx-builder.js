// @ts-check
/**
 * VSDX Builder - Generates Visio .vsdx files from parsed SVG data.
 *
 * VSDX is a ZIP-based Open Packaging Convention (OPC) format containing:
 * - [Content_Types].xml  - MIME types for package parts
 * - _rels/.rels          - Root relationships
 * - visio/document.xml   - Document properties
 * - visio/pages/pages.xml - Page index
 * - visio/pages/page1.xml - Page content (shapes)
 * - docProps/app.xml     - Application properties
 *
 * Coordinates: Visio uses inches with origin at bottom-left.
 * SVG uses pixels with origin at top-left.
 *
 * Uses the official Cell N="..." V="..." attribute format per MS-VSDX spec.
 * Connectors use <Connects> elements to glue to source/target shapes.
 */

class VsdxBuilder {
    constructor(parsedSvg) {
        this.data = parsedSvg;
        this.shapeIdCounter = 1;
        this.pageWidthInches = this.data.viewBox.width / 96;
        this.pageHeightInches = this.data.viewBox.height / 96;

        // Ensure minimum page size
        if (this.pageWidthInches < 1) this.pageWidthInches = 8.5;
        if (this.pageHeightInches < 1) this.pageHeightInches = 11;

        // A viewBox may start anywhere; without this offset a drawing with a
        // negative origin lands off the page.
        this.viewBoxX = this.data.viewBox.x || 0;
        this.viewBoxY = this.data.viewBox.y || 0;

        this.scale = 1 / 96; // px to inches

        // Text sits this far off the shape's border. Visio's own default is
        // 4pt, which is a different size on every drawing because it does not
        // scale; 4 user units matches the inset the source drawings use.
        this.textMargin = 4 * this.scale;

        // Track shape IDs for connector gluing
        this.shapeIds = []; // index = data.shapes index, value = Visio shape ID
        this.connectorLinks = []; // { connectorId, fromShapeId, toShapeId }
    }

    async build() {
        const zip = new JSZip();

        // Add required VSDX structure
        zip.file('[Content_Types].xml', this._contentTypes());
        zip.file('_rels/.rels', this._rootRels());
        zip.file('visio/document.xml', this._document());
        zip.file('visio/_rels/document.xml.rels', this._documentRels());
        zip.file('visio/pages/pages.xml', this._pages());
        zip.file('visio/pages/_rels/pages.xml.rels', this._pagesRels());
        zip.file('visio/pages/page1.xml', this._page1());
        zip.file('docProps/app.xml', this._appProps());
        zip.file('docProps/core.xml', this._coreProps());
        zip.file('visio/windows.xml', this._windows());

        const blob = await zip.generateAsync({
            type: 'blob',
            mimeType: 'application/vnd.ms-visio.drawing',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 }
        });

        return blob;
    }

    _nextId() {
        return this.shapeIdCounter++;
    }

    // Convert SVG Y (top-down) to Visio Y (bottom-up) in inches
    _svgToVisioY(svgY) {
        return this.pageHeightInches - ((svgY - this.viewBoxY) * this.scale);
    }

    _svgToVisioX(svgX) {
        return (svgX - this.viewBoxX) * this.scale;
    }

    /**
     * Map stroke-dasharray onto Visio's line patterns instead of collapsing
     * every dashed style into the same one.
     * 1 = solid, 2 = dashed, 3 = dotted, 4 = dash-dot.
     */
    _linePattern(dasharray) {
        if (!dasharray) return 1;
        const nums = String(dasharray).split(/[\s,]+/)
            .map(parseFloat).filter(n => !isNaN(n) && n >= 0);
        if (nums.length === 0) return 1;

        const dashes = nums.filter((n, i) => i % 2 === 0);
        if (Math.max.apply(null, dashes) <= 2) return 3;
        if (nums.length >= 4) return 4;
        return 2;
    }

    /** Visio transparency (0..1) from the opacity pair on a style. */
    _transparency(a, b) {
        const v = (a === undefined ? 1 : a) * (b === undefined ? 1 : b);
        return Math.min(1, Math.max(0, 1 - v));
    }

    // SVG text-anchor -> Visio HorzAlign (0 = left, 1 = centre, 2 = right)
    _horzAlign(style) {
        const anchor = (style && style.textAnchor) || 'start';
        if (anchor === 'middle') return 1;
        if (anchor === 'end') return 2;
        return 0;
    }

    /**
     * A geometry cell Visio can rescale.
     *
     * Visio resizes a shape by writing its Width and Height cells and then
     * re-evaluating the geometry. A geometry cell holding a plain number has
     * nothing to re-evaluate, so the outline stays put while the selection
     * frame grows - the shape looks like it cannot be resized at all. Every
     * coordinate therefore carries a formula in terms of Width/Height, with
     * the computed value cached in V for readers that do not evaluate
     * formulas.
     *
     * @param {string} name
     * @param {number} value the cached value, in inches
     * @param {string} formula
     */
    _geomCell(name, value, formula) {
        return `<Cell N="${name}" V="${value}" F="${this._xmlEscape(formula)}"/>`;
    }

    /** A geometry coordinate as a fraction of the shape's Width or Height. */
    _relGeomCell(name, value, extent, dimension) {
        const fraction = extent > 0 ? value / extent : 0;
        return this._geomCell(name, value, `${dimension}*${fraction}`);
    }

    /**
     * Font size in inches.
     *
     * An SVG font size is in user units - the same units as every coordinate
     * on the drawing - so it converts with the same scale. Treating it as
     * points instead (a plain /72) made every label 96/72 = 33% too large for
     * the box around it, which is why text that fitted in the SVG wrapped and
     * spilled out in Visio.
     */
    _fontSizeInches(style) {
        const size = style && style.fontSize ? style.fontSize : 14;
        return size * this.scale;
    }

    /**
     * Rendered width of one line, in inches. Deliberately generous: too wide
     * only costs an invisible margin inside the text block, while too narrow
     * makes Visio wrap a line that fitted in the source drawing.
     */
    _lineWidthInches(text, fontSizeInches) {
        return text.length * fontSizeInches * 0.6;
    }

    /**
     * The text block: margins, and a block at least as large as the text.
     *
     * Visio wraps shape text at the shape's width, so a label wider than its
     * box breaks into extra lines and spills out of a short tile - where the
     * same label in the source SVG simply overflowed on one line. TxtWidth and
     * TxtHeight keep the block as large as the text needs, and the block's pin
     * follows the paragraph alignment so the overflow grows away from the edge
     * the text is anchored to rather than back across it.
     *
     * The formulas keep that true after an edit: the block grows with the
     * shape and never shrinks below what the text needs to stay unwrapped.
     * The literals carry an explicit IN unit, because Visio reads a unitless
     * number in a formula in the drawing's own units - millimetres on a metric
     * installation, which would silently reduce MAX() to Width.
     *
     * @param {{text: string, style: any}[]} runs
     * @param {number} w shape width in inches
     * @param {number} h shape height in inches
     */
    _textBlockCells(runs, w, h) {
        const margin = this.textMargin;
        let needW = 0;
        let needH = 2 * margin;
        let overflowAlign = 0;

        for (const run of runs) {
            const size = this._fontSizeInches(run.style);
            const lineW = this._lineWidthInches(run.text, size) + 2 * margin;
            if (lineW > needW) {
                needW = lineW;
                overflowAlign = this._horzAlign(run.style);
            }
            needH += size * 1.5;
        }

        const txtW = Math.max(w, needW);
        const txtH = Math.max(h, needH);
        const pin = overflowAlign === 1 ? 0.5 : (overflowAlign === 2 ? 1 : 0);

        return `      <Cell N="LeftMargin" V="${margin}"/>
      <Cell N="RightMargin" V="${margin}"/>
      <Cell N="TopMargin" V="${margin}"/>
      <Cell N="BottomMargin" V="${margin}"/>
      <Cell N="VerticalAlign" V="1"/>
      <Cell N="TxtWidth" V="${txtW}" F="MAX(Width,${needW} IN)"/>
      <Cell N="TxtHeight" V="${txtH}" F="MAX(Height,${needH} IN)"/>
      <Cell N="TxtPinX" V="${w * pin}" F="Width*${pin}"/>
      <Cell N="TxtPinY" V="${h * 0.5}" F="Height*0.5"/>
      <Cell N="TxtLocPinX" V="${txtW * pin}" F="TxtWidth*${pin}"/>
      <Cell N="TxtLocPinY" V="${txtH * 0.5}" F="TxtHeight*0.5"/>
`;
    }

    _colorToRGB(color) {
        if (!color || color === 'none' || color === 'transparent') return null;
        // Unresolved paint servers stay unpainted rather than turning black
        if (/^url\(/i.test(color.trim())) return null;

        // Named colors
        const named = {
            'white': '#FFFFFF', 'black': '#000000', 'red': '#FF0000',
            'green': '#008000', 'blue': '#0000FF', 'yellow': '#FFFF00',
            'orange': '#FFA500', 'purple': '#800080', 'gray': '#808080',
            'grey': '#808080', 'lightgray': '#D3D3D3', 'lightgrey': '#D3D3D3',
            'darkgray': '#A9A9A9', 'darkgrey': '#A9A9A9', 'navy': '#000080',
            'teal': '#008080', 'maroon': '#800000', 'olive': '#808000',
            'lime': '#00FF00', 'aqua': '#00FFFF', 'fuchsia': '#FF00FF',
            'silver': '#C0C0C0', 'coral': '#FF7F50', 'salmon': '#FA8072',
            'tomato': '#FF6347', 'gold': '#FFD700', 'khaki': '#F0E68C',
            'pink': '#FFC0CB', 'plum': '#DDA0DD', 'violet': '#EE82EE',
            'indigo': '#4B0082', 'cyan': '#00FFFF', 'magenta': '#FF00FF',
            'crimson': '#DC143C', 'chocolate': '#D2691E', 'sienna': '#A0522D',
            'tan': '#D2B48C', 'wheat': '#F5DEB3', 'ivory': '#FFFFF0',
            'beige': '#F5F5DC', 'linen': '#FAF0E6', 'lavender': '#E6E6FA',
            'steelblue': '#4682B4', 'royalblue': '#4169E1', 'cornflowerblue': '#6495ED',
            'dodgerblue': '#1E90FF', 'deepskyblue': '#00BFFF', 'lightskyblue': '#87CEFA',
            'lightblue': '#ADD8E6', 'powderblue': '#B0E0E6', 'cadetblue': '#5F9EA0',
            'darkblue': '#00008B', 'midnightblue': '#191970', 'slateblue': '#6A5ACD',
            'darkslateblue': '#483D8B', 'mediumslateblue': '#7B68EE',
            'forestgreen': '#228B22', 'darkgreen': '#006400', 'limegreen': '#32CD32',
            'lightgreen': '#90EE90', 'seagreen': '#2E8B57', 'mediumseagreen': '#3CB371',
            'springgreen': '#00FF7F', 'yellowgreen': '#9ACD32', 'olivedrab': '#6B8E23',
            'darkolivegreen': '#556B2F', 'darkred': '#8B0000', 'firebrick': '#B22222',
            'indianred': '#CD5C5C', 'lightcoral': '#F08080', 'darkorange': '#FF8C00',
            'orangered': '#FF4500', 'darkviolet': '#9400D3', 'mediumpurple': '#9370DB',
            'darkorchid': '#9932CC', 'mediumorchid': '#BA55D3', 'orchid': '#DA70D6',
            'rosybrown': '#BC8F8F', 'sandybrown': '#F4A460', 'peru': '#CD853F',
            'saddlebrown': '#8B4513', 'burlywood': '#DEB887', 'darkgoldenrod': '#B8860B',
            'goldenrod': '#DAA520', 'palegoldenrod': '#EEE8AA',
            'darkkhaki': '#BDB76B', 'darkseagreen': '#8FBC8F', 'palegreen': '#98FB98',
            'mediumaquamarine': '#66CDAA', 'mediumturquoise': '#48D1CC',
            'darkturquoise': '#00CED1', 'lightseagreen': '#20B2AA',
            'darkcyan': '#008B8B', 'paleturquoise': '#AFEEEE',
            'aliceblue': '#F0F8FF', 'azure': '#F0FFFF', 'mintcream': '#F5FFFA',
            'honeydew': '#F0FFF0', 'ghostwhite': '#F8F8FF', 'whitesmoke': '#F5F5F5',
            'floralwhite': '#FFFAF0', 'oldlace': '#FDF5E6', 'antiquewhite': '#FAEBD7',
            'papayawhip': '#FFEFD5', 'blanchedalmond': '#FFEBCD',
            'bisque': '#FFE4C4', 'peachpuff': '#FFDAB9', 'navajowhite': '#FFDEAD',
            'moccasin': '#FFE4B5', 'cornsilk': '#FFF8DC', 'lemonchiffon': '#FFFACD',
            'lightyellow': '#FFFFE0', 'lightgoldenrodyellow': '#FAFAD2',
            'mistyrose': '#FFE4E1', 'lavenderblush': '#FFF0F5', 'seashell': '#FFF5EE',
            'snow': '#FFFAFA', 'dimgray': '#696969', 'dimgrey': '#696969',
            'darkslategray': '#2F4F4F', 'darkslategrey': '#2F4F4F',
            'slategray': '#708090', 'slategrey': '#708090',
            'lightslategray': '#778899', 'lightslategrey': '#778899',
            'gainsboro': '#DCDCDC'
        };

        const lower = color.toLowerCase().trim();
        if (named[lower]) return named[lower];

        // Handle rgb() and rgba()
        const rgbMatch = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (rgbMatch) {
            const r = parseInt(rgbMatch[1]).toString(16).padStart(2, '0');
            const g = parseInt(rgbMatch[2]).toString(16).padStart(2, '0');
            const b = parseInt(rgbMatch[3]).toString(16).padStart(2, '0');
            return '#' + r + g + b;
        }

        // Already hex
        if (color.startsWith('#')) {
            if (color.length === 4) {
                return '#' + color[1] + color[1] + color[2] + color[2] + color[3] + color[3];
            }
            return color.toUpperCase();
        }

        return '#000000';
    }

    _xmlEscape(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    _contentTypes() {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/>
  <Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/>
  <Override PartName="/visio/pages/page1.xml" ContentType="application/vnd.ms-visio.page+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/visio/windows.xml" ContentType="application/vnd.ms-visio.windows+xml"/>
</Types>`;
    }

    _rootRels() {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/document" Target="visio/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;
    }

    _document() {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<VisioDocument xmlns="http://schemas.microsoft.com/office/visio/2012/main"
               xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
               xml:space="preserve">
  <DocumentSettings TopPage="0" DefaultTextStyle="0" DefaultLineStyle="0" DefaultFillStyle="0">
    <GlueSettings>9</GlueSettings>
    <SnapSettings>65847</SnapSettings>
    <SnapExtensions>34</SnapExtensions>
  </DocumentSettings>
  <FaceNames>
    <FaceName ID="1" Name="Calibri" UnicodeRanges="-536870145 1073786111 0 0" CharSets="536871327 0" Panos="2 15 5 2 2 2 4 3 2 4"/>
    <FaceName ID="2" Name="Arial" UnicodeRanges="-536870145 1073786111 0 0" CharSets="536871327 0" Panos="2 11 6 4 2 2 2 2 2 4"/>
  </FaceNames>
  <StyleSheets>
    <StyleSheet ID="0" Name="No Style" NameU="No Style">
      <Cell N="LineWeight" V="0.01041666666666667"/>
      <Cell N="LineColor" V="#000000"/>
      <Cell N="LinePattern" V="1"/>
      <Cell N="LineCap" V="0"/>
      <Cell N="BeginArrow" V="0"/>
      <Cell N="EndArrow" V="0"/>
      <Cell N="BeginArrowSize" V="2"/>
      <Cell N="EndArrowSize" V="2"/>
      <Cell N="FillForegnd" V="#FFFFFF"/>
      <Cell N="FillBkgnd" V="#000000"/>
      <Cell N="FillPattern" V="1"/>
      <Cell N="ShdwForegnd" V="#D8D8D8"/>
      <Cell N="ShdwPattern" V="0"/>
      <Section N="Character">
        <Row IX="0">
          <Cell N="Font" V="1"/>
          <Cell N="Color" V="#000000"/>
          <Cell N="Size" V="0.1111111111111111"/>
        </Row>
      </Section>
      <Section N="Paragraph">
        <Row IX="0">
          <Cell N="HorzAlign" V="1"/>
        </Row>
      </Section>
    </StyleSheet>
  </StyleSheets>
</VisioDocument>`;
    }

    _documentRels() {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/pages" Target="pages/pages.xml"/>
  <Relationship Id="rId2" Type="http://schemas.microsoft.com/visio/2010/relationships/windows" Target="windows.xml"/>
</Relationships>`;
    }

    _pages() {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Pages xmlns="http://schemas.microsoft.com/office/visio/2012/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <Page ID="0" Name="Page-1" NameU="Page-1">
    <PageSheet>
      <Cell N="PageWidth" V="${this.pageWidthInches}"/>
      <Cell N="PageHeight" V="${this.pageHeightInches}"/>
      <Cell N="PageScale" V="1"/>
      <Cell N="DrawingScale" V="1"/>
      <Cell N="DrawingSizeType" V="1"/>
      <Cell N="DrawingScaleType" V="0"/>
    </PageSheet>
    <Rel r:id="rId1"/>
  </Page>
</Pages>`;
    }

    _pagesRels() {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/page" Target="page1.xml"/>
</Relationships>`;
    }

    _appProps() {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>SVG to Visio Converter</Application>
  <AppVersion>15.00</AppVersion>
</Properties>`;
    }

    _coreProps() {
        const now = new Date().toISOString();
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                   xmlns:dc="http://purl.org/dc/elements/1.1/"
                   xmlns:dcterms="http://purl.org/dc/terms/"
                   xmlns:dcmitype="http://purl.org/dc/dcmitype/"
                   xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>SVG to Visio Converter</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
    }

    _windows() {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Windows xmlns="http://schemas.microsoft.com/office/visio/2012/main"
         xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <Window ID="0" WindowType="Drawing" WindowState="1073741824"
          WindowLeft="-1" WindowTop="-1" WindowWidth="1024" WindowHeight="768"
          Page="0">
    <ShowGrid>0</ShowGrid>
    <ShowGuides>0</ShowGuides>
    <ShowConnectionPoints>0</ShowConnectionPoints>
    <ShowPageBreaks>0</ShowPageBreaks>
    <TabSplitterPos>0.5</TabSplitterPos>
  </Window>
</Windows>`;
    }

    _page1() {
        let shapesXml = '';
        this.connectorLinks = [];
        // Building the page twice must produce the same IDs
        this.shapeIdCounter = 1;

        // IDs before geometry: a connector may glue to a box nested three
        // frames deep, and <Connects> needs that ID before the tree is walked.
        this.shapeIds = this.data.shapes.map(() => this._nextId());
        this.textIds = this.data.texts.map(() => this._nextId());
        this.connectorIds = this.data.connectors.map(() => this._nextId());

        this.childShapes = new Map();
        this.childTexts = new Map();
        this.childConnectors = new Map();
        this.data.shapes.forEach((shape, i) => this._addChild(this.childShapes, shape.parentShape, i));
        this.data.texts.forEach((text, i) => this._addChild(this.childTexts, text.parentShape, i));
        this.data.connectors.forEach((conn, i) => this._addChild(this.childConnectors, conn.parentShape, i));

        // The page itself is the outermost coordinate system
        const pageOrigin = { x: 0, y: 0 };
        for (const i of (this.childShapes.get(null) || [])) {
            shapesXml += this._buildShapeTree(i, pageOrigin);
        }
        for (const i of (this.childTexts.get(null) || [])) {
            shapesXml += this._buildTextShape(this.data.texts[i], this.textIds[i], pageOrigin);
        }
        for (const i of (this.childConnectors.get(null) || [])) {
            shapesXml += this._buildConnector(this.data.connectors[i], this.connectorIds[i], pageOrigin);
        }
        for (let i = 0; i < this.data.connectors.length; i++) {
            this._trackGlue(this.data.connectors[i], this.connectorIds[i]);
        }

        // Build <Connects> section
        let connectsXml = '';
        if (this.connectorLinks.length > 0) {
            connectsXml = '\n  <Connects>';
            for (const link of this.connectorLinks) {
                connectsXml += `\n    <Connect FromSheet="${link.connectorId}" FromCell="${link.cell}" FromPart="${link.fromPart}" ToSheet="${link.targetId}" ToCell="PinX" ToPart="${link.toPart}"/>`;
            }
            connectsXml += '\n  </Connects>';
        }

        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<PageContents xmlns="http://schemas.microsoft.com/office/visio/2012/main"
              xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
              xml:space="preserve">
  <Shapes>
${shapesXml}
  </Shapes>${connectsXml}
</PageContents>`;
    }

    /**
     * Record a connector's glue for the page's <Connects> section.
     *
     * <Connects> lives on the page whatever depth the shapes sit at, so this
     * runs for every connector, nested or not.
     */
    _trackGlue(conn, id) {
        if (conn.fromShape !== null) {
            this.connectorLinks.push({
                connectorId: id,
                cell: 'BeginX',
                fromPart: 9,
                targetId: this.shapeIds[conn.fromShape],
                toPart: 3
            });
        }
        if (conn.toShape !== null) {
            this.connectorLinks.push({
                connectorId: id,
                cell: 'EndX',
                fromPart: 12,
                targetId: this.shapeIds[conn.toShape],
                toPart: 3
            });
        }
    }

    /** Group children by their parent index, with null for the page itself. */
    _addChild(map, parent, index) {
        const key = parent === undefined ? null : parent;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(index);
    }

    /** A shape's box in absolute Visio inches. */
    _shapeBox(shape) {
        return {
            w: shape.width * this.scale,
            h: shape.height * this.scale,
            left: this._svgToVisioX(shape.x),
            bottom: this._svgToVisioY(shape.y + shape.height)
        };
    }

    /**
     * A shape and everything the layout stage nested inside it.
     *
     * A frame with contents becomes a group, so dragging the frame takes its
     * contents along instead of sliding out from under them. A frame with
     * nothing inside it stays an ordinary shape - a group of one would only
     * make it harder to select.
     */
    _buildShapeTree(index, origin) {
        const shape = this.data.shapes[index];
        const kidShapes = this.childShapes.get(index) || [];
        const kidTexts = this.childTexts.get(index) || [];
        const kidConns = this.childConnectors.get(index) || [];

        if (!kidShapes.length && !kidTexts.length && !kidConns.length) {
            return this._buildShape(shape, this.shapeIds[index], origin, '');
        }

        // A group's children are placed in the group's own coordinate system,
        // whose origin is the group's lower-left corner.
        const box = this._shapeBox(shape);
        const inner = { x: box.left, y: box.bottom };
        let childrenXml = '';
        for (const i of kidShapes) childrenXml += this._buildShapeTree(i, inner);
        for (const i of kidTexts) {
            childrenXml += this._buildTextShape(this.data.texts[i], this.textIds[i], inner);
        }
        // Last, so a route draws over the boxes it runs between
        for (const i of kidConns) {
            childrenXml += this._buildConnector(this.data.connectors[i], this.connectorIds[i], inner);
        }

        return this._buildShape(shape, this.shapeIds[index], origin, childrenXml);
    }

    /**
     * The cells that make a group a Visio container rather than a plain group.
     *
     * A container moves its members with it and still lets a single click
     * select a member, instead of making you step into the group first. Visio
     * drives that from this user-defined cell; a Visio that does not act on it
     * falls back to ordinary group behaviour, which already fixes a frame
     * dragging out from under its contents. Nothing here changes the layout
     * either way.
     */
    _containerSection() {
        return `
      <Section N="User">
        <Row N="msvStructureType"><Cell N="Value" V="Container"/><Cell N="Prompt" V=""/></Row>
      </Section>`;
    }

    /**
     * @param {any} shape
     * @param {number} id
     * @param {{x: number, y: number}} origin the coordinate system to place it in
     * @param {string} childrenXml nested shapes, or '' for a leaf
     */
    _buildShape(shape, id, origin, childrenXml) {
        // Center position in Visio coordinates (inches, bottom-left origin)
        const box = this._shapeBox(shape);
        const w = box.w;
        const h = box.h;
        const pinX = box.left - origin.x + w / 2;
        const pinY = box.bottom - origin.y + h / 2;

        const fillColor = this._colorToRGB(shape.style.fill);
        const lineColor = this._colorToRGB(shape.style.stroke);
        const lineWeight = (shape.style.strokeWidth || 1) * this.scale;

        let cellsXml = '';
        let sectionsXml = '';
        let textXml = '';

        // XForm cells
        cellsXml += `      <Cell N="PinX" V="${pinX}"/>
      <Cell N="PinY" V="${pinY}"/>
      <Cell N="Width" V="${w}"/>
      <Cell N="Height" V="${h}"/>
      <Cell N="LocPinX" V="${w / 2}"/>
      <Cell N="LocPinY" V="${h / 2}"/>
      <Cell N="Angle" V="${shape.angle || 0}"/>
`;

        // Fill cells
        if (fillColor && shape.style.fill !== 'none') {
            const trans = 1 - (shape.style.fillOpacity || 1) * (shape.style.opacity || 1);
            cellsXml += `      <Cell N="FillForegnd" V="${fillColor}"/>
      <Cell N="FillPattern" V="1"/>
      <Cell N="FillForegndTrans" V="${trans}"/>
`;
        } else {
            cellsXml += `      <Cell N="FillPattern" V="0"/>
`;
        }

        // Line cells
        if (lineColor && shape.style.stroke !== 'none') {
            const dashPattern = this._linePattern(shape.style.strokeDasharray);
            const lineTrans = this._transparency(shape.style.strokeOpacity, shape.style.opacity);
            cellsXml += `      <Cell N="LineWeight" V="${lineWeight}"/>
      <Cell N="LineColor" V="${lineColor}"/>
      <Cell N="LineColorTrans" V="${lineTrans}"/>
      <Cell N="LinePattern" V="${dashPattern}"/>
`;
        } else {
            cellsXml += `      <Cell N="LinePattern" V="0"/>
`;
        }

        // Rounding for rects
        if (shape.type === 'rect' && shape.style.rx > 0) {
            cellsXml += `      <Cell N="Rounding" V="${shape.style.rx * this.scale}"/>
`;
        }

        // Geometry section
        switch (shape.type) {
            case 'rect':
                sectionsXml += this._rectGeom();
                break;
            case 'circle':
            case 'ellipse':
                sectionsXml += this._ellipseGeom(w, h);
                break;
            case 'diamond':
                sectionsXml += this._diamondGeom(w, h);
                break;
            case 'polygon':
            case 'path-shape':
                sectionsXml += this._polygonGeom(shape, w, h);
                break;
            default:
                sectionsXml += this._rectGeom();
        }

        // Text: one character/paragraph run per source line, referenced from
        // <Text> via <pp>/<cp>, so a heading and its detail lines keep their
        // own size, weight, colour and alignment inside a single shape.
        if (shape.text) {
            const runs = (shape.textRuns && shape.textRuns.length)
                ? shape.textRuns
                : [{ text: shape.text, style: shape.textStyle || {} }];

            const charKeys = [];
            const paraKeys = [];
            let charRows = '';
            let paraRows = '';
            const bodyLines = [];

            for (const run of runs) {
                const st = run.style || {};
                const color = this._colorToRGB(st.textColor || st.fill) || '#000000';
                const size = this._fontSizeInches(st);
                const bold = st.fontWeight === 'bold' ? '1' : '0';
                const align = this._horzAlign(st);

                const cKey = color + '|' + size + '|' + bold;
                let cIx = charKeys.indexOf(cKey);
                if (cIx === -1) {
                    cIx = charKeys.push(cKey) - 1;
                    charRows += `
        <Row IX="${cIx}">
          <Cell N="Font" V="1"/>
          <Cell N="Color" V="${color}"/>
          <Cell N="Size" V="${size}"/>
          <Cell N="Style" V="${bold}"/>
        </Row>`;
                }

                const pKey = String(align);
                let pIx = paraKeys.indexOf(pKey);
                if (pIx === -1) {
                    pIx = paraKeys.push(pKey) - 1;
                    paraRows += `
        <Row IX="${pIx}">
          <Cell N="HorzAlign" V="${align}"/>
        </Row>`;
                }

                bodyLines.push(`<pp IX="${pIx}"/><cp IX="${cIx}"/>${this._xmlEscape(run.text)}`);
            }

            cellsXml += this._textBlockCells(runs, w, h);

            sectionsXml += `
      <Section N="Character">${charRows}
      </Section>
      <Section N="Paragraph">${paraRows}
      </Section>`;

            textXml = `
      <Text>${bodyLines.join('\n')}</Text>`;
        }

        if (childrenXml) {
            sectionsXml += this._containerSection();
            return `    <Shape ID="${id}" Type="Group" LineStyle="0" FillStyle="0" TextStyle="0">
${cellsXml}${sectionsXml}${textXml}
      <Shapes>
${childrenXml}      </Shapes>
    </Shape>
`;
        }

        return `    <Shape ID="${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">
${cellsXml}${sectionsXml}${textXml}
    </Shape>
`;
    }

    /**
     * A rectangle in relative coordinates, so it follows Width and Height.
     *
     * Rounded corners are not drawn as arcs here: the Rounding cell rounds the
     * corners of whatever path a shape has, and a constant radius survives a
     * resize the way arc coordinates would not.
     */
    _rectGeom() {
        return `
      <Section N="Geometry" IX="0">
        <Cell N="NoFill" V="0"/>
        <Cell N="NoLine" V="0"/>
        <Row T="RelMoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>
        <Row T="RelLineTo" IX="2"><Cell N="X" V="1"/><Cell N="Y" V="0"/></Row>
        <Row T="RelLineTo" IX="3"><Cell N="X" V="1"/><Cell N="Y" V="1"/></Row>
        <Row T="RelLineTo" IX="4"><Cell N="X" V="0"/><Cell N="Y" V="1"/></Row>
        <Row T="RelLineTo" IX="5"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>
      </Section>`;
    }

    _ellipseGeom(w, h) {
        return `
      <Section N="Geometry" IX="0">
        <Cell N="NoFill" V="0"/>
        <Cell N="NoLine" V="0"/>
        <Row T="Ellipse" IX="1">
          ${this._geomCell('X', w / 2, 'Width*0.5')}${this._geomCell('Y', h / 2, 'Height*0.5')}
          ${this._geomCell('A', w, 'Width*1')}${this._geomCell('B', h / 2, 'Height*0.5')}
          ${this._geomCell('C', w / 2, 'Width*0.5')}${this._geomCell('D', h, 'Height*1')}
        </Row>
      </Section>`;
    }

    // The diamond is drawn with relative coordinates, so its size is implied
    _diamondGeom(_w, _h) {
        return `
      <Section N="Geometry" IX="0">
        <Cell N="NoFill" V="0"/>
        <Cell N="NoLine" V="0"/>
        <Row T="RelMoveTo" IX="1"><Cell N="X" V="0.5"/><Cell N="Y" V="0"/></Row>
        <Row T="RelLineTo" IX="2"><Cell N="X" V="1"/><Cell N="Y" V="0.5"/></Row>
        <Row T="RelLineTo" IX="3"><Cell N="X" V="0.5"/><Cell N="Y" V="1"/></Row>
        <Row T="RelLineTo" IX="4"><Cell N="X" V="0"/><Cell N="Y" V="0.5"/></Row>
        <Row T="RelLineTo" IX="5"><Cell N="X" V="0.5"/><Cell N="Y" V="0"/></Row>
      </Section>`;
    }

    _polygonGeom(shape, w, h) {
        if (!shape.points || shape.points.length < 3) {
            return this._rectGeom();
        }

        let xml = `
      <Section N="Geometry" IX="0">
        <Cell N="NoFill" V="0"/>
        <Cell N="NoLine" V="0"/>`;

        const pts = shape.points;
        for (let i = 0; i < pts.length; i++) {
            const lx = (pts[i].x - shape.x) * this.scale;
            // Flip Y for Visio local coords
            const ly = h - (pts[i].y - shape.y) * this.scale;

            if (i === 0) {
                xml += `
        <Row T="MoveTo" IX="1">${this._relGeomCell('X', lx, w, 'Width')}${this._relGeomCell('Y', ly, h, 'Height')}</Row>`;
            } else {
                xml += `
        <Row T="LineTo" IX="${i + 1}">${this._relGeomCell('X', lx, w, 'Width')}${this._relGeomCell('Y', ly, h, 'Height')}</Row>`;
            }
        }

        // Close
        const lx0 = (pts[0].x - shape.x) * this.scale;
        const ly0 = h - (pts[0].y - shape.y) * this.scale;
        xml += `
        <Row T="LineTo" IX="${pts.length + 1}">${this._relGeomCell('X', lx0, w, 'Width')}${this._relGeomCell('Y', ly0, h, 'Height')}</Row>`;

        xml += `
      </Section>`;

        return xml;
    }

    /**
     * @param {any} text
     * @param {number} id
     * @param {{x: number, y: number}} origin the coordinate system to place it in
     */
    _buildTextShape(text, id, origin) {
        // Estimate text size from the widest line, not the whole string
        const fontSizeInches = this._fontSizeInches(text.style);
        const lines = text.text.split('\n');
        const runs = lines.map(line => ({ text: line, style: text.style }));
        const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), '');
        const margin = this.textMargin;
        const estWidth = Math.max(this._lineWidthInches(longest, fontSizeInches) + 2 * margin, 1);
        const estHeight = 2 * margin + Math.max(lines.length, 1) * fontSizeInches * 1.5;

        const pinX = this._svgToVisioX(text.x) - origin.x;
        const pinY = this._svgToVisioY(text.y) - origin.y;

        // In SVG, x is the anchor point and y is the baseline. Visio positions a
        // box by its local pin, so move the pin to match the anchor and lift the
        // box off the baseline - otherwise every label drifts left and down.
        const horzAlign = this._horzAlign(text.style);
        const locPinX = horzAlign === 1 ? estWidth / 2 : (horzAlign === 2 ? estWidth : 0);
        const locPinY = estHeight / 2 - 0.35 * fontSizeInches;

        const textColor = this._colorToRGB(text.style.textColor || text.style.fill) || '#000000';
        const isBold = text.style.fontWeight === 'bold';

        return `    <Shape ID="${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">
      <Cell N="PinX" V="${pinX}"/>
      <Cell N="PinY" V="${pinY}"/>
      <Cell N="Width" V="${estWidth}"/>
      <Cell N="Height" V="${estHeight}"/>
      <Cell N="LocPinX" V="${locPinX}"/>
      <Cell N="LocPinY" V="${locPinY}"/>
      <Cell N="Angle" V="0"/>
      <Cell N="FillPattern" V="0"/>
      <Cell N="LinePattern" V="0"/>
${this._textBlockCells(runs, estWidth, estHeight)}      <Section N="Character">
        <Row IX="0">
          <Cell N="Font" V="1"/>
          <Cell N="Color" V="${textColor}"/>
          <Cell N="Size" V="${fontSizeInches}"/>
          <Cell N="Style" V="${isBold ? '1' : '0'}"/>
        </Row>
      </Section>
      <Section N="Paragraph">
        <Row IX="0">
          <Cell N="HorzAlign" V="${horzAlign}"/>
        </Row>
      </Section>
      <Text>${this._xmlEscape(text.text)}</Text>
    </Shape>
`;
    }

    /**
     * A connector, as a Visio 1-D shape.
     *
     * Visio only treats a shape as a connector - and only honours the glue
     * recorded in <Connects> - when OneD is set. Without it the Begin/End
     * cells describe endpoints of a shape that has none, so the arrows sat on
     * the page unattached and stayed behind when a box moved.
     *
     * A 1-D shape lives in the frame its own endpoints define: local X runs
     * from the begin point to the end point, local Y is the perpendicular
     * offset. Elbows therefore survive as drawn, and because the XForm cells
     * are formulas over Begin/End, moving a glued box re-places the endpoint
     * and the whole route follows.
     *
     * A connector usually stays on the page: page-level glue reaches a shape
     * at any depth, and a route crossing a frame boundary belongs to neither
     * frame. One whose whole route and both ends are inside a single frame is
     * nested into it, so it travels with the frame instead of stretching.
     *
     * @param {any} conn
     * @param {number} id
     * @param {{x: number, y: number}} origin the coordinate system to place it in
     */
    _buildConnector(conn, id, origin) {
        const pts = conn.points;
        if (pts.length < 2) return '';

        // Visio coordinates, y growing upwards, before any local frame
        const vpts = pts.map(p => ({
            x: this._svgToVisioX(p.x) - origin.x,
            y: this._svgToVisioY(p.y) - origin.y
        }));
        const begin = vpts[0];
        const end = vpts[vpts.length - 1];

        const spanX = end.x - begin.x;
        const spanY = end.y - begin.y;
        const length = Math.hypot(spanX, spanY);
        // A connector whose ends coincide has no direction to lay a local
        // frame along; keep it visible rather than dividing by zero.
        const w = Math.max(length, 0.01);
        const angle = length > 0 ? Math.atan2(spanY, spanX) : 0;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        const local = vpts.map(p => {
            const dx = p.x - begin.x;
            const dy = p.y - begin.y;
            return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
        });

        // Height is the route's perpendicular extent, doubled so the line
        // itself keeps Visio's usual place at half the shape's height.
        const perp = local.reduce((m, p) => Math.max(m, Math.abs(p.y)), 0);
        const h = 2 * perp;

        const lineColor = this._colorToRGB(conn.style.stroke) || '#000000';
        const lineWeight = (conn.style.strokeWidth || 1) * this.scale;
        const dashPattern = this._linePattern(conn.style.strokeDasharray);
        const lineTrans = this._transparency(conn.style.strokeOpacity, conn.style.opacity);

        // Arrow: 5 = filled triangle
        // SceneModel guarantees both ends are present and boolean
        const beginArrow = conn.arrowStart ? '5' : '0';
        const endArrow = conn.arrowEnd ? '5' : '0';

        let geomXml = `
      <Section N="Geometry" IX="0">
        <Cell N="NoFill" V="1"/>
        <Cell N="NoLine" V="0"/>`;

        local.forEach((p, i) => {
            const ly = h / 2 + p.y;
            const row = i === 0 ? 'MoveTo' : 'LineTo';
            geomXml += `
        <Row T="${row}" IX="${i + 1}">${this._relGeomCell('X', p.x, w, 'Width')}${this._relGeomCell('Y', ly, h, 'Height')}</Row>`;
        });

        geomXml += `
      </Section>`;

        // The XForm follows the endpoints, the way Visio's own connectors do,
        // so re-gluing an end moves and re-aims the whole shape.
        return `    <Shape ID="${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">
      <Cell N="OneD" V="1"/>
      <Cell N="BeginX" V="${begin.x}"/>
      <Cell N="BeginY" V="${begin.y}"/>
      <Cell N="EndX" V="${end.x}"/>
      <Cell N="EndY" V="${end.y}"/>
      <Cell N="PinX" V="${(begin.x + end.x) / 2}" F="(BeginX+EndX)/2"/>
      <Cell N="PinY" V="${(begin.y + end.y) / 2}" F="(BeginY+EndY)/2"/>
      <Cell N="Width" V="${w}" F="SQRT((EndX-BeginX)^2+(EndY-BeginY)^2)"/>
      <Cell N="Height" V="${h}"/>
      <Cell N="LocPinX" V="${w / 2}" F="Width*0.5"/>
      <Cell N="LocPinY" V="${h / 2}" F="Height*0.5"/>
      <Cell N="Angle" V="${angle}" F="ATAN2(EndY-BeginY,EndX-BeginX)"/>
      <Cell N="FillPattern" V="0"/>
      <Cell N="LineWeight" V="${lineWeight}"/>
      <Cell N="LineColor" V="${lineColor}"/>
      <Cell N="LinePattern" V="${dashPattern}"/>
      <Cell N="BeginArrow" V="${beginArrow}"/>
      <Cell N="EndArrow" V="${endArrow}"/>
      <Cell N="BeginArrowSize" V="2"/>
      <Cell N="EndArrowSize" V="2"/>
      <Cell N="LineColorTrans" V="${lineTrans}"/>${geomXml}
    </Shape>
`;
    }
}
