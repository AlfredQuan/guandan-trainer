import assert from 'node:assert/strict';
import { createDeck } from '../lib/game/cards';
import { chooseAiMove, legalMoves, observe } from '../lib/game/ai';
import { legalPlay, newGame, nextRound, passTurn, playCards, tributeReturnCard } from '../lib/game/engine';
import { comboOptions, parseCombo } from '../lib/game/rules';
import type { ComboDeclaration, GameState, Seat } from '../lib/game/types';

assert.equal(createDeck().length, 108);
assert.equal(new Set(createDeck().map(c => c.id)).size, 108);
let state: GameState = newGame(12345);
const snapshots: GameState[] = [state];
let moves = 0;
while (state.phase === 'playing' && moves < 350) {
  const seat = state.turn;
  const observation = observe(state, seat);
  assert.equal(observation.hand.length, state.players[seat].hand.length);
  const move = chooseAiMove(observation);
  if (move) {
    assert.equal(legalPlay(state, seat, move).ok, true);
    state = playCards(state, seat, move);
  } else if (state.lastPlay) state = passTurn(state, seat);
  else {
    const first = legalMoves(observation)[0];
    assert.ok(first?.length, '领出时必须能出牌');
    state = playCards(state, seat, first);
  }
  snapshots.push(state);
  const inHands = state.players.reduce((sum, p) => sum + p.hand.length, 0);
  const publiclyPlayed = new Set(state.events.filter(e => e.type === 'play').flatMap(e => e.cardIds || []));
  assert.equal(inHands + publiclyPlayed.size, 108, '每步牌张守恒');
  moves++;
}
assert.equal(state.phase, 'finished', 'AI 应完成完整一副牌');
assert.equal(state.finishOrder.length, 4);
assert.ok(moves > 20);
console.log(`单副牌冒烟通过：${moves} 步，${snapshots.length} 个局面，结果 ${state.finishOrder.join('-')}`);
if (state.matchWinner === null) {
  const next = nextRound(state, 9876);
  assert.equal(next.roundNo, 2);
  assert.equal(next.players.reduce((sum, p) => sum + p.hand.length, 0), 108);
  assert.equal(next.turn, next.leader, '进贡后或抗贡后，第一圈牌权必须与领出者一致');
  assert.ok(next.events[0].note?.includes(next.players[next.turn].name), '发牌日志必须标出真正的首出者');
  console.log('跨副牌升级与贡还牌冒烟通过');
}
const seat = 0 as Seat;
const original = newGame(0);
const observation = observe(original, seat);
const altered: GameState = { ...original, players: original.players.map((p, i) => i === 0 ? p : { ...p, hand: [...original.players[((i + 1) % 3) + 1].hand] }) };
assert.deepEqual(chooseAiMove(observation), chooseAiMove(observe(altered, seat)), '同一观察不应读取其他三家的暗牌');
console.log('暗牌隔离冒烟通过');

const doubleEnded: GameState = { ...newGame(4), phase: 'finished', finishOrder: [0, 2, 1, 3], players: newGame(4).players.map(p => ({ ...p, finished: ([0, 2, 1, 3] as Seat[]).indexOf(p.seat) + 1 })) };
for (const tributeSeed of [1, 11]) {
  const round = nextRound(doubleEnded, tributeSeed);
  assert.equal(round.turn, round.leader);
  assert.ok(round.events[0].note?.includes(round.players[round.turn].name));
}
const fixtureDeck = createDeck();
const card = (rank: number, suit: string, copy = 0) => fixtureDeck.find(c => c.rank === rank && c.suit === suit && c.deck === copy)!;
assert.equal(tributeReturnCard([card(9, 'S'), card(11, 'S'), card(16, 'J')], 9, card(16, 'J').id).rank, 9, '还贡限制应按印刷点数判定，而非主牌牌力');
const opening = card(5, 'S');
const originalTrick = newGame(8);
const trick = (winnerFinished: boolean): GameState => ({
  ...originalTrick, turn: 1, leader: 0, passes: 0, finishOrder: winnerFinished ? [0] : [],
  lastPlay: { seat: 0, cardIds: [opening.id], combo: parseCombo([opening], 2)! },
  players: originalTrick.players.map(p => p.seat === 0 ? { ...p, finished: winnerFinished ? 1 : undefined, hand: winnerFinished ? [] : [card(11, 'S')] }
    : { ...p, hand: p.seat === 3 ? [card(6, 'S'), card(10, 'S')] : [card(7 + p.seat, 'S')] }),
});
let ordinary = trick(false);
ordinary = passTurn(ordinary, 1); ordinary = passTurn(ordinary, 2);
assert.equal(ordinary.turn, 3); assert.ok(ordinary.lastPlay, '普通牌圈尚未结束');
ordinary = passTurn(ordinary, 3);
assert.equal(ordinary.turn, 0); assert.equal(ordinary.leader, 0); assert.equal(ordinary.lastPlay, null);
assert.equal(ordinary.events.at(-1)?.note, '无人再压，最大方新一圈领出');
let borrowed = trick(true);
borrowed = passTurn(borrowed, 1); borrowed = passTurn(borrowed, 2);
assert.equal(borrowed.turn, 3); assert.ok(borrowed.lastPlay, '头游出完后，两家过牌仍不能提前接风');
borrowed = passTurn(borrowed, 3);
assert.equal(borrowed.turn, 2); assert.equal(borrowed.leader, 2); assert.equal(borrowed.lastPlay, null);
assert.equal(borrowed.events.at(-1)?.note, '出完者无人再压，搭档接风');
let contested = trick(true);
contested = passTurn(contested, 1); contested = passTurn(contested, 2);
contested = playCards(contested, 3, [card(6, 'S').id]);
assert.equal(contested.lastPlay?.seat, 3); assert.equal(contested.turn, 1);
contested = passTurn(contested, 1); contested = passTurn(contested, 2);
assert.equal(contested.turn, 3); assert.equal(contested.lastPlay, null);
assert.equal(contested.events.at(-1)?.note, '无人再压，最大方新一圈领出');
// This check also rules out the suspected early-borrow behavior in the prior engine:
// the earlier needed = active - (winnerFinished ? 0 : 1) expression was equivalent.
console.log('牌权状态机核对通过：普通三家过牌、头游接风前必须三家过牌、对手压牌后重新轮转');

const ambiguous = [card(9, 'S'), card(9, 'C'), card(10, 'S'), card(10, 'C'), card(2, 'H')];
const interpretations = comboOptions(ambiguous, 2).filter(c => c.kind === 'triplePair');
assert.ok(interpretations.some(c => c.mainRank === 9 && c.secondaryRank === 10));
assert.ok(interpretations.some(c => c.mainRank === 10 && c.secondaryRank === 9));
const declared: ComboDeclaration = { kind: 'triplePair', mainRank: 9, secondaryRank: 10 };
assert.equal(parseCombo(ambiguous, 2, declared)?.mainRank, 9);
assert.equal(parseCombo(ambiguous, 2, { kind: 'bomb', mainRank: 9 }), null);
const asLead: GameState = { ...newGame(8), players: newGame(8).players.map(p => p.seat === 0 ? { ...p, hand: ambiguous } : p) };
const announced = playCards(asLead, 0, ambiguous.map(c => c.id), declared);
assert.equal(announced.lastPlay?.combo.mainRank, 9);
assert.equal(announced.lastPlay?.combo.secondaryRank, 10);
assert.ok(announced.events.find(e => e.type === 'play')?.note?.includes('逢人配声明'));
assert.equal(legalPlay(asLead, 0, ambiguous.map(c => c.id), { kind: 'bomb', mainRank: 9 }).ok, false);
assert.equal(legalPlay(asLead, 0, [ambiguous[0].id, ambiguous[0].id]).ok, false, '重复同一张实体牌不能出牌');
console.log('逢人配声明回归通过：三带二不同主点/带对、无效声明拒绝和记录留存');
