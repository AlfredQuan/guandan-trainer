import { createDeck, rankPower } from '../lib/game/cards';
import type { Observation } from '../lib/game/ai';
import type { Card, Rank, Suit } from '../lib/game/types';

export interface CardMemory {
  /** Exact physical cards still outside the acting player's hand; owners are unknown. */
  outside: Card[];
  played: Card[];
  outsideByRank: ReadonlyMap<Rank, number>;
  outsideBySuitRank: ReadonlyMap<string, number>;
  outsideCount: number;
  /** Count of visible non-finished opponents' cards, not their identities. */
  otherHandCounts: number[];
}

const deck = createDeck();
const byId = new Map(deck.map(card => [card.id, card]));
const cardKey = (suit: Suit, rank: Rank) => `${suit}-${rank}`;

/** Reconstruct the public unseen pool. Never reads GameState, seed or another seat's hand. */
export function countOutsideCards(view: Pick<Observation, 'seat' | 'hand' | 'counts' | 'events'>): CardMemory {
  if (!Number.isInteger(view.seat) || view.seat < 0 || view.seat > 3 || view.counts.length !== 4 ||
      view.counts.some(count => !Number.isInteger(count) || count < 0 || count > 27) ||
      view.counts[view.seat] !== view.hand.length) throw new Error('记牌器：座位或手牌张数无效');
  const hand = new Set<string>();
  for (const card of view.hand) {
    const known = byId.get(card.id);
    if (!known || known.suit !== card.suit || known.rank !== card.rank || known.deck !== card.deck || hand.has(card.id)) throw new Error('记牌器：手牌实体牌无效');
    hand.add(card.id);
  }
  const seen = new Set<string>();
  for (const event of view.events) {
    if (event.type !== 'play') continue;
    if (!event.cardIds?.length || event.cardIds.some(id => !byId.has(id) || hand.has(id) || seen.has(id))) throw new Error('记牌器：公开出牌记录冲突');
    event.cardIds.forEach(id => seen.add(id));
  }
  const played = deck.filter(card => seen.has(card.id));
  const outside = deck.filter(card => !hand.has(card.id) && !seen.has(card.id));
  const otherHandCounts = view.counts.map((count, seat) => seat === view.seat ? 0 : count);
  if (outside.length !== otherHandCounts.reduce((a, b) => a + b, 0)) throw new Error('记牌器：未见牌数量与各家剩牌不一致');
  const outsideByRank = new Map<Rank, number>(), outsideBySuitRank = new Map<string, number>();
  for (const card of outside) {
    outsideByRank.set(card.rank, (outsideByRank.get(card.rank) ?? 0) + 1);
    const key = cardKey(card.suit, card.rank);
    outsideBySuitRank.set(key, (outsideBySuitRank.get(key) ?? 0) + 1);
  }
  return { outside, played, outsideByRank, outsideBySuitRank, outsideCount: outside.length, otherHandCounts };
}

/** A *potential*, not certainty: a higher natural singleton may all be in the teammate's hand. */
export function possibleHigherSingles(memory: CardMemory, rank: Rank, level: Rank): number {
  const power = rankPower(rank, level);
  return memory.outside.reduce((n, card) => n + Number(rankPower(card.rank, level) > power), 0);
}

/** Purely public possibility. Bombs and wild interpretations are not ruled out by this helper. */
export function possibleHigherNaturalGroups(memory: CardMemory, rank: Rank, size: 2 | 3, level: Rank): number {
  const power = rankPower(rank, level);
  let options = 0;
  for (const [otherRank, count] of memory.outsideByRank) {
    if (count >= size && rankPower(otherRank, level) > power) options++;
  }
  return options;
}
