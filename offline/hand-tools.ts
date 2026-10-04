import { cardLabel, RANK_LABEL, rankPower, SUIT_LABEL } from '../lib/game/cards';
import { beats, comboName, comboOptions, parseCombo } from '../lib/game/rules';
import type { Card, ComboDeclaration, Rank, Suit, TrickPlay } from '../lib/game/types';

export type HandOrder = 'rank' | 'suit' | 'combo' | 'manual';
export interface HandStack { key: string; label: string; cards: Card[] }
export interface FlushOption {
  cards: Card[];
  ids: string[];
  suit: Exclude<Suit, 'J'>;
  high: number;
  wildCount: number;
  declaration: ComboDeclaration;
  playable: boolean;
  label: string;
}
const suits: Exclude<Suit, 'J'>[] = ['S', 'H', 'C', 'D'];
const suitOrder = (suit: Suit): number => suit === 'J' ? 4 : suits.indexOf(suit);

/** Display-only ordering: it never changes the game engine's hand or saved replay. */
export function arrangeHand(hand: Card[], level: Rank, order: HandOrder): Card[] {
  return [...hand].sort((a, b) => order === 'suit'
    ? suitOrder(a.suit) - suitOrder(b.suit) || rankPower(a.rank, level) - rankPower(b.rank, level) || a.deck - b.deck
    : rankPower(a.rank, level) - rankPower(b.rank, level) || suitOrder(a.suit) - suitOrder(b.suit) || a.deck - b.deck);
}

/** Group the display order into overlapping vertical stacks without touching the rules hand. */
export function stackHand(hand: Card[], level: Rank, order: HandOrder): HandStack[] {
  const groups = new Map<string, HandStack>();
  for (const card of arrangeHand(hand, level, order)) {
    const key = order === 'rank' ? `${card.rank}` : `${card.suit}-${card.rank}`;
    let stack = groups.get(key);
    if (!stack) {
      stack = { key, label: order === 'rank' ? RANK_LABEL[card.rank] : `${SUIT_LABEL[card.suit]}${RANK_LABEL[card.rank]}`, cards: [] };
      groups.set(key, stack);
    }
    stack.cards.push(card);
  }
  return [...groups.values()];
}

/** Enumerate physical five-card flushes, including two-deck alternatives and red-heart-level wilds.
 * Final classification and whether the play beats the current trick come from the shared rules core.
 */
export function findStraightFlushes(hand: Card[], level: Rank, lastPlay: TrickPlay | null): FlushOption[] {
  const wilds = hand.filter(c => c.suit === 'H' && c.rank === level).sort((a, b) => a.deck - b.deck);
  const windows = [[14, 2, 3, 4, 5], ...Array.from({ length: 9 }, (_, i) => Array.from({ length: 5 }, (_, j) => i + 2 + j))];
  const found = new Map<string, FlushOption>();
  for (const suit of suits) for (const window of windows) {
    const byRank = window.map(rank => hand.filter(c => c.suit === suit && c.rank === rank && !wilds.includes(c)));
    if (byRank.filter(cards => !cards.length).length > wilds.length) continue;
    const high = window[0] === 14 ? 5 : window[4];
    const visit = (index: number, chosen: Card[], substitutions: number[]): void => {
      if (index === window.length) {
        // Keep representative physical cards for each visible strength and wild usage.
        const key = `${suit}|${high}|${substitutions.length}`;
        if (found.has(key) || new Set(chosen.map(c => c.id)).size !== 5) return;
        const combo = comboOptions(chosen, level).find(c => c.kind === 'straightFlush' && c.mainRank === high);
        if (!combo) return;
        found.set(key, {
          cards: chosen, ids: chosen.map(c => c.id), suit, high, wildCount: substitutions.length,
          declaration: { kind: 'straightFlush', mainRank: high },
          playable: beats(combo, lastPlay?.combo ?? null),
          // The first part lists ONLY physical cards actually present in the hand.
          label: `${chosen.map(cardLabel).join(' · ')}${substitutions.length ? `（逢人配代 ${substitutions.map(rank => RANK_LABEL[rank]).join('、')}；组成 ${SUIT_LABEL[suit]}${window.map(rank => RANK_LABEL[rank]).join('')}）` : ''}`,
        });
        return;
      }
      for (const card of byRank[index]) visit(index + 1, [...chosen, card], substitutions);
      for (const card of wilds) if (!chosen.includes(card)) visit(index + 1, [...chosen, card], [...substitutions, window[index]]);
    };
    visit(0, [], []);
  }
  return [...found.values()].sort((a, b) => Number(b.playable) - Number(a.playable)
    || a.wildCount - b.wildCount || a.high - b.high || suitOrder(a.suit) - suitOrder(b.suit)
    || a.ids.join('|').localeCompare(b.ids.join('|')));
}

export function handGroupLabel(cards: Card[], level: Rank): string {
  const combo = parseCombo(cards, level);
  return combo ? comboName(combo) : '自定义';
}

/** Build a bounded, deterministic partition of physical cards into playable shapes.
 * This is display-only, not a search over opponents or a claim of optimal play.
 */
export function groupHandByCombos(hand: Card[], level: Rank): string[][] {
  if (!hand.length) return [];
  if (hand.length > 27) throw new Error('单人手牌超过 27 张');
  const sorted = arrangeHand(hand, level, 'rank');
  const index = new Map(sorted.map((card, i) => [card.id, i]));
  const wilds = sorted.filter(card => card.suit === 'H' && card.rank === level);
  const naturals = sorted.filter(card => !wilds.includes(card));
  const choices = new Map<number, { mask: number; cards: Card[]; price: number }>();
  const comboCache = new Map<number, ReturnType<typeof parseCombo>>();
  const add = (cards: Card[]): void => {
    if (!cards.length || new Set(cards.map(card => card.id)).size !== cards.length) return;
    const mask = cards.reduce((value, card) => value | (1 << index.get(card.id)!), 0);
    if (choices.has(mask)) return;
    let combo = comboCache.get(mask);
    if (combo === undefined) { combo = parseCombo(cards, level); comboCache.set(mask, combo); }
    if (!combo) return;
    const spent = cards.filter(card => wilds.includes(card)).length;
    // Fewer hands first. Protect scarce wilds and prefer trump groups when hand-count ties.
    const priority = combo.kind === 'jokerBomb' ? 240 : combo.kind === 'straightFlush' ? 210 : combo.kind === 'bomb' ? 170 : 0;
    choices.set(mask, { mask, cards, price: 1000 + spent * 36 - priority + combo.mainRank * 0.01 });
  };
  const pick = (rank: number, count: number, suit?: Suit): Card[][] => {
    const available = naturals.filter(card => card.rank === rank && (!suit || card.suit === suit));
    const result: Card[][] = [];
    // A wildcard may replace a natural card even when the rank is complete: that
    // natural card can then finish a different shape in the display partition.
    for (let used = Math.max(0, count - available.length); used <= Math.min(count, wilds.length); used++) {
      const n = count - used;
      const variants: Card[][] = [];
      if (n <= 3) {
        const collect = (start: number, picked: Card[]): void => {
          if (picked.length === n) { variants.push(picked); return; }
          for (let i = start; i <= available.length - (n - picked.length); i++) collect(i + 1, [...picked, available[i]]);
        };
        collect(0, []);
      } else if (available.length >= n) variants.push(available.slice(0, n), available.slice(-n));
      if (!variants.length || variants[0].length !== n) continue;
      const extras = used === 0 ? [[]] : used === 1 ? wilds.map(card => [card]) : [wilds];
      for (const cards of variants) for (const extra of extras) result.push([...cards, ...extra]);
    }
    return result;
  };
  const patterns = (ranks: number[], count: number, suit?: Suit): void => {
    const visit = (position: number, cards: Card[]): void => {
      if (position === ranks.length) { add(cards); return; }
      for (const group of pick(ranks[position], count, suit)) {
        if (group.some(card => cards.includes(card))) continue;
        visit(position + 1, [...cards, ...group]);
      }
    };
    visit(0, []);
  };
  for (const card of sorted) add([card]);
  for (let rank = 2; rank <= 16; rank++) for (const size of [2, 3]) for (const group of pick(rank, size)) add(group);
  for (let rank = 2; rank <= 14; rank++) {
    const present = naturals.filter(card => card.rank === rank);
    for (let size = 4; size <= Math.min(10, present.length + wilds.length); size++) {
      // Do not spend a wildcard to form an otherwise available smaller bomb by default.
      for (const group of pick(rank, size)) add(group);
    }
  }
  add(sorted.filter(card => card.suit === 'J'));
  for (let triple = 2; triple <= 14; triple++) for (let pair = 2; pair <= 14; pair++) {
    if (triple === pair) continue;
    for (const a of pick(triple, 3)) for (const b of pick(pair, 2)) {
      if (a.some(card => b.includes(card))) continue;
      add([...a, ...b]);
    }
  }
  const straightWindows = [[14, 2, 3, 4, 5], ...Array.from({ length: 9 }, (_, i) => Array.from({ length: 5 }, (_, j) => 2 + i + j))];
  for (const window of straightWindows) {
    patterns(window, 1);
    for (const suit of suits) patterns(window, 1, suit);
  }
  for (let rank = 2; rank <= 12; rank++) patterns([rank, rank + 1, rank + 2], 2);
  for (let rank = 2; rank <= 13; rank++) patterns([rank, rank + 1], 3);
  // Reuse the already tested finder for suit sequences and double-deck choices.
  for (const option of findStraightFlushes(sorted, level, null)) add(option.cards);
  const byCard: Array<Array<NonNullable<ReturnType<typeof choices.get>>>> = Array.from({ length: sorted.length }, () => []);
  for (const choice of choices.values()) for (let bit = 0; bit < sorted.length; bit++) if (choice.mask & (1 << bit)) byCard[bit].push(choice);
  for (const list of byCard) list.sort((a, b) => a.price / a.cards.length - b.price / b.cards.length || a.mask - b.mask);
  const full = (1 << sorted.length) - 1;
  const memo = new Map<number, { price: number; groups: Card[][] }>();
  let remainingBudget = 2800;
  const solve = (available: number): { price: number; groups: Card[][] } => {
    if (!available) return { price: 0, groups: [] };
    const cached = memo.get(available);
    if (cached) return cached;
    // Bounded fallback is always a valid partition, even for unusually dense hands.
    if (--remainingBudget < 0) {
      const bit = 31 - Math.clz32(available & -available);
      const candidate = byCard[bit].find(group => group.mask === (1 << bit))!;
      const rest = solve(available ^ candidate.mask);
      return { price: candidate.price + rest.price, groups: [candidate.cards, ...rest.groups] };
    }
    let pivot = -1, fewest = Infinity;
    for (let bit = 0; bit < sorted.length; bit++) if (available & (1 << bit)) {
      const count = byCard[bit].filter(group => (group.mask & available) === group.mask).length;
      if (count < fewest) { fewest = count; pivot = bit; }
    }
    let best = { price: Infinity, groups: [] as Card[][] };
    for (const candidate of byCard[pivot]) {
      if ((candidate.mask & available) !== candidate.mask) continue;
      const rest = solve(available ^ candidate.mask);
      const price = candidate.price + rest.price;
      if (price < best.price) best = { price, groups: [candidate.cards, ...rest.groups] };
    }
    memo.set(available, best);
    return best;
  };
  const result = solve(full).groups;
  // One group for each play: show individual ranks in sequence and keep trump/wilds recognizable.
  const order = (cards: Card[]) => {
    const combo = parseCombo(cards, level)!;
    return combo.kind === 'jokerBomb' ? 0 : combo.kind === 'straightFlush' ? 1 : combo.kind === 'bomb' ? 2 : combo.kind === 'plate' ? 3 : combo.kind === 'tube' ? 4 : combo.kind === 'triplePair' ? 5 : combo.kind === 'straight' ? 6 : combo.kind === 'triple' ? 7 : combo.kind === 'pair' ? 8 : 9;
  };
  return result.sort((a, b) => order(a) - order(b) || a[0].rank - b[0].rank).map(cards => cards.map(card => card.id));
}

export function groupSelectedCards(stacks: string[][], ids: string[]): string[][] {
  const selected = new Set(ids);
  const available = new Set(stacks.flat());
  if (selected.size < 2 || selected.size !== ids.length || ids.some(id => !available.has(id))) return stacks.map(group => [...group]);
  const remaining = stacks.map(group => group.filter(id => !selected.has(id))).filter(group => group.length);
  return [[...ids], ...remaining];
}

/** User-arranged stacks store physical card IDs only; removed cards are dropped on display. */
export function manualHandStacks(hand: Card[], level: Rank, stored: unknown, fallback: 'rank' | 'suit' = 'rank'): string[][] {
  const valid = new Set(hand.map(card => card.id));
  const seen = new Set<string>();
  const stacks: string[][] = [];
  if (Array.isArray(stored)) for (const group of stored.slice(0, 108)) {
    if (!Array.isArray(group)) continue;
    const cards: string[] = [];
    for (const id of group.slice(0, 108)) if (typeof id === 'string' && valid.has(id) && !seen.has(id)) {
      cards.push(id); seen.add(id);
    }
    if (cards.length) stacks.push(cards);
  }
  for (const group of stackHand(hand.filter(card => !seen.has(card.id)), level, fallback)) stacks.push(group.cards.map(card => card.id));
  return stacks;
}

export function moveManualCard(stacks: string[][], source: string, target: string | null): string[][] {
  const next = stacks.map(group => [...group]);
  if (!next.some(group => group.includes(source)) || (target !== null && !next.some(group => group.includes(target))) || source === target) return next;
  for (const group of next) {
    const index = group.indexOf(source);
    if (index !== -1) { group.splice(index, 1); break; }
  }
  const nonempty = next.filter(group => group.length);
  if (target === null) nonempty.push([source]);
  else {
    const group = nonempty.find(cards => cards.includes(target))!;
    group.splice(group.indexOf(target), 0, source);
  }
  return nonempty;
}

export function moveManualColumn(stacks: string[][], index: number, direction: -1 | 1): string[][] {
  const next = stacks.map(group => [...group]);
  const destination = index + direction;
  if (!Number.isInteger(index) || index < 0 || destination < 0 || destination >= next.length) return next;
  [next[index], next[destination]] = [next[destination], next[index]];
  return next;
}

export function pulledHand(hand: Card[], level: Rank, order: HandOrder, flush: FlushOption | null): Card[] {
  if (!flush) return arrangeHand(hand, level, order);
  const ids = new Set(flush.ids);
  return [...flush.cards, ...arrangeHand(hand.filter(c => !ids.has(c.id)), level, order)];
}
