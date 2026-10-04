import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { observe } from '../lib/game/ai';
import { newGame, legalPlay, playCards, passTurn, upgradeSteps } from '../lib/game/engine';
import type { Rank } from '../lib/game/types';
import { chooseStructuredMove } from './strong-ai';
import { assertPhysicalCardConservation } from './selfplay';
import { validateModel, type NeuralModel } from './neural-policy';
import { decideModelSearch } from './model-search';
import { pairedGate } from './cloud-selfplay';
import { decideAdvancedSearch, advancedSearchVariants, type AdvancedVariant } from './advanced-search';

export function modelSearchDuel(seed:number,parity:0|1,model:NeuralModel,variant:'v020'|AdvancedVariant='v020'){
 let state=newGame(seed,(2+((seed>>>0)%13)) as Rank),steps=0,searched=0,changed=0;
 const latencies:number[]=[];
 while(state.phase==='playing'&&steps<350){
  const o=observe(state,state.turn);let action;
  if(o.seat%2===parity){const start=performance.now(),d=variant==='v020'?decideModelSearch(o,model):decideAdvancedSearch(o,model,variant);
   action=d.action;searched+=Number(d.searched);changed+=Number(d.changed);latencies.push(performance.now()-start);
  }else action={cards:chooseStructuredMove(o)};
  if(action.cards===null){assert.ok(state.lastPlay);state=passTurn(state,o.seat);}
  else{assert.ok(legalPlay(state,o.seat,action.cards,action.declared).ok);state=playCards(state,o.seat,action.cards,action.declared);}
  assertPhysicalCardConservation(state);steps++;
 }
 assert.equal(state.phase,'finished');
 return {won:state.finishOrder[0]%2===parity,steps,upgrade:upgradeSteps(state.finishOrder),searched,changed,latencies};
}

if(/(?:^|[\\/])model-search-benchmark\.js$/.test(process.argv[1]??'')){
 const [countText,offsetText,output,modelPath,variantText='v020']=process.argv.slice(2),count=Number(countText),offset=Number(offsetText);
 assert.ok(Number.isSafeInteger(count)&&count>0&&Number.isSafeInteger(offset)&&offset>=0&&output&&modelPath);
 assert.ok(variantText==='v020'||Object.hasOwn(advancedSearchVariants,variantText));
 const variant=variantText as 'v020'|AdvancedVariant;
 const model=validateModel(JSON.parse(fs.readFileSync(modelPath,'utf8'))),perSeed=[],scores=[],latencies=[];
 let searched=0,changed=0,upgradeBalance=0;
 for(let i=0;i<count;i++){
  const seed=7001+(offset+i)*7919,games=[];
  for(const parity of [0,1] as const){const result=modelSearchDuel(seed,parity,model,variant);
   searched+=result.searched;changed+=result.changed;latencies.push(...result.latencies);
   upgradeBalance+=(result.won?1:-1)*result.upgrade;games.push({parity,won:result.won,steps:result.steps,upgrade:result.upgrade});
  }
  scores.push(games.reduce((s,g)=>s+Number(g.won),0)/2);perSeed.push({seed,games});
 }
 latencies.sort((a,b)=>a-b);
 const report={mode:'v017-neural-plus-public-match-search-vs-frozen-structured',variant,config:variant==='v020'?null:advancedSearchVariants[variant],pairs:count,games:count*2,wins:scores.reduce((s,x)=>s+x,0)*2,...pairedGate(scores),
  offset,upgradeBalance,searched,changed,invalidDecisions:0,p95Ms:latencies[Math.floor((latencies.length-1)*.95)],maxMs:latencies.at(-1),perSeed};
 fs.writeFileSync(output,JSON.stringify(report));console.log(JSON.stringify({...report,perSeed:undefined}));
}
