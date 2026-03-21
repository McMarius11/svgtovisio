#!/usr/bin/env node
/**
 * Build script - inlines all JS files into index.html for standalone deployment.
 * This avoids file:// and CORS issues when opening the HTML directly.
 *
 * Usage: node build.js
 * Output: dist/index.html (self-contained single file)
 */

const fs = require('fs');
const path = require('path');

const srcDir = __dirname;
const distDir = path.join(srcDir, 'dist');

if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir);
}

let html = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf8');

// Inline each local script src
const scriptRegex = /<script src="([^"]+\.js)"><\/script>/g;
html = html.replace(scriptRegex, (match, src) => {
    // Skip CDN scripts
    if (src.startsWith('http')) return match;

    const filePath = path.join(srcDir, src);
    if (!fs.existsSync(filePath)) {
        console.error(`WARNING: ${src} not found, keeping external reference`);
        return match;
    }

    const code = fs.readFileSync(filePath, 'utf8');
    console.log(`Inlined: ${src} (${(code.length / 1024).toFixed(1)} KB)`);
    return `<script>/* ${src} */\n${code}\n</script>`;
});

fs.writeFileSync(path.join(distDir, 'index.html'), html);
console.log(`\nBuilt: dist/index.html (${(html.length / 1024).toFixed(1)} KB)`);
