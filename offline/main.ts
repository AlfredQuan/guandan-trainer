import { candidates, createAnalysisRunner, project, type AnalysisResult } from './analysis';
import { cardLabel, RANK_LABEL, SUIT_LABEL } from '../lib/game/cards';
import { findStraightFlushes, groupHandByCombos, groupSelectedCards, handGroupLabel, manualHandStacks, moveManualCard, moveManualColumn, stackHand, type FlushOption, type HandOrder } from './hand-tools';
import { legalMoves, observe } from '../lib/game/ai';
import { aiActionToGame, buildAiRequest, decideSafely, localAiProvider, loopbackAiProvider } from './ai-gateway';
import { arenaStatus } from './arena-status';
import { legalPlay, newGame, passTurn, playCards } from '../lib/game/engine';
import { beats, comboName, comboOptions, parseCombo } from '../lib/game/rules';
import type { Card, ComboDeclaration, GameState, Seat } from '../lib/game/types';
import './style.css';

type Action = { kind: 'play'; seat: Seat; cards: string[]; declared?: ComboDeclaration } | { kind: 'pass'; seat: Seat };
type Deal = { initial: GameState; actions: Action[] };
type Session = { version: 2; deals: [Deal] };
type Frame = { state: GameState; label: string; round: number };

const KEY = 'guandan-offline-single-deal-v2';
const HAND_ORDER_KEY = 'guandan-offline-hand-order-v1';
const AI_MODE_KEY = 'guandan-arena-ai-mode-v1';
const MANUAL_KEY = 'guandan-offline-manual-v1-';
const MAX_ACTIONS = 350;
const ANALYSIS_SAMPLES = 20;
const app = document.querySelector<HTMLDivElement>('#app')!;
const mobileApp = document.documentElement?.dataset.platform === 'android';
let session: Session;
let frames: Frame[] = [];
let replay = -1;
let selected = new Set<string>();
let selectedDeclaration: ComboDeclaration | null = null;
let handOrder: HandOrder = 'rank';
let manualEditing = false;
let arrangingCard: string | null = null;
let pulledKey: string | null = null;
let flushMenuOpen = false;
let quickMovesOpen = false;
let error = '';
let warning = '';
let aiTimer: ReturnType<typeof setTimeout> | undefined;
let aiRevision = 0;
let hintRevision = 0;
let aiMode: 'local' | 'loopback' = 'local';
let aiStatus = '本地结构策略就绪';
let pendingNew = false;
let pendingAnalysis = false;
let analyzedSamples = 0;
let analysisResult: AnalysisResult | null = null;
let analysisIndex = -1;
let analysisTimer: ReturnType<typeof setTimeout> | undefined;
const analysisCache = new Map<number, AnalysisResult>();
const handLayoutCache = new Map<string, string[][]>();
const names = ['你', '王总', '小顾', '林姐'];
const comboNames: Record<string, string> = { single: '单张', pair: '对子', triple: '三张', triplePair: '三带二', straight: '顺子', tube: '三连对', plate: '二连三', bomb: '炸弹', straightFlush: '同花顺', jokerBomb: '四王炸' };

function initialSession(): Session {
  const random = crypto.getRandomValues(new Uint32Array(2));
  const level = (2 + random[1] % 13) as GameState['level'];
  return { version: 2, deals: [{ initial: newGame(random[0], level), actions: [] }] };
}
function singleDealSummary(state: GameState): string {
  if (state.phase !== 'finished' || state.finishOrder.length < 4) return '';
  const winner = state.finishOrder[0] % 2;
  const pattern = state.finishOrder[1] % 2 === winner ? '双上' : state.finishOrder[2] % 2 === winner ? '头游三游' : '头游末游';
  return `${winner === 0 ? '你 / 小顾队' : '王总 / 林姐队'} · ${pattern} · ${winner === 0 ? '你方获胜' : '对方获胜'}（本局结束，不升级、不贡还）`;
}

function rebuild(value: Session): Frame[] {
  if (value.version !== 2 || !Array.isArray(value.deals) || value.deals.length !== 1) throw new Error('仅支持新版单局存档；旧版多副比赛仍保留在旧文件中');
  const all: Frame[] = [];
  for (let i = 0; i < value.deals.length; i++) {
    const deal = value.deals[i];
    if (!deal || !Array.isArray(deal.actions) || deal.actions.length > MAX_ACTIONS || !Number.isInteger(deal.initial?.seed) || !Number.isInteger(deal.initial?.level) || deal.initial.level < 2 || deal.initial.level > 14) throw new Error('存档记录不完整');
    let state = newGame(deal.initial.seed, deal.initial.level);
    if (state.roundNo !== deal.initial.roundNo || state.level !== deal.initial.level || state.turn !== deal.initial.turn || state.players.map(p => p.hand.map(c => c.id).join(',')).join('|') !== deal.initial.players.map(p => p.hand.map(c => c.id).join(',')).join('|')) throw new Error('发牌记录校验失败');
    all.push({ state, round: state.roundNo, label: '单局 · 发牌' });
    for (const action of deal.actions) {
      if (![0, 1, 2, 3].includes(action.seat)) throw new Error('座位记录无效');
      state = action.kind === 'pass' ? passTurn(state, action.seat) : action.kind === 'play' && Array.isArray(action.cards) ? playCards(state, action.seat, action.cards, action.declared) : (() => { throw new Error('动作记录无效'); })();
      all.push({ state, round: state.roundNo, label: `${names[action.seat]}${action.kind === 'pass' ? '过牌' : `出了 ${action.cards.length} 张`}` });
    }
  }
  return all;
}

function load(): Session {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Session;
      frames = rebuild(parsed);
      return parsed;
    }
  } catch (cause) { warning = `本地存档无法读取，已新开一局。${cause instanceof Error ? cause.message : ''}`; }
  const fresh = initialSession();
  frames = rebuild(fresh);
  return fresh;
}

function persist(): void {
  try { localStorage.setItem(KEY, JSON.stringify(session)); }
  catch { warning = '浏览器存储空间不足，本次对局可能无法保存；请勿关闭页面。'; }
}

function current(): GameState { return frames.at(-1)!.state; }
function shown(): GameState { return frames[replay < 0 ? frames.length - 1 : replay].state; }
function escapeHtml(input: string): string { return input.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }
function cardView(card: Card, clickable = false, pulled = false): string {
  const active = manualEditing ? arrangingCard === card.id && replay < 0 : selected.has(card.id) && replay < 0;
  const wild = card.suit === 'H' && card.rank === shown().level;
  const suit = card.suit === 'J' ? (card.rank === 16 ? '★' : '✦') : SUIT_LABEL[card.suit];
  const name = card.suit === 'J' ? RANK_LABEL[card.rank] : `${({ S: '黑桃', H: '红桃', C: '梅花', D: '方块' } as const)[card.suit]}${RANK_LABEL[card.rank]}`;
  return `<button class="card suit-${card.suit} ${active ? 'selected' : ''} ${wild ? 'wild' : ''} ${pulled ? 'pulled' : ''}" ${clickable ? `data-card="${escapeHtml(card.id)}" aria-pressed="${active}"` : 'disabled'} aria-label="${name}，第${card.deck + 1}副${wild ? '，逢人配' : ''}" title="${name}${wild ? ' · 逢人配' : ''}"><span class="card-corner"><span class="card-rank">${escapeHtml(card.suit === 'J' ? (card.rank === 16 ? '大' : '小') : RANK_LABEL[card.rank])}</span><span class="card-suit">${suit}</span></span><span class="card-watermark" aria-hidden="true">${suit}</span>${wild ? '<span class="wild-dot">配</span>' : ''}</button>`;
}
function selectedOptions(state: GameState) {
  return comboOptions(state.players[0].hand.filter(c => selected.has(c.id)), state.level);
}
function selectedInfo(state: GameState): { text: string; valid: boolean } {
  if (!selected.size) return { text: '点选手牌，再出牌；可用“提示”查看基础策略。', valid: false };
  const options = selectedOptions(state);
  if (!options.length) return { text: '当前组合不是合法牌型', valid: false };
  if (options.length > 1 && !selectedDeclaration) return { text: '这组牌含逢人配，有多种合法解释：请先在下方声明牌型与点数。', valid: false };
  const combo = options.length === 1 ? options[0] : parseCombo(state.players[0].hand.filter(c => selected.has(c.id)), state.level, selectedDeclaration!);
  if (!combo) return { text: '声明的牌型与所选牌不符，请重新选择。', valid: false };
  const legal = beats(combo, state.lastPlay?.combo ?? null);
  return { text: `${comboName(combo)} · ${combo.mainRank} 点${combo.secondaryRank === undefined ? '' : ` · 带 ${combo.secondaryRank} 点对子`} · ${selected.size} 张${legal ? '' : ' · 压不过上一手'}`, valid: legal };
}
function playerBadge(state: GameState, seat: Seat): string {
  const p = state.players[seat];
  return `<div class="player ${state.turn === seat && state.phase === 'playing' ? 'turn' : ''} ${seat % 2 === 0 ? 'ally' : 'rival'}"><span class="player-avatar">${['我', '王', '顾', '林'][seat]}</span><div><strong>${names[seat]}</strong><small>${seat % 2 === 0 ? '我方' : '对方'} · ${p.finished ? `第 ${p.finished} 名` : `${p.hand.length} 张`}</small></div>${seat !== 0 && !p.finished ? '<span class="card-back" aria-hidden="true"></span>' : ''}${state.turn === seat && state.phase === 'playing' ? '<i class="turn-mark"></i>' : ''}</div>`;
}
function historyRows(state: GameState): string {
  return state.events.filter(e => ['play','pass','trick','round'].includes(e.type)).slice(-13).reverse().map(e => {
    const cards = e.cardIds?.length && e.type === 'play' ? e.cardIds.map(id => {
      const card = state.players.flatMap(p => p.hand).find(c => c.id === id);
      if (card) return cardLabel(card);
      const match = id.match(/^[01]-([SHCDJ])-(\d+)$/);
      return match ? `${({ S: '♠', H: '♥', C: '♣', D: '♦', J: '' } as Record<string,string>)[match[1]]}${RANK_LABEL[Number(match[2])]}` : '?';
    }).join(' ') : '';
    return `<li><span class="history-seat">${e.seat === undefined ? '牌局' : names[e.seat]}</span><span>${escapeHtml(e.type === 'play' ? `${cards}${e.note ? ` · ${e.note}` : ''}` : e.type === 'pass' ? '过牌' : e.note || '新一圈')}</span></li>`;
  }).join('') || '<li class="muted">本副牌刚开始</li>';
}
function analysisPanel(cursor: number): string {
  const state = frames[cursor].state;
  if (state.phase !== 'playing' || state.turn !== 0) return '<p class="muted">请在时间轴选择轮到你的决策前局面，查看候选出法比较。</p>';
  const result = analysisIndex === cursor ? analysisResult : analysisCache.get(cursor);
  const leading = result?.estimates.find(item => item.candidate.key === result.leadingKey);
  const verdict = result ? `<p class="analysis-verdict">${leading ? `${result.separated ? '本次采样有相对明显的领先候选' : '本次采样得分暂时领先'}：${escapeHtml(leading.candidate.label)}。${result.separated ? '配对抽样差值区间均高于其余候选；仍非确定最优。' : '与其他候选的差异尚不稳健，暂不建议据此断言优劣。'}` : '当前候选在保守抽样得分上并列或没有有效结果，暂不推荐唯一出法。'}</p>` : '';
  const rows = result?.estimates.map((item, index) => `<li class="estimate-row ${item.candidate.key === result.leadingKey ? 'leading' : ''}"><div><strong>${escapeHtml(item.candidate.label)}${item.candidate.original ? ' · 实际选择' : ''}${item.candidate.key === result.leadingKey ? ' · 本次采样得分领先' : ''}</strong><small>${item.completed}/${result.samples} 次有效完成；相对列表首项 ${index === 0 ? '基准' : `${item.pairedGap >= 0 ? '+' : ''}${Math.round(item.pairedGap * 100)} 个百分点（配对区间 ${Math.round(item.pairedLow * 100)}～${Math.round(item.pairedHigh * 100)}）`}</small></div><span>${Math.round(item.probability * 100)}%<small>${Math.round(item.low * 100)}–${Math.round(item.high * 100)}%</small></span></li>`).join('') ?? '';
  return `<p class="muted">指标：从当时视角估计本副牌本队取得头游的概率；不是整场胜率。列表首项仅作配对比较的基准；领先者按保守抽样得分筛选，不代表最优出法。</p><button class="return-live" data-action="analyze" ${pendingAnalysis ? 'disabled' : ''}>${pendingAnalysis && analysisIndex === cursor ? `正在计算 ${analyzedSamples}/${ANALYSIS_SAMPLES} 组…` : result ? '重新估计' : '比较候选出法'}</button>${verdict}${rows ? `<ol class="estimates">${rows}</ol><small>${result?.samples} 组配对暗牌采样 · 95% 近似抽样波动区间。仅比较列表内的候选；续打用结构策略且仅看各自可见信息，模型及暗牌先验误差不含在区间内。</small>` : '<p class="muted analysis-empty">默认对照最多 5 个候选（优先含实际出法、结构策略、过牌和其他打法）；并未穷举所有实体牌组合。粗估后可重新估计。</p>'}`;
}
function quickOptions(state: GameState): string[][] {
  if (state.phase !== 'playing' || state.turn !== 0) return [];
  const byId = new Map(state.players[0].hand.map(card => [card.id, card]));
  const grouped = new Map<string, string[]>();
  for (const move of legalMoves(observe(state, 0))) {
    const combo = parseCombo(move.map(id => byId.get(id)!), state.level);
    if (combo && !grouped.has(combo.kind)) grouped.set(combo.kind, move);
  }
  return [...grouped.values()].slice(0, 10);
}
function manualStorageKey(state: GameState): string { return `${MANUAL_KEY}${state.seed}-${state.roundNo}-${state.level}`; }
function readManual(state: GameState, fallback: 'rank' | 'suit' = 'rank'): string[][] {
  const key = manualStorageKey(state);
  let saved: unknown = handLayoutCache.get(key) ?? null;
  if (saved === null) {
    try { saved = JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { saved = null; }
  }
  if (saved === null && handOrder === 'combo') {
    const groups = groupHandByCombos(state.players[0].hand, state.level);
    saveManual(state, groups);
    return groups;
  }
  return manualHandStacks(state.players[0].hand, state.level, saved, fallback);
}
function saveManual(state: GameState, stacks: string[][]): void {
  const key = manualStorageKey(state);
  handLayoutCache.set(key, stacks.map(group => [...group]));
  try { localStorage.setItem(key, JSON.stringify(stacks)); }
  catch { warning = '浏览器存储不可用，理牌仅在当前页面内保留。'; }
}
function handMarkup(state: GameState, order: HandOrder, pulled: FlushOption | null, clickable: boolean): string {
  const hand = state.players[0].hand;
  const level = state.level;
  const pulledIds = new Set(pulled?.ids ?? []);
  const visible = hand.filter(card => !pulledIds.has(card.id));
  const byId = new Map(visible.map(card => [card.id, card]));
  const stacks = order === 'manual' || order === 'combo'
    ? readManual(state).map((ids, index) => {
      const cards = ids.map(id => byId.get(id)!).filter(Boolean);
      return { key: `group-${index}`, label: order === 'combo' ? handGroupLabel(cards, level) : `第${index + 1}列`, cards, sourceIndex: index };
    }).filter(stack => stack.cards.length)
    : stackHand(visible, level, order).map((stack, sourceIndex) => ({ ...stack, sourceIndex }));
  const extracted = pulled ? `<div class="extracted-hand" role="group" aria-label="已拔出的同花顺"><span class="stack-heading">已拔出的同花顺</span><div class="extracted-cards">${hand.filter(card => pulledIds.has(card.id)).map(card => cardView(card, clickable, true)).join('')}</div></div>` : '';
  const hint = manualEditing ? '手动理牌：点来源牌再点目标牌插到它前面；可单独成组或用箭头移动整组。点“完成理牌”恢复选牌。' : order === 'combo' ? '按合法牌型分组，横向滑动查看更多；点组名整组选牌。重叠组法仅作启发式整理，不保证唯一或最优；也可自己选牌“理成一组”。' : order === 'manual' ? '已保留手动排布 · 点击牌面选牌' : `${order === 'rank' ? '同点数竖向叠放' : '按花色分组，同花色同点数叠放'} · 点击露出的牌面选牌；选好三带二/顺子等，可点“理成一组” · 横向滑动查看全部`;
  return `${extracted}<div class="hand-scroll-hint">${hint}</div>${manualEditing && replay < 0 ? `<div class="manual-actions"><span>${arrangingCard ? '已选择一张牌：点目标牌插入，或单独成列。' : '先点要移动的牌。'}</span><button class="tool-chip" data-action="manual-new" ${arrangingCard ? '' : 'disabled'}>单独成列</button><button class="tool-chip" data-action="manual-cancel" ${arrangingCard ? '' : 'disabled'}>取消移动</button></div>` : ''}${!manualEditing && replay < 0 && selected.size >= 2 ? `<div class="manual-actions"><span>已选中 ${selected.size} 张：点“理成一组”可按你的组合单独摆放，不会出牌。</span><button class="tool-chip" data-action="group-selection">理成一组</button></div>` : ''}<div class="hand ${order === 'combo' ? 'combo-hand' : order === 'manual' ? 'manual-hand' : ''} ${manualEditing ? 'editing-hand' : ''}" role="group" aria-label="我的手牌">${stacks.map((stack, index) => `<div class="hand-column" role="group" aria-label="${escapeHtml(stack.label)}，${stack.cards.length}张"><span class="stack-heading">${manualEditing && replay < 0 ? `<button type="button" data-manual-column="${stack.sourceIndex}" data-direction="-1" aria-label="第${index + 1}列左移" ${index === 0 ? 'disabled' : ''}>‹</button>` : ''}${order === 'combo' && !manualEditing && replay < 0 ? `<button type="button" class="combo-select" data-combo-group="${stack.sourceIndex}" ${clickable ? '' : 'disabled'} aria-label="选中${escapeHtml(stack.label)}${stack.cards.length}张">${escapeHtml(stack.label)} <small>${stack.cards.length}</small></button>` : `${escapeHtml(stack.label)} <small>${stack.cards.length}</small>`}${manualEditing && replay < 0 ? `<button type="button" data-manual-column="${stack.sourceIndex}" data-direction="1" aria-label="第${index + 1}列右移" ${index === stacks.length - 1 ? 'disabled' : ''}>›</button>` : ''}</span><div class="hand-stack">${stack.cards.map(card => cardView(card, clickable || (manualEditing && replay < 0))).join('')}</div></div>`).join('') || '<span class="hand-empty">手牌已出完</span>'}</div>`;
}
function render(): void {
  const handScroll = document.querySelector<HTMLDivElement>('.hand')?.scrollLeft ?? 0;
  const extractedScroll = document.querySelector<HTMLDivElement>('.extracted-cards')?.scrollLeft ?? 0;
  const focused = typeof HTMLButtonElement !== 'undefined' && document.activeElement instanceof HTMLButtonElement && app.contains(document.activeElement)
    ? { card: document.activeElement.dataset.card, action: document.activeElement.dataset.action } : null;
  const state = shown();
  const latest = current();
  const inspecting = replay >= 0;
  const myTurn = !inspecting && latest.phase === 'playing' && latest.turn === 0;
  const flushes = findStraightFlushes(state.players[0].hand, state.level, state.lastPlay);
  const pulled = flushes.find(option => `${option.ids.slice().sort().join('|')}|${option.high}` === pulledKey) ?? null;
  const myHand = state.players[0].hand;
  const info = inspecting ? { text: '回放仅展示当时你自己的手牌；不显示其他三家的暗牌。', valid: false } : manualEditing ? { text: '正在手动理牌：完成后点“完成理牌”保留排布并返回选牌。', valid: false } : selectedInfo(latest);
  const quickMoves = quickMovesOpen && myTurn ? quickOptions(latest) : [];
  const status = arenaStatus(state);
  const last = state.lastPlay;
  const lastCards = last ? last.combo.cards.map(c => cardView(c)).join('') : '';
  const cursor = inspecting ? replay : frames.length - 1;
  const declaredChoices = myTurn && !manualEditing && selected.size ? selectedOptions(latest) : [];
  const declarationMarkup = declaredChoices.length > 1 ? `<div class="declaration-options" role="group" aria-label="逢人配牌型声明"><strong>声明本手牌型：</strong>${declaredChoices.map((combo, index) => `<button class="tool-chip ${selectedDeclaration?.kind === combo.kind && selectedDeclaration.mainRank === combo.mainRank && selectedDeclaration.secondaryRank === combo.secondaryRank ? 'on' : ''}" data-declare="${index}" aria-pressed="${selectedDeclaration?.kind === combo.kind && selectedDeclaration.mainRank === combo.mainRank && selectedDeclaration.secondaryRank === combo.secondaryRank}">${escapeHtml(comboName(combo))} · ${combo.mainRank} 点${combo.secondaryRank === undefined ? '' : ` 带 ${combo.secondaryRank} 点对子`}${beats(combo, latest.lastPlay?.combo ?? null) ? '' : '（压不过）'}</button>`).join('')}</div>` : '';
  app.innerHTML = `<div class="shell"><header class="topbar"><div class="brand"><span class="brand-icon">掼</span><div><b>掼蛋训练器</b><small>随机级牌 · 单局 Arena · 测试版 0.15</small></div></div><div class="header-right"><span class="offline-pill"><span class="online-dot"></span>本地运行</span>${mobileApp ? '<a class="subtle mobile-replay-link" href="#replay">查看复盘</a>' : ''}<button class="subtle" data-action="export">导出存档</button><button class="subtle" data-action="import">导入存档</button><button class="subtle" data-action="new">新开单局</button><input id="import-file" type="file" accept=".json,application/json" hidden /></div></header>
  <main class="layout"><section class="primary"><div class="headline"><div><p class="eyebrow">GUANDAN / SOLO PRACTICE</p><h1>${inspecting ? '逐步回放' : '单局 Arena'}</h1><p class="muted">单局随机级牌 · 级牌 ${escapeHtml(RANK_LABEL[state.level])} · 不升级、不贡还 · 随机首出</p></div><div class="score-strip"><span>我方 <b>${state.players.filter(p => p.seat % 2 === 0 && !p.finished).reduce((n, p) => n + p.hand.length, 0)}</b>张</span><em>VS</em><span>对方 <b>${state.players.filter(p => p.seat % 2 === 1 && !p.finished).reduce((n, p) => n + p.hand.length, 0)}</b>张</span></div></div><div class="arena-hud" role="status"><div class="hud-icon">${status.handoff ? '接' : status.phase === 'reply' ? '压' : '领'}</div><div><strong>${escapeHtml(status.label)}</strong><small>${status.phase === 'reply' ? `最大方 ${names[status.owner]} · 已响应 ${status.responses}/${status.required} · 下一位 ${names[status.next]}` : status.phase === 'lead' ? `牌权：${names[status.owner]} · 本圈第 ${state.trickNo} 圈` : escapeHtml(singleDealSummary(state))}</small></div><div class="hud-progress" aria-label="本圈响应进度">${status.phase === 'reply' ? Array.from({ length: status.required }, (_, i) => `<i class="${i < status.responses ? 'done' : ''}"></i>`).join('') : ''}</div></div><div class="ai-toolbar" role="group" aria-label="AI 决策来源"><span>AI 决策来源</span>${mobileApp ? '<a class="mobile-hand-link" href="#hand-panel">下滑选牌 ↓</a>' : ''}<button type="button" data-action="ai-local" class="tool-chip ${aiMode === 'local' ? 'on' : ''}" aria-pressed="${aiMode === 'local'}">完全离线</button>${mobileApp ? '' : `<button type="button" data-action="ai-loopback" class="tool-chip ${aiMode === 'loopback' ? 'on' : ''}" aria-pressed="${aiMode === 'loopback'}">本机接口（可选）</button>`}<small>${escapeHtml(aiStatus)}</small></div>
  ${warning ? `<div class="notice warning">${escapeHtml(warning)}</div>` : ''}${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
  <div class="table"><div class="north">${playerBadge(state,2)}</div><div class="west">${playerBadge(state,3)}</div><div class="east">${playerBadge(state,1)}</div><div class="center"><span class="center-overline">${state.phase === 'finished' ? '本副牌已结束' : last ? `当前最大方 · ${names[last.seat]}` : `${status.handoff ? '搭档接风' : '新一圈'} · ${names[state.turn]}领出`}</span>${last ? `<strong>${comboName(last.combo)}</strong><div class="played-cards">${lastCards}</div>` : `<strong>${status.handoff ? '搭档接风' : '自由领出'}</strong><p>${names[state.turn]}拥有牌权 · 绿色边框标明行动位</p>`}</div><div class="south">${playerBadge(state,0)}</div></div>
  <div class="hand-panel" id="hand-panel"><div class="panel-heading"><div><span class="eyebrow">YOUR HAND</span><h2>我的手牌 <small>${myHand.length} 张</small></h2></div><span class="muted">${inspecting ? '历史局面' : myTurn ? '轮到你' : latest.phase === 'finished' ? '本局结束' : 'AI 正在思考'}</span></div><div class="hand-tools"><div class="order-controls" role="group" aria-label="理牌方式"><button data-action="order-combo" class="tool-chip combo-sort ${handOrder === 'combo' ? 'on' : ''}" aria-label="一键按牌型理牌，重新整理整手牌">一键按牌型理牌</button><button data-action="order-rank" class="tool-chip ${handOrder === 'rank' ? 'on' : ''}" aria-pressed="${handOrder === 'rank'}">一键理牌 · 点数</button><button data-action="order-suit" class="tool-chip ${handOrder === 'suit' ? 'on' : ''}" aria-pressed="${handOrder === 'suit'}">一键理牌 · 花色</button><button data-action="order-manual" class="tool-chip ${manualEditing ? 'on' : ''}" aria-pressed="${manualEditing}" ${inspecting ? 'disabled' : ''}>${manualEditing ? '完成理牌' : '手动理牌'}</button></div><div class="hand-tool-end"><button class="tool-chip" data-action="quick-moves" aria-expanded="${quickMovesOpen}" ${myTurn && !manualEditing ? '' : 'disabled'}>基础牌型候选</button><button class="tool-chip pull-button ${pulled ? 'on' : ''}" data-action="pull-flush" aria-expanded="${flushMenuOpen}" ${flushes.length && !manualEditing ? '' : 'disabled'}>拔同花顺 ${flushes.length ? `(${flushes.length})` : ''}</button></div></div>${quickMovesOpen && myTurn ? `<div class="quick-options"><span class="flush-caption">规则引擎验证的部分可出牌型，仅供快速选牌；并非全部合法出法，也不是最优解。</span>${quickMoves.map((move, index) => { const cards = move.map(id => latest.players[0].hand.find(c => c.id === id)!); const combo = parseCombo(cards, latest.level)!; return `<button class="quick-option" data-quick="${index}"><strong>${escapeHtml(comboName(combo))}</strong><span>${escapeHtml(cards.map(cardLabel).join(' '))}</span></button>`; }).join('') || '<span class="muted">当前没有可出的基础候选；可自行选牌。</span>'}</div>` : ''}${flushMenuOpen ? `<div class="flush-options"><div class="flush-caption">左侧只列真实手牌；括号内注明逢人配替代的点数。点击以提到最前并选中。${inspecting ? '历史局面只展示，不可出牌。' : ''}</div>${flushes.length ? flushes.map((option, index) => `<button class="flush-option" data-flush="${index}"><span class="flush-suit suit-text-${option.suit}">${SUIT_LABEL[option.suit]}</span><span>${escapeHtml(option.label)}</span><small>${option.playable ? '牌型可出' : '压不过当前牌'}</small></button>`).join('') : '<span class="muted">当前没有可组成的同花顺</span>'}</div>` : ''}${handMarkup(state, handOrder, pulled, myTurn)}${pulled ? `<p class="pull-status">已拔出：${escapeHtml(pulled.label)} · ${pulled.playable ? '牌型可出' : '压不过当前牌'}${inspecting ? ' · 回放仅展示' : ''}</p>` : ''}<div class="selection-info" aria-live="polite">${escapeHtml(info.text)}</div>${declarationMarkup}<div class="actions"><button class="button-primary" data-action="play" ${myTurn && !manualEditing && info.valid ? '' : 'disabled'}>出牌</button><button class="button-secondary" data-action="pass" ${myTurn && !manualEditing && latest.lastPlay ? '' : 'disabled'}>过牌</button><button class="button-secondary" data-action="hint" ${myTurn && !manualEditing ? '' : 'disabled'}>提示</button><button class="button-secondary" data-action="clear" ${selected.size && myTurn ? '' : 'disabled'}>清除选择</button>${!inspecting && latest.phase === 'finished' ? '<button class="button-primary" data-action="next">再来一局（随机级牌）</button>' : ''}</div></div>
  ${state.phase === 'finished' ? `<div class="result"><span class="eyebrow">RESULT</span><strong>${escapeHtml(singleDealSummary(state))}</strong></div>` : ''}</section>
  <aside class="sidebar" id="replay"><div class="side-section"><span class="eyebrow">REPLAY</span><h2>对局回放</h2><p class="muted">已记录 ${frames.length} 个局面。可回看每一步自己当时的手牌与公开出牌。</p><div class="timeline"><button data-action="first" ${cursor === 0 ? 'disabled' : ''}>|‹</button><button data-action="prev" ${cursor === 0 ? 'disabled' : ''}>‹</button><span>${cursor + 1} / ${frames.length}</span><button data-action="forward" ${cursor === frames.length - 1 ? 'disabled' : ''}>›</button><button data-action="live" ${!inspecting ? 'disabled' : ''}>实时</button></div><input type="range" aria-label="回放进度" min="0" max="${frames.length - 1}" value="${cursor}" id="scrub" /><div class="step-label">${escapeHtml(frames[cursor].label)}</div>${inspecting ? '<button class="return-live" data-action="live">返回实时对局</button>' : ''}</div><div class="side-section events"><span class="eyebrow">PUBLIC RECORD</span><h2>最近行动</h2><ol>${historyRows(state)}</ol></div><div class="side-section research"><span class="eyebrow">EXPERIMENTAL ANALYSIS</span><h2>候选模拟</h2>${analysisPanel(cursor)}<p>“提示”采用本地结构策略；在固定种子对战中优于原启发式 AI，但尚非最优解。每一步动态胜率曲线尚未实现；当前仅支持选定决策点的概率粗估。</p><small>${mobileApp ? '手机独立版始终完全离线，不连接本机接口。搜索策略尚未通过手机性能验证，当前使用已冻结的结构策略。' : '默认完全离线；启用本机接口后只向 127.0.0.1 发送当前行动者可见信息及合法候选，不发送存档、种子或对手手牌；服务不可用将回退本地策略。'}</small></div></aside></main><footer>规则与基础 AI 复用 GuanDan Lab（Apache-2.0）；本地入口已修改。该版本用于规则和交互验证，不保证高手棋力。</footer></div>`;
  const handViewport = document.querySelector<HTMLDivElement>('.hand');
  if (handViewport) handViewport.scrollLeft = handScroll;
  const extractedViewport = document.querySelector<HTMLDivElement>('.extracted-cards');
  if (extractedViewport) extractedViewport.scrollLeft = extractedScroll;
  const focusTarget = focused?.card ? Array.from(app.querySelectorAll<HTMLButtonElement>('button[data-card]')).find(button => button.dataset.card === focused.card)
    : focused?.action ? Array.from(app.querySelectorAll<HTMLButtonElement>('button[data-action]')).find(button => button.dataset.action === focused.action) : undefined;
  if (focusTarget && !focusTarget.disabled) focusTarget.focus({ preventScroll: true });
  document.querySelector<HTMLInputElement>('#scrub')!.addEventListener('input', e => { if (pendingAnalysis) stopAnalysis(); hintRevision++; replay = Number((e.target as HTMLInputElement).value); manualEditing = false; arrangingCard = null; selected.clear(); selectedDeclaration = null; pulledKey = null; flushMenuOpen = false; quickMovesOpen = false; render(); scheduleAi(); });
  document.querySelector<HTMLInputElement>('#import-file')!.addEventListener('change', async e => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw new Error('存档不能超过 2 MB');
      const restored = JSON.parse(await file.text()) as Session;
      const tested = rebuild(restored);
      if (!confirm('导入后将覆盖当前本地对局。要继续吗？')) { frames = rebuild(session); render(); return; }
      if (aiTimer) clearTimeout(aiTimer);
      aiRevision++; hintRevision++;
      stopAnalysis(); analysisCache.clear(); handLayoutCache.clear();
      session = restored; frames = tested; replay = -1; manualEditing = false; arrangingCard = null; selected.clear(); selectedDeclaration = null; pulledKey = null; flushMenuOpen = false; quickMovesOpen = false; error = ''; warning = ''; persist(); render(); scheduleAi();
    } catch (cause) { frames = rebuild(session); error = cause instanceof Error ? cause.message : '导入失败'; render(); }
  });
}
function stopAnalysis(): void {
  if (analysisTimer) clearTimeout(analysisTimer);
  analysisTimer = undefined;
  pendingAnalysis = false;
  analyzedSamples = 0;
  analysisResult = null;
  analysisIndex = -1;
}
function startAnalysis(cursor: number): void {
  if (pendingAnalysis) return;
  const state = frames[cursor].state;
  if (state.phase !== 'playing' || state.turn !== 0) return;
  let original: string[] | null | undefined;
  let originalDeclared: ComboDeclaration | undefined;
  const next = frames[cursor + 1];
  if (next && next.round === frames[cursor].round) {
    const events = next.state.events.slice(state.events.length);
    const action = events.find(e => (e.type === 'play' || e.type === 'pass') && e.seat === 0);
    if (action) {
      original = action.type === 'pass' ? null : action.cardIds ?? [];
      const recorded = session.deals[0].actions[cursor];
      if (recorded?.kind === 'play' && recorded.seat === 0) originalDeclared = recorded.declared;
    }
  }
  try {
    const view = project(state);
    const options = candidates(view, original, originalDeclared);
    const runner = createAnalysisRunner(view, options, ANALYSIS_SAMPLES, 73691 + cursor * 83);
    pendingAnalysis = true; analysisIndex = cursor; analyzedSamples = 0; error = ''; render();
    const step = () => {
      if (!pendingAnalysis || analysisIndex !== cursor) return;
      try {
        runner.step(); analyzedSamples = runner.completed;
        if (runner.completed === ANALYSIS_SAMPLES) {
          const result = runner.result();
          analysisCache.set(cursor, result); analysisResult = result;
          pendingAnalysis = false; analysisTimer = undefined; render();
        } else {
          if (runner.completed % 4 === 0) render();
          analysisTimer = setTimeout(step, 0);
        }
      } catch (cause) {
        error = `分析失败：${cause instanceof Error ? cause.message : '未知错误'}`;
        pendingAnalysis = false; analysisTimer = undefined; render();
      }
    };
    analysisTimer = setTimeout(step, 30);
  } catch (cause) { error = `分析失败：${cause instanceof Error ? cause.message : '未知错误'}`; pendingAnalysis = false; render(); }
}
function commit(action: Action): void {
  if (replay >= 0) return;
  const latest = current();
  if (session.deals[0].actions.length >= MAX_ACTIONS) throw new Error('单局动作已达到存档上限，请导出存档后新开单局');
  const next = action.kind === 'play' ? playCards(latest, action.seat, action.cards, action.declared) : passTurn(latest, action.seat);
  hintRevision++;
  session.deals[0].actions.push(action);
  frames.push({ state: next, round: next.roundNo, label: `${names[action.seat]}${action.kind === 'pass' ? '过牌' : `出了 ${action.cards.length} 张`}` });
  selected.clear(); selectedDeclaration = null; arrangingCard = null; pulledKey = null; flushMenuOpen = false; quickMovesOpen = false; error = ''; persist(); render(); scheduleAi();
}
function startFreshDeal(): void {
  pendingNew = false;
  if (aiTimer) clearTimeout(aiTimer);
  aiRevision++; hintRevision++;
  stopAnalysis(); analysisCache.clear(); handLayoutCache.clear();
  session = initialSession(); frames = rebuild(session); replay = -1; manualEditing = false;
  selected.clear(); selectedDeclaration = null; arrangingCard = null; pulledKey = null;
  flushMenuOpen = false; quickMovesOpen = false; error = ''; warning = '';
  persist(); render(); scheduleAi();
}
function scheduleAi(): void {
  if (aiTimer) clearTimeout(aiTimer);
  const revision = ++aiRevision;
  const state = current();
  if (replay >= 0 || state.phase !== 'playing' || state.turn === 0) return;
  aiTimer = setTimeout(async () => {
    aiTimer = undefined;
    if (replay >= 0 || current() !== state || revision !== aiRevision) return;
    try {
      const request = buildAiRequest(observe(state, state.turn), 'play', `arena-${revision}`);
      const provider = aiMode === 'loopback' ? loopbackAiProvider() : localAiProvider;
      const result = await decideSafely(request, provider);
      if (revision !== aiRevision || replay >= 0 || current() !== state) return;
      aiStatus = result.fallback && aiMode === 'loopback' ? '本机服务不可用或响应非法，已回退本地策略' : result.source === 'structured-v0.11' ? '完全离线 · 结构策略' : `本机服务 · ${result.source}`;
      commit(aiActionToGame(result.action, state));
    } catch (cause) { if (revision === aiRevision && current() === state) { error = cause instanceof Error ? cause.message : '机器人行动失败'; render(); } }
  }, 170);
}
app.addEventListener('click', e => {
  const button = (e.target as Element).closest<HTMLButtonElement>('button');
  if (!button || button.disabled) return;
  const clickRevision = ++hintRevision;
  const card = button.dataset.card;
  if (card && replay < 0 && manualEditing) {
    const state = current();
    if (arrangingCard && arrangingCard !== card) { saveManual(state, moveManualCard(readManual(state), arrangingCard, card)); arrangingCard = null; }
    else arrangingCard = arrangingCard === card ? null : card;
    render(); return;
  }
  if (card && replay < 0 && current().turn === 0) { selected.has(card) ? selected.delete(card) : selected.add(card); selectedDeclaration = null; render(); return; }
  const action = button.dataset.action;
  try {
    if (button.dataset.declare !== undefined && replay < 0 && current().turn === 0) {
      const option = selectedOptions(current())[Number(button.dataset.declare)];
      if (!option) throw new Error('牌型选择无效');
      selectedDeclaration = { kind: option.kind, mainRank: option.mainRank, secondaryRank: option.secondaryRank };
      render(); return;
    }
    if (action === 'group-selection' && replay < 0 && !manualEditing && selected.size >= 2) {
      const state = current();
      const cards = state.players[0].hand.filter(card => selected.has(card.id));
      if (!parseCombo(cards, state.level)) throw new Error('选中的牌不是合法牌型；请重新选择再理成一组。');
      const layout = handOrder === 'combo' || handOrder === 'manual'
        ? readManual(state) : stackHand(state.players[0].hand, state.level, handOrder).map(stack => stack.cards.map(card => card.id));
      saveManual(state, groupSelectedCards(layout, cards.map(card => card.id)));
      handOrder = 'combo'; selected.clear(); selectedDeclaration = null; arrangingCard = null; pulledKey = null;
      try { localStorage.setItem(HAND_ORDER_KEY, handOrder); } catch { /* 会话内仍然有效 */ }
      render(); return;
    }
    if (action === 'order-combo' && replay < 0) {
      const state = current();
      saveManual(state, groupHandByCombos(state.players[0].hand, state.level));
      handOrder = 'combo'; manualEditing = false; arrangingCard = null; pulledKey = null; flushMenuOpen = false; quickMovesOpen = false;
      try { localStorage.setItem(HAND_ORDER_KEY, handOrder); } catch { /* 会话内仍然有效 */ }
      render(); return;
    }
    if (button.dataset.comboGroup !== undefined && handOrder === 'combo' && !manualEditing && replay < 0 && current().turn === 0) {
      const pulledIds = new Set(findStraightFlushes(current().players[0].hand, current().level, current().lastPlay)
        .find(option => `${option.ids.slice().sort().join('|')}|${option.high}` === pulledKey)?.ids ?? []);
      const group = readManual(current())[Number(button.dataset.comboGroup)]?.filter(id => current().players[0].hand.some(card => card.id === id) && !pulledIds.has(id));
      if (group?.length) {
        const alreadySelected = group.every(id => selected.has(id)) && selected.size === group.length;
        selected = alreadySelected ? new Set() : new Set(group);
        selectedDeclaration = null;
        render();
      }
      return;
    }
    if (action === 'order-rank' || action === 'order-suit') {
      handOrder = action === 'order-rank' ? 'rank' : 'suit'; manualEditing = false; arrangingCard = null; pulledKey = null; flushMenuOpen = false; quickMovesOpen = false;
      try { localStorage.setItem(HAND_ORDER_KEY, handOrder); } catch { /* 会话内仍然有效 */ }
      render(); return;
    }
    if (action === 'order-manual' && replay < 0) {
      if (manualEditing) { manualEditing = false; arrangingCard = null; }
      else {
        if (handOrder === 'rank' || handOrder === 'suit') {
          const state = current();
          const initial = stackHand(state.players[0].hand, state.level, handOrder).map(stack => stack.cards.map(card => card.id));
          saveManual(state, initial);
          handOrder = 'manual';
        }
        manualEditing = true; arrangingCard = null; pulledKey = null; flushMenuOpen = false; quickMovesOpen = false;
      }
      try { localStorage.setItem(HAND_ORDER_KEY, handOrder); } catch { /* 会话内仍然有效 */ }
      render(); return;
    }
    if (action === 'manual-new' && manualEditing && arrangingCard && replay < 0) {
      const state = current(); saveManual(state, moveManualCard(readManual(state), arrangingCard, null)); arrangingCard = null; render(); return;
    }
    if (action === 'manual-cancel' && manualEditing) { arrangingCard = null; render(); return; }
    if (button.dataset.manualColumn !== undefined && manualEditing && replay < 0) {
      const state = current();
      const index = Number(button.dataset.manualColumn), direction = Number(button.dataset.direction);
      if (Number.isInteger(index) && (direction === -1 || direction === 1)) saveManual(state, moveManualColumn(readManual(state), index, direction));
      render(); return;
    }
    if (action === 'pull-flush') { flushMenuOpen = !flushMenuOpen; quickMovesOpen = false; render(); return; }
    if (action === 'quick-moves') { quickMovesOpen = !quickMovesOpen; flushMenuOpen = false; render(); return; }
    if (button.dataset.quick !== undefined) {
      const move = quickOptions(current())[Number(button.dataset.quick)];
      if (move && replay < 0) { selected = new Set(move); selectedDeclaration = null; quickMovesOpen = false; render(); }
      return;
    }
    if (button.dataset.flush !== undefined) {
      const index = Number(button.dataset.flush);
      const state = shown();
      const options = findStraightFlushes(state.players[0].hand, state.level, state.lastPlay);
      if (!Number.isInteger(index) || !options[index]) return;
      const option = options[index]; pulledKey = `${option.ids.slice().sort().join('|')}|${option.high}`; flushMenuOpen = false;
      if (replay < 0 && state.turn === 0 && state.phase === 'playing') {
        selected = new Set(option.ids);
        selectedDeclaration = selectedOptions(state).length > 1 ? option.declaration : null;
      }
      render(); return;
    }
    if (action === 'export') {
      if (mobileApp) {
        const text = JSON.stringify(session);
        const file = new File([text], `guandan-session-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
        void (async () => {
          try {
            if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: '掼蛋对局存档' }); return; }
            await navigator.clipboard.writeText(text);
            warning = '当前设备不支持文件分享，已将存档复制到剪贴板；请粘贴到安全位置保存。'; render();
          } catch (cause) {
            if (cause instanceof Error && cause.name === 'AbortError') return;
            error = '无法分享或复制存档，请检查系统文件分享与剪贴板权限。'; render();
          }
        })();
        return;
      }
      const blob = new Blob([JSON.stringify(session)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = `guandan-session-${new Date().toISOString().slice(0, 10)}.json`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    if (action === 'import') { document.querySelector<HTMLInputElement>('#import-file')?.click(); return; }
    if (action === 'ai-local' || (action === 'ai-loopback' && !mobileApp)) {
      aiMode = action === 'ai-local' ? 'local' : 'loopback';
      aiStatus = aiMode === 'local' ? '完全离线 · 不使用网络' : '本机接口 127.0.0.1:17364 · 不可用时自动回退';
      try { localStorage.setItem(AI_MODE_KEY, aiMode); } catch { /* 当前会话仍有效 */ }
      error = ''; scheduleAi(); render(); return;
    }
    if (action === 'new') {
      if (mobileApp) { if (confirm('新开单局会覆盖当前存档，建议先导出。确定继续吗？')) startFreshDeal(); return; }
      if (!pendingNew) { pendingNew = true; error = '再次点击“新开单局”将覆盖当前单局存档；可先导出保存。'; render(); return; }
      startFreshDeal(); return;
    }
    pendingNew = false;
    if (action === 'analyze') { startAnalysis(replay < 0 ? frames.length - 1 : replay); return; }
    if (action === 'play') { const cards = [...selected]; if (selectedOptions(current()).length > 1 && !selectedDeclaration) throw new Error('请先声明逢人配牌型'); const declared = selectedDeclaration ?? undefined; const check = legalPlay(current(), 0, cards, declared); if (!check.ok) throw new Error(check.reason); commit({ kind: 'play', seat: 0, cards, declared }); }
    else if (action === 'pass') commit({ kind: 'pass', seat: 0 });
    else if (action === 'hint') {
      const state = current();
      if (state.phase !== 'playing' || state.turn !== 0 || replay >= 0) return;
      const request = buildAiRequest(observe(state, 0), 'hint', `hint-${clickRevision}`);
      error = '正在生成建议…'; render();
      void decideSafely(request, aiMode === 'loopback' ? loopbackAiProvider() : localAiProvider).then(result => {
        if (hintRevision !== clickRevision || replay >= 0 || current() !== state) return;
        selected = new Set(result.action.cards ?? []);
        selectedDeclaration = result.action.declared ?? null;
        aiStatus = result.fallback && aiMode === 'loopback' ? '本机服务不可用或响应非法，已回退本地策略' : `建议来源 · ${result.source}`;
        error = result.action.cards ? '已选中 AI 建议：请确认牌型后自行决定是否出牌；这不是唯一最优解。' : 'AI 建议过牌；你仍可自行出牌。';
        render();
      }).catch(cause => { if (hintRevision === clickRevision) { error = cause instanceof Error ? cause.message : '提示失败'; render(); } });
    }
    else if (action === 'clear') { selected.clear(); selectedDeclaration = null; error = ''; render(); }
    else if (action === 'next' && current().phase === 'finished') startFreshDeal();
    else if (['first', 'prev', 'forward', 'live'].includes(action || '')) {
      const cursor = replay < 0 ? frames.length - 1 : replay;
      replay = action === 'live' ? -1 : action === 'first' ? 0 : action === 'prev' ? Math.max(0, cursor - 1) : Math.min(frames.length - 1, cursor + 1);
      if (replay === frames.length - 1) replay = -1;
      manualEditing = false; arrangingCard = null;
      if (pendingAnalysis) stopAnalysis();
      selected.clear(); selectedDeclaration = null; arrangingCard = null; pulledKey = null; flushMenuOpen = false; quickMovesOpen = false; render(); scheduleAi();
    }
  } catch (cause) { error = cause instanceof Error ? cause.message : '操作失败'; render(); }
});

try { const saved = localStorage.getItem(HAND_ORDER_KEY); handOrder = saved === 'suit' || saved === 'manual' || saved === 'combo' ? saved : 'rank'; } catch { handOrder = 'rank'; }
try { aiMode = !mobileApp && localStorage.getItem(AI_MODE_KEY) === 'loopback' ? 'loopback' : 'local'; } catch { aiMode = 'local'; }
aiStatus = aiMode === 'loopback' ? '本机接口 127.0.0.1:17364 · 不可用时自动回退' : '完全离线 · 不使用网络';
session = load();
render();
scheduleAi();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => { /* 本地服务不可用时仍可在线程中继续对局。 */ }); });
}
