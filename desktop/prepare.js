// Copy the server and the built UI into this package before Electron runs or packages it.
//
// Why copy rather than reference ../server directly: the bundled server.js does
// `import express from 'express'`, and Node resolves that by walking UP from the file's
// own location. Sitting inside desktop/, it finds desktop/node_modules — the copy that
// electron-builder actually ships and rebuilds against Electron's ABI. Left in ../server
// it would resolve to the standalone server's node_modules, which isn't in the bundle.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const bundle = path.join(__dirname, 'server-bundle');
const webOut = path.join(__dirname, 'web-dist');
const webDist = path.join(root, 'web', 'dist');

fs.mkdirSync(bundle, { recursive: true });
// server.js is ESM, but desktop/package.json has no "type": "module" (main.js is
// CommonJS, which Electron is happiest with). Copying it as .mjs tells Node it's ESM
// without forcing a module type on this whole package.
fs.copyFileSync(path.join(root, 'server', 'server.js'), path.join(bundle, 'server.mjs'));
fs.copyFileSync(path.join(root, 'server', 'schema.sql'), path.join(bundle, 'schema.sql'));

if (!fs.existsSync(path.join(webDist, 'index.html'))) {
  console.error('\nweb/dist is missing. Build the UI first:\n  cd web && npm install && npm run build\n');
  process.exit(1);
}
fs.rmSync(webOut, { recursive: true, force: true });
fs.cpSync(webDist, webOut, { recursive: true });

console.log('bundled: server.js, schema.sql, web-dist/');
