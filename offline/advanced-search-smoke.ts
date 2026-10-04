import assert from 'node:assert/strict';
import fs from 'node:fs';
import { observe } from '../lib/game/ai';
import { newGame, playCards, passTurn } from '../lib/game/engine';
import { buildAiRequest, actionKey, validAiAction } from './ai-gateway';
import { chooseStructuredMove } from './strong-ai';
import { decideSearchWithBaseline } from './search-ai';
import { validateModel } from './neural-policy';
import { decideAdvancedSearch, advancedSearchVariants } from './advanced-search';
const model=validateModel(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));
let state=newGame(7001);
while(state.phase==='playing'&&state.finishOrder.length===0){
 const o=observe(state,state.turn),ids=chooseStructuredMove(o);
 if(o.hand.length<=12&&o.counts.reduce((s,n)=>s+n,0)<=48&&o.lastPlay?.seat!==(o.seat+2)%4&&ids?.length!==o.hand.length&&buildAiRequest(o,'play','fixture').actions.filter(a=>a.cards).length>=2)break;
 state=ids?playCards(state,o.seat,ids):passTurn(state,o.seat);
}
const o=observe(state,state.turn),offered=buildAiRequest(o,'play','fixture').actions;
const baseline={cards:chooseStructuredMove(o)},proposal=offered.find(a=>a.cards&&actionKey(a)!==actionKey(baseline))!;
assert.ok(proposal);
const d=decideSearchWithBaseline(o,baseline,{samples:8,maxCandidates:6},'match',256,[proposal]);
assert.ok(d.candidates.some(a=>actionKey(a)===actionKey(proposal)));
assert.throws(()=>decideSearchWithBaseline(o,baseline,{},'match',256,[{cards:['bad']} ]));
const outside=newGame(9011),early=observe(outside,outside.turn);
for(const variant of ['rules-ensemble','rules-wide','model-wide'] as const){
 const result=decideAdvancedSearch(early,model,variant);
 assert.equal(result.searched,false);assert.ok(validAiAction(early,result.action));
 assert.ok((advancedSearchVariants[variant].samples??0)>=24);
 if(variant!=='model-wide')assert.equal(actionKey(result.baseline),actionKey({cards:chooseStructuredMove(early)}));
}
assert.throws(()=>decideAdvancedSearch(early,model,'unknown' as never));
console.log('advanced search: offered neural proposals, illegal-proposal rejection, frozen budgets and early-game baselines passed');
