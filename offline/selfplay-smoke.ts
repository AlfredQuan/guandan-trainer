import assert from 'node:assert/strict';
import { observe } from '../lib/game/ai';
import { newGame, playCards } from '../lib/game/engine';
import { actionKey, buildAiRequest, validAiAction } from './ai-gateway';
import { chooseStructuredMove } from './strong-ai';
import { assertPhysicalCardConservation, exportSelfplayJsonl, imitationAccuracy,
  playSelfplayDeal, selectLinearAction, splitByDeal, trainLinearScorer } from './selfplay';
import { gradeAnswers, makeChallenge, replayOneIntervention } from './teacher-challenge';

const initial = newGame(7001);
assertPhysicalCardConservation(initial);
const seat = initial.turn;
const observation = observe(initial, seat);
const request = buildAiRequest(observation, 'play', 'visibility');
// 轮换另外三个座位的暗牌，保持公开的手牌张数不变。
const others = initial.players.filter(player => player.seat !== seat);
const permuted = { ...initial, players: initial.players.map(player => player.seat === seat ? player : {
  ...player, hand: others[(others.findIndex(other => other.seat === player.seat) + 1) % 3].hand,
}) };
assert.deepEqual(buildAiRequest(observe(initial, seat), 'play', 'visibility'),
  buildAiRequest(observe(permuted, seat), 'play', 'visibility'), '暗牌不能影响模型请求');
assert.ok(!['seed', 'players', 'finishOrder', 'phase', 'createdAt'].some(key => Object.hasOwn(request, key) || Object.hasOwn(request.view, key)));
for (const other of others) for (const card of other.hand) assert.ok(!request.view.hand.some(visible => visible.id === card.id));
const choice = chooseStructuredMove(observation);
assert.ok(choice);
const played = playCards(initial, seat, choice);
assertPhysicalCardConservation(played);
const duplicated = { ...played, players: played.players.map(player => player.seat === (seat + 1) % 4 ? {
  ...player, hand: [initial.players[seat].hand.find(card => card.id === choice[0])!, ...player.hand.slice(1)],
} : player) };
assert.throws(() => assertPhysicalCardConservation(duplicated), '总数仍为 108 的重复/丢牌也应被拒绝');
assert.equal(validAiAction(request.view, { cards: null }), false, '领出不能过牌');
assert.equal(validAiAction(request.view, { cards: [others[0].hand[0].id] }), false, '别人的牌不能出');

const a = playSelfplayDeal(7001, seat);
const b = playSelfplayDeal(14920, 0);
assert.deepEqual(a, playSelfplayDeal(7001, seat), '同种子数据应确定');
assert.ok(a.length && b.length);
for (const row of [...a, ...b]) {
  assert.equal(row.request.view.seat, row.deal.recordedSeat, '一副仅记录指定座位');
  assert.equal(row.request.view.turn, row.deal.recordedSeat);
  assert.equal(row.request.requestId, 'selfplay-turn', '请求编号不携带副牌信息');
  assert.ok(!['seed', 'players', 'finishOrder', 'phase', 'createdAt', 'label'].some(key => JSON.stringify(row.request).includes(`"${key}"`)), '请求不含暗牌或终局');
  const teacher = row.request.actions.find(action => actionKey(action) === row.label.teacherActionKey);
  assert.ok(teacher && validAiAction(row.request.view, teacher), '教师动作必须匹配合法候选');
}
assert.ok(a.every(row => row.label.teamHeadWin === a[0].label.teamHeadWin), '终局标签独立且一致');
const lines = exportSelfplayJsonl([...a, ...b]).trimEnd().split('\n');
assert.equal(lines.length, a.length + b.length);
const exported = JSON.parse(lines[0]);
assert.equal(typeof exported.dealId, 'string');
assert.equal(exported.request.view.seat, a[0].request.view.seat);
assert.deepEqual(exported.label, a[0].label);
assert.ok(!('deal' in exported) && !lines.some(line => line.includes('"seed"')), '导出不得包含可重建暗牌的种子');
assert.equal(JSON.parse(lines[1]).dealId, exported.dealId, '同副牌的所有行需共用随机分组 ID');
const { train, test } = splitByDeal([...a, ...b], [14920]);
assert.deepEqual(new Set(train.map(row => row.deal.seed)), new Set([7001]));
assert.deepEqual(new Set(test.map(row => row.deal.seed)), new Set([14920]));
assert.throws(() => splitByDeal([...a, ...b], [7001, 7001]));
assert.throws(() => splitByDeal([...a, ...b], [123456]));
const model = trainLinearScorer(train, 2);
assert.ok(imitationAccuracy(model, test) >= 0 && imitationAccuracy(model, test) <= 1);
assert.ok(test.every(row => validAiAction(row.request.view, selectLinearAction(model, row.request))));
assert.throws(() => trainLinearScorer([{ ...train[0], label: { ...train[0].label, teacherActionKey: 'illegal' } }]));
assert.throws(() => selectLinearAction(model, { ...test[0].request,
  actions: [{ cards: ['not-a-card'] }, ...test[0].request.actions] }), '非法候选不能进入评分');
const challenge = makeChallenge(2, 0);
assert.equal(challenge.publicCases.length, 2);
assert.equal(challenge.privateCases.length, 2);
for (let i = 0; i < 2; i++) {
  const exposed = challenge.publicCases[i], privateRow = challenge.privateCases[i];
  assert.equal(exposed.caseId, privateRow.caseId);
  assert.ok(!['seed', 'baselineKey', 'baselineWon', 'deal'].some(key => JSON.stringify(exposed).includes(`"${key}"`)), '教师局面不得泄露私有元数据');
  assert.ok(privateRow.audit.baselineIncluded);
  assert.ok(exposed.request.view.counts.every(count => count > 0), '头游已定的局面不应用于头游率对比');
  assert.ok(exposed.request.actions.every(option => validAiAction(exposed.request.view, option)));
  const baseline = exposed.request.actions.find(option => actionKey(option) === privateRow.baselineKey)!;
  assert.ok(baseline);
  assert.deepEqual(replayOneIntervention(privateRow, baseline), { baselineWon: privateRow.baselineWon, changedWon: privateRow.baselineWon });
}
const answer = { caseId: challenge.publicCases[0].caseId, actionKey: challenge.privateCases[0].baselineKey, confidence: 0.7 };
assert.equal(gradeAnswers(challenge.publicCases, challenge.privateCases, [answer]).baselineAgreement, 1);
assert.throws(() => gradeAnswers(challenge.publicCases, challenge.privateCases, [{ ...answer, actionKey: 'nonexistent' }]));
assert.throws(() => gradeAnswers(challenge.publicCases, challenge.privateCases, [answer, answer]));
console.log(`自博弈与教师挑战赛烟测通过：${a.length + b.length} 条请求、2 个盲测局面、回放、非法标签拦截`);
