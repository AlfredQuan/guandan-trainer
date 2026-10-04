import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { observe } from '../lib/game/ai';
import { newGame, legalPlay, playCards, passTurn, upgradeSteps } from '../lib/game/engine';
import type { Rank } from '../lib/game/types';
import { actionKey, buildAiRequest } from './ai-gateway';
import { chooseCardCountingMove, chooseLegacyStructuredMove, chooseStructuredMove } from './strong-ai';
import { decideSearchWithBaseline, defaultSearchOptions, type SearchOptions } from './search-ai';
import { benchmarkSeeds } from './ai-benchmark';

export type SearchOpponent = 'structured' | 'legacy' | 'counting';

/** Same seeded deals without search: a control, not a replacement for the head-to-head experiment. */
export function evaluateStructuredControl(count:number,offset:number,opponent:SearchOpponent,output?:string){
 if(!['legacy','counting'].includes(opponent))throw new Error('基准对手无效');
 const opponentPolicy=opponent==='legacy'?chooseLegacyStructuredMove:chooseCardCountingMove;
 const perSeed=benchmarkSeeds(count,offset).map(seed=>{
  const games=[];
  for(const parity of [0,1] as const){
   let state=newGame(seed,(2+((seed>>>0)%13)) as Rank),steps=0;
   while(state.phase==='playing'&&steps<350){
    const seat=state.turn,o=observe(state,seat),cards=(seat%2===parity?chooseStructuredMove:opponentPolicy)(o);
    if(cards){if(!legalPlay(state,seat,cards).ok)throw new Error('基准对照非法出牌');state=playCards(state,seat,cards);}
    else state=passTurn(state,seat);
    steps++;
   }
   if(state.phase!=='finished')throw new Error('基准对照未结束');
   games.push({parity,won:state.finishOrder[0]%2===parity,steps});
  }
  return {seed,games};
 });
 const wins=perSeed.flatMap(r=>r.games).filter(g=>g.won).length;
 const report={mode:'frozen-structured-paired-control',opponent,offset,pairs:count,total:2*count,wins,rate:wins/(2*count),perSeed};
 if(output)fs.writeFileSync(output,JSON.stringify(report,null,2));
 return report;
}

export function evaluateSearch(count:number,offset:number,options:Partial<SearchOptions>={},output?:string,opponent:SearchOpponent='structured'){
 if(!['structured','legacy','counting'].includes(opponent))throw new Error('未知的评测对手');
 const opponentPolicy=opponent==='legacy'?chooseLegacyStructuredMove:opponent==='counting'?chooseCardCountingMove:chooseStructuredMove;
 const config={...defaultSearchOptions,...options},started=performance.now(),seeds=benchmarkSeeds(count,offset);
 const records:Array<{seed:number;games:Array<{parity:0|1;won:boolean;steps:number;upgrade:number}>}>=[];
 let decisions=0,searched=0,changed=0,completedSamples=0,upgradeBalance=0;
 const latency:number[]=[];
 for(const seed of seeds){
  const games=[];
  for(const parity of [0,1] as const){
   let state=newGame(seed,(2+((seed>>>0)%13)) as Rank),steps=0;
   while(state.phase==='playing'&&steps<350){
    const seat=state.turn,o=observe(state,seat);let action;
    if(seat%2===parity){
     // Match the live 256-action gateway, including request construction in the measured duration.
     const begin=performance.now(),request=buildAiRequest(o,'play','benchmark',256);
     const result=decideSearchWithBaseline(o,{cards:chooseStructuredMove(o)},config,'head',256);
     if(!request.actions.some(candidate=>actionKey(candidate)===actionKey(result.action)))throw new Error('搜索动作不在现场候选集');
     latency.push(performance.now()-begin);decisions++;searched+=Number(result.searched);changed+=Number(result.changed);completedSamples+=result.sampleCount;
     action=result.action;
    }else action={cards:opponentPolicy(o)};
    if(action.cards){if(!legalPlay(state,seat,action.cards,action.declared).ok)throw new Error('评测返回非法出牌');state=playCards(state,seat,action.cards,action.declared);}
    else state=passTurn(state,seat);
    steps++;
   }
   if(state.phase!=='finished')throw new Error('评测对局未结束');
   const won=state.finishOrder[0]%2===parity,upgrade=upgradeSteps(state.finishOrder);
   upgradeBalance+=(won?1:-1)*upgrade;games.push({parity,won,steps,upgrade});
  }
  records.push({seed,games});
  if(records.length%10===0)console.error(JSON.stringify({completedPairs:records.length,totalPairs:count,wins:records.flatMap(r=>r.games).filter(g=>g.won).length,searched,changed}));
 }
 const pairs=records.map(r=>r.games.reduce((sum,g)=>sum+Number(g.won),0)/2),rate=pairs.reduce((s,x)=>s+x,0)/count;
 const variance=count>1?pairs.reduce((s,x)=>s+(x-rate)**2,0)/(count-1):0;
 const radius=1.96*Math.sqrt(variance/count);
 const conservativeRadius=Math.sqrt(Math.log(2/0.05)/(2*count));
 latency.sort((a,b)=>a-b);
 const over500=latency.filter(ms=>ms>500).length,over700=latency.filter(ms=>ms>700).length,over900=latency.filter(ms=>ms>900).length;
 const report={mode:'public-pool-search-256-paired-opponent',opponent,candidateBudget:256,pairs:count,total:count*2,wins:Math.round(rate*count*2),rate,
  pairedNormal95:[Math.max(0,rate-radius),Math.min(1,rate+radius)],hoeffding95:[Math.max(0,rate-conservativeRadius),Math.min(1,rate+conservativeRadius)],
  // Cross-opponent performance and Android latency are separate release gates, not implied by this number.
  deployable:false,passesThisOpponentStatGate:count>=200&&rate>=0.55&&rate-conservativeRadius>0.5,upgradeBalance,invalidDecisions:0,
  config,offset,decisions,searched,changed,completedSamples,
  decisionTiming:'synchronous local request construction, baseline and search; excludes HTTP transport, server validation and Android runtime',
  timeoutCaveat:'Node timer cannot preempt synchronous search on the same event loop; over900 is latency threshold exceedance, not an observed HTTP timeout rate',
  localServerTimeoutMs:900,over500,over700,over900,over900Rate:over900/decisions,
  p50Ms:latency[Math.floor(latency.length*0.5)],p95Ms:latency[Math.floor(latency.length*0.95)],p99Ms:latency[Math.floor(latency.length*0.99)],maxMs:latency[latency.length-1],
  elapsedMs:performance.now()-started,perSeed:records,metric:'team first finish',sampling:'uniform unknown owners constrained by exact unseen physical pool and public counts; optional passes do not prove inability'};
 if(output)fs.writeFileSync(output,JSON.stringify(report,null,2));
 return report;
}

if(/(?:^|[\\/])search-benchmark\.js$/.test(process.argv[1]??'')){
 const count=Number(process.argv[2]??20),offset=Number(process.argv[3]??6500000),output=process.argv[4];
 const options=process.argv[5]?JSON.parse(process.argv[5]) as Partial<SearchOptions>:{};
 const opponent=(process.argv[6]??'structured') as SearchOpponent;
 const result=evaluateSearch(count,offset,options,output,opponent);
 console.log(JSON.stringify({...result,perSeed:undefined}));
}
