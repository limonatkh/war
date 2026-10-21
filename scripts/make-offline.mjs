// Package an offline HTML release from local Three.js ES module builds.
// Usage: node scripts/make-offline.mjs /absolute/path/to/three-build-directory /absolute/output.html
// Node 24's TypeScript transform handles syntax; run npm run build for full type checking.
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative, posix } from 'node:path';
const [threePath, output] = process.argv.slice(2);
if (!threePath || !output) throw new Error('Pass the Three.js build directory and output HTML path.');
const root = resolve(import.meta.dirname, '..');
const imports = {};
const encode = (code) => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
for (const name of ['three.core.js', 'three.module.js']) {
  const code = readFileSync(resolve(threePath, name), 'utf8').replaceAll("'./three.core.js'", "'war:three-core'");
  imports[name === 'three.core.js' ? 'war:three-core' : 'three'] = encode(code);
}
function collect(directory) {
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) {
      let code = stripTypeScriptTypes(readFileSync(resolve(root, path), 'utf8'), { mode: 'transform' });
      code = code.replace("import './style.css';", '');
      code = code.replace(/from '([.][^']+)'/g, (_, specifier) => `from 'war:${posix.normalize(posix.join(posix.dirname(path), specifier))}'`);
      imports['war:' + path.slice(0, -3)] = encode(code);
    }
  }
}
collect('src');
const css = readFileSync(resolve(root, 'src/style.css'), 'utf8');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lemonat: WAR — Field Command</title><style>${css}</style><script type="importmap">${JSON.stringify({ imports })}</script></head><body><div id="ui"></div><script type="module">import 'war:src/main';</script></body></html>`;
writeFileSync(output, html);
console.log(`Offline game created: ${output} (${Buffer.byteLength(html)} bytes, ${Object.keys(imports).length} embedded modules).`);
