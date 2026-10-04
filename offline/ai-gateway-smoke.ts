import assert from 'node:assert/strict';
import { createDeck } from '../lib/game/cards';
import { observe } from '../lib/game/ai';
import { newGame, passTurn, playCards } from '../lib/game/engine';
import { parseCombo } from '../lib/game/rules';
import type { GameState, Seat } from '../lib/game/types';
import { actionKey, aiActionToGame, buildAiRequest, decideSafely, localAiProvider, validAiAction, verifyAiReply } from './ai-gateway';
import { arenaStatus } from './arena-status';

async function run(): Promise<void> {
  const opening = newGame(4, 9);
  const request = buildAiRequest(observe(opening, 0), 'play', 'smoke-1');
  assert.equal(request.view.seat, 0);
  assert.equal(request.view.hand.length, 27);
  assert.equal(request.view.counts.length, 4);
  assert.ok(request.actions.length > 0);
  assert.ok(request.actions.every(a => a.cards !== null));
  assert.ok(!Object.hasOwn(request.view, 'seed') && !Object.hasOwn(request.view, 'players'));
  for (const hand of opening.players.slice(1)) assert.ok(!request.view.hand.some(card => hand.hand.some(other => other.id === card.id)));
  const json = JSON.stringify(request);
  assert.ok(!json.includes('"seed"') && !json.includes('"players"'));
  const reply = await localAiProvider.decide(request);
  assert.ok(request.actions.some(a => actionKey(a) === actionKey(verifyAiReply(request, reply))));
  assert.deepEqual(verifyAiReply(request, reply), (await decideSafely(request, localAiProvider)).action);
  assert.throws(() => verifyAiReply(request, { ...reply, requestId: 'wrong' }));
  assert.throws(() => verifyAiReply(request, { ...reply, action: { cards: [opening.players[1].hand[0].id] } }));
  assert.equal(validAiAction(request.view, { cards: null }), false, '领出不可过牌');
  assert.equal(validAiAction(request.view, { cards: [request.view.hand[0].id, request.view.hand[0].id] }), false);
  const timeout = await decideSafely(request, { id: 'stuck', decide: () => new Promise(() => {}) }, 1);
  assert.equal(timeout.fallback, true);
  const invalid = await decideSafely(request, { id: 'unsafe', decide: async r => ({ version: 1, requestId: r.requestId, provider: 'unsafe', action: { cards: [opening.players[1].hand[0].id] } }) });
  assert.equal(invalid.fallback, true);
  const action = aiActionToGame(reply.action, opening);
  assert.equal(action.kind, 'play');
  const next = action.kind === 'play' ? playCards(opening, 0, action.cards, action.declared) : passTurn(opening, 0);
  assert.equal(next.events.find(e => e.type === 'play')?.seat, 0);

  // The UI tracks the engine's state machine; three active responses are needed after a player empties their hand.
  const deck = createDeck();
  const card = deck.find(c => c.suit === 'S' && c.rank === 5)!;
  const base = newGame(8);
  const asTrick: GameState = { ...base, turn: 1, leader: 0, passes: 0, finishOrder: [0],
    lastPlay: { seat: 0, cardIds: [card.id], combo: parseCombo([card], 2)! },
    players: base.players.map(p => p.seat === 0 ? { ...p, hand: [], finished: 1 } : { ...p, hand: [deck.find(c => c.rank === 8 + p.seat && c.suit === 'S')!] }) };
  assert.equal(arenaStatus(asTrick).required, 3);
  assert.equal(arenaStatus(asTrick).handoff, true);
  let s = passTurn(asTrick, 1 as Seat);
  assert.equal(arenaStatus(s).responses, 1);
  s = passTurn(s, 2 as Seat);
  assert.equal(arenaStatus(s).phase, 'reply');
  s = passTurn(s, 3 as Seat);
  assert.equal(arenaStatus(s).phase, 'lead');
  assert.equal(arenaStatus(s).next, 2);
  assert.equal(arenaStatus(s).handoff, true);
  assert.equal(arenaStatus(newGame(4)).label, '新一圈 · 自由领出');
  console.log('AI 网关/可见信息/非法动作回退/超时/牌权 HUD 冒烟通过');
}
void run();
