import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const ts = require(process.argv[2] || 'typescript');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const target = path.resolve(root, '..', 'outputs', 'guandan-offline-v0.15');
const entries = ['offline/main.ts', 'offline/analysis.ts', 'offline/hand-tools.ts', 'offline/ai-gateway.ts', 'offline/arena-status.ts', 'offline/ai-budget-smoke.ts', 'offline/ai-gateway-smoke.ts', 'offline/smoke.ts', 'offline/analysis-smoke.ts', 'offline/hand-tools-smoke.ts', 'offline/ai-benchmark.ts', 'offline/strong-ai.ts', 'offline/strong-ai-smoke.ts', 'offline/advanced-search.ts', 'offline/advanced-search-smoke.ts', 'offline/model-search.ts', 'offline/model-search-benchmark.ts', 'offline/model-search-smoke.ts', 'offline/search-distill.ts', 'offline/search-distill-smoke.ts', 'offline/search-ai.ts', 'offline/search-ai-smoke.ts', 'offline/search-benchmark.ts', 'offline/card-memory.ts', 'offline/card-memory-smoke.ts', 'offline/selfplay.ts', 'offline/selfplay-smoke.ts', 'offline/teacher-challenge.ts', 'offline/neural-policy.ts', 'offline/neural-smoke.ts', 'offline/cloud-selfplay.ts', 'lib/game/cards.ts', 'lib/game/types.ts', 'lib/game/rules.ts', 'lib/game/engine.ts', 'lib/game/ai.ts'];

fs.mkdirSync(target, { recursive: true });
for (const entry of entries) {
  const input = fs.readFileSync(path.join(root, entry), 'utf8');
  const result = ts.transpileModule(input, { fileName: entry, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, strict: true } });
  if (result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error(`编译失败：${entry}`);
  const output = result.outputText
    .replace(/import\s+["']\.\/style\.css["'];?/g, '')
    .replace(/(\bfrom\s*["'])(\.{1,2}\/[^"']+)(["'])/g, (_, start, source, end) => `${start}${source}.js${end}`);
  const destination = path.join(target, entry.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, output);
}
fs.writeFileSync(path.join(target, 'package.json'), '{"type":"module"}\n');
fs.copyFileSync(path.join(here, 'style.css'), path.join(target, 'offline/style.css'));
fs.copyFileSync(path.join(here, 'public/sw.js'), path.join(target, 'offline/sw.js'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(target, 'LICENSE'));
fs.copyFileSync(path.join(here, 'ai-server.mjs'), path.join(target, 'offline/ai-server.mjs'));
fs.copyFileSync(path.join(here, 'ai-provider-example.mjs'), path.join(target, 'offline/ai-provider-example.mjs'));
for (const releaseFile of ['release-policy.mjs', 'release-provider.mjs']) fs.copyFileSync(path.join(here, releaseFile), path.join(target, 'offline', releaseFile));
fs.copyFileSync(path.join(here, 'advanced-provider.mjs'), path.join(target, 'offline/advanced-provider.mjs'));
fs.copyFileSync(path.join(here, 'model-search-provider.mjs'), path.join(target, 'offline/model-search-provider.mjs'));
fs.copyFileSync(path.join(here, 'search-provider.mjs'), path.join(target, 'offline/search-provider.mjs'));
fs.copyFileSync(path.join(here, 'neural-provider.mjs'), path.join(target, 'offline/neural-provider.mjs'));
fs.copyFileSync(path.join(here, 'train-neural.mjs'), path.join(target, 'offline/train-neural.mjs'));
fs.copyFileSync(path.join(here, 'check-model.mjs'), path.join(target, 'offline/check-model.mjs'));
const html = fs.readFileSync(path.join(here, 'index.html'), 'utf8')
  .replace('./main.ts', './main.js')
  .replace('</head>', '  <link rel="stylesheet" href="./style.css" />\n</head>');
fs.writeFileSync(path.join(target, 'offline/index.html'), html);

const modules = entries.filter(entry => !entry.endsWith('-smoke.ts') && entry !== 'offline/smoke.ts' && entry !== 'offline/ai-benchmark.ts' && entry !== 'offline/advanced-search.ts' && entry !== 'offline/model-search.ts' && entry !== 'offline/model-search-benchmark.ts' && entry !== 'offline/search-distill.ts' && entry !== 'offline/search-benchmark.ts' && entry !== 'offline/selfplay.ts' && entry !== 'offline/teacher-challenge.ts' && entry !== 'offline/cloud-selfplay.ts' && entry !== 'offline/neural-policy.ts').map(entry => {
  const id = entry.replace(/\.ts$/, '');
  const source = fs.readFileSync(path.join(root, entry), 'utf8');
  const compiled = ts.transpileModule(source, { fileName: entry, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true } }).outputText
    .replace(/^require\(["']\.\/style\.css["']\);?\s*$/gm, '');
  return `${JSON.stringify(id)}: function(require, module, exports) {\n${compiled}\n}`;
}).join(',\n');
const runtime = `(function () {\nconst modules = {\n${modules}\n};\nconst loaded = {};\nfunction load(id) {\n  if (loaded[id]) return loaded[id].exports;\n  if (!Object.hasOwn(modules, id)) throw new Error('找不到模块：' + id);\n  const module = { exports: {} }; loaded[id] = module;\n  const localRequire = spec => {\n    const parts = id.split('/'); parts.pop();\n    for (const part of spec.split('/')) { if (part === '..') parts.pop(); else if (part !== '.') parts.push(part); }\n    return load(parts.join('/').replace(/\\.js$/, ''));\n  };\n  modules[id](localRequire, module, module.exports);\n  return module.exports;\n}\nload('offline/main');\n})();`;
const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const standalone = fs.readFileSync(path.join(here, 'index.html'), 'utf8')
  .replace('  <script type="module" src="./main.ts"></script>', `<details style="padding:1rem;margin:auto;max-width:960px;color:#5d6d61"><summary>开源组件许可证（Apache-2.0）</summary><pre style="white-space:pre-wrap;font-size:10px">${escape(license)}</pre></details>\n<script>${runtime.replaceAll('</script', '<\\/script')}</script>`)
  .replace('</head>', `<style>${fs.readFileSync(path.join(here, 'style.css'), 'utf8')}</style>\n</head>`);
if (standalone.includes('src="./main.ts"') || !standalone.includes('<script>' + runtime.slice(0, 24))) throw new Error('单文件入口未正确内嵌');
const standalonePath = path.resolve(root, '..', 'outputs', '掼蛋Arena_v0.15_单机版.html');
fs.writeFileSync(standalonePath, standalone);

// The mobile entry is self-contained: it also works inside an Android WebView with no network.
const mobileDir = path.join(root, 'mobile', 'offline');
fs.mkdirSync(mobileDir, { recursive: true });
const mobileHtml = standalone
  .replace('<html lang="zh-CN">', '<html lang="zh-CN" data-platform="android">')
  .replace('<title>掼蛋训练器 · 离线对局</title>', '<title>掼蛋训练器 · 手机离线版</title>')
  .replace('</head>', '  <link rel="manifest" href="./mobile.webmanifest" />\n  <meta name="mobile-web-app-capable" content="yes" />\n  <meta name="apple-mobile-web-app-capable" content="yes" />\n</head>');
fs.writeFileSync(path.join(mobileDir, 'index.html'), mobileHtml);
fs.copyFileSync(path.join(here, 'mobile.webmanifest'), path.join(mobileDir, 'mobile.webmanifest'));
fs.copyFileSync(path.join(here, 'public', 'sw.js'), path.join(mobileDir, 'sw.js'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(mobileDir, '..', 'LICENSE'));
// Draw a local app icon with no external image, font or runtime dependency.
const crcTable = Array.from({ length: 256 }, (_, i) => { let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function icon(size) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1); pixels[row] = 0;
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const cardBack = u > .23 && u < .71 && v > .17 && v < .81;
      const cardFront = u > .32 && u < .80 && v > .25 && v < .88;
      const heart = Math.pow((u - .56) / .105, 2) + Math.pow((v - .51 - .085 * Math.sqrt(Math.abs((u - .56) / .105))) / .13, 2) < 1;
      let color = [38, 87, 65];
      if (cardBack) color = [200, 221, 199];
      if (cardFront) color = [253, 252, 245];
      if (cardFront && heart) color = [186, 51, 68];
      const off = row + 1 + 4 * x;
      pixels[off] = color[0]; pixels[off + 1] = color[1]; pixels[off + 2] = color[2]; pixels[off + 3] = 255;
    }
  }
  const chunk = (name, data) => { const tag = Buffer.from(name), body = Buffer.concat([tag, data]); let crc = 0xffffffff; for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); const head = Buffer.alloc(8), tail = Buffer.alloc(4); head.writeUInt32BE(data.length); tag.copy(head, 4); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([head, data, tail]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
for (const size of [192, 512]) fs.writeFileSync(path.join(mobileDir, `icon-${size}.png`), icon(size));
const nativeRes = path.join(root, 'mobile', 'android', 'app', 'src', 'main', 'res');
if (fs.existsSync(nativeRes)) for (const [dpi, size] of Object.entries({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 })) {
  const directory = path.join(nativeRes, `mipmap-${dpi}`);
  for (const suffix of ['', '_round', '_foreground']) fs.writeFileSync(path.join(directory, `ic_launcher${suffix}.png`), icon(size));
}
console.log(`独立手机离线入口已生成：${path.join(mobileDir, 'index.html')}`);
console.log(`离线单文件已生成：${standalonePath}`);
console.log(`PWA 静态目录已生成：${path.join(target, 'offline')}`);
