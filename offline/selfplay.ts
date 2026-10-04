import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { observe } from '../lib/game/ai';
import { createDeck } from '../lib/game/cards';
import { legalPlay, newGame, passTurn, playCards } from '../lib/game/engine';
import { parseCombo } from '../lib/game/rules';
import type { GameState, Seat } from '../lib/game/types';
import { actionKey, buildAiRequest, validAiAction, type AiAction, type AiRequest } from './ai-gateway';
import { benchmarkSeeds, runDirectPairedDuel } from './ai-benchmark';
import { chooseStructuredMove } from './strong-ai';

export interface SelfplayRow {
  deal: { seed: number; recordedSeat: Seat }; // 分组元数据，不交给评分器。
  step: number;
  request: AiRequest;
  label: { teacherActionKey: string; teamHeadWin: boolean };
}

/** 108 张实体牌各自只存在于一份当前手牌或一次历史出牌事件中。 */
export function assertPhysicalCardConservation(state: GameState): void {
  const actual = [...state.players.flatMap(player => player.hand.map(card => card.id)),
    ...state.events.filter(event => event.type === 'play').flatMap(event => event.cardIds ?? [])];
  const expected = createDeck().map(card => card.id);
  assert.equal(actual.length, expected.length, '实体牌总数不为 108');
  assert.deepEqual(actual.sort(), expected.sort(), '实体牌重复、丢失或凭空出现');
}

/** 单副确定性四座位对局，只记录指定座位轮到行动时的请求。 */
export function playSelfplayDeal(seed: number, recordedSeat: Seat): SelfplayRow[] {
  if (!Number.isSafeInteger(seed) || !Number.isInteger(recordedSeat) || recordedSeat < 0 || recordedSeat > 3) throw new Error('副牌参数无效');
  let state = newGame(seed);
  const pending: Array<{ step: number; request: AiRequest; teacherActionKey: string }> = [];
  assertPhysicalCardConservation(state);
  let step = 0;
  while (state.phase === 'playing' && step < 350) {
    const seat = state.turn;
    const observation = observe(state, seat);
    const teacher = chooseStructuredMove(observation);
    if (seat === recordedSeat) {
      // 请求编号固定，不编码种子、座位或结局。
      const request = buildAiRequest(observation, 'play', 'selfplay-turn');
      const teacherActionKey = actionKey({ cards: teacher });
      assert.ok(request.actions.some(action => actionKey(action) === teacherActionKey && validAiAction(request.view, action)), '教师动作不在合法候选集中');
      pending.push({ step, request, teacherActionKey });
    }
    if (teacher === null) {
      assert.ok(state.lastPlay, '领出不能过牌');
      state = passTurn(state, seat);
    } else {
      assert.equal(legalPlay(state, seat, teacher).ok, true, '教师动作未通过规则引擎');
      state = playCards(state, seat, teacher);
    }
    assertPhysicalCardConservation(state);
    step++;
  }
  assert.equal(state.phase, 'finished', '副牌未在 350 步内结束');
  assert.deepEqual([...state.finishOrder].sort(), [0, 1, 2, 3], '终局座次不完整');
  return pending.map(row => ({
    deal: { seed, recordedSeat }, step: row.step, request: row.request,
    label: { teacherActionKey: row.teacherActionKey, teamHeadWin: state.finishOrder[0] % 2 === recordedSeat % 2 },
  }));
}

export function splitByDeal(rows: SelfplayRow[], testSeeds: readonly number[]): { train: SelfplayRow[]; test: SelfplayRow[] } {
  const heldOut = new Set(testSeeds);
  if (!heldOut.size || heldOut.size !== testSeeds.length) throw new Error('测试副牌种子必须非空且唯一');
  const seats = new Map<number, Seat>();
  for (const row of rows) {
    const prior = seats.get(row.deal.seed);
    if (prior !== undefined && prior !== row.deal.recordedSeat) throw new Error('同一副牌记录了多个座位');
    seats.set(row.deal.seed, row.deal.recordedSeat);
  }
  if (testSeeds.some(seed => !seats.has(seed))) throw new Error('测试种子不在数据集中');
  const train = rows.filter(row => !heldOut.has(row.deal.seed));
  const test = rows.filter(row => heldOut.has(row.deal.seed));
  if (!train.length || !test.length) throw new Error('训练集或测试集为空');
  return { train, test };
}

export function exportSelfplayJsonl(rows: readonly SelfplayRow[]): string {
  // The shuffle seed reconstructs every hidden hand. Never serialize it into a
  // model-facing dataset, even though the private evaluator needs it to pair games.
  const dealIds = new Map<number, string>();
  return rows.length ? `${rows.map(row => {
    if (!dealIds.has(row.deal.seed)) dealIds.set(row.deal.seed, randomUUID());
    return JSON.stringify({ dealId: dealIds.get(row.deal.seed), step: row.step,
      request: row.request, label: row.label });
  }).join('\n')}\n` : '';
}

export const featureNames = ['pass', 'cards/10', 'finish', 'rank/20', 'bomb', 'wilds/2', 'yieldPartner', 'threatCards/10'] as const;
export interface LinearScorer { kind: 'action-conditional-linear'; featureNames: typeof featureNames; weights: number[] }

/** 特征只依赖当前可见请求及其合法实体牌动作。 */
export function actionFeatures(request: AiRequest, action: AiAction): number[] {
  const { view } = request;
  const allyLeads = view.lastPlay?.seat === (view.seat + 2) % 4;
  if (action.cards === null) return [1, 0, 0, 0, 0, 0, Number(allyLeads), 0];
  const byId = new Map(view.hand.map(card => [card.id, card]));
  const cards = action.cards.map(id => byId.get(id)!);
  const combo = parseCombo(cards, view.level, action.declared)!;
  const bomb = ['bomb', 'straightFlush', 'jokerBomb'].includes(combo.kind);
  const threat = view.counts.some((count, seat) => seat % 2 !== view.seat % 2 && count <= 3);
  return [0, cards.length / 10, Number(cards.length === view.hand.length),
    cards.reduce((sum, card) => sum + card.rank, 0) / (20 * cards.length), Number(bomb),
    cards.filter(card => card.suit === 'H' && card.rank === view.level).length / 2,
    0, threat ? cards.length / 10 : 0];
}

/** 换边接口只接受实体牌 ID，因此评分时不选带显式声明的万能牌动作。 */
function defaultCandidates(request: AiRequest): AiAction[] {
  if (request.actions.some(action => !validAiAction(request.view, action))) throw new Error('请求中含非法候选动作');
  const candidates = request.actions.filter(action => action.declared === undefined);
  if (!candidates.length) throw new Error('没有可用于实体牌对局的动作');
  return candidates.sort((a, b) => actionKey(a).localeCompare(actionKey(b), 'en'));
}

export function selectLinearAction(model: LinearScorer, request: AiRequest): AiAction {
  if (model.weights.length !== featureNames.length || model.weights.some(weight => !Number.isFinite(weight))) throw new Error('线性权重无效');
  const candidates = defaultCandidates(request);
  return candidates.reduce((best, action) => {
    const score = actionFeatures(request, action).reduce((sum, value, i) => sum + value * model.weights[i], 0);
    return score > best.score ? { action, score } : best;
  }, { action: candidates[0], score: -Infinity }).action;
}

/** 在线感知机模仿教师；不是深度模型，也不代表棋力提升。 */
export function trainLinearScorer(rows: readonly SelfplayRow[], epochs = 3, learningRate = 0.1): LinearScorer {
  if (!rows.length || !Number.isSafeInteger(epochs) || epochs < 1 || epochs > 100 || !Number.isFinite(learningRate) || learningRate <= 0 || learningRate > 1) throw new Error('训练参数无效');
  const model: LinearScorer = { kind: 'action-conditional-linear', featureNames, weights: Array(featureNames.length).fill(0) };
  for (let epoch = 0; epoch < epochs; epoch++) for (const row of rows) {
    const candidates = defaultCandidates(row.request);
    const teacher = candidates.find(action => actionKey(action) === row.label.teacherActionKey);
    if (!teacher) throw new Error('教师动作缺失或不支持声明牌型');
    const predicted = selectLinearAction(model, row.request);
    if (actionKey(predicted) === row.label.teacherActionKey) continue;
    const positive = actionFeatures(row.request, teacher), negative = actionFeatures(row.request, predicted);
    model.weights = model.weights.map((weight, i) => weight + learningRate * (positive[i] - negative[i]));
  }
  return model;
}

export function imitationAccuracy(model: LinearScorer, rows: readonly SelfplayRow[]): number {
  if (!rows.length) throw new Error('测试集为空');
  return rows.filter(row => actionKey(selectLinearAction(model, row.request)) === row.label.teacherActionKey).length / rows.length;
}

export function runColdStart(trainDeals = 1, testDeals = 1, offset = 0, epochs = 3) {
  if (!Number.isSafeInteger(trainDeals) || !Number.isSafeInteger(testDeals) || trainDeals < 1 || testDeals < 1 || trainDeals + testDeals > 100) throw new Error('副牌数无效');
  const seeds = benchmarkSeeds(trainDeals + testDeals, offset);
  const testSeeds = seeds.slice(trainDeals);
  // 轮换每副唯一记录座位，不固定为种子决定的首出座位。
  const rows = seeds.flatMap((seed, index) => playSelfplayDeal(seed, ((Math.floor(index / 4) + index % 4) % 4) as Seat));
  const { train, test } = splitByDeal(rows, testSeeds);
  const model = trainLinearScorer(train, epochs);
  const imitation = imitationAccuracy(model, test);
  const duel = runDirectPairedDuel(testSeeds, observation => {
    const request = buildAiRequest(observation, 'play', 'selfplay-evaluation');
    return selectLinearAction(model, request).cards;
  }, chooseStructuredMove);
  const deployable = testSeeds.length >= 20 && imitation >= 0.9 && duel.rate >= 0.55 && duel.challenger.invalidDecisions === 0;
  return {
    rows, train, test, model,
    report: { mode: 'linear-cold-start-experiment', trainDeals, testDeals, trainRows: train.length,
      testRows: test.length, imitation, duel, gate: { deployable, rule: '至少20副独立测试牌，模仿率≥0.90，换边头游胜率≥0.55，非法动作=0；否则不部署' } },
  };
}

if (/(?:^|[\\/])selfplay\.js$/.test(process.argv[1] ?? '')) {
  const args = process.argv.slice(2);
  const options: Record<string, number> = { '--train': 1, '--test': 1, '--offset': 0, '--epochs': 3 };
  let jsonl = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--jsonl') { jsonl = true; continue; }
    if (!Object.hasOwn(options, args[i]) || i + 1 >= args.length || !/^\d+$/.test(args[i + 1])) throw new Error('用法: node selfplay.js [--train N] [--test N] [--offset N] [--epochs N] [--jsonl]');
    options[args[i]] = Number(args[++i]);
  }
  const { rows, report } = runColdStart(options['--train'], options['--test'], options['--offset'], options['--epochs']);
  if (jsonl) { process.stdout.write(exportSelfplayJsonl(rows)); console.error(JSON.stringify(report)); }
  else console.log(JSON.stringify(report));
}
