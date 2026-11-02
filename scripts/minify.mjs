// Minifies ratings.js (and the CSS embedded in it) for release builds.
// Usage: node minify.mjs <in.js> <out.js>   (needs the esbuild package)
import { transform } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

const [input, output] = process.argv.slice(2);
let src = readFileSync(input, 'utf8');

// esbuild leaves template strings alone, so minify the stylesheet on its own first.
const cssPattern = /style\.textContent = `([\s\S]*?)`;/;
const css = src.match(cssPattern);
if (!css) {
    throw new Error('Stylesheet not found in ' + input);
}
const minCss = (await transform(css[1], { loader: 'css', minify: true })).code.trim();
src = src.replace(cssPattern, () => `style.textContent = ${JSON.stringify(minCss)};`);

const { code } = await transform(src, { minify: true, target: 'es2020' });
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, code);
console.log(`${input}: ${Buffer.byteLength(readFileSync(input))} -> ${Buffer.byteLength(code)} bytes`);
