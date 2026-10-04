import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { observe } from '../lib/game/ai';
import { newGame, legalPlay, playCards, passTurn, upgradeSteps } from '../lib/game/engine';
import type { Rank, Seat } from '../lib/game/types';
import { buildAiRequest, actionKey, type AiAction } from './ai-gateway';
import { chooseStructuredMove } from './strong-ai';
import { assertPhysicalCardConservation } from './selfplay';
import { encodeActions, featureNames, validateModel, scoreFeatures, type NeuralModel } from './neural-policy';

export interface TrainingRow {schema:1;dealId:string;seat:Seat;features:number[][];teacher:number;chosen:number;logProbability:number;reward:number}
function rng(seed:number):()=>number {let a=seed>>>0;return ()=>{a+=0x6D2B79F5;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};}
function pick(scores:number[],temperature:number,random:()=>number):{index:number;logProbability:number} {
 if(temperature===0)return {index:scores.indexOf(Math.max(...scores)),logProbability:0};
 const maximum=Math.max(...scores),weights=scores.map(s=>Math.exp((s-maximum)/temperature));
 const sum=weights.reduce((a,b)=>a+b,0);let draw=random()*sum,index=weights.length-1;
 for(let i=0;i<weights.length;i++){draw-=weights[i];if(draw<=0){index=i;break;}}
 return {index,logProbability:Math.log(weights[index]/sum)};
}

/** Rules stay in the original engine; only the acting seat's encoded view crosses into training. */
export function cloudDeal(seed:number,recordedSeat:Seat,model?:NeuralModel,temperature=0.8,challengerParity?:0|1,recordSeats:1|4=1) {
 if(!Number.isSafeInteger(seed)||![0,1,2,3].includes(recordedSeat)||![1,4].includes(recordSeats)||!Number.isFinite(temperature)||temperature<0||temperature>5)throw new Error('副牌参数无效');
 const random=rng(seed^0x4f1bbcdc),dealId=randomUUID();
 let state=newGame(seed,(2+((seed>>>0)%13)) as Rank),steps=0;
 const rows:TrainingRow[]=[],latencies:number[]=[];
 assertPhysicalCardConservation(state);
 while(state.phase==='playing'&&steps<350){
  const seat=state.turn,o=observe(state,seat),useModel=!!model&&(challengerParity===undefined||seat%2===challengerParity);
  const started=performance.now();
  let action:AiAction;
  // During evaluation do not generate training data or inspect the teacher at model seats beyond candidate generation.
  if(useModel||challengerParity===undefined&&(recordSeats===4||seat===recordedSeat)){
   const request=buildAiRequest(o,'play','cloud-turn');
   const {actions,features}=encodeActions(request);
   const recording=challengerParity===undefined&&(recordSeats===4||seat===recordedSeat);
   const teacher=recording?actions.findIndex(a=>actionKey(a)===actionKey({cards:chooseStructuredMove(o)})):-1;
   if(recording)assert.ok(teacher>=0,'教师动作遗漏');
   const selected=useModel?pick(features.map(x=>scoreFeatures(model!,x)),temperature,random):{index:teacher,logProbability:0};
   action=actions[selected.index];
   if(recording)rows.push({schema:1,dealId,seat,features,teacher,chosen:selected.index,logProbability:selected.logProbability,reward:0});
  }else action={cards:chooseStructuredMove(o)};
  if(useModel)latencies.push(performance.now()-started);
  if(action.cards===null){assert.ok(state.lastPlay,'领出不能过牌');state=passTurn(state,seat);}
  else{assert.ok(legalPlay(state,seat,action.cards,action.declared).ok,'非法动作');state=playCards(state,seat,action.cards,action.declared);}
  assertPhysicalCardConservation(state);steps++;
 }
 assert.equal(state.phase,'finished','超出步数预算');
 assert.deepEqual([...state.finishOrder].sort(),[0,1,2,3]);
 const winnerParity=state.finishOrder[0]%2,upgrade=upgradeSteps(state.finishOrder);
 const reward=(winnerParity===recordedSeat%2?1:-1)*upgrade/3;
 for(const row of rows)row.reward=(row.seat%2===winnerParity?1:-1)*upgrade/3;
 return {rows,steps,winnerParity,upgrade,latencies};
}

/** Hoeffding bound treats each swapped pair as one independent bounded observation. */
export function pairedGate(pairScores:number[]) {
 if(!pairScores.length||pairScores.some(x=>![0,0.5,1].includes(x)))throw new Error('配对分数无效');
 const rate=pairScores.reduce((a,b)=>a+b,0)/pairScores.length;
 const radius=Math.sqrt(Math.log(2/0.05)/(2*pairScores.length));
 return {rate,lower95:Math.max(0,rate-radius),upper95:Math.min(1,rate+radius),
  deployable:pairScores.length>=200&&rate>=0.55&&rate-radius>0.5,
  unit:'independent-deal-pair',interval:'two-sided 95% Hoeffding bound'};
}

export function evaluateCloud(model:NeuralModel,games:number,offset:number){
 const perSeed:unknown[]=[],scores:number[]=[],latencies:number[]=[];let upgradeBalance=0;
 for(let i=0;i<games;i++){
  const seed=7001+(offset+i)*7919;let wins=0;
  const pair=[];
  for(const parity of [0,1] as const){
   const result=cloudDeal(seed,parity,model,0,parity),won=result.winnerParity===parity;
   wins+=Number(won);upgradeBalance+=(won?1:-1)*result.upgrade;latencies.push(...result.latencies);
   pair.push({parity,won,steps:result.steps,upgrade:result.upgrade});
  }
  scores.push(wins/2);perSeed.push({seed,games:pair});
 }
 latencies.sort((a,b)=>a-b);
 return {mode:'neural-vs-frozen-structured-paired',pairs:games,games:games*2,offset,
  wins:scores.reduce((a,b)=>a+b,0)*2,...pairedGate(scores),upgradeBalance,invalidDecisions:0,
  p95Ms:latencies[Math.floor((latencies.length-1)*0.95)],perSeed};
}

if(/(?:^|[\\/])cloud-selfplay\.js$/.test(process.argv[1]??'')){
 const mode=process.argv[2],args=process.argv.slice(3),opt:Record<string,string>={};
 for(let i=0;i<args.length;i+=2){if(!['--games','--offset','--output','--model','--temperature','--record-seats'].includes(args[i])||args[i+1]===undefined)throw new Error('参数无效');opt[args[i]]=args[i+1];}
 const games=Number(opt['--games']??10),offset=Number(opt['--offset']??0),temperature=Number(opt['--temperature']??0.8),recordSeats=Number(opt['--record-seats']??1);
 if(!['generate','evaluate'].includes(mode)||!Number.isSafeInteger(games)||games<1||games>100000||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(7001+(offset+games)*7919)||!opt['--output']||!Number.isFinite(temperature)||temperature<0||temperature>5||![1,4].includes(recordSeats)||(mode==='evaluate'&&opt['--record-seats']!==undefined))throw new Error('用法: cloud-selfplay.js generate|evaluate --games N --offset N --output FILE [--model FILE] [--record-seats 1|4]');
 const model=opt['--model']?validateModel(JSON.parse(fs.readFileSync(opt['--model'],'utf8'))):undefined;
 if(mode==='evaluate'){
  if(!model)throw new Error('评测需要模型');
  const result=evaluateCloud(model,games,offset);fs.writeFileSync(opt['--output'],JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,perSeed:undefined}));
 }else{
  const fd=fs.openSync(opt['--output'],'w');let rows=0;
  try{for(let i=0;i<games;i++){
   const result=cloudDeal(7001+(offset+i)*7919,(i%4) as Seat,model,temperature,undefined,recordSeats as 1|4);
   for(const row of result.rows){fs.writeSync(fd,JSON.stringify(row)+'\n');rows++;}
   if((i+1)%10===0)console.error(JSON.stringify({games:i+1,total:games,rows}));
  }}finally{fs.closeSync(fd);}
  fs.writeFileSync(opt['--output']+'.meta.json',JSON.stringify({schema:1,features:featureNames,games,rows,offset,temperature,policy:model?'neural-selfplay':'teacher',recordSeats,modelPath:opt['--model']??null}));
  console.log(JSON.stringify({games,rows,output:opt['--output']}));
 }
}
