import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { newGame } from '../../outputs/guandan-offline-v0.14/lib/game/engine.js';
import { observe } from '../../outputs/guandan-offline-v0.14/lib/game/ai.js';
import { buildAiRequest, verifyAiReply } from '../../outputs/guandan-offline-v0.14/offline/ai-gateway.js';

const finder = net.createServer();
await new Promise(resolve => finder.listen(0, '127.0.0.1', resolve));
const port = finder.address().port;
await new Promise(resolve => finder.close(resolve));
const custom = process.argv.includes('--custom');
const modulePath = fileURLToPath(new URL('../../outputs/guandan-offline-v0.14/offline/ai-provider-example.mjs', import.meta.url));
const child = spawn(process.execPath, [fileURLToPath(new URL('../../outputs/guandan-offline-v0.14/offline/ai-server.mjs', import.meta.url))], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, GUANDAN_AI_PORT: String(port), ...(custom ? { GUANDAN_AI_PROVIDER_MODULE: modulePath } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  await Promise.race([
    new Promise((resolve, reject) => {
      let stdout = '';
      child.stdout.on('data', data => { stdout += data; if (stdout.includes('"status":"ready"')) resolve(); });
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`本机服务提前退出 ${code}`)));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('服务启动超时')), 5000)),
  ]);
  const root = `http://127.0.0.1:${port}`;
  const health = await fetch(root + '/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).provider, custom ? 'example-fast-shed-v1' : 'structured-v0.11');
  const request = buildAiRequest(observe(newGame(4, 9), 0), 'play', 'http-test-1');
  const response = await fetch(root + '/v1/decide', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'null' }, body: JSON.stringify(request) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'null');
  verifyAiReply(request, await response.json());
  const invalid = await fetch(root + '/v1/decide', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'null' }, body: JSON.stringify({ ...request, view: { ...request.view, seed: 12345 } }) });
  assert.equal(invalid.status, 400, '服务不得接受暗牌种子字段');
  const denied = await fetch(root + '/v1/decide', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.com' }, body: JSON.stringify(request) });
  assert.equal(denied.status, 403, '拒绝任意跨域网站');
  console.log(`本机 AI HTTP 冒烟通过（${custom ? '可替换策略模块' : '默认策略'}）：健康检查、合法动作、隐私字段拒绝与跨域限制`);
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); });
}
