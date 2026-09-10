// @ts-check
/**
 * Render the generated Visio page back to an SVG, so you can see what Visio
 * will draw without owning Visio.
 *
 * This reads the built page XML - not the input - so it shows what actually
 * survived the conversion. Comparing it against the source SVG in a browser is
 * the fastest way to spot a conversion regression.
 *
 *   node tools/preview.js input.svg out.svg
 *   node tools/preview.js input.drawio out.svg
 */

const fs = require('fs');
const path = require('path');
const { load } = require('./load.js');

const PX_PER_INCH = 96;

function esc(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {string} inputPath
 * @returns {{svg: string, pageXml: string, warnings: string[]}}
 */
function preview(inputPath) {
    const { SvgParser, DrawioParser, VsdxBuilder, domParser, window } = load();

    const source = fs.readFileSync(inputPath, 'utf8');
    const isDrawio = /\.(drawio|xml)$/.test(inputPath);
    const scene = new (isDrawio ? DrawioParser : SvgParser)(source).parse();

    const builder = new VsdxBuilder(scene);
    const pageXml = builder._page1();
    const doc = domParser.parseFromString(pageXml, 'application/xml');

    const pageW = builder.pageWidthInches;
    const pageH = builder.pageHeightInches;
    const cell = (shape, name) => {
        const c = shape.querySelector(`Cell[N="${name}"]`);
        return c ? c.getAttribute('V') : null;
    };
    const num = (shape, name, fallback) => {
        const v = parseFloat(cell(shape, name));
        return isNaN(v) ? fallback : v;
    };

    let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${pageW * PX_PER_INCH}" ` +
        `height="${pageH * PX_PER_INCH}" viewBox="0 0 ${pageW * PX_PER_INCH} ${pageH * PX_PER_INCH}" ` +
        `font-family="Arial, Helvetica, sans-serif">` +
        `<defs><marker id="a" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">` +
        `<path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>` +
        `<rect width="100%" height="100%" fill="#ffffff"/>`;

    for (const shape of Array.from(doc.querySelectorAll('Shape'))) {
        const w = num(shape, 'Width', 0) * PX_PER_INCH;
        const h = num(shape, 'Height', 0) * PX_PER_INCH;
        const pinX = num(shape, 'PinX', 0) * PX_PER_INCH;
        const pinY = num(shape, 'PinY', 0) * PX_PER_INCH;
        const locX = num(shape, 'LocPinX', w / PX_PER_INCH / 2) * PX_PER_INCH;
        const locY = num(shape, 'LocPinY', h / PX_PER_INCH / 2) * PX_PER_INCH;
        const left = pinX - locX;
        const top = pageH * PX_PER_INCH - (pinY - locY + h);

        const fillPattern = num(shape, 'FillPattern', 1);
        const linePattern = num(shape, 'LinePattern', 1);
        const fill = fillPattern === 0 ? 'none' : (cell(shape, 'FillForegnd') || 'none');
        const stroke = linePattern === 0 ? 'none' : (cell(shape, 'LineColor') || '#000000');
        const lineWeight = num(shape, 'LineWeight', 1 / PX_PER_INCH) * PX_PER_INCH;
        const dash = { 2: '6 4', 3: '2 3', 4: '10 4 2 4' }[linePattern] || null;
        const dashAttr = dash ? ` stroke-dasharray="${dash}"` : '';
        const angle = num(shape, 'Angle', 0);
        const rotate = angle
            ? ` transform="rotate(${(-angle * 180 / Math.PI).toFixed(3)} ${left + w / 2} ${top + h / 2})"`
            : '';

        // Character and paragraph runs, referenced from <Text> by <cp>/<pp>
        const charRows = Array.from(shape.querySelectorAll('Section[N="Character"] Row')).map(r => ({
            // The Size cell is in inches, like every other length in the page
            size: (parseFloat((r.querySelector('Cell[N="Size"]') || { getAttribute: () => '0.14' })
                .getAttribute('V')) || 0.14) * PX_PER_INCH,
            color: (r.querySelector('Cell[N="Color"]') || { getAttribute: () => '#000000' }).getAttribute('V'),
            bold: (r.querySelector('Cell[N="Style"]') || { getAttribute: () => '0' }).getAttribute('V') === '1'
        }));
        const paraRows = Array.from(shape.querySelectorAll('Section[N="Paragraph"] Row')).map(r =>
            parseInt((r.querySelector('Cell[N="HorzAlign"]') || { getAttribute: () => '1' }).getAttribute('V'), 10));

        const runs = [];
        const textEl = shape.querySelector('Text');
        if (textEl) {
            let charIx = 0;
            let paraIx = 0;
            for (const node of Array.from(textEl.childNodes)) {
                if (node.nodeType === 1) {
                    const name = node.nodeName.toLowerCase();
                    if (name === 'cp') charIx = parseInt(node.getAttribute('IX'), 10) || 0;
                    if (name === 'pp') paraIx = parseInt(node.getAttribute('IX'), 10) || 0;
                } else if (node.nodeType === 3) {
                    for (const line of node.textContent.split('\n')) {
                        if (line.length) {
                            runs.push({ text: line, char: charRows[charIx] || charRows[0], align: paraRows[paraIx] });
                        }
                    }
                }
            }
        }

        // Connectors carry Begin/End coordinates; everything else is a shape
        if (cell(shape, 'BeginX') !== null) {
            const geometry = shape.querySelector('Section[N="Geometry"]');
            const points = [];
            if (geometry) {
                for (const row of Array.from(geometry.querySelectorAll('Row'))) {
                    const x = parseFloat((row.querySelector('Cell[N="X"]') || { getAttribute: () => null }).getAttribute('V'));
                    const y = parseFloat((row.querySelector('Cell[N="Y"]') || { getAttribute: () => null }).getAttribute('V'));
                    if (!isNaN(x) && !isNaN(y)) {
                        points.push(`${left + x * PX_PER_INCH},${top + h - y * PX_PER_INCH}`);
                    }
                }
            }
            if (points.length >= 2) {
                const head = cell(shape, 'EndArrow') !== '0' ? ' marker-end="url(#a)"' : '';
                const tail = cell(shape, 'BeginArrow') !== '0' ? ' marker-start="url(#a)"' : '';
                out += `<polyline points="${points.join(' ')}" fill="none" stroke="${stroke}" ` +
                    `stroke-width="${lineWeight}"${dashAttr}${head}${tail}/>`;
            }
            continue;
        }

        const isEllipse = shape.querySelector('Row[T="Ellipse"]') !== null;
        if (fillPattern !== 0 || linePattern !== 0) {
            out += isEllipse
                ? `<ellipse cx="${left + w / 2}" cy="${top + h / 2}" rx="${w / 2}" ry="${h / 2}" ` +
                  `fill="${fill}" stroke="${stroke}" stroke-width="${lineWeight}"${dashAttr}${rotate}/>`
                : `<rect x="${left}" y="${top}" width="${w}" height="${h}" rx="${num(shape, 'Rounding', 0) * PX_PER_INCH}" ` +
                  `fill="${fill}" stroke="${stroke}" stroke-width="${lineWeight}"${dashAttr}${rotate}/>`;
        }

        if (runs.length) {
            // Text sits in its own block, which is at least as wide as the
            // text needs - so a long label overflows on one line here the way
            // it will in Visio, rather than silently fitting the shape.
            const txtW = num(shape, 'TxtWidth', w / PX_PER_INCH) * PX_PER_INCH;
            const txtPinX = num(shape, 'TxtPinX', w / PX_PER_INCH / 2) * PX_PER_INCH;
            const txtLocPinX = num(shape, 'TxtLocPinX', txtW / PX_PER_INCH / 2) * PX_PER_INCH;
            const txtLeft = left + txtPinX - txtLocPinX;
            const margin = num(shape, 'LeftMargin', 3 / PX_PER_INCH) * PX_PER_INCH;
            const lineHeight = (charRows[0] ? charRows[0].size : 12) * 1.25;
            let y = top + h / 2 - (runs.length * lineHeight) / 2 + lineHeight * 0.75;
            for (const run of runs) {
                const align = run.align === undefined ? 1 : run.align;
                const anchor = align === 0 ? 'start' : (align === 2 ? 'end' : 'middle');
                const x = align === 0 ? txtLeft + margin
                    : (align === 2 ? txtLeft + txtW - margin : txtLeft + txtW / 2);
                out += `<text x="${x}" y="${y}" font-size="${run.char.size}" fill="${run.char.color}" ` +
                    `text-anchor="${anchor}"${run.char.bold ? ' font-weight="bold"' : ''}>${esc(run.text)}</text>`;
                y += lineHeight;
            }
        }
    }

    out += '</svg>';
    window.close();
    return { svg: out, pageXml, warnings: scene.warnings };
}

module.exports = { preview };

if (require.main === module) {
    const [input, output] = process.argv.slice(2);
    if (!input) {
        console.error('usage: node tools/preview.js <input.svg|.drawio> [out.svg]');
        process.exit(2);
    }
    const result = preview(input);
    const target = output || path.basename(input).replace(/\.[^.]+$/, '') + '.preview.svg';
    fs.writeFileSync(target, result.svg);
    console.log(`wrote ${target}`);
    if (result.warnings.length) {
        console.log('\nthe .vsdx cannot reproduce:');
        for (const w of result.warnings) console.log('  - ' + w);
    }
}
