import { createDeck, rankPower } from '../lib/game/cards';
import { parseCombo } from '../lib/game/rules';
import type { Card } from '../lib/game/types';
import { actionKey, validAiAction, type AiRequest, type AiAction } from './ai-gateway';

const ranks = Array.from({length:15},(_,i)=>i+2);
const suits = ['S','H','C','D'];
const kinds = ['single','pair','triple','triplePair','straight','tube','plate','bomb','straightFlush','jokerBomb'];
export const featureNames: string[] = [
 ...['hand','remaining','played','unseen'].flatMap(group=>ranks.map(r=>`${group}.rank${r}`)),
 ...suits.flatMap(s=>Array.from({length:13},(_,i)=>`remaining.${s}${i+2}`)),
 ...Array.from({length:4},(_,i)=>`relativeSeat${i}.count`),
 ...kinds.map(k=>`action.${k}`), ...kinds.map(k=>`last.${k}`),
 'pass','finish','size','mainPower','secondaryPower','wildSpent','powerSpent','remainingSingles','brokenGroups',
 'allyLeads','opponentThreat','freeLead','level','lastSize','lastPower',
 ...Array.from({length:4},(_,i)=>`relativeSeat${i}.recentPass`),
];

/** A shared state/action encoder. No seed, timestamp, ID ordering, outcome or other hands. */
export function encodeActions(request: AiRequest): {actions:AiAction[]; features:number[][]} {
 const {view}=request;
 if (!request.actions.length || request.actions.some(a=>!validAiAction(view,a))) throw new Error('非法候选');
 const actions=[...request.actions].sort((a,b)=>actionKey(a).localeCompare(actionKey(b),'en'));
 const handMap=new Map(view.hand.map(c=>[c.id,c]));
 const deck=createDeck();
 const playedIds=new Set(view.events.filter(e=>e.type==='play').flatMap(e=>e.cardIds??[]));
 const played=deck.filter(c=>playedIds.has(c.id));
 const unseen=deck.filter(c=>!handMap.has(c.id)&&!playedIds.has(c.id));
 const rankCounts=(cards:Card[])=>ranks.map(r=>cards.filter(c=>c.rank===r).length/8);
 const recentPass=new Set<number>();
 for(let i=view.events.length-1;i>=0;i--){
  const e=view.events[i]; if(e.type==='play'||e.type==='trick') break;
  if(e.type==='pass'&&e.seat!==undefined) recentPass.add(e.seat);
 }
 const allyLeads=view.lastPlay?.seat===(view.seat+2)%4;
 const before=new Map(ranks.map(r=>[r,view.hand.filter(c=>c.rank===r).length]));
 const shared=[...rankCounts(played),...rankCounts(unseen)];
 const features=actions.map(action=>{
  const ids=new Set(action.cards??[]), cards=(action.cards??[]).map(id=>handMap.get(id)!);
  const remaining=view.hand.filter(c=>!ids.has(c.id));
  const combo=cards.length?parseCombo(cards,view.level,action.declared)!:null;
  const after=new Map(ranks.map(r=>[r,remaining.filter(c=>c.rank===r).length]));
  return [...rankCounts(view.hand),...rankCounts(remaining),...shared,
   ...suits.flatMap(s=>Array.from({length:13},(_,i)=>remaining.filter(c=>c.suit===s&&c.rank===i+2).length/2)),
   ...Array.from({length:4},(_,i)=>view.counts[(view.seat+i)%4]/27),
   ...kinds.map(k=>Number(combo?.kind===k)),...kinds.map(k=>Number(view.lastPlay?.combo.kind===k)),
   Number(action.cards===null),Number(cards.length===view.hand.length),cards.length/10,
   (combo?.mainRank??0)/20,(combo?.secondaryRank??0)/20,
   cards.filter(c=>c.suit==='H'&&c.rank===view.level).length/2,
   cards.reduce((sum,c)=>sum+Math.max(0,rankPower(c.rank,view.level)-10),0)/50,
   ranks.filter(r=>after.get(r)===1&&r!==view.level&&r<=14).length/13,
   ranks.filter(r=>after.get(r)===1&&before.get(r)!>=2).length/13,
   Number(allyLeads),Number(view.counts.some((n,s)=>s%2!==view.seat%2&&n>0&&n<=3)),
   Number(!view.lastPlay),view.level/14,(view.lastPlay?.cardIds.length??0)/10,(view.lastPlay?.combo.mainRank??0)/20,
   ...Array.from({length:4},(_,i)=>Number(recentPass.has((view.seat+i)%4))),
  ];
 });
 return {actions,features};
}

export interface NeuralModel {version:1;kind:'guandan-action-mlp';features:string[];w1:number[][];b1:number[];w2:number[];b2:number}
export function validateModel(value:unknown):NeuralModel {
 const m=value as NeuralModel;
 if(!m||m.version!==1||m.kind!=='guandan-action-mlp'||JSON.stringify(m.features)!==JSON.stringify(featureNames)||
  !Array.isArray(m.w1)||m.w1.length<1||m.w1.length>256||!Array.isArray(m.b1)||!Array.isArray(m.w2)||
  m.b1.length!==m.w1.length||m.w2.length!==m.w1.length||!Number.isFinite(m.b2)||
  m.w1.some(row=>!Array.isArray(row)||row.length!==featureNames.length||row.some(n=>!Number.isFinite(n)))||
  [...m.b1,...m.w2].some(n=>!Number.isFinite(n))) throw new Error('模型格式或特征版本不匹配');
 return m;
}
export function scoreFeatures(model:NeuralModel,x:number[]):number {
 if(x.length!==featureNames.length||x.some(n=>!Number.isFinite(n))) throw new Error('特征无效');
 let score=model.b2;
 for(let j=0;j<model.w1.length;j++){
  let h=model.b1[j];for(let i=0;i<x.length;i++)h+=model.w1[j][i]*x[i];
  score+=model.w2[j]*Math.tanh(h);
 }
 if(!Number.isFinite(score))throw new Error('模型数值溢出');
 return score;
}
export function selectNeuralAction(model:NeuralModel,request:AiRequest):AiAction {
 const {actions,features}=encodeActions(request);
 let best=0,score=-Infinity;
 features.forEach((x,i)=>{const next=scoreFeatures(model,x);if(next>score){score=next;best=i;}});
 return actions[best];
}
