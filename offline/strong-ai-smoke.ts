import assert from 'node:assert/strict';
import { observe } from '../lib/game/ai';
import { createDeck } from '../lib/game/cards';
import { legalPlay, newGame, passTurn, playCards } from '../lib/game/engine';
import { parseCombo } from '../lib/game/rules';
import { chooseLegacyStructuredMove, chooseStructuredMove } from './strong-ai';
import type { GameState } from '../lib/game/types';

const deck = createDeck();
const get = (suit: string, rank: number) => deck.find(card => card.suit === suit && card.rank === rank)!;
for (let seed = 10; seed < 30; seed++) {
  let state = newGame(seed);
  let steps = 0;
  while (state.phase === 'playing' && steps < 350) {
    const seat = state.turn;
    const action = chooseStructuredMove(observe(state, seat));
    if (action) {
      assert.equal(legalPlay(state, seat, action).ok, true);
      state = playCards(state, seat, action);
    } else {
      assert.ok(state.lastPlay, '领出不能过牌');
      state = passTurn(state, seat);
    }
    steps++;
  }
  assert.equal(state.phase, 'finished');
}
const base = newGame(400);
const permuted: GameState = { ...base, players: base.players.map((player, seat) => seat === 0 ? player : { ...player, hand: base.players[seat === 1 ? 2 : seat === 2 ? 3 : 1].hand }) };
assert.deepEqual(chooseStructuredMove(observe(base, 0)), chooseStructuredMove(observe(permuted, 0)), '暗牌不能影响策略');
const hand = [get('S', 6), get('C', 6)];
const leader = get('S', 5);
const observation = { ...observe(base, 0), hand, level: 2 as const, lastPlay: { seat: 2 as const, cardIds: [leader.id], combo: parseCombo([leader], 2)! }, counts: [2, 15, 2, 15] };
assert.equal(chooseStructuredMove(observation), null, '队友领出且没有可一手出完的牌应让牌');
const finishing = { ...observation, hand: [get('S', 6)] };
assert.deepEqual(chooseStructuredMove(finishing), [get('S', 6).id], '能一手出完时应允许压队友');
assert.deepEqual(chooseLegacyStructuredMove(finishing), [get('S', 6).id], '冻结的旧策略必须可用于配对测试');
const pairHand = [get('S', 4), get('C', 4), get('S', 5), get('C', 5), get('S', 6), get('C', 6), get('S', 7)];
const pairObs = { ...observe(base, 0), hand: pairHand, level: 2 as const, lastPlay: null, counts: [7, 13, 13, 13] };
const improved = chooseStructuredMove(pairObs);
assert.ok(improved && parseCombo(improved.map(id => pairHand.find(card => card.id === id)!), 2), '保护牌组的策略仍须选合法牌型');
console.log('结构策略测试通过：20 副自对局、合法性、暗牌隔离、冻结旧版、让牌与直接出完');
