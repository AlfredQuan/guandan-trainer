import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { chooseAiMove, legalMoves, observe } from '../lib/game/ai';
import { legalPlay, newGame, passTurn, playCards, upgradeSteps } from '../lib/game/engine';
import { chooseLegacyStructuredMove, chooseStructuredMove } from './strong-ai';
import type { GameState, Seat } from '../lib/game/types';

export type Policy = (observation: ReturnType<typeof observe>) => string[] | null;
type Side = 'challenger' | 'legacy';
type DecisionObserver = (side: Side, latencyMs: number, action: 'play' | 'pass') => void;

function playDeal(seed: number, challenger: Policy, opponent: Policy, challengerParity: 0 | 1, onDecision?: DecisionObserver, allowLeadFallback = false): { state: GameState; steps: number; challengedMoves: number } {
  let state: GameState = newGame(seed);
  let steps = 0, challengedMoves = 0;
  while (state.phase === 'playing' && steps < 350) {
    const seat = state.turn;
    const obs = observe(state, seat);
    const challenged = seat % 2 === challengerParity;
    const side = challenged ? 'challenger' : 'legacy';
    const started = onDecision ? performance.now() : 0;
    const choice = (challenged ? challenger : opponent)(obs);
    const latencyMs = onDecision ? performance.now() - started : 0;
    if (challenged) challengedMoves++;
    if (choice !== null) {
      assert.ok(Array.isArray(choice) && choice.length > 0, `无效动作：种子 ${seed} 座位 ${seat} 步 ${steps}`);
      assert.equal(legalPlay(state, seat, choice).ok, true, `非法出牌：种子 ${seed} 座位 ${seat} 步 ${steps}`);
      state = playCards(state, seat, choice);
    } else if (state.lastPlay) state = passTurn(state, seat);
    else if (allowLeadFallback) {
      const fallback = legalMoves(obs)[0];
      assert.ok(fallback?.length, `领出无牌：种子 ${seed} 步 ${steps}`);
      state = playCards(state, seat, fallback);
    } else assert.fail(`领出不能过牌：种子 ${seed} 座位 ${seat} 步 ${steps}`);
    onDecision?.(side, latencyMs, choice === null ? 'pass' : 'play');
    steps++;
  }
  assert.equal(state.phase, 'finished', `超出步数：种子 ${seed}`);
  return { state, steps, challengedMoves };
}

export function playBenchmarkDeal(seed: number, challenger: Policy, challengerParity: 0 | 1): { won: boolean; steps: number; challengedMoves: number } {
  const { state, steps, challengedMoves } = playDeal(seed, challenger, chooseAiMove, challengerParity, undefined, true);
  return { won: state.finishOrder[0] % 2 === challengerParity, steps, challengedMoves };
}

export function runBenchmark(policy: Policy, seeds: number[]): { wins: number; total: number; rate: number; meanSteps: number; perSeed: Array<{ seed: number; wins: number }> } {
  let wins = 0, totalSteps = 0;
  const perSeed = seeds.map(seed => {
    let matched = 0;
    for (const parity of [0, 1] as const) {
      const result = playBenchmarkDeal(seed, policy, parity);
      matched += Number(result.won);
      wins += Number(result.won);
      totalSteps += result.steps;
    }
    return { seed, wins: matched };
  });
  return { wins, total: seeds.length * 2, rate: wins / (seeds.length * 2), meanSteps: totalSteps / (seeds.length * 2), perSeed };
}

export interface LatencySummary { samples: number; p50: number; p95: number; max: number }
export interface SideSummary {
  decisions: number;
  legalPlays: number;
  legalPasses: number;
  invalidDecisions: number;
  latencyMs: LatencySummary;
  firstFinishes: number;
  topTwoFinishes: number;
  upgradeSteps: number;
}
export interface DuelGame {
  challengerParity: 0 | 1;
  won: boolean;
  steps: number;
  challengedMoves: number;
  finishOrder: Seat[];
  winnerTeam: 0 | 1;
  upgradeSteps: number;
  challengerUpgradeSteps: number;
  legacyUpgradeSteps: number;
}

function summarizeLatency(samples: number[]): LatencySummary {
  if (!samples.length) return { samples: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) => {
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position), upper = Math.ceil(position);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  };
  return { samples: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted[sorted.length - 1] };
}

/** Same dealt seed twice, swapping teams. Policies receive only their own Observation. */
export function runDirectPairedDuel(seeds: number[], challenger: Policy = chooseStructuredMove, legacy: Policy = chooseLegacyStructuredMove): {
  mode: 'direct-paired-duel'; seeds: number; total: number; completedDeals: number;
  wins: number; losses: number; rate: number; meanSteps: number; upgradeBalance: number;
  challenger: SideSummary; legacy: SideSummary;
  perSeed: Array<{ seed: number; games: DuelGame[] }>;
} {
  assert.ok(seeds.length > 0 && seeds.every(Number.isSafeInteger) && new Set(seeds).size === seeds.length, '种子必须是非空且不重复的安全整数');
  const stats = {
    challenger: { decisions: 0, legalPlays: 0, legalPasses: 0, invalidDecisions: 0, firstFinishes: 0, topTwoFinishes: 0, upgradeSteps: 0, latencies: [] as number[] },
    legacy: { decisions: 0, legalPlays: 0, legalPasses: 0, invalidDecisions: 0, firstFinishes: 0, topTwoFinishes: 0, upgradeSteps: 0, latencies: [] as number[] },
  };
  let wins = 0, completedDeals = 0, totalSteps = 0, totalUpgrades = 0, challengedDecisions = 0;
  const perSeed = seeds.map(seed => {
    const games: DuelGame[] = [];
    for (const parity of [0, 1] as const) {
      const { state, steps, challengedMoves } = playDeal(seed, challenger, legacy, parity, (side, latencyMs, action) => {
        const record = stats[side];
        record.decisions++;
        record.latencies.push(latencyMs);
        if (action === 'play') record.legalPlays++;
        else record.legalPasses++;
      });
      assert.equal(state.finishOrder.length, 4, `终局名次不完整：种子 ${seed} 队伍 ${parity}`);
      assert.deepEqual([...state.finishOrder].sort((a, b) => a - b), [0, 1, 2, 3], `终局名次无效：种子 ${seed} 队伍 ${parity}`);
      const winnerTeam = (state.finishOrder[0] % 2) as 0 | 1;
      const stepsUp = upgradeSteps(state.finishOrder);
      assert.ok(stepsUp >= 1 && stepsUp <= 3, `升级步数无效：种子 ${seed} 队伍 ${parity}`);
      const won = winnerTeam === parity;
      const challengerUpgradeSteps = won ? stepsUp : 0;
      const legacyUpgradeSteps = won ? 0 : stepsUp;
      stats.challenger.upgradeSteps += challengerUpgradeSteps;
      stats.legacy.upgradeSteps += legacyUpgradeSteps;
      stats.challenger.firstFinishes += Number(won);
      stats.legacy.firstFinishes += Number(!won);
      stats.challenger.topTwoFinishes += state.finishOrder.slice(0, 2).filter(seat => seat % 2 === parity).length;
      stats.legacy.topTwoFinishes += state.finishOrder.slice(0, 2).filter(seat => seat % 2 !== parity).length;
      games.push({ challengerParity: parity, won, steps, challengedMoves, finishOrder: [...state.finishOrder], winnerTeam, upgradeSteps: stepsUp, challengerUpgradeSteps, legacyUpgradeSteps });
      wins += Number(won);
      totalSteps += steps;
      totalUpgrades += stepsUp;
      challengedDecisions += challengedMoves;
      completedDeals++;
    }
    assert.equal(games.length, 2, `种子 ${seed} 未完成换边`);
    return { seed, games };
  });
  assert.equal(completedDeals, seeds.length * 2, '配对局数不完整');
  const sideSummary = (side: Side): SideSummary => {
    const { latencies, ...record } = stats[side];
    assert.equal(record.decisions, record.legalPlays + record.legalPasses, `${side} 合法性计数不一致`);
    return { ...record, latencyMs: summarizeLatency(latencies) };
  };
  const challengerSummary = sideSummary('challenger'), legacySummary = sideSummary('legacy');
  assert.equal(challengerSummary.decisions, challengedDecisions, '挑战方决策数不一致');
  assert.equal(challengerSummary.firstFinishes, wins, '挑战方头游数不一致');
  assert.equal(legacySummary.firstFinishes, completedDeals - wins, '旧策略头游数不一致');
  assert.equal(challengerSummary.topTwoFinishes + legacySummary.topTwoFinishes, completedDeals * 2, '前两名统计不一致');
  assert.equal(challengerSummary.upgradeSteps + legacySummary.upgradeSteps, totalUpgrades, '升级步数统计不一致');
  return {
    mode: 'direct-paired-duel', seeds: seeds.length, total: completedDeals, completedDeals,
    wins, losses: completedDeals - wins, rate: wins / completedDeals, meanSteps: totalSteps / completedDeals,
    upgradeBalance: challengerSummary.upgradeSteps - legacySummary.upgradeSteps,
    challenger: challengerSummary, legacy: legacySummary, perSeed,
  };
}

export function benchmarkSeeds(count: number, offset = 0): number[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 2000 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(7001 + (offset + count - 1) * 7919)) throw new Error('基准参数无效');
  return Array.from({ length: count }, (_, i) => 7001 + (offset + i) * 7919);
}

if (process.argv[1]?.endsWith('ai-benchmark.js')) {
  const duel = process.argv[2] === 'duel';
  const count = Number(process.argv[duel ? 3 : 2] ?? '20');
  const offset = Number(process.argv[duel ? 4 : 3] ?? '0');
  const seeds = benchmarkSeeds(count, offset);
  const start = performance.now();
  if (duel) {
    console.log(JSON.stringify({ ...runDirectPairedDuel(seeds), offset, elapsedMs: performance.now() - start }));
  } else {
    const baseline = runBenchmark(chooseAiMove, seeds);
    const result = runBenchmark(chooseStructuredMove, seeds);
    console.log(JSON.stringify({ mode: 'structured-vs-baseline', seeds: count, offset, baselineRate: baseline.rate, wins: result.wins, total: result.total, rate: result.rate, meanSteps: result.meanSteps, elapsedMs: performance.now() - start }));
  }
}
