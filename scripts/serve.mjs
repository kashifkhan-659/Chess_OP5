// Dependency-free static server. With no argument it serves src/ and public/
// overlaid, so `npm run dev` needs no build step — just refresh the page.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
const roots = (arg ? [arg] : ['src', 'public']).map((d) => path.resolve(root, d));
const port = Number(process.env.PORT) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function resolve(urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  rel = path.normalize(rel).replace(/^([/\\])+/, '');
  for (const base of roots) {
    const full = path.join(base, rel);
    // Refuse anything that escapes the served root.
    if (!full.startsWith(base)) continue;
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return null;
}

createServer((req, res) => {
  const file = resolve(req.url || '/');
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log(`Serving ${roots.map((r) => path.relative(root, r) || '.').join(' + ')}`);
  console.log(`  http://localhost:${port}`);
});
