/**
 * SVG Parser - Extracts shapes, connectors, and text from Claude-generated SVGs.
 *
 * Claude typically generates SVGs with:
 * - <rect> for boxes/cards
 * - <circle>, <ellipse> for circles
 * - <line>, <polyline>, <path> for arrows/connectors
 * - <polygon> for diamonds/triangles
 * - <text> for labels
 * - <marker> definitions for arrowheads
 * - <g> groups combining shapes with their labels
 */

class SvgParser {
    constructor(svgString) {
        this.svgString = svgString;
        this.parser = new DOMParser();
        this.doc = null;
        this.svgEl = null;
        this.viewBox = { x: 0, y: 0, width: 800, height: 600 };
        this.shapes = [];
        this.connectors = [];
        this.texts = [];
        this.defs = {};
    }

    parse() {
        this.doc = this.parser.parseFromString(this.svgString, 'image/svg+xml');
        const errorNode = this.doc.querySelector('parsererror');
        if (errorNode) {
            throw new Error('Invalid SVG: ' + errorNode.textContent.slice(0, 200));
        }

        this.svgEl = this.doc.querySelector('svg');
        if (!this.svgEl) {
            throw new Error('No <svg> element found');
        }

        this._parseViewBox();
        this._parseStyleSheet();
        this._parseDefs();
        this._parseElements(this.svgEl, null);
        this._markContainers();
        this._associateTextsWithShapes();
        this._detectConnectors();

        return {
            viewBox: this.viewBox,
            shapes: this.shapes,
            connectors: this.connectors,
            texts: this.texts
        };
    }

    _parseViewBox() {
        const vb = this.svgEl.getAttribute('viewBox');
        if (vb) {
            const parts = vb.split(/[\s,]+/).map(Number);
            if (parts.length === 4) {
                this.viewBox = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
            }
        } else {
            const w = this.svgEl.getAttribute('width');
            const h = this.svgEl.getAttribute('height');
            if (w && h) {
                this.viewBox.width = parseFloat(w);
                this.viewBox.height = parseFloat(h);
            }
        }
    }

    _parseDefs() {
        const defs = this.svgEl.querySelector('defs');
        if (!defs) return;

        // Parse markers (arrowheads)
        defs.querySelectorAll('marker').forEach(marker => {
            this.defs[marker.id] = {
                type: 'marker',
                id: marker.id
            };
        });
    }

    _parseElements(parent, groupTransform) {
        for (const el of parent.children) {
            const tag = el.tagName.toLowerCase();

            if (tag === 'defs' || tag === 'style' || tag === 'title' || tag === 'desc') continue;

            if (tag === 'g') {
                const transform = this._combineTransform(groupTransform, el.getAttribute('transform'));
                this._parseElements(el, transform);
                continue;
            }

            const style = this._extractStyle(el);

            switch (tag) {
                case 'rect':
                    this._parseRect(el, style, groupTransform);
                    break;
                case 'circle':
                    this._parseCircle(el, style, groupTransform);
                    break;
                case 'ellipse':
                    this._parseEllipse(el, style, groupTransform);
                    break;
                case 'polygon':
                    this._parsePolygon(el, style, groupTransform);
                    break;
                case 'line':
                    this._parseLine(el, style, groupTransform);
                    break;
                case 'polyline':
                    this._parsePolyline(el, style, groupTransform);
                    break;
                case 'path':
                    this._parsePath(el, style, groupTransform);
                    break;
                case 'text':
                    this._parseText(el, style, groupTransform);
                    break;
            }
        }
    }

    /**
     * Presentation attributes that also exist as CSS properties.
     * These form the lowest layer of the cascade (specificity 0).
     */
    static get PRESENTATION_ATTRS() {
        return ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray',
                'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-size', 'font-family',
                'font-weight', 'font-style', 'text-anchor', 'rx', 'ry', 'color', 'visibility'];
    }

    /** Properties that SVG inherits from ancestor elements. */
    static get INHERITED_PROPS() {
        return ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray',
                'stroke-linecap', 'stroke-linejoin', 'font-size', 'font-family',
                'font-weight', 'font-style', 'text-anchor', 'color', 'visibility'];
    }

    /**
     * Collect the rules of every <style> block so that class-based SVGs
     * (.box, .fw, ...) keep their fills, strokes and fonts.
     */
    _parseStyleSheet() {
        this.cssRules = [];
        this.svgEl.querySelectorAll('style').forEach(styleEl => {
            const css = styleEl.textContent.replace(/\/\*[\s\S]*?\*\//g, '');
            const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
            let m;
            while ((m = ruleRe.exec(css)) !== null) {
                const decls = this._parseDeclarations(m[2]);
                if (Object.keys(decls).length === 0) continue;
                for (const sel of m[1].split(',').map(x => x.trim()).filter(Boolean)) {
                    const spec = this._selectorSpecificity(sel);
                    if (spec === null) continue; // combinators / pseudo classes unsupported
                    this.cssRules.push({ sel, spec, decls, order: this.cssRules.length });
                }
            }
        });
    }

    _parseDeclarations(text) {
        const decls = {};
        for (const prop of text.split(';')) {
            const idx = prop.indexOf(':');
            if (idx < 0) continue;
            const key = prop.slice(0, idx).trim().toLowerCase();
            const val = prop.slice(idx + 1).trim();
            if (key && val) decls[key] = val;
        }
        return decls;
    }

    /** Specificity of a simple compound selector, or null when unsupported. */
    _selectorSpecificity(sel) {
        if (/[\s>+~:\[\]*]/.test(sel)) return null;
        const ids = (sel.match(/#[\w-]+/g) || []).length;
        const classes = (sel.match(/\.[\w-]+/g) || []).length;
        const tag = /^[a-zA-Z]/.test(sel) ? 1 : 0;
        return ids * 10000 + classes * 100 + tag;
    }

    _selectorMatches(sel, el) {
        const tagPart = sel.match(/^[a-zA-Z][\w-]*/);
        if (tagPart && el.tagName.toLowerCase() !== tagPart[0].toLowerCase()) return false;
        for (const id of sel.match(/#[\w-]+/g) || []) {
            if (el.getAttribute('id') !== id.slice(1)) return false;
        }
        const classAttr = (el.getAttribute('class') || '').split(/\s+/);
        for (const cls of sel.match(/\.[\w-]+/g) || []) {
            if (classAttr.indexOf(cls.slice(1)) === -1) return false;
        }
        return true;
    }

    /**
     * CSS cascade for a single element:
     * presentation attributes < stylesheet rules (by specificity) < inline style.
     */
    _ownProps(el) {
        const props = {};
        for (const name of SvgParser.PRESENTATION_ATTRS) {
            const v = el.getAttribute(name);
            if (v !== null && v !== '') props[name] = v;
        }
        const matched = (this.cssRules || [])
            .filter(r => this._selectorMatches(r.sel, el))
            .sort((a, b) => (a.spec - b.spec) || (a.order - b.order));
        for (const r of matched) Object.assign(props, r.decls);

        const inline = el.getAttribute('style');
        if (inline) Object.assign(props, this._parseDeclarations(inline));
        return props;
    }

    _extractStyle(el) {
        // Ancestor chain (root first) so inherited properties resolve correctly.
        const chain = [];
        let node = el;
        while (node && node.nodeType === 1) {
            chain.unshift(node);
            if (node === this.svgEl) break;
            node = node.parentNode;
        }

        const props = {};
        for (let i = 0; i < chain.length; i++) {
            const own = this._ownProps(chain[i]);
            if (i === chain.length - 1) {
                Object.assign(props, own);
            } else {
                for (const key of SvgParser.INHERITED_PROPS) {
                    if (own[key] !== undefined) props[key] = own[key];
                }
            }
        }

        const num = (v, fallback) => {
            const n = parseFloat(v);
            return isNaN(n) ? fallback : n;
        };
        const dash = props['stroke-dasharray'];

        return {
            fill: props['fill'] !== undefined ? props['fill'] : 'none',
            fillOpacity: num(props['fill-opacity'], 1),
            stroke: props['stroke'] !== undefined ? props['stroke'] : 'none',
            strokeWidth: num(props['stroke-width'], 1),
            strokeDasharray: (dash && dash !== 'none') ? dash : null,
            fontSize: num(props['font-size'], 14),
            fontFamily: props['font-family'] || 'Calibri',
            fontWeight: props['font-weight'] || 'normal',
            // SVG default is "start" - "middle" silently re-centres every left-aligned label.
            textAnchor: props['text-anchor'] || 'start',
            opacity: num(props['opacity'], 1),
            rx: num(props['rx'], 0),
            ry: num(props['ry'], 0)
        };
    }

    _combineTransform(parent, child) {
        if (!parent && !child) return null;
        if (!child) return parent;
        if (!parent) return child;
        return parent + ' ' + child;
    }

    _applyTransform(x, y, transform) {
        if (!transform) return { x, y };

        const translateMatch = transform.match(/translate\(\s*([^,\s]+)[\s,]*([^)]*)\)/);
        if (translateMatch) {
            x += parseFloat(translateMatch[1]);
            y += parseFloat(translateMatch[2] || 0);
        }

        return { x, y };
    }

    _parseRect(el, style, transform) {
        let x = parseFloat(el.getAttribute('x') || 0);
        let y = parseFloat(el.getAttribute('y') || 0);
        const w = parseFloat(el.getAttribute('width') || 0);
        const h = parseFloat(el.getAttribute('height') || 0);

        if (w === 0 || h === 0) return;

        const pos = this._applyTransform(x, y, transform);

        this.shapes.push({
            type: 'rect',
            x: pos.x,
            y: pos.y,
            width: w,
            height: h,
            style,
            id: el.id || null,
            text: null
        });
    }

    _parseCircle(el, style, transform) {
        let cx = parseFloat(el.getAttribute('cx') || 0);
        let cy = parseFloat(el.getAttribute('cy') || 0);
        const r = parseFloat(el.getAttribute('r') || 0);

        if (r === 0) return;

        const pos = this._applyTransform(cx, cy, transform);

        this.shapes.push({
            type: 'circle',
            x: pos.x - r,
            y: pos.y - r,
            width: r * 2,
            height: r * 2,
            cx: pos.x,
            cy: pos.y,
            r,
            style,
            id: el.id || null,
            text: null
        });
    }

    _parseEllipse(el, style, transform) {
        let cx = parseFloat(el.getAttribute('cx') || 0);
        let cy = parseFloat(el.getAttribute('cy') || 0);
        const rx = parseFloat(el.getAttribute('rx') || 0);
        const ry = parseFloat(el.getAttribute('ry') || 0);

        if (rx === 0 || ry === 0) return;

        const pos = this._applyTransform(cx, cy, transform);

        this.shapes.push({
            type: 'ellipse',
            x: pos.x - rx,
            y: pos.y - ry,
            width: rx * 2,
            height: ry * 2,
            style,
            id: el.id || null,
            text: null
        });
    }

    _parsePolygon(el, style, transform) {
        const pointsStr = el.getAttribute('points');
        if (!pointsStr) return;

        const points = this._parsePointsString(pointsStr);
        if (points.length < 3) return;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of points) {
            const tp = this._applyTransform(p.x, p.y, transform);
            minX = Math.min(minX, tp.x);
            minY = Math.min(minY, tp.y);
            maxX = Math.max(maxX, tp.x);
            maxY = Math.max(maxY, tp.y);
        }

        // Detect diamond shape (4 points forming a rhombus)
        const isDiamond = points.length === 4 && this._isDiamondShape(points);

        this.shapes.push({
            type: isDiamond ? 'diamond' : 'polygon',
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
            points: points.map(p => this._applyTransform(p.x, p.y, transform)),
            style,
            id: el.id || null,
            text: null
        });
    }

    _isDiamondShape(points) {
        if (points.length !== 4) return false;
        const cx = points.reduce((s, p) => s + p.x, 0) / 4;
        const cy = points.reduce((s, p) => s + p.y, 0) / 4;

        // Check if points are roughly at top, right, bottom, left of center
        let hasTop = false, hasRight = false, hasBottom = false, hasLeft = false;
        const tolerance = 5;
        for (const p of points) {
            if (Math.abs(p.x - cx) < tolerance && p.y < cy) hasTop = true;
            if (Math.abs(p.x - cx) < tolerance && p.y > cy) hasBottom = true;
            if (p.x > cx && Math.abs(p.y - cy) < tolerance) hasRight = true;
            if (p.x < cx && Math.abs(p.y - cy) < tolerance) hasLeft = true;
        }
        return hasTop && hasRight && hasBottom && hasLeft;
    }

    _parseLine(el, style, transform) {
        let x1 = parseFloat(el.getAttribute('x1') || 0);
        let y1 = parseFloat(el.getAttribute('y1') || 0);
        let x2 = parseFloat(el.getAttribute('x2') || 0);
        let y2 = parseFloat(el.getAttribute('y2') || 0);

        const p1 = this._applyTransform(x1, y1, transform);
        const p2 = this._applyTransform(x2, y2, transform);

        const hasArrow = this._hasArrowMarker(el);

        this.connectors.push({
            type: 'line',
            points: [p1, p2],
            hasArrow,
            style,
            id: el.id || null,
            text: null
        });
    }

    _parsePolyline(el, style, transform) {
        const pointsStr = el.getAttribute('points');
        if (!pointsStr) return;

        const points = this._parsePointsString(pointsStr).map(p =>
            this._applyTransform(p.x, p.y, transform)
        );

        if (points.length < 2) return;

        const hasArrow = this._hasArrowMarker(el);

        this.connectors.push({
            type: 'polyline',
            points,
            hasArrow,
            style,
            id: el.id || null,
            text: null
        });
    }

    _parsePath(el, style, transform) {
        const d = el.getAttribute('d');
        if (!d) return;

        const hasArrow = this._hasArrowMarker(el);
        const points = this._pathToPoints(d, transform);

        if (points.length < 2) return;

        // Determine if this is a connector (line-like) or a filled shape
        const isFilled = style.fill !== 'none' && style.fill !== 'transparent' &&
                         style.fill !== '' && style.fill !== undefined;
        const isClosed = d.toLowerCase().includes('z');
        const isLikelyConnector = !isFilled || hasArrow ||
            (style.stroke !== 'none' && !isClosed);

        if (isLikelyConnector && !isClosed) {
            this.connectors.push({
                type: 'path',
                points,
                hasArrow,
                style,
                d,
                id: el.id || null,
                text: null
            });
        } else if (isClosed && isFilled) {
            // Treat as a shape
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of points) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
            }
            this.shapes.push({
                type: 'path-shape',
                x: minX,
                y: minY,
                width: maxX - minX,
                height: maxY - minY,
                points,
                style,
                d,
                id: el.id || null,
                text: null
            });
        } else {
            // Default to connector
            this.connectors.push({
                type: 'path',
                points,
                hasArrow,
                style,
                d,
                id: el.id || null,
                text: null
            });
        }
    }

    _parseText(el, style, transform) {
        let x = parseFloat(el.getAttribute('x') || 0);
        let y = parseFloat(el.getAttribute('y') || 0);

        const pos = this._applyTransform(x, y, transform);

        // Collect text from child <tspan> elements or direct text
        let textContent = '';
        const tspans = el.querySelectorAll('tspan');
        if (tspans.length > 0) {
            const lines = [];
            tspans.forEach(ts => {
                lines.push(ts.textContent.trim());
            });
            textContent = lines.join('\n');
        } else {
            textContent = el.textContent.trim();
        }

        if (!textContent) return;

        // Text is painted with `fill`; SVG's default text colour is black.
        style.textColor = (style.fill && style.fill !== 'none') ? style.fill : '#000000';

        this.texts.push({
            x: pos.x,
            y: pos.y,
            text: textContent,
            style,
            id: el.id || null
        });
    }

    _hasArrowMarker(el) {
        const markerEnd = el.getAttribute('marker-end');
        const markerStart = el.getAttribute('marker-start');
        return !!(markerEnd || markerStart);
    }

    _parsePointsString(str) {
        const nums = str.trim().split(/[\s,]+/).map(Number);
        const points = [];
        for (let i = 0; i < nums.length - 1; i += 2) {
            if (!isNaN(nums[i]) && !isNaN(nums[i + 1])) {
                points.push({ x: nums[i], y: nums[i + 1] });
            }
        }
        return points;
    }

    _pathToPoints(d, transform) {
        const points = [];
        let curX = 0, curY = 0;
        let startX = 0, startY = 0;

        // Tokenize path data
        const tokens = d.match(/[a-zA-Z][^a-zA-Z]*/g) || [];

        for (const token of tokens) {
            const cmd = token[0];
            const nums = (token.slice(1).match(/-?\d+\.?\d*(?:e[+-]?\d+)?/gi) || []).map(Number);

            switch (cmd) {
                case 'M':
                    for (let i = 0; i < nums.length; i += 2) {
                        curX = nums[i]; curY = nums[i + 1];
                        startX = curX; startY = curY;
                        const p = this._applyTransform(curX, curY, transform);
                        points.push(p);
                    }
                    break;
                case 'm':
                    for (let i = 0; i < nums.length; i += 2) {
                        curX += nums[i]; curY += nums[i + 1];
                        if (i === 0) { startX = curX; startY = curY; }
                        const p = this._applyTransform(curX, curY, transform);
                        points.push(p);
                    }
                    break;
                case 'L':
                    for (let i = 0; i < nums.length; i += 2) {
                        curX = nums[i]; curY = nums[i + 1];
                        const p = this._applyTransform(curX, curY, transform);
                        points.push(p);
                    }
                    break;
                case 'l':
                    for (let i = 0; i < nums.length; i += 2) {
                        curX += nums[i]; curY += nums[i + 1];
                        const p = this._applyTransform(curX, curY, transform);
                        points.push(p);
                    }
                    break;
                case 'H':
                    for (const n of nums) {
                        curX = n;
                        const p = this._applyTransform(curX, curY, transform);
                        points.push(p);
                    }
                    break;
                case 'h':
                    for (const n of nums) {
                        curX += n;
                        const p = this._applyTransform(curX, curY, transform);
                        points.push(p);
                    }
                    break;
                case 'V':
                    for (const n of nums) {
                        curY = n;
                        const p = this._applyTransform(curX, curY, transform);
                        points.push(p);
                    }
                    break;
                case 'v':
                    for (const n of nums) {
                        curY += n;
                        const p = this._applyTransform(curX, curY, transform);
                        points.push(p);
                    }
                    break;
                case 'C':
                    // Cubic bezier - take endpoint
                    for (let i = 0; i < nums.length; i += 6) {
                        if (i + 5 < nums.length) {
                            // Add control points for curve approximation
                            const midX = (curX + nums[i + 4]) / 2;
                            const midY = (curY + nums[i + 5]) / 2;
                            const mp = this._applyTransform(midX, midY, transform);
                            points.push(mp);
                            curX = nums[i + 4]; curY = nums[i + 5];
                            const p = this._applyTransform(curX, curY, transform);
                            points.push(p);
                        }
                    }
                    break;
                case 'c':
                    for (let i = 0; i < nums.length; i += 6) {
                        if (i + 5 < nums.length) {
                            const midX = curX + nums[i + 4] / 2;
                            const midY = curY + nums[i + 5] / 2;
                            const mp = this._applyTransform(midX, midY, transform);
                            points.push(mp);
                            curX += nums[i + 4]; curY += nums[i + 5];
                            const p = this._applyTransform(curX, curY, transform);
                            points.push(p);
                        }
                    }
                    break;
                case 'Q':
                    for (let i = 0; i < nums.length; i += 4) {
                        if (i + 3 < nums.length) {
                            curX = nums[i + 2]; curY = nums[i + 3];
                            const p = this._applyTransform(curX, curY, transform);
                            points.push(p);
                        }
                    }
                    break;
                case 'q':
                    for (let i = 0; i < nums.length; i += 4) {
                        if (i + 3 < nums.length) {
                            curX += nums[i + 2]; curY += nums[i + 3];
                            const p = this._applyTransform(curX, curY, transform);
                            points.push(p);
                        }
                    }
                    break;
                case 'A': case 'a':
                    // Arc - just take the endpoint
                    for (let i = 0; i < nums.length; i += 7) {
                        if (i + 6 < nums.length) {
                            if (cmd === 'a') {
                                curX += nums[i + 5]; curY += nums[i + 6];
                            } else {
                                curX = nums[i + 5]; curY = nums[i + 6];
                            }
                            const p = this._applyTransform(curX, curY, transform);
                            points.push(p);
                        }
                    }
                    break;
                case 'Z': case 'z':
                    curX = startX; curY = startY;
                    break;
            }
        }

        return points;
    }

    /**
     * A shape that fully encloses another shape is a grouping frame (subnet,
     * VNet, legend box), not a labelled box. Such frames must not swallow the
     * labels of the shapes inside them, and connectors must not glue to them.
     */
    _markContainers() {
        for (const a of this.shapes) {
            a.isContainer = false;
            const areaA = a.width * a.height;
            if (areaA <= 0) continue;
            for (const b of this.shapes) {
                if (b === a) continue;
                const areaB = b.width * b.height;
                if (areaB <= 0 || areaB >= areaA * 0.9) continue;
                if (b.x >= a.x - 1 && b.y >= a.y - 1 &&
                    b.x + b.width <= a.x + a.width + 1 &&
                    b.y + b.height <= a.y + a.height + 1) {
                    a.isContainer = true;
                    break;
                }
            }
        }
    }

    _associateTextsWithShapes() {
        const PAD = 2;
        const assigned = new Map();

        for (const text of this.texts) {
            let best = null;
            let bestArea = Infinity;

            for (const shape of this.shapes) {
                if (shape.isContainer) continue;

                const inside = text.x >= shape.x - PAD && text.x <= shape.x + shape.width + PAD &&
                               text.y >= shape.y - PAD && text.y <= shape.y + shape.height + PAD;
                if (!inside) continue;

                // Innermost (smallest) enclosing shape wins, not the nearest centre -
                // otherwise a label lands in the big frame around its box.
                const area = shape.width * shape.height;
                if (area < bestArea) {
                    bestArea = area;
                    best = shape;
                }
            }

            if (best) {
                if (!assigned.has(best)) assigned.set(best, []);
                assigned.get(best).push(text);
                text._associated = true;
            }
        }

        for (const [shape, texts] of assigned) {
            texts.sort((a, b) => (a.y - b.y) || (a.x - b.x));
            shape.text = texts.map(t => t.text).join('\n');
            // One run per source line so a heading keeps its own size/weight.
            shape.textRuns = texts.map(t => ({ text: t.text, style: t.style }));
            // The largest line drives the shape's overall font styling.
            shape.textStyle = texts.reduce((a, b) =>
                (b.style.fontSize || 0) > (a.style.fontSize || 0) ? b : a).style;
        }

        // Keep unassociated texts as standalone text shapes
        this.texts = this.texts.filter(t => !t._associated);
    }

    _detectConnectors() {
        // Try to detect which shapes connectors connect to
        for (const conn of this.connectors) {
            if (conn.points.length < 2) continue;

            const startPt = conn.points[0];
            const endPt = conn.points[conn.points.length - 1];

            conn.fromShape = this._findNearestShape(startPt);
            conn.toShape = this._findNearestShape(endPt);
        }
    }

    _findNearestShape(point) {
        const MAX_DIST = 30;
        let best = null;
        let bestDist = MAX_DIST;
        let bestArea = Infinity;

        for (let i = 0; i < this.shapes.length; i++) {
            const shape = this.shapes[i];
            // Every point inside a frame has edge distance 0, so without this
            // check all connectors would glue to the outermost frame.
            if (shape.isContainer) continue;

            const cx = shape.x + shape.width / 2;
            const cy = shape.y + shape.height / 2;

            // Distance to shape edge
            const dx = Math.max(0, Math.abs(point.x - cx) - shape.width / 2);
            const dy = Math.max(0, Math.abs(point.y - cy) - shape.height / 2);
            const dist = Math.hypot(dx, dy);
            if (dist >= MAX_DIST) continue;

            const area = shape.width * shape.height;
            if (dist < bestDist - 0.5 || (Math.abs(dist - bestDist) <= 0.5 && area < bestArea)) {
                bestDist = dist;
                bestArea = area;
                best = i;
            }
        }

        return best;
    }

    getStats() {
        return {
            shapes: this.shapes.length,
            connectors: this.connectors.length,
            texts: this.texts.length,
            viewBox: this.viewBox
        };
    }
}
