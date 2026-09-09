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
        this.gradients = {};
        this.warnings = [];
        this._warned = new Set();
    }

    /** Record a conversion caveat once, so the UI can surface what was dropped. */
    _warn(message) {
        if (this._warned.has(message)) return;
        this._warned.add(message);
        this.warnings.push(message);
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
            warnings: this.warnings,
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
        // Markers (arrowheads) - only their existence matters for conversion
        this.svgEl.querySelectorAll('marker').forEach(marker => {
            if (marker.id) this.defs[marker.id] = { type: 'marker', id: marker.id };
        });

        // Gradients are flattened to a single colour; remember their stops
        this.svgEl.querySelectorAll('linearGradient, radialGradient').forEach(g => {
            if (!g.id) return;
            this.gradients[g.id] = g;
        });

        // Index every id once so <use> can resolve references cheaply
        this.idMap = {};
        this.svgEl.querySelectorAll('[id]').forEach(el => {
            const id = el.getAttribute('id');
            if (id && !this.idMap[id]) this.idMap[id] = el;
        });
    }

    /** Colour of a gradient stop, from either the attribute or its style. */
    _stopColor(stop) {
        if (!stop) return null;
        const inline = stop.getAttribute('style');
        if (inline) {
            const decls = this._parseDeclarations(inline);
            if (decls['stop-color']) return decls['stop-color'];
        }
        const own = this._ownProps(stop);
        return stop.getAttribute('stop-color') || own['stop-color'] || null;
    }

    /**
     * Visio has no gradient fill here, so a gradient is flattened to the blend
     * of its first and last stop - far closer than the previous fallback,
     * which turned every gradient into solid black.
     */
    _resolveGradient(id) {
        let g = this.gradients[id];
        if (!g) return null;

        // A gradient may inherit its stops from another one via href
        let stops = g.querySelectorAll('stop');
        let guard = 0;
        while (stops.length === 0 && guard++ < 8) {
            const href = g.getAttribute('href') || g.getAttribute('xlink:href');
            if (!href || href[0] !== '#') break;
            g = this.gradients[href.slice(1)];
            if (!g) break;
            stops = g.querySelectorAll('stop');
        }
        if (stops.length === 0) return null;

        const first = this._stopColor(stops[0]);
        const last = this._stopColor(stops[stops.length - 1]);
        if (!first) return null;
        if (!last || last === first) return first;

        const mix = this._blend(first, last);
        return mix || first;
    }

    /** Average two colours; returns null when either cannot be read as hex. */
    _blend(c1, c2) {
        const toRgb = c => {
            const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
            if (!m) return null;
            let h = m[1];
            if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
            return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
        };
        const a = toRgb(c1), b = toRgb(c2);
        if (!a || !b) return null;
        const hex = n => Math.round(n).toString(16).padStart(2, '0');
        return '#' + hex((a[0] + b[0]) / 2) + hex((a[1] + b[1]) / 2) + hex((a[2] + b[2]) / 2);
    }

    /** Turn a paint value into a plain colour, resolving url(#gradient). */
    _resolvePaint(value, what) {
        if (!value) return value;
        const url = /^url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)/.exec(value.trim());
        if (!url) return value;

        const resolved = this._resolveGradient(url[1]);
        if (resolved) {
            this._warn(`gradient "#${url[1]}" was flattened to a single colour (${resolved})`);
            return resolved;
        }
        this._warn(`${what} references "#${url[1]}" (pattern or unknown paint) and was left unpainted`);
        return 'none';
    }

    _parseElements(parent, groupTransform, depth) {
        depth = depth || 0;
        for (const el of parent.children) {
            const tag = el.tagName.toLowerCase();

            if (tag === 'defs' || tag === 'style' || tag === 'title' || tag === 'desc' ||
                tag === 'metadata' || tag === 'marker' || tag === 'lineargradient' ||
                tag === 'radialgradient' || tag === 'pattern' || tag === 'clippath' ||
                tag === 'mask' || tag === 'filter' || tag === 'symbol' || tag === 'script') {
                continue;
            }

            if (tag === 'g' || tag === 'a' || tag === 'switch') {
                if (tag === 'switch') this._warn('<switch> was flattened - every branch was converted');
                const transform = this._combineTransform(groupTransform, el.getAttribute('transform'));
                this._parseElements(el, transform, depth);
                continue;
            }

            if (tag === 'use') {
                this._parseUse(el, groupTransform, depth);
                continue;
            }

            if (el.getAttribute('clip-path') || el.getAttribute('mask') || el.getAttribute('filter')) {
                this._warn('clip-path / mask / filter are ignored - shapes are converted unclipped');
            }

            const transform = this._combineTransform(groupTransform, el.getAttribute('transform'));
            const style = this._scaleStyle(this._extractStyle(el), transform);
            this._dispatchElement(tag, el, style, transform);
        }
    }

    _dispatchElement(tag, el, style, transform) {
        switch (tag) {
            case 'rect':
                this._parseRect(el, style, transform);
                break;
            case 'circle':
                this._parseCircle(el, style, transform);
                break;
            case 'ellipse':
                this._parseEllipse(el, style, transform);
                break;
            case 'polygon':
                this._parsePolygon(el, style, transform);
                break;
            case 'line':
                this._parseLine(el, style, transform);
                break;
            case 'polyline':
                this._parsePolyline(el, style, transform);
                break;
            case 'path':
                this._parsePath(el, style, transform);
                break;
            case 'text':
                this._parseText(el, style, transform);
                break;
            case 'image':
                this._warn('<image> was skipped - embedded bitmaps are not converted');
                break;
            case 'foreignobject':
                this._warn('<foreignObject> was skipped - embedded HTML is not converted');
                break;
            default:
                this._warn(`<${tag}> is not supported and was skipped`);
        }
    }

    /** Expand <use> by converting the element it references. */
    _parseUse(el, groupTransform, depth) {
        if (depth >= 8) {
            this._warn('<use> references nest too deeply and were not expanded');
            return;
        }

        const href = el.getAttribute('href') || el.getAttribute('xlink:href');
        if (!href || href[0] !== '#') {
            this._warn('<use> without a local #reference was skipped');
            return;
        }

        const target = this.idMap && this.idMap[href.slice(1)];
        if (!target) {
            this._warn(`<use> references "${href}", which does not exist in this file`);
            return;
        }

        let transform = this._combineTransform(groupTransform, el.getAttribute('transform'));
        const x = parseFloat(el.getAttribute('x') || 0);
        const y = parseFloat(el.getAttribute('y') || 0);
        if (x || y) {
            transform = this._combineTransform(transform, { a: 1, b: 0, c: 0, d: 1, e: x, f: y });
        }

        const tag = target.tagName.toLowerCase();
        if (tag === 'g' || tag === 'symbol' || tag === 'svg') {
            const inner = this._combineTransform(transform, target.getAttribute('transform'));
            this._parseElements(target, inner, depth + 1);
            return;
        }

        const inner = this._combineTransform(transform, target.getAttribute('transform'));
        const style = this._scaleStyle(this._extractStyle(target), inner);
        this._dispatchElement(tag, target, style, inner);
    }

    /**
     * Presentation attributes that also exist as CSS properties.
     * These form the lowest layer of the cascade (specificity 0).
     */
    static get PRESENTATION_ATTRS() {
        return ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray',
                'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'opacity',
                'font-size', 'font-family', 'font-weight', 'font-style', 'text-anchor',
                'rx', 'ry', 'color', 'visibility', 'stop-color'];
    }

    /** Properties that SVG inherits from ancestor elements. */
    static get INHERITED_PROPS() {
        return ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray',
                'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'font-size',
                'font-family', 'font-weight', 'font-style', 'text-anchor', 'color',
                'visibility'];
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
            fill: this._resolvePaint(props['fill'] !== undefined ? props['fill'] : 'none', 'fill'),
            fillOpacity: num(props['fill-opacity'], 1),
            stroke: this._resolvePaint(props['stroke'] !== undefined ? props['stroke'] : 'none', 'stroke'),
            strokeWidth: num(props['stroke-width'], 1),
            strokeOpacity: num(props['stroke-opacity'], 1),
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

    // ---- Transform handling -------------------------------------------------
    // Transforms are carried as affine matrices {a,b,c,d,e,f}:
    //   x' = a*x + c*y + e
    //   y' = b*x + d*y + f
    // A string would only ever let us honour the outermost translate.

    static get IDENTITY() {
        return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    }

    _matrixMultiply(m1, m2) {
        return {
            a: m1.a * m2.a + m1.c * m2.b,
            b: m1.b * m2.a + m1.d * m2.b,
            c: m1.a * m2.c + m1.c * m2.d,
            d: m1.b * m2.c + m1.d * m2.d,
            e: m1.a * m2.e + m1.c * m2.f + m1.e,
            f: m1.b * m2.e + m1.d * m2.f + m1.f
        };
    }

    /** Parse a transform attribute (any number of chained functions). */
    _parseTransformAttr(str) {
        if (!str) return null;
        let m = null;
        const fnRe = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
        let match;
        while ((match = fnRe.exec(str)) !== null) {
            const name = match[1].toLowerCase();
            const args = match[2].trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
            const step = this._transformFunctionToMatrix(name, args);
            if (!step) {
                this._warn(`transform "${name}()" is not supported and was ignored`);
                continue;
            }
            m = m ? this._matrixMultiply(m, step) : step;
        }
        return m;
    }

    _transformFunctionToMatrix(name, a) {
        const rad = deg => deg * Math.PI / 180;
        switch (name) {
            case 'translate':
                return { a: 1, b: 0, c: 0, d: 1, e: a[0] || 0, f: a[1] || 0 };
            case 'scale': {
                const sx = a[0] !== undefined ? a[0] : 1;
                const sy = a[1] !== undefined ? a[1] : sx;
                return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
            }
            case 'rotate': {
                const t = rad(a[0] || 0);
                const cos = Math.cos(t), sin = Math.sin(t);
                const rot = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
                if (a.length < 3) return rot;
                // rotate(angle cx cy) == translate(cx,cy) rotate(angle) translate(-cx,-cy)
                const to = { a: 1, b: 0, c: 0, d: 1, e: a[1], f: a[2] };
                const back = { a: 1, b: 0, c: 0, d: 1, e: -a[1], f: -a[2] };
                return this._matrixMultiply(this._matrixMultiply(to, rot), back);
            }
            case 'skewx':
                return { a: 1, b: 0, c: Math.tan(rad(a[0] || 0)), d: 1, e: 0, f: 0 };
            case 'skewy':
                return { a: 1, b: Math.tan(rad(a[0] || 0)), c: 0, d: 1, e: 0, f: 0 };
            case 'matrix':
                if (a.length < 6) return null;
                return { a: a[0], b: a[1], c: a[2], d: a[3], e: a[4], f: a[5] };
            default:
                return null;
        }
    }

    _combineTransform(parent, child) {
        const childMatrix = typeof child === 'string' ? this._parseTransformAttr(child) : child;
        if (!parent) return childMatrix || null;
        if (!childMatrix) return parent;
        return this._matrixMultiply(parent, childMatrix);
    }

    _applyTransform(x, y, m) {
        if (!m) return { x, y };
        return {
            x: m.a * x + m.c * y + m.e,
            y: m.b * x + m.d * y + m.f
        };
    }

    /** Uniform scale factor of a matrix (used for stroke widths and font sizes). */
    _transformScale(m) {
        if (!m) return 1;
        const det = Math.abs(m.a * m.d - m.b * m.c);
        return det > 0 ? Math.sqrt(det) : 1;
    }

    /**
     * Map an axis-aligned box through a matrix. Pure translate/scale keeps it
     * axis aligned; a rotation is reported separately so Visio can spin the
     * shape via its Angle cell instead of distorting the geometry.
     */
    _transformRect(x, y, w, h, m) {
        if (!m) return { x, y, width: w, height: h, angle: 0 };

        const centre = this._applyTransform(x + w / 2, y + h / 2, m);
        const sx = Math.hypot(m.a, m.b);
        const sy = Math.hypot(m.c, m.d);
        const width = w * sx;
        const height = h * sy;
        // SVG rotates clockwise (y grows downwards), Visio counter-clockwise.
        const angle = -Math.atan2(m.b, m.a);

        return {
            x: centre.x - width / 2,
            y: centre.y - height / 2,
            width,
            height,
            angle: Math.abs(angle) < 1e-9 ? 0 : angle
        };
    }

    /** Stroke widths and font sizes scale with the transform. */
    _scaleStyle(style, m) {
        const s = this._transformScale(m);
        if (s === 1) return style;
        return Object.assign({}, style, {
            strokeWidth: style.strokeWidth * s,
            fontSize: style.fontSize * s,
            rx: style.rx * s,
            ry: style.ry * s
        });
    }

    _parseRect(el, style, transform) {
        let x = parseFloat(el.getAttribute('x') || 0);
        let y = parseFloat(el.getAttribute('y') || 0);
        const w = parseFloat(el.getAttribute('width') || 0);
        const h = parseFloat(el.getAttribute('height') || 0);

        if (w === 0 || h === 0) return;

        const box = this._transformRect(x, y, w, h, transform);

        this.shapes.push({
            type: 'rect',
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            angle: box.angle,
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

        const box = this._transformRect(cx - r, cy - r, r * 2, r * 2, transform);

        this.shapes.push({
            type: 'circle',
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            angle: box.angle,
            cx: box.x + box.width / 2,
            cy: box.y + box.height / 2,
            r: box.width / 2,
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

        const box = this._transformRect(cx - rx, cy - ry, rx * 2, ry * 2, transform);

        this.shapes.push({
            type: 'ellipse',
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            angle: box.angle,
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

        const arrows = this._arrowMarkers(el);
        const hasArrow = arrows.start || arrows.end;

        this.connectors.push({
            type: 'line',
            points: [p1, p2],
            hasArrow,
            arrowStart: arrows.start,
            arrowEnd: arrows.end,
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

        const arrows = this._arrowMarkers(el);
        const hasArrow = arrows.start || arrows.end;

        this.connectors.push({
            type: 'polyline',
            points,
            hasArrow,
            arrowStart: arrows.start,
            arrowEnd: arrows.end,
            style,
            id: el.id || null,
            text: null
        });
    }

    _parsePath(el, style, transform) {
        const d = el.getAttribute('d');
        if (!d) return;

        const arrows = this._arrowMarkers(el);
        const hasArrow = arrows.start || arrows.end;
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
                arrowStart: arrows.start,
                arrowEnd: arrows.end,
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
                arrowStart: arrows.start,
                arrowEnd: arrows.end,
                style,
                d,
                id: el.id || null,
                text: null
            });
        }
    }

    /** Nearest xml:space declaration, walking up to the root. */
    _xmlSpacePreserved(el) {
        let node = el;
        while (node && node.nodeType === 1) {
            const v = node.getAttribute('xml:space');
            if (v) return v === 'preserve';
            if (node === this.svgEl) break;
            node = node.parentNode;
        }
        return false;
    }

    _parseText(el, style, transform) {
        if (el.querySelector('textPath')) {
            this._warn('<textPath> is not supported - the text was placed at its anchor instead');
        }

        const baseX = parseFloat(el.getAttribute('x') || 0);
        const baseY = parseFloat(el.getAttribute('y') || 0);

        // Walk the children rather than collecting every <tspan> at once: a
        // tspan carrying its own x/y is a new line at a new position, and the
        // bare text before it must not be thrown away.
        const pieces = [];
        let cur = { x: baseX, y: baseY, style, parts: [] };

        // SVG collapses runs of whitespace unless xml:space="preserve"
        const preserve = this._xmlSpacePreserved(el);

        const flush = () => {
            const raw = cur.parts.join('');
            const text = preserve ? raw.replace(/[\n\r\t]/g, ' ') : raw.replace(/\s+/g, ' ').trim();
            if (text) pieces.push({ x: cur.x, y: cur.y, style: cur.style, text });
            cur = { x: cur.x, y: cur.y, style: cur.style, parts: [] };
        };

        for (const node of el.childNodes) {
            if (node.nodeType === 3) {           // text node
                cur.parts.push(node.textContent);
                continue;
            }
            if (node.nodeType !== 1) continue;

            if (node.tagName.toLowerCase() !== 'tspan') {
                cur.parts.push(node.textContent);
                continue;
            }

            const hasOwnPos = node.hasAttribute('x') || node.hasAttribute('y') ||
                              node.hasAttribute('dx') || node.hasAttribute('dy');
            const spanStyle = this._scaleStyle(this._extractStyle(node), transform);

            if (!hasOwnPos) {
                cur.parts.push(node.textContent);
                continue;
            }

            flush();
            const nx = node.hasAttribute('x') ? parseFloat(node.getAttribute('x'))
                     : cur.x + parseFloat(node.getAttribute('dx') || 0);
            const ny = node.hasAttribute('y') ? parseFloat(node.getAttribute('y'))
                     : cur.y + parseFloat(node.getAttribute('dy') || 0);
            cur = { x: nx, y: ny, style: spanStyle, parts: [node.textContent] };
            flush();
        }
        flush();

        for (const piece of pieces) {
            const pos = this._applyTransform(piece.x, piece.y, transform);
            const st = Object.assign({}, piece.style);
            // Text is painted with `fill`; SVG's default text colour is black.
            st.textColor = (st.fill && st.fill !== 'none') ? st.fill : '#000000';

            this.texts.push({
                x: pos.x,
                y: pos.y,
                text: piece.text,
                style: st,
                id: el.id || null
            });
        }
    }

    /**
     * Which ends carry an arrowhead. Reporting only "has an arrow" put the
     * head on the wrong end for marker-start, and lost one head on a
     * double-headed connector.
     */
    _arrowMarkers(el) {
        return {
            start: !!el.getAttribute('marker-start'),
            end: !!el.getAttribute('marker-end')
        };
    }

    _hasArrowMarker(el) {
        const m = this._arrowMarkers(el);
        return m.start || m.end;
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
        // A fixed 30px radius is far too coarse on a small drawing and far too
        // tight on a large one, so scale it with the diagram's diagonal.
        const diagonal = Math.hypot(this.viewBox.width, this.viewBox.height);
        this.glueThreshold = Math.max(8, Math.min(48, diagonal * 0.015));

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
        const MAX_DIST = this.glueThreshold || 30;
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
            warnings: this.warnings,
            viewBox: this.viewBox
        };
    }
}
