import { chooseAiMove, legalMoves, observe } from '../lib/game/ai';
import { createDeck, shuffle } from '../lib/game/cards';
import { passTurn, playCards } from '../lib/game/engine';
import { beats, comboName, parseCombo } from '../lib/game/rules';
import type { Card, ComboDeclaration, GameEvent, GameState, Rank, Seat, TrickPlay } from '../lib/game/types';

import { chooseExpandedStructuredMove, chooseLegacyStructuredMove, chooseStructuredMove } from './strong-ai';

export interface AnalysisView {
  hand: Card[];
  level: Rank;
  turn: Seat;
  lastPlay: TrickPlay | null;
  passes: number;
  counts: number[];
  finishOrder: Seat[];
  events: GameEvent[];
}
export interface Candidate { cards: string[] | null; declared?: ComboDeclaration; label: string; key: string; original: boolean }
export interface Estimate { candidate: Candidate; wins: number; completed: number; probability: number; low: number; high: number; pairedGap: number; pairedLow: number; pairedHigh: number }
export interface AnalysisResult { estimates: Estimate[]; samples: number; seed: number; metric: string; model: string; leadingKey: string | null; separated: boolean }

// Deliberately constructs a data-transfer object without GameState.seed or any opponent hand.
export function project(state: GameState): AnalysisView {
  if (state.phase !== 'playing' || state.turn !== 0) throw new Error('只能分析轮到你的决策前局面');
  return {
    hand: state.players[0].hand.map(c => ({ ...c })), level: state.level, turn: 0,
    lastPlay: state.lastPlay ? { seat: state.lastPlay.seat, cardIds: [...state.lastPlay.cardIds], combo: { ...state.lastPlay.combo, cards: state.lastPlay.combo.cards.map(c => ({ ...c })), wildIds: [...state.lastPlay.combo.wildIds] } } : null,
    passes: state.passes, counts: state.players.map(p => p.hand.length), finishOrder: [...state.finishOrder],
    events: state.events.filter(e => ['play', 'pass', 'trick', 'finish'].includes(e.type)).map(e => ({ id: e.id, type: e.type, at: e.at, seat: e.seat, cardIds: e.cardIds ? [...e.cardIds] : undefined })),
  };
}
export function candidateKey(cards: string[] | null, declared?: ComboDeclaration): string { return cards === null ? 'pass' : `${[...cards].sort().join('|')}${declared ? `#${declared.kind}:${declared.mainRank}:${declared.secondaryRank ?? ''}` : ''}`; }

/** Replay and live play now share candidate generation and the same rules validator.
 * Above eight cards, both modes are bounded representatives rather than exhaustive actions.
 */
export function analysisMoves(view: AnalysisView): string[][] {
  return legalMoves({ hand: view.hand, level: view.level, turn: view.turn,
    counts: view.counts, lastPlay: view.lastPlay, events: view.events,
    seat: 0, role: 'you', persona: 'learner' }, 'analysis');
}

export function candidates(view: AnalysisView, original?: string[] | null, originalDeclared?: ComboDeclaration): Candidate[] {
  const byId = new Map(view.hand.map(c => [c.id, c]));
  const base = { hand: view.hand, level: view.level, turn: view.turn, counts: view.counts, lastPlay: view.lastPlay, events: view.events, seat: 0 as Seat, role: 'you' as const, persona: 'learner' as const };
  const moves = analysisMoves(view);
  const info = (move: string[]) => parseCombo(move.map(id => byId.get(id)!), view.level)!;
  const special = (move: string[]) => ['bomb', 'straightFlush', 'jokerBomb'].includes(info(move).kind);
  const score = (move: string[]) => info(move).mainRank - move.length * 5 + move.filter(id => byId.get(id)!.suit === 'H' && byId.get(id)!.rank === view.level).length * 8;
  const ordinary = moves.filter(move => !special(move)).sort((a, b) => score(a) - score(b) || candidateKey(a).localeCompare(candidateKey(b)));
  const bombs = moves.filter(special).sort((a, b) => info(a).size - info(b).size || info(a).mainRank - info(b).mainRank);
  const result: Candidate[] = [];
  const add = (cards: string[] | null, originalChoice = false, declared?: ComboDeclaration) => {
    if (cards === null && !view.lastPlay) return;
    if (cards !== null && (!cards.length || new Set(cards).size !== cards.length || cards.some(id => !byId.has(id)))) return;
    const combo = cards ? parseCombo(cards.map(id => byId.get(id)!), view.level, declared) : null;
    if (cards && (!combo || (view.lastPlay && !beats(combo, view.lastPlay.combo)))) return;
    const key = candidateKey(cards, declared);
    if (result.some(c => c.key === key)) { if (originalChoice) result.find(c => c.key === key)!.original = true; return; }
    if (result.length >= 5) return;
    result.push({ cards, declared, key, original: originalChoice, label: cards ? `${comboName(combo!)} · ${cards.map(id => {
      const c = byId.get(id)!; return `${c.suit === 'J' ? '' : ({ S:'♠', H:'♥', C:'♣', D:'♦' } as Record<string, string>)[c.suit]}${c.rank === 14 ? 'A' : c.rank === 13 ? 'K' : c.rank === 12 ? 'Q' : c.rank === 11 ? 'J' : c.rank === 15 ? '小王' : c.rank === 16 ? '大王' : c.rank}`;
    }).join(' ')}` : '过牌' });
  };
  if (original !== undefined) add(original, true, originalDeclared);
  const baseline = chooseAiMove(base);
  const current = chooseStructuredMove(base);
  const previous = chooseLegacyStructuredMove(base);
  const expanded = chooseExpandedStructuredMove(base);
  // Compare the current policy to the frozen predecessor and expanded-action experiment.
  if (current !== null) add(current);
  if (view.lastPlay) add(null);
  if (previous !== null) add(previous);
  if (expanded !== null) add(expanded);
  if (baseline) add(baseline);
  if (bombs.length) add(bombs[0]);
  if (ordinary.length) add(ordinary[0]);
  const longest = [...ordinary].sort((a, b) => b.length - a.length || score(a) - score(b));
  if (longest.length) add(longest[0]);
  for (const move of [...longest, ...ordinary, ...bombs]) { if (result.length >= 5) break; add(move); }
  return result;
}

export function sampleHidden(view: AnalysisView, seed: number): GameState {
  if (view.counts.length !== 4 || view.counts.some(c => !Number.isInteger(c) || c < 0 || c > 27)) throw new Error('剩余张数无效');
  const deck = createDeck();
  const valid = new Set(deck.map(c => c.id));
  const played = view.events.filter(e => e.type === 'play').flatMap(e => e.cardIds ?? []);
  const used = [...view.hand.map(c => c.id), ...played];
  if (new Set(used).size !== used.length || used.some(id => !valid.has(id)) || view.counts[0] !== view.hand.length) throw new Error('已知牌不一致');
  const unknown = shuffle(deck.filter(c => !used.includes(c.id)), seed);
  if (view.counts[1] + view.counts[2] + view.counts[3] !== unknown.length) throw new Error('公开剩余张数与牌数不一致');
  let offset = 0;
  const players = ([0,1,2,3] as Seat[]).map(seat => {
    const hand = seat === 0 ? [...view.hand] : unknown.slice(offset, offset += view.counts[seat]);
    return { seat, name: ['你','王总','小顾','林姐'][seat], role: (['you','boss','partner','opponent'] as const)[seat], hand, finished: view.finishOrder.includes(seat) ? view.finishOrder.indexOf(seat) + 1 : undefined };
  });
  return {
    schemaVersion: 2, ruleVersion: '竞技掼蛋2022-教学版', seed: 0, createdAt: 0, level: view.level,
    levelOwner: null, phase: 'playing', players, turn: view.turn, leader: view.lastPlay?.seat ?? view.turn,
    lastPlay: view.lastPlay, passes: view.passes, finishOrder: [...view.finishOrder], events: view.events,
    trickNo: 0, roundNo: 1, teamLevels: [view.level, view.level], matchWinner: null,
  };
}
function rollout(sample: GameState, candidate: Candidate): boolean | null {
  let state = candidate.cards ? playCards(sample, 0, candidate.cards, candidate.declared) : passTurn(sample, 0);
  for (let step = 0; state.phase === 'playing' && step < 240; step++) {
    const seat = state.turn;
    const o = observe(state, seat);
    const choice = chooseStructuredMove(o);
    if (choice) state = playCards(state, seat, choice);
    else if (state.lastPlay) state = passTurn(state, seat);
    else {
      const fallback = legalMoves(o)[0];
      if (!fallback) return null;
      state = playCards(state, seat, fallback);
    }
  }
  return state.phase === 'finished' ? state.finishOrder[0] % 2 === 0 : null;
}
function wilson(wins: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 1];
  const p = wins / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const r = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - r), Math.min(1, c + r)];
}
function pairedDifference(a: Array<boolean | null>, b: Array<boolean | null>): { mean: number; low: number; high: number; completed: number } {
  const paired = a.flatMap((value, i) => value === null || b[i] == null ? [] : [Number(value) - Number(b[i])]);
  const mean = paired.reduce((sum, n) => sum + n, 0) / (paired.length || 1);
  const variance = paired.length > 1 ? paired.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (paired.length - 1) : 0;
  const radius = paired.length > 1 ? 1.96 * Math.sqrt(variance / paired.length) : 1;
  return { mean, low: Math.max(-1, mean - radius), high: Math.min(1, mean + radius), completed: paired.length };
}

/** A sampled leader is not a mathematically optimal play, nor a calibrated win probability. */
export function assessLeader(outcomes: Array<Array<boolean | null>>): { index: number | null; separated: boolean } {
  if (!outcomes.length) return { index: null, separated: false };
  const stats = outcomes.map(row => ({ wins: row.filter(Boolean).length, completed: row.filter(value => value !== null).length }));
  const scores = stats.map(s => s.completed ? wilson(s.wins, s.completed, 1.28)[0] : -1);
  const best = Math.max(...scores);
  const leaders = scores.flatMap((score, index) => score === best && score >= 0 ? [index] : []);
  if (leaders.length !== 1) return { index: null, separated: false };
  const index = leaders[0];
  // Paired intervals are descriptive only; the threshold prevents tiny samples being labeled distinct.
  const separated = outcomes.length > 1 && outcomes.every((row, other) => {
    if (other === index) return true;
    const diff = pairedDifference(outcomes[index], row);
    return diff.completed >= 8 && diff.low > 0;
  });
  return { index, separated };
}

export function createAnalysisRunner(view: AnalysisView, options: Candidate[], samples = 12, seed = 73691) {
  if (!Number.isInteger(samples) || samples < 2 || samples > 120 || !options.length || options.length > 5 || view.turn !== 0) throw new Error('分析参数无效');
  const outcomes: Array<Array<boolean | null>> = options.map(() => []);
  let completed = 0;
  return {
    get completed() { return completed; },
    step(): void {
      if (completed >= samples) return;
      const sample = sampleHidden(view, seed + completed * 7919);
      for (let j = 0; j < options.length; j++) outcomes[j].push(rollout(sample, options[j]));
      completed++;
    },
    result(): AnalysisResult {
      if (completed !== samples) throw new Error('抽样尚未完成');
      const baseline = outcomes[0];
      const estimates = options.map((candidate, index) => {
        const finished = outcomes[index].filter(value => value !== null) as boolean[];
        const wins = finished.filter(Boolean).length;
        const [low, high] = wilson(wins, finished.length);
        const paired = pairedDifference(outcomes[index], baseline);
        return { candidate, wins, completed: finished.length, probability: finished.length ? wins / finished.length : 0, low, high,
          pairedGap: paired.mean, pairedLow: paired.low, pairedHigh: paired.high };
      });
      const leader = assessLeader(outcomes);
      return { estimates, samples, seed, leadingKey: leader.index === null ? null : options[leader.index].key, separated: leader.separated,
        metric: '本副牌本队取得头游', model: '可见信息随机暗牌分配 + 本地结构策略；未按历史行为更新暗牌先验或校准概率' };
    },
  };
}

export function analyze(view: AnalysisView, options: Candidate[], samples = 12, seed = 73691): AnalysisResult {
  const runner = createAnalysisRunner(view, options, samples, seed);
  while (runner.completed < samples) runner.step();
  return runner.result();
}
