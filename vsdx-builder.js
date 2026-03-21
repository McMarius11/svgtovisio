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

        this.scale = 1 / 96; // px to inches
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
        return this.pageHeightInches - (svgY * this.scale);
    }

    _svgToVisioX(svgX) {
        return svgX * this.scale;
    }

    _colorToRGB(color) {
        if (!color || color === 'none' || color === 'transparent') return null;

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
</Types>`;
    }

    _rootRels() {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/document" Target="visio/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
    }

    _document() {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<VisioDocument xmlns="http://schemas.microsoft.com/office/visio/2012/main"
               xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
               xml:space="preserve">
  <DocumentProperties>
    <Creator>SVG to Visio Converter</Creator>
    <Description>Converted from SVG</Description>
  </DocumentProperties>
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
      <Line>
        <LineWeight>0.01041666666666667</LineWeight>
        <LineColor>0</LineColor>
        <LinePattern>1</LinePattern>
        <LineCap>0</LineCap>
        <BeginArrow>0</BeginArrow>
        <EndArrow>0</EndArrow>
        <BeginArrowSize>2</BeginArrowSize>
        <EndArrowSize>2</EndArrowSize>
      </Line>
      <Fill>
        <FillForegnd>#FFFFFF</FillForegnd>
        <FillBkgnd>#000000</FillBkgnd>
        <FillPattern>1</FillPattern>
        <ShdwForegnd>#D8D8D8</ShdwForegnd>
        <ShdwPattern>0</ShdwPattern>
      </Fill>
      <Text>
        <Font ID="1"/>
        <Color>#000000</Color>
        <Size>0.1111111111111111</Size>
      </Text>
      <Char IX="0">
        <Font>1</Font>
        <Color>#000000</Color>
        <Size>0.1111111111111111</Size>
      </Char>
      <Para IX="0">
        <HorzAlign>1</HorzAlign>
      </Para>
    </StyleSheet>
  </StyleSheets>
</VisioDocument>`;
    }

    _documentRels() {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/pages" Target="pages/pages.xml"/>
</Relationships>`;
    }

    _pages() {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Pages xmlns="http://schemas.microsoft.com/office/visio/2012/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <Page ID="0" Name="Page-1" NameU="Page-1">
    <PageSheet>
      <PageProps>
        <PageWidth>${this.pageWidthInches}</PageWidth>
        <PageHeight>${this.pageHeightInches}</PageHeight>
        <PageScale>1</PageScale>
        <DrawingScale>1</DrawingScale>
        <DrawingSizeType>1</DrawingSizeType>
        <DrawingScaleType>0</DrawingScaleType>
      </PageProps>
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

    _page1() {
        let shapesXml = '';

        // Render shapes
        for (const shape of this.data.shapes) {
            shapesXml += this._buildShape(shape);
        }

        // Render standalone texts
        for (const text of this.data.texts) {
            shapesXml += this._buildTextShape(text);
        }

        // Render connectors
        for (const conn of this.data.connectors) {
            shapesXml += this._buildConnector(conn);
        }

        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<PageContents xmlns="http://schemas.microsoft.com/office/visio/2012/main"
              xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <Shapes>
${shapesXml}
  </Shapes>
</PageContents>`;
    }

    _buildShape(shape) {
        const id = this._nextId();

        // Center position in Visio coordinates (inches, bottom-left origin)
        const w = shape.width * this.scale;
        const h = shape.height * this.scale;
        const pinX = this._svgToVisioX(shape.x) + w / 2;
        const pinY = this._svgToVisioY(shape.y + shape.height) + h / 2;

        const fillColor = this._colorToRGB(shape.style.fill);
        const lineColor = this._colorToRGB(shape.style.stroke);
        const lineWeight = (shape.style.strokeWidth || 1) * this.scale;

        let geomSection = '';
        let fillSection = '';
        let lineSection = '';
        let textSection = '';
        let charSection = '';

        // Fill
        if (fillColor && shape.style.fill !== 'none') {
            fillSection = `
      <Fill>
        <FillForegnd>${fillColor}</FillForegnd>
        <FillPattern>1</FillPattern>
        <FillForegndTrans>${1 - (shape.style.fillOpacity || 1) * (shape.style.opacity || 1)}</FillForegndTrans>
      </Fill>`;
        } else {
            fillSection = `
      <Fill>
        <FillPattern>0</FillPattern>
      </Fill>`;
        }

        // Line
        if (lineColor && shape.style.stroke !== 'none') {
            const dashPattern = shape.style.strokeDasharray ? '2' : '1';
            lineSection = `
      <Line>
        <LineWeight>${lineWeight}</LineWeight>
        <LineColor>${lineColor}</LineColor>
        <LinePattern>${dashPattern}</LinePattern>
      </Line>`;
        } else {
            lineSection = `
      <Line>
        <LinePattern>0</LinePattern>
      </Line>`;
        }

        // Geometry based on shape type
        switch (shape.type) {
            case 'rect':
                geomSection = this._rectGeom(w, h, shape.style.rx * this.scale);
                break;
            case 'circle':
            case 'ellipse':
                geomSection = this._ellipseGeom(w, h);
                break;
            case 'diamond':
                geomSection = this._diamondGeom(w, h);
                break;
            case 'polygon':
            case 'path-shape':
                geomSection = this._polygonGeom(shape, w, h);
                break;
            default:
                geomSection = this._rectGeom(w, h, 0);
        }

        // Text
        if (shape.text) {
            const textColor = (shape.textStyle && shape.textStyle.textColor) ?
                this._colorToRGB(shape.textStyle.textColor) : '#000000';
            const fontSize = ((shape.textStyle && shape.textStyle.fontSize) || 14) / 72; // pt to inches
            const fontWeight = (shape.textStyle && shape.textStyle.fontWeight === 'bold') ? '1' : '0';

            charSection = `
      <Char IX="0">
        <Font>1</Font>
        <Color>${textColor || '#000000'}</Color>
        <Size>${fontSize}</Size>
        <Style>${fontWeight === '1' ? '1' : '0'}</Style>
      </Char>
      <Para IX="0">
        <HorzAlign>1</HorzAlign>
      </Para>`;

            textSection = `
      <Text>${this._xmlEscape(shape.text)}</Text>`;
        }

        return `    <Shape ID="${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">
      <XForm>
        <PinX>${pinX}</PinX>
        <PinY>${pinY}</PinY>
        <Width>${w}</Width>
        <Height>${h}</Height>
        <LocPinX>${w / 2}</LocPinX>
        <LocPinY>${h / 2}</LocPinY>
        <Angle>0</Angle>
      </XForm>${fillSection}${lineSection}${charSection}${geomSection}${textSection}
    </Shape>
`;
    }

    _rectGeom(w, h, rx) {
        if (rx > 0) {
            // Rounded rectangle
            return `
      <Geom IX="0">
        <NoFill>0</NoFill>
        <NoLine>0</NoLine>
        <MoveTo IX="1"><X>0</X><Y>${rx}</Y></MoveTo>
        <ArcTo IX="2"><X>${rx}</X><Y>0</Y><A>${rx * 0.4142}</A></ArcTo>
        <LineTo IX="3"><X>${w - rx}</X><Y>0</Y></LineTo>
        <ArcTo IX="4"><X>${w}</X><Y>${rx}</Y><A>${rx * 0.4142}</A></ArcTo>
        <LineTo IX="5"><X>${w}</X><Y>${h - rx}</Y></LineTo>
        <ArcTo IX="6"><X>${w - rx}</X><Y>${h}</Y><A>${rx * 0.4142}</A></ArcTo>
        <LineTo IX="7"><X>${rx}</X><Y>${h}</Y></LineTo>
        <ArcTo IX="8"><X>0</X><Y>${h - rx}</Y><A>${rx * 0.4142}</A></ArcTo>
        <LineTo IX="9"><X>0</X><Y>${rx}</Y></LineTo>
      </Geom>`;
        }

        return `
      <Geom IX="0">
        <NoFill>0</NoFill>
        <NoLine>0</NoLine>
        <MoveTo IX="1"><X>0</X><Y>0</Y></MoveTo>
        <LineTo IX="2"><X>${w}</X><Y>0</Y></LineTo>
        <LineTo IX="3"><X>${w}</X><Y>${h}</Y></LineTo>
        <LineTo IX="4"><X>0</X><Y>${h}</Y></LineTo>
        <LineTo IX="5"><X>0</X><Y>0</Y></LineTo>
      </Geom>`;
    }

    _ellipseGeom(w, h) {
        return `
      <Geom IX="0">
        <NoFill>0</NoFill>
        <NoLine>0</NoLine>
        <Ellipse IX="1">
          <X>${w / 2}</X><Y>${h / 2}</Y>
          <A>${w}</A><B>${h / 2}</B>
          <C>${w / 2}</C><D>${h}</D>
        </Ellipse>
      </Geom>`;
    }

    _diamondGeom(w, h) {
        return `
      <Geom IX="0">
        <NoFill>0</NoFill>
        <NoLine>0</NoLine>
        <MoveTo IX="1"><X>${w / 2}</X><Y>0</Y></MoveTo>
        <LineTo IX="2"><X>${w}</X><Y>${h / 2}</Y></LineTo>
        <LineTo IX="3"><X>${w / 2}</X><Y>${h}</Y></LineTo>
        <LineTo IX="4"><X>0</X><Y>${h / 2}</Y></LineTo>
        <LineTo IX="5"><X>${w / 2}</X><Y>0</Y></LineTo>
      </Geom>`;
    }

    _polygonGeom(shape, w, h) {
        if (!shape.points || shape.points.length < 3) {
            return this._rectGeom(w, h, 0);
        }

        // Normalize points to local coordinates (0..w, 0..h)
        let xml = `
      <Geom IX="0">
        <NoFill>0</NoFill>
        <NoLine>0</NoLine>`;

        const pts = shape.points;
        for (let i = 0; i < pts.length; i++) {
            const lx = (pts[i].x - shape.x) * this.scale;
            // Flip Y for Visio local coords
            const ly = h - (pts[i].y - shape.y) * this.scale;

            if (i === 0) {
                xml += `
        <MoveTo IX="1"><X>${lx}</X><Y>${ly}</Y></MoveTo>`;
            } else {
                xml += `
        <LineTo IX="${i + 1}"><X>${lx}</X><Y>${ly}</Y></LineTo>`;
            }
        }

        // Close
        const lx0 = (pts[0].x - shape.x) * this.scale;
        const ly0 = h - (pts[0].y - shape.y) * this.scale;
        xml += `
        <LineTo IX="${pts.length + 1}"><X>${lx0}</X><Y>${ly0}</Y></LineTo>`;

        xml += `
      </Geom>`;

        return xml;
    }

    _buildTextShape(text) {
        const id = this._nextId();

        // Estimate text size
        const fontSize = (text.style.fontSize || 14);
        const estWidth = Math.max(text.text.length * fontSize * 0.6 * this.scale, 1);
        const estHeight = fontSize * 1.5 * this.scale;

        const pinX = this._svgToVisioX(text.x);
        const pinY = this._svgToVisioY(text.y);

        const textColor = this._colorToRGB(text.style.textColor || text.style.fill) || '#000000';
        const fontSizeInches = fontSize / 72;
        const fontWeight = text.style.fontWeight === 'bold' ? '1' : '0';

        return `    <Shape ID="${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">
      <XForm>
        <PinX>${pinX}</PinX>
        <PinY>${pinY}</PinY>
        <Width>${estWidth}</Width>
        <Height>${estHeight}</Height>
        <LocPinX>${estWidth / 2}</LocPinX>
        <LocPinY>${estHeight / 2}</LocPinY>
        <Angle>0</Angle>
      </XForm>
      <Fill>
        <FillPattern>0</FillPattern>
      </Fill>
      <Line>
        <LinePattern>0</LinePattern>
      </Line>
      <Char IX="0">
        <Font>1</Font>
        <Color>${textColor}</Color>
        <Size>${fontSizeInches}</Size>
        <Style>${fontWeight === '1' ? '1' : '0'}</Style>
      </Char>
      <Para IX="0">
        <HorzAlign>1</HorzAlign>
      </Para>
      <Text>${this._xmlEscape(text.text)}</Text>
    </Shape>
`;
    }

    _buildConnector(conn) {
        const id = this._nextId();
        const pts = conn.points;
        if (pts.length < 2) return '';

        const startPt = pts[0];
        const endPt = pts[pts.length - 1];

        // Calculate bounding box
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of pts) {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        }

        const w = Math.max((maxX - minX) * this.scale, 0.01);
        const h = Math.max((maxY - minY) * this.scale, 0.01);
        const pinX = this._svgToVisioX(minX) + w / 2;
        const pinY = this._svgToVisioY(maxY) + h / 2;

        const lineColor = this._colorToRGB(conn.style.stroke) || '#000000';
        const lineWeight = (conn.style.strokeWidth || 1) * this.scale;
        const dashPattern = conn.style.strokeDasharray ? '2' : '1';

        // Arrow
        const endArrow = conn.hasArrow ? '5' : '0';

        // Build geometry
        let geomXml = `
      <Geom IX="0">
        <NoFill>1</NoFill>
        <NoLine>0</NoLine>`;

        for (let i = 0; i < pts.length; i++) {
            const lx = (pts[i].x - minX) * this.scale;
            const ly = h - (pts[i].y - minY) * this.scale;

            if (i === 0) {
                geomXml += `
        <MoveTo IX="1"><X>${lx}</X><Y>${ly}</Y></MoveTo>`;
            } else {
                geomXml += `
        <LineTo IX="${i + 1}"><X>${lx}</X><Y>${ly}</Y></LineTo>`;
            }
        }

        geomXml += `
      </Geom>`;

        // Connection references
        let connXml = '';
        if (conn.fromShape !== null) {
            const fromId = conn.fromShape + 1; // 1-based shape IDs
            connXml += `
      <Connection IX="0">
        <X>0</X><Y>0</Y>
      </Connection>`;
        }

        return `    <Shape ID="${id}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">
      <XForm>
        <PinX>${pinX}</PinX>
        <PinY>${pinY}</PinY>
        <Width>${w}</Width>
        <Height>${h}</Height>
        <LocPinX>${w / 2}</LocPinX>
        <LocPinY>${h / 2}</LocPinY>
        <Angle>0</Angle>
      </XForm>
      <XForm1D>
        <BeginX>${this._svgToVisioX(startPt.x)}</BeginX>
        <BeginY>${this._svgToVisioY(startPt.y)}</BeginY>
        <EndX>${this._svgToVisioX(endPt.x)}</EndX>
        <EndY>${this._svgToVisioY(endPt.y)}</EndY>
      </XForm1D>
      <Fill>
        <FillPattern>0</FillPattern>
      </Fill>
      <Line>
        <LineWeight>${lineWeight}</LineWeight>
        <LineColor>${lineColor}</LineColor>
        <LinePattern>${dashPattern}</LinePattern>
        <BeginArrow>0</BeginArrow>
        <EndArrow>${endArrow}</EndArrow>
        <BeginArrowSize>2</BeginArrowSize>
        <EndArrowSize>2</EndArrowSize>
      </Line>${geomXml}
    </Shape>
`;
    }
}
