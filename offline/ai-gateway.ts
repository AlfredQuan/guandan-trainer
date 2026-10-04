import { legalMoves, type Observation } from '../lib/game/ai';
import { beats, comboOptions, parseCombo } from '../lib/game/rules';
import type { Card, ComboDeclaration, GameState, Seat } from '../lib/game/types';
import { chooseStructuredMove } from './strong-ai';

/** A local, replaceable decision boundary. Neither requests nor providers receive GameState/seed/opponent hands. */
export interface AiAction { cards: string[] | null; declared?: ComboDeclaration }
export interface AiView {
  seat: Seat; hand: Card[]; level: Observation['level']; turn: Seat;
  lastPlay: Observation['lastPlay']; counts: number[]; events: Observation['events'];
}
export interface AiRequest {
  version: 1; requestId: string; intent: 'play' | 'hint';
  view: AiView; actions: AiAction[];
}
export interface AiReply { version: 1; requestId: string; provider: string; action: AiAction }
export interface AiProvider { id: string; timeoutMs?: number; decide(request: AiRequest, signal?: AbortSignal): Promise<AiReply> }

export function actionKey(action: AiAction): string {
  return action.cards === null ? 'pass' : `${[...action.cards].sort().join('|')}#${action.declared ? `${action.declared.kind}:${action.declared.mainRank}:${action.declared.secondaryRank ?? ''}` : 'default'}`;
}
export function validAiAction(view: AiView, action: AiAction): boolean {
  if (!action || typeof action !== 'object') return false;
  if (action.cards === null) return !!view.lastPlay && action.declared === undefined;
  if (!Array.isArray(action.cards) || !action.cards.length || action.cards.length > view.hand.length || action.cards.some(id => typeof id !== 'string') || new Set(action.cards).size !== action.cards.length) return false;
  const byId = new Map(view.hand.map(card => [card.id, card]));
  const cards = action.cards.map(id => byId.get(id));
  if (cards.some(card => !card)) return false;
  if (action.declared !== undefined && (!action.declared || !['single', 'pair', 'triple', 'triplePair', 'straight', 'tube', 'plate', 'bomb', 'straightFlush', 'jokerBomb'].includes(action.declared.kind) || !Number.isFinite(action.declared.mainRank))) return false;
  const combo = parseCombo(cards as Card[], view.level, action.declared);
  return !!combo && beats(combo, view.lastPlay?.combo ?? null);
}

export function publicAiView(o: Observation): AiView {
  return {
    seat: o.seat, turn: o.turn, level: o.level,
    hand: o.hand.map(c => ({ id: c.id, suit: c.suit, rank: c.rank, deck: c.deck })),
    lastPlay: o.lastPlay ? {
      seat: o.lastPlay.seat, cardIds: [...o.lastPlay.cardIds],
      combo: { ...o.lastPlay.combo, cards: o.lastPlay.combo.cards.map(c => ({ ...c })), wildIds: [...o.lastPlay.combo.wildIds] },
    } : null,
    counts: [...o.counts],
    events: o.events.filter(e => e.type !== 'deal').map(e => ({ id: e.id, type: e.type, at: e.at, seat: e.seat, cardIds: e.cardIds ? [...e.cardIds] : undefined, note: e.type === 'trick' ? e.note : undefined })),
  };
}

/** Bounded representative candidates; explicit wildcard interpretations carry their own declaration. */
export function buildAiRequest(o: Observation, intent: AiRequest['intent'], requestId: string, maxActions = 256): AiRequest {
  if (o.turn !== o.seat || !Number.isInteger(maxActions) || maxActions < 1 || maxActions > 512) throw new Error('AI 请求参数无效');
  const view = publicAiView(o);
  const byId = new Map(view.hand.map(card => [card.id, card]));
  const actions: AiAction[] = [], seen = new Set<string>();
  const add = (a: AiAction): void => { const key = actionKey(a); if (actions.length < maxActions && !seen.has(key) && validAiAction(view, a)) { seen.add(key); actions.push(a); } };
  const preferred = chooseStructuredMove(o);
  if (preferred) add({ cards: preferred });
  if (o.lastPlay) add({ cards: null });
  for (const ids of legalMoves(o, 'analysis')) {
    if (actions.length >= maxActions) break;
    const cards = ids.map(id => byId.get(id)!);
    for (const combo of comboOptions(cards, view.level)) {
      if (!beats(combo, view.lastPlay?.combo ?? null)) continue;
      const defaultCombo = parseCombo(cards, view.level);
      const sameAsDefault = defaultCombo?.kind === combo.kind && defaultCombo.mainRank === combo.mainRank && defaultCombo.secondaryRank === combo.secondaryRank;
      add({ cards: ids, ...(sameAsDefault ? {} : { declared: { kind: combo.kind, mainRank: combo.mainRank, secondaryRank: combo.secondaryRank } }) });
    }
  }
  if (!actions.length) throw new Error('未能生成合法 AI 动作');
  return { version: 1, requestId, intent, view, actions };
}

export function verifyAiReply(request: AiRequest, reply: AiReply): AiAction {
  if (!reply || reply.version !== 1 || reply.requestId !== request.requestId || typeof reply.provider !== 'string') throw new Error('AI 响应版本或请求编号无效');
  if (!validAiAction(request.view, reply.action) || !request.actions.some(action => actionKey(action) === actionKey(reply.action))) throw new Error('AI 返回了候选集以外或非法的动作');
  return reply.action;
}

export const localAiProvider: AiProvider = {
  id: 'structured-v0.11',
  async decide(request) {
    const o: Observation = { ...request.view, role: (['you', 'boss', 'partner', 'opponent'] as const)[request.view.seat], persona: (['learner', 'control', 'partnerFirst', 'tempo'] as const)[request.view.seat] };
    const preferred = chooseStructuredMove(o);
    const target = preferred ? actionKey({ cards: preferred }) : 'pass';
    const action = request.actions.find(option => actionKey(option) === target)
      ?? (request.view.lastPlay ? request.actions.find(option => option.cards === null) : undefined)
      ?? request.actions.find(option => option.cards !== null);
    if (!action) throw new Error('没有可执行的 AI 动作');
    return { version: 1, requestId: request.requestId, provider: this.id, action };
  },
};

/** Optional loopback provider. Never sends GameState, seed, other seats' hands, or saved games. */
export function loopbackAiProvider(endpoint = 'http://127.0.0.1:17364/v1/decide'): AiProvider {
  if (endpoint !== 'http://127.0.0.1:17364/v1/decide') throw new Error('只允许预设的本机 AI 地址');
  return {
    id: 'loopback-v1',
    timeoutMs: 10000,
    async decide(request, signal) {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal });
      if (!response.ok) throw new Error(`本机 AI 服务不可用（${response.status}）`);
      return await response.json() as AiReply;
    },
  };
}

/** Timeout, invalid reply, and backend failure all fail closed to the offline strategy. */
export async function decideSafely(request: AiRequest, provider: AiProvider, timeoutMs = provider.timeoutMs ?? 1200): Promise<{ action: AiAction; source: string; fallback: boolean }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      provider.decide(request, controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('AI 决策超时')); }, timeoutMs); }),
    ]);
    return { action: verifyAiReply(request, reply), source: reply.provider, fallback: false };
  } catch {
    const fallback = await localAiProvider.decide(request);
    return { action: verifyAiReply(request, fallback), source: localAiProvider.id, fallback: true };
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Revalidate at commit time against the authoritative engine; no provider can mutate state. */
export function aiActionToGame(action: AiAction, state: GameState): { seat: Seat; kind: 'play'; cards: string[]; declared?: ComboDeclaration } | { seat: Seat; kind: 'pass' } {
  const seat = state.turn;
  if (action.cards === null) return { seat, kind: 'pass' };
  return { seat, kind: 'play', cards: action.cards, ...(action.declared ? { declared: action.declared } : {}) };
}
