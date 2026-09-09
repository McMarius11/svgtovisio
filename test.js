/**
 * Node.js test script for the SVG parser.
 * Tests parsing of sample SVGs to verify shape/connector extraction.
 */

const fs = require('fs');
const { JSDOM } = require('jsdom');

// Set up browser globals for the parser
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.DOMParser = dom.window.DOMParser;

// Load the parsers
const parserCode = fs.readFileSync('./svg-parser.js', 'utf8');
const SvgParser = new Function(parserCode + '\nreturn SvgParser;')();

const drawioParserCode = fs.readFileSync('./drawio-parser.js', 'utf8');
const DrawioParser = new Function(drawioParserCode + '\nreturn DrawioParser;')();

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        console.log(`  PASS: ${msg}`);
        passed++;
    } else {
        console.log(`  FAIL: ${msg}`);
        failed++;
    }
}

// Test 1: Flowchart
console.log('\n--- Test 1: Flowchart SVG ---');
const flowchartSvg = fs.readFileSync('./test-samples/flowchart.svg', 'utf8');
const parser1 = new SvgParser(flowchartSvg);
const result1 = parser1.parse();
const stats1 = parser1.getStats();

assert(stats1.shapes >= 5, `Should have at least 5 shapes (got ${stats1.shapes})`);
assert(stats1.connectors >= 6, `Should have at least 6 connectors (got ${stats1.connectors})`);

// Check shape types
const shapeTypes1 = result1.shapes.map(s => s.type);
assert(shapeTypes1.includes('ellipse'), 'Should have ellipse shapes (start/end)');
assert(shapeTypes1.includes('rect'), 'Should have rect shapes (process boxes)');
assert(shapeTypes1.includes('diamond') || shapeTypes1.includes('polygon'),
    'Should have diamond/polygon shape (decision)');

// Check text association
const shapesWithText = result1.shapes.filter(s => s.text);
assert(shapesWithText.length >= 4, `At least 4 shapes should have text (got ${shapesWithText.length})`);

// Check arrow detection
const arrowConnectors = result1.connectors.filter(c => c.hasArrow);
assert(arrowConnectors.length >= 6, `At least 6 connectors should have arrows (got ${arrowConnectors.length})`);

// Test 2: Architecture diagram
console.log('\n--- Test 2: Architecture SVG ---');
const archSvg = fs.readFileSync('./test-samples/architecture.svg', 'utf8');
const parser2 = new SvgParser(archSvg);
const result2 = parser2.parse();
const stats2 = parser2.getStats();

assert(stats2.shapes >= 10, `Should have at least 10 shapes (got ${stats2.shapes})`);
assert(stats2.connectors >= 5, `Should have at least 5 connectors (got ${stats2.connectors})`);

// Check that connectors reference shapes
const linkedConnectors = result2.connectors.filter(c => c.fromShape !== null || c.toShape !== null);
assert(linkedConnectors.length > 0, `Some connectors should be linked to shapes (got ${linkedConnectors.length})`);

// Test 3: Edge cases
console.log('\n--- Test 3: Edge cases ---');

// Minimal SVG
const minSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="blue"/></svg>';
const parser3 = new SvgParser(minSvg);
const result3 = parser3.parse();
assert(result3.shapes.length === 1, 'Minimal SVG: should have 1 shape');
assert(result3.shapes[0].style.fill === 'blue', 'Fill color should be blue');

// SVG with path connectors
const pathSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">
  <rect x="10" y="50" width="100" height="60" fill="#eee" stroke="#333"/>
  <rect x="250" y="50" width="100" height="60" fill="#eee" stroke="#333"/>
  <path d="M 110 80 C 150 80 200 80 250 80" stroke="#333" stroke-width="2" fill="none" marker-end="url(#a)"/>
</svg>`;
const parser4 = new SvgParser(pathSvg);
const result4 = parser4.parse();
assert(result4.shapes.length === 2, `Path SVG: should have 2 shapes (got ${result4.shapes.length})`);
assert(result4.connectors.length === 1, `Path SVG: should have 1 connector (got ${result4.connectors.length})`);

// Test 4: Draw.io flowchart
console.log('\n--- Test 4: Draw.io Flowchart ---');
const drawioXml = fs.readFileSync('./test-samples/flowchart.drawio', 'utf8');
const drawioParser = new DrawioParser(drawioXml);
const drawioResult = drawioParser.parse();
const drawioStats = drawioParser.getStats();

assert(drawioStats.shapes >= 6, `Should have at least 6 shapes (got ${drawioStats.shapes})`);
assert(drawioStats.connectors >= 5, `Should have at least 5 connectors (got ${drawioStats.connectors})`);

// Check shape types
const drawioTypes = drawioResult.shapes.map(s => s.type);
assert(drawioTypes.includes('ellipse'), 'Should have ellipse shapes (Start/End)');
assert(drawioTypes.includes('rect'), 'Should have rect shapes (process boxes)');
assert(drawioTypes.includes('diamond'), 'Should have diamond shape (decision)');

// Check text extraction
const drawioShapesWithText = drawioResult.shapes.filter(s => s.text);
assert(drawioShapesWithText.length >= 6, `All 6 shapes should have text (got ${drawioShapesWithText.length})`);

// Check connector linking
const drawioLinked = drawioResult.connectors.filter(c => c.fromShape !== null && c.toShape !== null);
assert(drawioLinked.length >= 5, `At least 5 connectors should be linked (got ${drawioLinked.length})`);

// Check arrows
const drawioArrows = drawioResult.connectors.filter(c => c.hasArrow);
assert(drawioArrows.length >= 5, `At least 5 connectors should have arrows (got ${drawioArrows.length})`);

// Check edge labels become texts
const edgeLabels = drawioResult.texts.filter(t => t.text === 'Yes' || t.text === 'No');
assert(edgeLabels.length === 2, `Should have 2 edge labels (got ${edgeLabels.length})`);

// Test 5: Draw.io raw mxGraphModel (without mxfile wrapper)
console.log('\n--- Test 5: Draw.io raw mxGraphModel ---');
const rawDrawio = `<mxGraphModel>
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <mxCell id="2" value="Box A" style="rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
      <mxGeometry x="50" y="50" width="120" height="60" as="geometry"/>
    </mxCell>
    <mxCell id="3" value="Box B" style="fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
      <mxGeometry x="250" y="50" width="120" height="60" as="geometry"/>
    </mxCell>
    <mxCell id="4" style="endArrow=classic;" edge="1" source="2" target="3" parent="1">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>
  </root>
</mxGraphModel>`;
const rawParser = new DrawioParser(rawDrawio);
const rawResult = rawParser.parse();
assert(rawResult.shapes.length === 2, `Should have 2 shapes (got ${rawResult.shapes.length})`);
assert(rawResult.connectors.length === 1, `Should have 1 connector (got ${rawResult.connectors.length})`);
assert(rawResult.shapes[0].style.rx > 0, 'First shape should be rounded');
assert(rawResult.connectors[0].hasArrow, 'Connector should have arrow');

// Test 6: Real-world Draw.io (Köln BGP network diagram)
console.log('\n--- Test 6: Real-world Draw.io (BGP network) ---');
const bgpXml = fs.readFileSync('./test-samples/koeln-bgp.drawio', 'utf8');
const bgpParser = new DrawioParser(bgpXml);
const bgpResult = bgpParser.parse();
const bgpStats = bgpParser.getStats();

assert(bgpStats.shapes === 12, `Should have 12 shapes (got ${bgpStats.shapes})`);
assert(bgpStats.connectors === 10, `Should have 10 connectors (got ${bgpStats.connectors})`);
assert(bgpStats.texts === 2, `Should have 2 edge labels (got ${bgpStats.texts})`);

// Check &#xa; newline decoding in labels
const koelnShape = bgpResult.shapes.find(s => s.text && s.text.includes('Köln'));
assert(koelnShape && koelnShape.text.includes('\n'), 'Should decode &#xa; as newline in labels');

// Check all connectors are linked
const allLinked = bgpResult.connectors.every(c => c.fromShape !== null && c.toShape !== null);
assert(allLinked, 'All connectors should be linked to shapes');

// Check waypoints parsed for HA connectors
const haConn = bgpResult.connectors.find(c => c.points.length > 2);
assert(haConn && haConn.points.length === 4, `HA connector should have 4 points (got ${haConn ? haConn.points.length : 0})`);

// Test 7: CSS classes, <style> blocks, group transforms, nested frames
console.log('\n--- Test 7: Class-styled SVG ---');
const cssSvg = fs.readFileSync('./test-samples/css-classes.svg', 'utf8');
const result7 = new SvgParser(cssSvg).parse();

const frame = result7.shapes.find(s => s.width === 500);
const nodeA = result7.shapes.find(s => s.x === 80);
const nodeB = result7.shapes.find(s => s.x === 340);

assert(nodeA && nodeA.style.fill === '#FFFFFF', `.box fill from <style> (got ${nodeA && nodeA.style.fill})`);
assert(nodeA && nodeA.style.stroke === '#333333', `.box stroke from <style> (got ${nodeA && nodeA.style.stroke})`);
assert(nodeA && nodeA.style.strokeWidth === 1.5, `.box stroke-width from <style> (got ${nodeA && nodeA.style.strokeWidth})`);
assert(frame && frame.style.strokeDasharray === '8 5', 'frame keeps its dash pattern');
assert(frame && frame.isContainer === true, 'enclosing rect is detected as a container');
assert(frame && !frame.text, `container must not swallow inner labels (got ${JSON.stringify(frame && frame.text)})`);
assert(nodeA && nodeA.text === 'Node A\ndetail line', `inner box keeps both its lines (got ${JSON.stringify(nodeA && nodeA.text)})`);
assert(nodeA && nodeA.textRuns && nodeA.textRuns.length === 2, 'inner box keeps one style run per line');
assert(nodeA && nodeA.textRuns[0].style.fontSize === 18 && nodeA.textRuns[1].style.fontSize === 11,
    'heading and detail line keep their own font sizes');
assert(nodeA && nodeA.y === 150, `group transform is applied (got y=${nodeA && nodeA.y})`);

const title = result7.texts.find(t => t.text.indexOf('Title') === 0);
assert(title && title.style.textAnchor === 'start', `text-anchor defaults to start (got ${title && title.style.textAnchor})`);
assert(title && title.style.textColor === '#009640', `text colour comes from the class (got ${title && title.style.textColor})`);
assert(title && title.style.fontSize === 18, `class font-size applies (got ${title && title.style.fontSize})`);

const link = result7.connectors.find(c => c.hasArrow);
assert(link && link.style.stroke === '#009640', `connector stroke from class (got ${link && link.style.stroke})`);
const aIdx = result7.shapes.indexOf(nodeA), bIdx = result7.shapes.indexOf(nodeB);
assert(link && link.fromShape === aIdx && link.toShape === bIdx,
    `connector glues to the inner boxes, not the frame (got ${link && link.fromShape}->${link && link.toShape})`);

// Test 8: the styles survive into the VSDX page
console.log('\n--- Test 8: VSDX output ---');
const VsdxBuilder = new Function(fs.readFileSync('./vsdx-builder.js', 'utf8') + '\nreturn VsdxBuilder;')();
const pageXml = new VsdxBuilder(result7)._page1();

assert(pageXml.indexOf('N="FillForegnd" V="#FFFFFF"') !== -1, 'fill colour reaches the VSDX');
assert(pageXml.indexOf('N="LineColor" V="#333333"') !== -1, 'stroke colour reaches the VSDX');
assert(pageXml.indexOf('N="LineColor" V="#009640"') !== -1, 'connector colour reaches the VSDX');
assert((pageXml.match(/<cp IX=/g) || []).length >= 2, 'per-line character runs are emitted');
assert(pageXml.indexOf('N="HorzAlign" V="0"') !== -1, 'left-aligned text is not force-centred');

// Summary
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
