/**
 * App - Ties together the UI, SVG parser, and VSDX builder.
 */

(function () {
    const dropZone = document.getElementById('dropZone');
    const browseBtn = document.getElementById('browseBtn');
    const fileInput = document.getElementById('fileInput');
    const svgInput = document.getElementById('svgInput');
    const convertBtn = document.getElementById('convertBtn');
    const statusText = document.getElementById('statusText');
    const logEl = document.getElementById('log');
    const previewSection = document.getElementById('previewSection');
    const previewContainer = document.getElementById('previewContainer');
    const statsEl = document.getElementById('stats');

    let currentInput = '';
    let currentFormat = 'svg'; // 'svg' or 'drawio'

    // --- Drag and drop ---
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file) loadFile(file);
    });

    browseBtn.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('click', (e) => {
        if (e.target !== browseBtn) fileInput.click();
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files[0]) loadFile(fileInput.files[0]);
    });

    // --- Paste area ---
    svgInput.addEventListener('input', () => {
        const val = svgInput.value.trim();
        if (val && val.includes('<svg')) {
            currentInput = val;
            currentFormat = 'svg';
            convertBtn.disabled = false;
            showPreview(val);
        } else if (val && (val.includes('<mxGraphModel') || val.includes('<mxfile'))) {
            currentInput = val;
            currentFormat = 'drawio';
            convertBtn.disabled = false;
            showPreview(null);
            log('Draw.io XML detected', 'info');
        } else {
            convertBtn.disabled = !currentInput;
        }
    });

    // --- Convert button ---
    convertBtn.addEventListener('click', async () => {
        if (!currentInput) return;
        await convert(currentInput, currentFormat);
    });

    function loadFile(file) {
        const name = file.name.toLowerCase();
        const isSvg = name.endsWith('.svg') || file.type === 'image/svg+xml';
        const isDrawio = name.endsWith('.drawio') || name.endsWith('.xml');

        if (!isSvg && !isDrawio) {
            log('Please select an SVG, .drawio, or .xml file.', 'error');
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const content = e.target.result;
            currentInput = content;
            svgInput.value = content;

            // Auto-detect format from content
            if (content.includes('<mxGraphModel') || content.includes('<mxfile')) {
                currentFormat = 'drawio';
                showPreview(null);
                log(`Loaded Draw.io file: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`, 'info');
            } else {
                currentFormat = 'svg';
                showPreview(content);
                log(`Loaded SVG: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`, 'info');
            }

            convertBtn.disabled = false;
        };
        reader.readAsText(file);
    }

    function showPreview(svgString) {
        previewSection.style.display = 'block';
        if (svgString) {
            previewContainer.innerHTML = svgString;
            const svg = previewContainer.querySelector('svg');
            if (svg) {
                svg.style.maxWidth = '100%';
                svg.style.height = 'auto';
            }
        } else {
            previewContainer.innerHTML = '<p style="color:#888; padding:2rem;">Draw.io XML loaded (no visual preview)</p>';
        }
    }

    async function convert(inputString, format) {
        logEl.style.display = 'block';
        logEl.innerHTML = '';
        convertBtn.disabled = true;
        statusText.textContent = 'Converting...';

        try {
            // Parse input based on format
            const isDrawio = format === 'drawio';
            log(isDrawio ? 'Parsing Draw.io XML...' : 'Parsing SVG...', 'info');

            const parser = isDrawio ? new DrawioParser(inputString) : new SvgParser(inputString);
            const parsed = parser.parse();
            const stats = parser.getStats();

            log(`Found ${stats.shapes} shapes, ${stats.connectors} connectors, ${stats.texts} standalone texts`, 'info');
            showStats(stats);

            // Build VSDX
            log('Building VSDX file...', 'info');
            const builder = new VsdxBuilder(parsed);
            const blob = await builder.build();

            log(`Generated VSDX: ${(blob.size / 1024).toFixed(1)} KB`, 'success');

            // Download
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'diagram.vsdx';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            log('Download started!', 'success');
            statusText.textContent = 'Done! Check your downloads.';
        } catch (err) {
            log('Error: ' + err.message, 'error');
            statusText.textContent = 'Conversion failed.';
            console.error(err);
        } finally {
            convertBtn.disabled = false;
        }
    }

    function showStats(stats) {
        statsEl.innerHTML = `
            <div class="stat-badge">Shapes: <span>${stats.shapes}</span></div>
            <div class="stat-badge">Connectors: <span>${stats.connectors}</span></div>
            <div class="stat-badge">Texts: <span>${stats.texts}</span></div>
            <div class="stat-badge">Canvas: <span>${stats.viewBox.width} x ${stats.viewBox.height}</span></div>
        `;
    }

    function log(msg, type) {
        const line = document.createElement('div');
        line.className = type || '';
        line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        logEl.appendChild(line);
        logEl.scrollTop = logEl.scrollHeight;
    }
})();
