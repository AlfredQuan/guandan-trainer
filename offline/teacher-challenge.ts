import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { observe, legalMoves, type Observation } from '../lib/game/ai';
import { newGame, legalPlay, passTurn, playCards } from '../lib/game/engine';
import { beats, comboOptions, parseCombo } from '../lib/game/rules';
import type { Seat } from '../lib/game/types';
import { actionKey, buildAiRequest, validAiAction, type AiAction, type AiRequest } from './ai-gateway';
import { benchmarkSeeds } from './ai-benchmark';
import { playSelfplayDeal } from './selfplay';
import { chooseStructuredMove } from './strong-ai';

export interface ChallengeCase { schema: 1; caseId: string; request: AiRequest }
export interface PrivateCase { caseId: string; seed: number; step: number; seat: Seat; baselineKey: string; baselineWon: boolean; audit: CandidateAudit }
export interface CandidateAudit {
  handSize: number; generatedActions: number; offeredActions: number; omittedByCap: number;
  truncated: boolean; exactReferenceActions: number | null; omittedByGenerator: number | null;
  baselineIncluded: boolean;
}
export interface TeacherAnswer { caseId: string; actionKey: string | null; confidence?: number; reason?: string }

/** Measures coverage of the *representative generator*, not all legal physical plays with >8 cards. */
export function auditCandidates(o: Observation, request: AiRequest): CandidateAudit {
  const view = request.view;
  const generated = new Set<string>();
  const add = (action: AiAction) => { if (validAiAction(view, action)) generated.add(actionKey(action)); };
  add({ cards: chooseStructuredMove(o) });
  if (o.lastPlay) add({ cards: null });
  const byId = new Map(view.hand.map(card => [card.id, card]));
  for (const ids of legalMoves(o, 'analysis')) {
    const cards = ids.map(id => byId.get(id)!);
    const defaultCombo = parseCombo(cards, view.level);
    for (const combo of comboOptions(cards, view.level)) {
      if (!beats(combo, view.lastPlay?.combo ?? null)) continue;
      const same = defaultCombo?.kind === combo.kind && defaultCombo.mainRank === combo.mainRank && defaultCombo.secondaryRank === combo.secondaryRank;
      add({ cards: ids, ...(same ? {} : { declared: { kind: combo.kind, mainRank: combo.mainRank, secondaryRank: combo.secondaryRank } }) });
    }
  }
  const offered = new Set(request.actions.map(actionKey));
  assert.ok([...offered].every(key => generated.has(key)), '请求包含候选源以外的动作');
  const baselineIncluded = offered.has(actionKey({ cards: chooseStructuredMove(o) }));
  let exactReferenceActions: number | null = null, omittedByGenerator: number | null = null;
  if (view.hand.length <= 8) {
    const exact = new Set<string>();
    if (o.lastPlay) exact.add('pass');
    for (let mask = 1; mask < (1 << view.hand.length); mask++) {
      const cards = view.hand.filter((_, index) => (mask & (1 << index)) !== 0);
      const defaultCombo = parseCombo(cards, view.level);
      for (const combo of comboOptions(cards, view.level)) {
        if (!beats(combo, view.lastPlay?.combo ?? null)) continue;
        const same = defaultCombo?.kind === combo.kind && defaultCombo.mainRank === combo.mainRank && defaultCombo.secondaryRank === combo.secondaryRank;
        const action: AiAction = { cards: cards.map(card => card.id), ...(same ? {} : { declared: { kind: combo.kind, mainRank: combo.mainRank, secondaryRank: combo.secondaryRank } }) };
        if (validAiAction(view, action)) exact.add(actionKey(action));
      }
    }
    exactReferenceActions = exact.size;
    omittedByGenerator = [...exact].filter(key => !generated.has(key)).length;
  }
  return { handSize: view.hand.length, generatedActions: generated.size, offeredActions: offered.size,
    omittedByCap: [...generated].filter(key => !offered.has(key)).length, truncated: generated.size > offered.size,
    exactReferenceActions, omittedByGenerator, baselineIncluded };
}

function difficulty(row: ReturnType<typeof playSelfplayDeal>[number]): number {
  const { view, actions } = row.request;
  const enemyClose = view.counts.some((n, s) => s % 2 !== view.seat % 2 && n > 0 && n <= 6);
  return (view.hand.length <= 8 ? 6 : 0) + (enemyClose ? 4 : 0)
    + (view.lastPlay?.seat === (view.seat + 2) % 4 ? 2 : 0) + (actions.length > 1 ? 1 : 0);
}

/** One preselected position per independent deal, based only on observations (never on outcomes). */
export function makeChallenge(deals: number, offset: number): { publicCases: ChallengeCase[]; privateCases: PrivateCase[] } {
  const seeds = benchmarkSeeds(deals, offset);
  const publicCases: ChallengeCase[] = [], privateCases: PrivateCase[] = [];
  seeds.forEach((seed, index) => {
    const seat = (index % 4) as Seat;
    // Head-finish ownership is fixed once any seat has emptied its hand; exclude such turns.
    const rows = playSelfplayDeal(seed, seat).filter(row => row.request.actions.length > 1 && row.request.view.counts.every(count => count > 0));
    assert.ok(rows.length, '该副牌没有可比较的局面');
    // Stratify by acting hand size so an endgame-heavy sample cannot masquerade as full-game coverage.
    const band = index % 3;
    const target = rows.filter(row => band === 0 ? row.request.view.hand.length >= 16
      : band === 1 ? row.request.view.hand.length >= 9 && row.request.view.hand.length <= 15
      : row.request.view.hand.length <= 8);
    const pool = target.length ? target : rows;
    const chosen = pool.reduce((best, row) => difficulty(row) > difficulty(best) ? row : best);
    const caseId = randomUUID(); // Neither seed nor outcome enters the teacher-facing ID.
    const original = chosen.request;
    const audit = auditCandidates({ ...original.view, role: (['you', 'boss', 'partner', 'opponent'] as const)[seat],
      persona: (['learner', 'control', 'partnerFirst', 'tempo'] as const)[seat] }, original);
    const actions = [...original.actions].sort((a, b) => {
      const hash = (v: AiAction) => createHash('sha256').update(caseId).update(actionKey(v)).digest('hex');
      return hash(a).localeCompare(hash(b));
    });
    const request: AiRequest = { ...original, requestId: caseId, intent: 'hint', actions };
    assert.ok(!('seed' in request) && !('players' in request.view), '教师请求中出现私有状态');
    publicCases.push({ schema: 1, caseId, request });
    privateCases.push({ caseId, seed, step: chosen.step, seat, baselineKey: chosen.label.teacherActionKey,
      baselineWon: chosen.label.teamHeadWin, audit });
  });
  return { publicCases, privateCases };
}

/** Validate every answer against the exact exported action key, including wildcard declarations. */
export function gradeAnswers(publicCases: ChallengeCase[], privateCases: PrivateCase[], answers: TeacherAnswer[]) {
  assert.equal(publicCases.length, privateCases.length, '公私局面数量不一致');
  const cases = new Map(publicCases.map(c => [c.caseId, c]));
  const privateById = new Map(privateCases.map(c => [c.caseId, c]));
  assert.equal(cases.size, publicCases.length, '局面编号重复');
  assert.equal(privateById.size, privateCases.length, '私有局面编号重复');
  const seen = new Set<string>();
  const checked = answers.map(answer => {
    assert.ok(answer && typeof answer.caseId === 'string' && cases.has(answer.caseId) && !seen.has(answer.caseId), '未知或重复的局面编号');
    seen.add(answer.caseId);
    assert.ok(answer.actionKey === null || typeof answer.actionKey === 'string', '答卷动作键无效');
    assert.ok(answer.confidence === undefined || typeof answer.confidence === 'number' && answer.confidence >= 0 && answer.confidence <= 1, '置信度无效');
    assert.ok(answer.reason === undefined || typeof answer.reason === 'string' && answer.reason.length <= 500, '理由无效');
    const request = cases.get(answer.caseId)!.request;
    const action = answer.actionKey === null ? null : request.actions.find(a => actionKey(a) === answer.actionKey);
    if (answer.actionKey !== null) assert.ok(action && validAiAction(request.view, action), `非法或不在候选内的动作: ${answer.caseId}`);
    const meta = privateById.get(answer.caseId)!;
    assert.ok(meta, '私有局面映射缺失');
    return { caseId: answer.caseId, actionKey: answer.actionKey, abstained: answer.actionKey === null,
      agreesWithBaseline: answer.actionKey === null ? null : answer.actionKey === meta.baselineKey,
      confidence: answer.confidence ?? null };
  });
  return { cases: cases.size, answered: checked.length, abstained: checked.filter(x => x.abstained).length,
    valid: checked.length - checked.filter(x => x.abstained).length,
    baselineAgreement: checked.filter(x => x.agreesWithBaseline).length,
    note: '合法性及一致率不是棋力；没有独立对局之前不能断言教师更强', checked };
}

/** Private, same-deal one-turn intervention; diagnostic only, not an independent strength test. */
export function replayOneIntervention(meta: PrivateCase, action: AiAction): { baselineWon: boolean; changedWon: boolean } {
  let state = newGame(meta.seed), step = 0;
  while (state.phase === 'playing' && step < 350) {
    const o = observe(state, state.turn);
    const baseline = chooseStructuredMove(o);
    let choice: AiAction = { cards: baseline };
    if (step === meta.step) {
      assert.equal(state.turn, meta.seat, '回放座位不一致');
      assert.equal(actionKey(choice), meta.baselineKey, '回放基线动作不一致');
      const request = buildAiRequest(o, 'hint', 'private-replay');
      assert.ok(request.actions.some(a => actionKey(a) === actionKey(action)), '干预动作不在当时的候选集中');
      choice = action;
    }
    if (choice.cards === null) { assert.ok(state.lastPlay, '领出不能过'); state = passTurn(state, state.turn); }
    else { assert.ok(legalPlay(state, state.turn, choice.cards, choice.declared).ok, '回放动作非法'); state = playCards(state, state.turn, choice.cards, choice.declared); }
    step++;
  }
  assert.equal(state.phase, 'finished', '干预对局超过步数上限');
  return { baselineWon: meta.baselineWon, changedWon: state.finishOrder[0] % 2 === meta.seat % 2 };
}

if (/(?:^|[\\/])teacher-challenge\.js$/.test(process.argv[1] ?? '')) {
  const [mode, ...args] = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--deals', '--offset', '--public', '--private', '--answers', '--report'].includes(args[i]) || !args[i + 1]) throw new Error('用法: teacher-challenge.js export --deals N --offset N --public FILE --private FILE | grade --public FILE --private FILE --answers FILE --report FILE');
    opts[args[i]] = args[i + 1];
  }
  if (mode === 'export') {
    if (!opts['--public'] || !opts['--private'] || opts['--public'] === opts['--private']) throw new Error('必须分别指定公开和私有文件');
    const deals = Number(opts['--deals']), offset = Number(opts['--offset']);
    if (!Number.isSafeInteger(deals) || deals < 1 || deals > 500 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('副牌数量或偏移无效');
    const { publicCases, privateCases } = makeChallenge(deals, offset);
    fs.writeFileSync(opts['--public'], publicCases.map(c => JSON.stringify(c)).join('\n') + '\n');
    fs.writeFileSync(opts['--private'], JSON.stringify({ schema: 1, warning: '含可重建暗牌的种子；不得发送给教师', cases: privateCases }, null, 2));
    const audits = privateCases.map(c => c.audit);
    console.log(JSON.stringify({ deals, publicCases: publicCases.length,
      handBands: { early16Plus: audits.filter(a => a.handSize >= 16).length, middle9to15: audits.filter(a => a.handSize >= 9 && a.handSize <= 15).length, end8OrLess: audits.filter(a => a.handSize <= 8).length },
      truncated: audits.filter(a => a.truncated).length,
      exactEndgames: audits.filter(a => a.exactReferenceActions !== null).length,
      exactGeneratorMisses: audits.reduce((n, a) => n + (a.omittedByGenerator ?? 0), 0),
      totalOmittedByCap: audits.reduce((n, a) => n + a.omittedByCap, 0),
      baselineMissing: audits.filter(a => !a.baselineIncluded).length }));
  } else if (mode === 'grade') {
    if (!opts['--public'] || !opts['--private'] || !opts['--answers'] || !opts['--report']) throw new Error('评分需要公开局面、私有映射、答卷、报告路径');
    const readLines = (path: string) => fs.readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const cases = readLines(opts['--public']) as ChallengeCase[];
    const privateCases = (JSON.parse(fs.readFileSync(opts['--private'], 'utf8')) as {cases: PrivateCase[]}).cases;
    const answers = readLines(opts['--answers']) as TeacherAnswer[];
    const result = gradeAnswers(cases, privateCases, answers);
    fs.writeFileSync(opts['--report'], JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ cases: result.cases, answered: result.answered, valid: result.valid, abstained: result.abstained, baselineAgreement: result.baselineAgreement }));
  } else throw new Error('模式只支持 export 或 grade');
}
