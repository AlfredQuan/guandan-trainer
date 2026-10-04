import { chooseAiMove, legalMoves, legacyLegalMoves, type Observation } from '../lib/game/ai';
import { rankPower } from '../lib/game/cards';
import { parseCombo } from '../lib/game/rules';
import { countOutsideCards, possibleHigherNaturalGroups, possibleHigherSingles, type CardMemory } from './card-memory';

/** Shipped policy: prefer retaining pairs and larger groups over shedding a few cards. */
export function chooseStructuredMove(o: Observation): string[] | null {
  return chooseFromMoves(o, legacyLegalMoves(o), 4, 6);
}

/** Experimental memory-aware challenger. The shipped/frozen structural policy stays unchanged until an independent paired duel proves an upgrade. */
export function chooseCardCountingMove(o: Observation): string[] | null {
  return chooseFromMoves(o, legacyLegalMoves(o), 4, 6, countOutsideCards(o));
}

/** Frozen v0.10 policy for direct paired regressions. */
export function chooseLegacyStructuredMove(o: Observation): string[] | null {
  return chooseFromMoves(o, legacyLegalMoves(o), 1.8, 2.7);
}

/** Expanded candidates with unchanged v0.10 scoring, for comparison only. */
export function chooseExpandedStructuredMove(o: Observation): string[] | null {
  return chooseFromMoves(o, legalMoves(o), 1.8, 2.7);
}

function chooseFromMoves(o: Observation, moves: string[][], singleWeight: number, breakWeight: number, memory?: CardMemory): string[] | null {
  if (!moves.length) return o.lastPlay ? null : chooseAiMove(o);
  const teammate = (o.seat + 2) % 4;
  const opponentMin = Math.min(...o.counts.filter((_, seat) => seat % 2 !== o.seat % 2));
  const allyLeads = o.lastPlay?.seat === teammate;
  const holding = o.hand.length;
  if (allyLeads && o.counts[teammate] <= 6 && !moves.some(ids => ids.length === holding)) return null;

  const byId = new Map(o.hand.map(card => [card.id, card]));
  const counts = new Map<number, number>();
  for (const card of o.hand) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  const hasNormal = moves.some(ids => {
    const combo = parseCombo(ids.map(id => byId.get(id)!), o.level)!;
    return !['bomb', 'straightFlush', 'jokerBomb'].includes(combo.kind);
  });
  const score = (ids: string[]): number => {
    const cards = ids.map(id => byId.get(id)!);
    const combo = parseCombo(cards, o.level)!;
    const rest = new Map(counts);
    for (const card of cards) rest.set(card.rank, rest.get(card.rank)! - 1);
    const wildSpent = cards.filter(card => card.suit === 'H' && card.rank === o.level).length;
    const powerSpent = cards.reduce((sum, card) => sum + Math.max(0, rankPower(card.rank, o.level) - 10), 0);
    let broken = 0, singles = 0;
    for (const [rank, left] of rest) {
      if (left === 1 && rank !== o.level && rank <= 14) singles++;
      if (left === 1 && (counts.get(rank) ?? 0) >= 2) broken++;
    }
    const bomb = ['bomb', 'straightFlush', 'jokerBomb'].includes(combo.kind);
    const finish = ids.length === holding;
    // A public-pool upper bound: no higher natural group does not rule out bombs,
    // wild interpretations or teammate ownership. Only a small situational tie-breaker.
    let memoryBonus = 0;
    if (memory && !allyLeads && wildSpent === 0 && ['single', 'pair', 'triple'].includes(combo.kind)) {
      const possible = combo.kind === 'single'
        ? possibleHigherSingles(memory, cards[0].rank, o.level)
        : possibleHigherNaturalGroups(memory, cards[0].rank, cards.length as 2 | 3, o.level);
      if (possible === 0) memoryBonus = opponentMin <= 3 ? -12 : -2;
      else if (possible <= 2 && opponentMin <= 3) memoryBonus = -4;
    }
    // Smaller is better. Frozen policies do not pass memory, so their scores are unchanged.
    return -(cards.length * 4.5) + singles * singleWeight + broken * breakWeight
      + wildSpent * (holding > 8 ? 6 : 1)
      + powerSpent * (holding > 8 ? 0.6 : 0.15)
      + (bomb && hasNormal && !finish && opponentMin > 2 ? 25 : 0)
      + (bomb && allyLeads ? 25 : 0)
      + (allyLeads ? 13 : 0)
      - (finish ? 1000 : 0)
      - (opponentMin <= 3 && !allyLeads ? cards.length * 1.5 : 0)
      + combo.mainRank * 0.04 + memoryBonus;
  };
  let best: string[] | null = null;
  let bestScore = Infinity;
  for (const ids of moves) {
    const value = score(ids);
    if (value < bestScore) { bestScore = value; best = ids; }
  }
  // Do not overtake a teammate unless a legal move immediately empties our hand.
  if (o.lastPlay && allyLeads) return moves.find(ids => ids.length === holding) ?? null;
  return best;
}
