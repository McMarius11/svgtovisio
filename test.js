/**
 * Node.js test script for the SVG parser.
 * Tests parsing of sample SVGs to verify shape/connector extraction.
 */

const fs = require('fs');
const { JSDOM } = require('jsdom');

// Set up browser globals for the parser
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.DOMParser = dom.window.DOMParser;

// Load the parser
const parserCode = fs.readFileSync('./svg-parser.js', 'utf8');
const SvgParser = new Function(parserCode + '\nreturn SvgParser;')();

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

// Summary
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
