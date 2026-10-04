import { legalMoves, observe, type Observation } from '../lib/game/ai';
import { rankPower, shuffle } from '../lib/game/cards';
import { legalPlay, playCards, passTurn, upgradeSteps } from '../lib/game/engine';
import { parseCombo } from '../lib/game/rules';
import type { GameState, Seat } from '../lib/game/types';
import { actionKey, buildAiRequest, validAiAction, type AiAction } from './ai-gateway';
import { countOutsideCards } from './card-memory';
import { chooseStructuredMove } from './strong-ai';

export interface SearchOptions { samples:number;maxCandidates:number;maxTotalCards:number;maxHand:number;seed:number;minGain:number }
export const defaultSearchOptions:SearchOptions={samples:12,maxCandidates:4,maxTotalCards:48,maxHand:12,seed:917539,minGain:0.05};
export interface SearchResult { action:AiAction;baseline:AiAction;searched:boolean;changed:boolean;candidates:AiAction[];outcomes:number[][];gain:number;sampleCount:number }

/** Reconstruct only public state. A pass records a choice, not proof that a seat lacks a counter. */
export function sampleSearchState(o:Observation,seed:number):GameState {
 const memory=countOutsideCards(o);
 if(o.turn!==o.seat||!o.hand.length||!Number.isSafeInteger(seed))throw new Error('采样回合无效');
 const outside=shuffle(memory.outside,seed);
 const finishOrder=o.events.filter(e=>e.type==='finish').map(e=>e.seat!);
 if(finishOrder.some(s=>s===undefined)||new Set(finishOrder).size!==finishOrder.length||
  o.counts.some((n,s)=>(n===0)!==finishOrder.includes(s as Seat)))throw new Error('公开出完记录不一致');
 let passes=0;
 if(o.lastPlay)for(let i=o.events.length-1;i>=0;i--){
  const event=o.events[i];if(event.type==='play'||event.type==='trick')break;
  if(event.type==='pass')passes++;
 }
 let offset=0;
 const players=([0,1,2,3] as Seat[]).map(seat=>({seat,name:String(seat),
  role:(['you','boss','partner','opponent'] as const)[seat],
  hand:seat===o.seat?o.hand.map(c=>({...c})):outside.slice(offset,offset+=o.counts[seat]),
  finished:finishOrder.includes(seat)?finishOrder.indexOf(seat)+1:undefined}));
 return {schemaVersion:2,ruleVersion:'竞技掼蛋2022-教学版',seed:0,createdAt:0,level:o.level,levelOwner:null,
  phase:'playing',players,turn:o.turn,leader:o.lastPlay?.seat??o.turn,
  lastPlay:o.lastPlay?{...o.lastPlay,cardIds:[...o.lastPlay.cardIds],combo:{...o.lastPlay.combo,
   cards:o.lastPlay.combo.cards.map(c=>({...c})),wildIds:[...o.lastPlay.combo.wildIds]}}:null,
  passes,finishOrder,events:o.events.map(e=>({...e,cardIds:e.cardIds?[...e.cardIds]:undefined})),
  trickNo:0,roundNo:1,teamLevels:[o.level,o.level],matchWinner:null};
}

/** Scores only shortlist quality, never interprets the outside pool as known owners. */
function shortlist(o:Observation,baseline:AiAction,maximum:number,candidateBudget=512,proposals:AiAction[]=[]):AiAction[] {
 const request=buildAiRequest(o,'play','sampling-search',candidateBudget),byId=new Map(o.hand.map(c=>[c.id,c]));
 const before=new Map<number,number>(o.hand.map(c=>[c.rank,o.hand.filter(x=>x.rank===c.rank).length]));
 const score=(a:AiAction)=>{
  if(!a.cards)return 0;
  const ids=new Set(a.cards),cards=a.cards.map(id=>byId.get(id)!);
  const remaining=o.hand.filter(c=>!ids.has(c.id)),counts=new Map<number,number>();
  for(const c of remaining)counts.set(c.rank,(counts.get(c.rank)??0)+1);
  let singles=0,broken=0;
  for(const [rank,n] of counts){if(n===1&&rank<=14&&rank!==o.level)singles++;if(n===1&&before.get(rank)!>=2)broken++;}
  const combo=parseCombo(cards,o.level,a.declared)!;
  const bomb=['bomb','straightFlush','jokerBomb'].includes(combo.kind);
  return -4.5*cards.length+4*singles+6*broken+
   cards.filter(c=>c.suit==='H'&&c.rank===o.level).length*(o.hand.length>8?6:1)+
   cards.reduce((s,c)=>s+Math.max(0,rankPower(c.rank,o.level)-10),0)*(o.hand.length>8?0.6:0.15)+
   (bomb&&cards.length!==o.hand.length?15:0)-Number(cards.length===o.hand.length)*1000+combo.mainRank*0.04;
 };
 // Duplicate copies with the same printed suit/rank and declaration have equivalent continuations.
 const signature=(a:AiAction)=>a.cards===null?'pass':a.cards.map(id=>{const c=byId.get(id)!;return c.suit+'-'+c.rank;}).sort().join('|')+'#'+JSON.stringify(a.declared??null);
 const result=[baseline],seen=new Set([signature(baseline)]);
 const ordered=request.actions.filter(a=>a.cards!==null).sort((a,b)=>score(a)-score(b)||actionKey(a).localeCompare(actionKey(b),'en'));
 const add=(a:AiAction)=>{const key=signature(a);if(!seen.has(key)&&result.length<maximum){seen.add(key);result.push(a);}};
 // Preserve the option to wait rather than spend control cards on an opponent.
 if(o.lastPlay)add({cards:null});
 add({cards:chooseStructuredMove(o)});
 const offered=new Set(request.actions.map(actionKey));
 for(const a of proposals)if(offered.has(actionKey(a)))add(a);
 for(const a of ordered)add(a);
 return result;
}

function continueToHead(sample:GameState,action:AiAction,seat:Seat,objective:'head'|'match'='head'):number|null {
 let state=action.cards===null?passTurn(sample,seat):playCards(sample,seat,action.cards,action.declared);
 for(let step=0;(objective==='match'||state.finishOrder.length===0)&&state.phase==='playing'&&step<(objective==='head'?240:350);step++){
  const active=state.turn,o=observe(state,active),ids=chooseStructuredMove(o);
  if(ids)state=playCards(state,active,ids);
  else if(state.lastPlay)state=passTurn(state,active);
  else {const fallback=legalMoves(o)[0];if(!fallback)return null;state=playCards(state,active,fallback);}
 }
 if(!state.finishOrder.length||(objective==='match'&&state.phase!=='finished'))return null;
 const won=state.finishOrder[0]%2===seat%2;
 return objective==='head'?Number(won):Number(won)+0.5*(won?1:-1)*upgradeSteps(state.finishOrder)/3;
}

function visibleSalt(o:Observation):number {
 let salt=2166136261;
 const value=o.hand.map(c=>c.id).sort().join('|')+'#'+o.events.filter(e=>e.type==='play'||e.type==='pass').map(e=>e.type+e.seat+(e.cardIds??[]).join(',')).join('|');
 for(let i=0;i<value.length;i++){salt^=value.charCodeAt(i);salt=Math.imul(salt,16777619);}
 return salt>>>0;
}

/** Fixed common random samples; conservative paired improvement required to override the frozen policy. */
export function decideSearch(o:Observation,overrides:Partial<SearchOptions>={}):SearchResult {
 return decideSearchWithBaseline(o,{cards:chooseStructuredMove(o)},overrides);
}

/** Experimental neural-policy critic. Full-match utility includes upgrade without known hidden owners. */
export function decideSearchWithBaseline(o:Observation,baseline:AiAction,overrides:Partial<SearchOptions>={},objective:'head'|'match'='head',candidateBudget=512,proposals:AiAction[]=[]):SearchResult {
 const config={...defaultSearchOptions,...overrides};
 if(!Number.isInteger(config.samples)||config.samples<2||config.samples>128||!Number.isInteger(config.maxCandidates)||config.maxCandidates<2||config.maxCandidates>8||
  !Number.isInteger(config.maxTotalCards)||config.maxTotalCards<1||config.maxTotalCards>108||!Number.isInteger(config.maxHand)||config.maxHand<1||config.maxHand>27||
  !Number.isSafeInteger(config.seed)||!Number.isFinite(config.minGain)||config.minGain<0||config.minGain>1)throw new Error('搜索预算无效');
 if(!['head','match'].includes(objective)||![256,512].includes(candidateBudget)||!validAiAction(o,baseline))throw new Error('搜索基准动作无效');
 if(!Array.isArray(proposals)||proposals.length>8||proposals.some(a=>!validAiAction(o,a)))throw new Error('搜索建议动作无效');
 const fallback:SearchResult={action:baseline,baseline,searched:false,changed:false,candidates:[baseline],outcomes:[],gain:0,sampleCount:0};
 if(o.hand.length>config.maxHand||o.counts.reduce((s,n)=>s+n,0)>config.maxTotalCards||o.counts.some(n=>n===0)||
  baseline.cards?.length===o.hand.length||o.lastPlay?.seat===(o.seat+2)%4)return fallback;
 const options=shortlist(o,baseline,config.maxCandidates,candidateBudget,proposals);
 if(options.length<2)return fallback;
 const outcomes:number[][]=options.map(()=>[]),salt=visibleSalt(o);
 for(let i=0;i<config.samples;i++){
  const sample=sampleSearchState(o,(config.seed+salt+i*7919)>>>0);
  const row=options.map(a=>continueToHead(sample,a,o.seat,objective));
  // Exclude failed samples for all candidates, preserving pairing.
  if(row.some(x=>x===null))continue;
  row.forEach((x,j)=>outcomes[j].push(x!));
 }
 const n=outcomes[0].length;
 let selected=0,bestGain=0;
 if(n>=8)for(let j=1;j<options.length;j++){
  const differences=outcomes[j].map((x,i)=>x-outcomes[0][i]);
  const gain=differences.reduce((s,x)=>s+x,0)/n;
  const variance=differences.reduce((s,x)=>s+(x-gain)**2,0)/(n-1);
  // A selection heuristic, not a confidence statement about the actual game's win probability.
  if(gain>bestGain&&gain>config.minGain+1.28*Math.sqrt(variance/n)){selected=j;bestGain=gain;}
 }
 return {action:options[selected],baseline,searched:true,changed:selected!==0,candidates:options,outcomes,gain:bestGain,sampleCount:n};
}

/** Rich provider keeps explicit wildcard declarations through the authoritative engine. */
export const searchAiProvider={id:'visible-sampling-search-v1',async decide(request:ReturnType<typeof buildAiRequest>){
 const view=request.view,seat=view.seat;
 const o:Observation={...view,role:(['you','boss','partner','opponent'] as const)[seat],persona:(['learner','control','partnerFirst','tempo'] as const)[seat]};
 // Search only actions exposed by the same 256-action budget as the live gateway.
 // Otherwise an expensive 512-action search can select an unavailable action and silently fall back.
 const selected=decideSearchWithBaseline(o,{cards:chooseStructuredMove(o)}, {}, 'head', 256).action;
 const action=request.actions.find(a=>actionKey(a)===actionKey(selected));
 if(!action)throw new Error('搜索动作不在本次请求的合法候选内');
 return {version:1 as const,requestId:request.requestId,provider:this.id,action};
}};
