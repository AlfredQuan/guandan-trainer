import assert from 'node:assert/strict';
import { analyze, analysisMoves, assessLeader, candidates, createAnalysisRunner, project, sampleHidden } from './analysis';
import { newGame, passTurn, playCards } from '../lib/game/engine';
import { chooseAiMove, legalMoves, legacyLegalMoves, observe } from '../lib/game/ai';
import { createDeck } from '../lib/game/cards';
import { beats, comboOptions, parseCombo } from '../lib/game/rules';
import type { Card, ComboKind } from '../lib/game/types';
import type { GameState } from '../lib/game/types';

let state: GameState = newGame(4);
const view = project(state);
assert.ok(!('seed' in view));
assert.ok(!('players' in view));
assert.equal(view.hand.length, 27);
const options = candidates(view);
assert.ok(options.length > 0 && options.length <= 5);
const sample = sampleHidden(view, 555);
assert.equal(sample.players.flatMap(p => p.hand).length, 108);
assert.deepEqual(sample.players[0].hand, view.hand);
assert.notDeepEqual(sample.players[1].hand, state.players[1].hand);
const changed: GameState = { ...state, players: state.players.map((p, seat) => seat === 0 ? p : ({ ...p, hand: [...state.players[seat === 1 ? 2 : seat === 2 ? 3 : 1].hand] })) };
assert.deepEqual(project(state), project(changed), '观察投影不能包含真实暗牌');
const started = Date.now();
const result = analyze(view, options.slice(0, 2), 2, 123);
assert.equal(result.samples, 2);
assert.equal(result.estimates.length, 2);
assert.ok(result.estimates.every(e => e.probability >= 0 && e.probability <= 1 && e.low <= e.high));
assert.deepEqual(result, analyze(project(changed), options.slice(0, 2), 2, 123));
const incremental = createAnalysisRunner(view, options.slice(0, 2), 2, 123);
assert.throws(() => incremental.result(), /尚未完成/);
incremental.step(); assert.equal(incremental.completed, 1);
incremental.step(); incremental.step(); assert.deepEqual(incremental.result(), result, '逐组计算应与同步模拟完全一致');
assert.deepEqual(assessLeader([[true, false], [false, true]]), { index: null, separated: false }, '并列不能强行给推荐');
assert.deepEqual(assessLeader([[true, true, true, true, true, true, true, true], [false, false, false, false, false, false, false, false]]), { index: 0, separated: true });
assert.deepEqual(assessLeader([[true, null], [false, null]]), { index: 0, separated: false }, '极小样本不得标注差距明显');
assert.deepEqual(assessLeader([[true, null], [true, true]]), { index: 1, separated: false }, '同为满胜率时应优先选择完成样本更多的一方');
console.log(`初始局面配对模拟通过（2 副采样 / 2 候选，双重复运行 ${Date.now() - started}ms）`);
let moves = 0;
while (state.turn !== 0 && moves < 10) {
  const move = chooseAiMove(observe(state, state.turn));
  state = move ? playCards(state, state.turn, move) : passTurn(state, state.turn);
  moves++;
}
assert.equal(project(state).turn, 0);

const deck = createDeck();
const find = (suit: Card['suit'], rank: number, copy = 0) => deck.find(c => c.suit === suit && c.rank === rank && c.deck === copy)!;
const fixtureHand = [find('S', 2), find('C', 2), find('D', 2), find('S', 3), find('C', 3), find('D', 3), find('S', 4), find('C', 4), find('S', 5), find('S', 6), find('H', 9), find('H', 9, 1), find('J', 15)];
const fixture = { ...view, level: 9 as const, hand: fixtureHand, counts: [fixtureHand.length, 27, 27, 27] };
const candidateMoves = analysisMoves(fixture);
const shapes = new Set(candidateMoves.map(ids => parseCombo(ids.map(id => fixtureHand.find(c => c.id === id)!), fixture.level)?.kind));
for (const kind of ['single', 'pair', 'triple', 'triplePair', 'straight', 'tube', 'plate', 'bomb', 'straightFlush'] as ComboKind[]) assert.ok(shapes.has(kind), `遗漏牌型 ${kind}`);
assert.ok(candidateMoves.some(ids => ids.includes(find('S', 2).id) && ids.includes(find('C', 2).id) && ids.includes(find('D', 2).id) && ids.includes(find('H', 9).id) && parseCombo(ids.map(id => fixtureHand.find(c => c.id === id)!), fixture.level)?.kind === 'bomb'), '未覆盖逢人配炸弹');
const overtake = { ...fixture, lastPlay: { seat: 1 as const, cardIds: [find('S', 4).id], combo: parseCombo([find('S', 4)], 9)! } };
const responding = analysisMoves(overtake);
assert.ok(responding.every(ids => beats(parseCombo(ids.map(id => fixtureHand.find(c => c.id === id)!), 9)!, overtake.lastPlay.combo)), '不能纳入压不住的出法');
const selected = candidates(overtake);
assert.ok(selected.some(choice => choice.cards === null), '跟牌时总应考虑过牌');
assert.ok(selected.length <= 5);
const original = candidates(overtake, [find('S', 5).id]);
assert.ok(original[0].original, '应保留用户实际出法');
const ambiguous = [find('S', 9), find('C', 9), find('S', 10), find('C', 10), find('H', 9)];
const alternatives = comboOptions(ambiguous, 9).filter(c => c.kind === 'triplePair');
const other = alternatives.find(c => c.mainRank !== parseCombo(ambiguous, 9)?.mainRank)!;
assert.ok(other, '应存在不等于默认解释的逢人配三带二');
const declaredChoice = { kind: other.kind, mainRank: other.mainRank, secondaryRank: other.secondaryRank };
const declaredCandidates = candidates({ ...fixture, hand: ambiguous, counts: [ambiguous.length, 27, 27, 27] }, ambiguous.map(c => c.id), declaredChoice);
assert.equal(declaredCandidates[0].declared?.mainRank, other.mainRank, '实际出法的声明不得在复盘候选中丢失');
assert.ok(declaredCandidates[0].original && declaredCandidates[0].key.includes('#'), '不同牌型解释应有独立候选标识');
assert.ok(legalMoves({ ...observe(state, 0), hand: fixtureHand, level: 9, lastPlay: null }).every(ids => candidateMoves.some(move => [...move].sort().join() === [...ids].sort().join())), '分析与实战必须共享候选集');
const straightHand = [find('S', 2), find('C', 3), find('D', 4), find('H', 5), find('S', 6), find('S', 10), find('C', 11), find('D', 12), find('J', 15)];
const straightObs = { ...observe(state, 0), hand: straightHand, level: 9 as const, lastPlay: null };
const lowStraight = straightHand.slice(0, 5).map(card => card.id).sort().join('|');
const key = (ids: string[]) => [...ids].sort().join('|');
assert.ok(!legacyLegalMoves(straightObs).some(ids => key(ids) === lowStraight), '旧版候选确实遗漏 23456');
assert.ok(legalMoves(straightObs).some(ids => key(ids) === lowStraight), '实战候选必须包含普通 23456');
assert.ok(analysisMoves({ ...fixture, hand: straightHand, counts: [9, 27, 27, 27], lastPlay: null }).some(ids => key(ids) === lowStraight), '复盘应使用同一顺子模板');
let verifiedSubsets = 0;
const smallHands = [straightHand.slice(0, 8),
  [find('H', 9), find('H', 9, 1), find('S', 2), find('C', 2), find('D', 2), find('S', 3), find('C', 3), find('S', 4)],
  ...Array.from({ length: 8 }, (_, i) => newGame(300 + i).players[0].hand.slice(0, 8))];
for (const hand of smallHands) for (const previous of [null, { seat: 1 as const, cardIds: [find('S', 3).id], combo: parseCombo([find('S', 3)], 9)! }]) {
  const obs = { ...straightObs, hand, lastPlay: previous };
  const expected = new Set<string>();
  for (let mask = 1; mask < (1 << hand.length); mask++) {
    const chosen = hand.filter((_, index) => (mask & (1 << index)) !== 0);
    const combo = parseCombo(chosen, 9);
    if (combo && beats(combo, previous?.combo ?? null)) expected.add(key(chosen.map(card => card.id)));
  }
  assert.deepEqual(new Set(legalMoves(obs).map(key)), expected, '至多 8 张手牌的实体牌候选应与穷举裁判一致');
  verifiedSubsets += (1 << hand.length) - 1;
}
for (const seed of [4, 8, 12]) {
  const game = newGame(seed);
  const obs = observe(game, game.turn);
  const generated = new Set(legalMoves(obs).map(key));
  assert.ok(legacyLegalMoves(obs).every(ids => generated.has(key(ids))), '大手牌不可丢失旧版合法候选');
  assert.ok(legalMoves(obs).every(ids => {
    const combo = parseCombo(ids.map(id => obs.hand.find(card => card.id === id)!), obs.level);
    return combo && beats(combo, obs.lastPlay?.combo ?? null);
  }), '生成的候选必须全部合法');
}
console.log(`候选覆盖通过：${candidateMoves.length} 个复盘代表出法、9 类牌型、23456、${verifiedSubsets} 个小手牌子集及大手牌向后兼容`);
