import assert from 'node:assert/strict';
import { observe } from '../lib/game/ai';
import { newGame, legalPlay, passTurn, playCards } from '../lib/game/engine';
import { countOutsideCards, possibleHigherSingles } from './card-memory';
import { chooseCardCountingMove } from './strong-ai';

for (const seed of [7001, 14920, 22839]) {
  let state = newGame(seed), steps = 0;
  while (state.phase === 'playing' && steps < 350) {
    const o = observe(state, state.turn);
    const memory = countOutsideCards(o);
    assert.equal(memory.outsideCount, o.counts.reduce((sum, count) => sum + count, 0) - o.hand.length);
    assert.equal(memory.outsideCount + memory.played.length + o.hand.length, 108);
    // Test-only omniscient oracle; production memory receives only the observation.
    const oracle = state.players.filter(player => player.seat !== o.seat).flatMap(player => player.hand.map(card => card.id)).sort();
    assert.deepEqual(memory.outside.map(card => card.id).sort(), oracle);
    assert.equal(memory.outsideByRank.get(16) ?? 0, memory.outside.filter(card => card.rank === 16).length);
    const hidden = state.players.filter(player => player.seat !== o.seat).flatMap(player => player.hand).reverse();
    let start = 0;
    const permuted = { ...state, players: state.players.map(player => {
      if (player.seat === o.seat) return player;
      const hand = hidden.slice(start, start + player.hand.length);
      start += player.hand.length;
      return { ...player, hand };
    }) };
    assert.deepEqual(countOutsideCards(observe(state, o.seat)), countOutsideCards(observe(permuted, o.seat)), '交换暗牌不能影响记牌器');
    assert.deepEqual(chooseCardCountingMove(o), chooseCardCountingMove(observe(permuted, o.seat)), '交换暗牌不能影响记牌决策');
    const action = chooseCardCountingMove(o);
    if (action) { assert.equal(legalPlay(state, state.turn, action).ok, true); state = playCards(state, state.turn, action); }
    else { assert.ok(state.lastPlay); state = passTurn(state, state.turn); }
    steps++;
  }
  assert.equal(state.phase, 'finished', '记牌策略未结束对局');
}
const initial = newGame(7001), o = observe(initial, initial.turn);
const impossible = { ...o, events: [...o.events, { id: 'fake', type: 'play' as const, at: 1, seat: o.seat, cardIds: [o.hand[0].id] }] };
assert.throws(() => countOutsideCards(impossible), /冲突/);
assert.throws(() => countOutsideCards({ ...o, counts: [0, 0, 0, 0] }), /无效|不一致/);
const initialMemory = countOutsideCards(o);
assert.equal(possibleHigherSingles(initialMemory, 16, o.level), 0, '没有比大王更高的自然单张');
console.log('记牌器烟测通过：3 副完整对局、每步外部实体牌守恒、暗牌置换、合法性和异常记录校验');
