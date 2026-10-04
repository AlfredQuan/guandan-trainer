import type { GameState, Seat } from '../lib/game/types';

export interface ArenaStatus {
  phase: 'finished' | 'lead' | 'reply';
  owner: Seat;
  next: Seat;
  responses: number;
  required: number;
  handoff: boolean;
  label: string;
}

/** Presentation-only projection; the engine is the sole authority for turn and handoff. */
export function arenaStatus(state: GameState): ArenaStatus {
  if (state.phase === 'finished') return { phase: 'finished', owner: state.lastPlay?.seat ?? state.leader, next: state.turn, responses: 0, required: 0, handoff: false, label: '本局结束' };
  if (!state.lastPlay) {
    const event = [...state.events].reverse().find(e => e.type === 'trick');
    const handoff = !!event?.note?.includes('接风');
    return { phase: 'lead', owner: state.leader, next: state.turn, responses: 0, required: 0, handoff,
      label: handoff ? '搭档接风 · 自由领出' : '新一圈 · 自由领出' };
  }
  const owner = state.lastPlay.seat;
  const required = state.players.filter(p => !p.finished && p.seat !== owner).length;
  return { phase: 'reply', owner, next: state.turn, responses: state.passes, required,
    handoff: !!state.players[owner].finished,
    label: state.players[owner].finished ? '最后一手待三家响应 · 不能提前接风' : '等待其余玩家响应' };
}
