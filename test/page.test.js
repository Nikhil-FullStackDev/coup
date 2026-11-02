// The page's classic scripts share one global scope. Parse them together, in index.html order, so a duplicate
// top-level name (which stops the whole page from loading) fails here instead of in players' browsers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('the page scripts parse together as one scope', () => {
  const pub = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]).filter(s => !/^https?:/.test(s));
  assert.ok(srcs.includes('app.js'), 'index.html loads app.js');
  const code = srcs.map(s => `// ${s}\n` + fs.readFileSync(path.join(pub, s.split('?')[0]), 'utf8')).join('\n;\n');
  assert.doesNotThrow(() => new vm.Script(code, { filename: 'page.js' }));
});
