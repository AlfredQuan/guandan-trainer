import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDeck } from '../lib/game/cards.js';
import { localAiProvider, validAiAction, verifyAiReply } from './ai-gateway.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.GUANDAN_AI_PORT ?? 17364);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('GUANDAN_AI_PORT 必须是 1024–65535 的整数');
const extraOrigin = process.env.GUANDAN_AI_ALLOWED_ORIGIN;
if (extraOrigin && !/^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/.test(extraOrigin)) throw new Error('GUANDAN_AI_ALLOWED_ORIGIN 只能是本机 HTTP 地址');
const origins = new Set(['null', `http://${HOST}:${PORT}`, `http://localhost:${PORT}`, ...(extraOrigin ? [extraOrigin] : [])]);
const deck = new Map(createDeck().map(c => [c.id, c]));
// Optional local strategy module: export default { id: string, async decide(request, signal): AiReply }.
// Only the operator can set this environment variable; never load module paths from HTTP requests.
const modulePath = process.env.GUANDAN_AI_PROVIDER_MODULE;
const provider = modulePath ? (await import(pathToFileURL(resolve(modulePath)).href)).default : localAiProvider;
if (!provider || typeof provider.id !== 'string' || !provider.id || typeof provider.decide !== 'function') throw new Error('自定义 AI 模块必须默认导出 AiProvider');
const send = (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(data)); };
const log = (id, status, duration, detail) => console.log(JSON.stringify({ at: new Date().toISOString(), requestId: id, status, elapsedMs: duration, detail }));
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'actions,intent,requestId,version,view') throw new Error('请求结构无效');
  if (value.version !== 1 || !['play', 'hint'].includes(value.intent) || typeof value.requestId !== 'string' || value.requestId.length < 1 || value.requestId.length > 80) throw new Error('协议版本或编号无效');
  const o = value.view;
  if (!o || typeof o !== 'object' || Object.keys(o).sort().join(',') !== 'counts,events,hand,lastPlay,level,seat,turn') throw new Error('仅接受玩家可见局面字段');
  if (![0, 1, 2, 3].includes(o.seat) || o.seat !== o.turn || !Number.isInteger(o.level) || o.level < 2 || o.level > 14 || !Array.isArray(o.hand) || o.hand.length < 1 || o.hand.length > 27) throw new Error('回合或手牌无效');
  if (new Set(o.hand.map(c => c.id)).size !== o.hand.length || o.hand.some(c => { const ref = deck.get(c.id); return !ref || Object.keys(c).sort().join(',') !== 'deck,id,rank,suit' || c.rank !== ref.rank || c.suit !== ref.suit || c.deck !== ref.deck; })) throw new Error('实体牌与牌库不符');
  if (!Array.isArray(o.counts) || o.counts.length !== 4 || o.counts.some(n => !Number.isInteger(n) || n < 0 || n > 27) || o.counts[o.seat] !== o.hand.length) throw new Error('剩余张数无效');
  if (!Array.isArray(o.events) || o.events.length > 500 || o.events.some(e => !e || typeof e !== 'object' || !['play', 'pass', 'trick', 'finish', 'round'].includes(e.type))) throw new Error('公开行动记录无效');
  if (o.lastPlay !== null && (!o.lastPlay || ![0,1,2,3].includes(o.lastPlay.seat) || !o.lastPlay.combo || !Array.isArray(o.lastPlay.combo.cards))) throw new Error('当前最大牌无效');
  if (!Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 512 || value.actions.some(a => !validAiAction(o, a))) throw new Error('候选动作不合法');
  return value;
}
const server = http.createServer(async (req, res) => {
  const id = randomUUID(), started = Date.now();
  const origin = req.headers.origin;
  if (origin && !origins.has(origin)) { send(res, 403, { code: 'ORIGIN_DENIED', requestId: id }); log(id, 403, Date.now() - started, 'origin'); return; }
  if (origin) { res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'Origin'); }
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS' && req.url === '/v1/decide') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/ready')) { send(res, 200, { status: 'ok', version: 1, provider: provider.id }); return; }
  if (req.method !== 'POST' || req.url !== '/v1/decide') { send(res, 404, { code: 'NOT_FOUND', requestId: id }); return; }
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) { send(res, 415, { code: 'JSON_REQUIRED', requestId: id }); return; }
  try {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 512_000) throw new Error('请求超过 512 KB'); chunks.push(chunk); }
    const input = validate(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const controller = new AbortController();
    let timer;
    try {
      const reply = await Promise.race([
        provider.decide(input, controller.signal),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('AI 模块超时')); }, 900); }),
      ]);
      verifyAiReply(input, reply);
      send(res, 200, reply); log(id, 200, Date.now() - started, input.intent);
    } catch (e) {
      send(res, 502, { code: 'PROVIDER_FAILED', requestId: id, message: e instanceof Error ? e.message : 'AI 模块失败' });
      log(id, 502, Date.now() - started, 'provider');
    } finally { if (timer) clearTimeout(timer); }
  } catch (e) {
    send(res, 400, { code: 'INVALID_REQUEST', requestId: id, message: e instanceof Error ? e.message : '输入无效' });
    log(id, 400, Date.now() - started, 'invalid');
  }
});
server.requestTimeout = 6000;
server.listen(PORT, HOST, () => console.log(JSON.stringify({ status: 'ready', host: HOST, port: PORT, provider: provider.id })));
const close = () => server.close(() => process.exit(0));
process.on('SIGINT', close);
process.on('SIGTERM', close);
