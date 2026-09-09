// @ts-check
/**
 * Layout heuristics, applied to the scene model after parsing.
 *
 * These decide which shapes are grouping frames, which label belongs to which
 * box, and which shapes a connector is glued to. They live here rather than in
 * a parser because they are not SVG-specific: a Draw.io drawing with nested
 * containers must behave the same way as the equivalent SVG. Previously they
 * only ran for SVG input.
 *
 * Every threshold is in TUNING. When a drawing converts badly, this is the
 * first place to look.
 */

const SceneLayout = {
    TUNING: Object.freeze({
        /**
         * A shape counts as a frame only if the shape it encloses is
         * meaningfully smaller. Without the margin, two rectangles of nearly
         * identical size would each call the other a container.
         */
        containerAreaRatio: 0.9,

        /**
         * Slack, in user units, when testing whether a label sits inside a
         * box. Generous padding lets a caption next to a small swatch get
         * swallowed by it, so keep this tight.
         */
        labelPadding: 2,

        /**
         * The connector glue radius is this fraction of the drawing's
         * diagonal, clamped below. A fixed radius is far too coarse on a small
         * drawing and far too tight on a large one.
         */
        glueRadiusFraction: 0.015,
        glueRadiusMin: 8,
        glueRadiusMax: 48
    }),

    /**
     * Run every heuristic over a scene, in order. Containers must be known
     * before labels are assigned, and labels before connectors are glued.
     * @param {any} scene
     * @param {any} [tuning]
     */
    apply(scene, tuning) {
        const t = tuning || this.TUNING;
        this.markContainers(scene, t);
        this.associateTexts(scene, t);
        this.glueConnectors(scene, t);
        return scene;
    },

    /** Glue radius for a drawing of this size, in user units. */
    glueRadius(scene, tuning) {
        const diagonal = Math.hypot(scene.viewBox.width, scene.viewBox.height);
        return Math.max(tuning.glueRadiusMin,
                        Math.min(tuning.glueRadiusMax, diagonal * tuning.glueRadiusFraction));
    },

    /**
     * A shape that fully encloses another shape is a grouping frame (subnet,
     * VNet, legend box), not a labelled box. Such frames must not swallow the
     * labels of the shapes inside them, and connectors must not glue to them.
     */
    markContainers(scene, tuning) {
        for (const a of scene.shapes) {
            a.isContainer = false;
            const areaA = a.width * a.height;
            if (areaA <= 0) continue;
            for (const b of scene.shapes) {
                if (b === a) continue;
                const areaB = b.width * b.height;
                if (areaB <= 0 || areaB >= areaA * tuning.containerAreaRatio) continue;
                if (b.x >= a.x - 1 && b.y >= a.y - 1 &&
                    b.x + b.width <= a.x + a.width + 1 &&
                    b.y + b.height <= a.y + a.height + 1) {
                    a.isContainer = true;
                    break;
                }
            }
        }
    },

    associateTexts(scene, tuning) {
        const PAD = tuning.labelPadding;
        const assigned = new Map();

        for (const text of scene.texts) {
            // A parser that already classified this text keeps the last word
            if (text.standalone) continue;

            let best = null;
            let bestArea = Infinity;

            for (const shape of scene.shapes) {
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
        scene.texts = scene.texts.filter(t => !t._associated);
    },

    glueConnectors(scene, tuning) {
        // A fixed 30px radius is far too coarse on a small drawing and far too
        // tight on a large one, so scale it with the diagram's diagonal.
        // Try to detect which shapes connectors connect to
        for (const conn of scene.connectors) {
            if (conn.points.length < 2) continue;

            // Only derive an endpoint the parser could not supply itself.
            // Draw.io knows its edges' source and target exactly; guessing
            // geometrically would be strictly worse.
            if (conn.fromShape === null) {
                conn.fromShape = this.findNearestShape(scene, tuning, conn.points[0]);
            }
            if (conn.toShape === null) {
                conn.toShape = this.findNearestShape(scene, tuning, conn.points[conn.points.length - 1]);
            }
        }
    },

    findNearestShape(scene, tuning, point) {
        const MAX_DIST = this.glueRadius(scene, tuning);
        let best = null;
        let bestDist = MAX_DIST;
        let bestArea = Infinity;

        for (let i = 0; i < scene.shapes.length; i++) {
            const shape = scene.shapes[i];
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
};
