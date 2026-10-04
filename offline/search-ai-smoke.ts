import assert from 'node:assert/strict';
import { observe } from '../lib/game/ai';
import { newGame, playCards, passTurn, legalPlay } from '../lib/game/engine';
import { chooseStructuredMove } from './strong-ai';
import { actionKey, validAiAction, buildAiRequest, verifyAiReply } from './ai-gateway';
import { sampleSearchState, decideSearch, searchAiProvider } from './search-ai';
import { evaluateSearch, evaluateStructuredControl } from './search-benchmark';

let state=newGame(7001);
while(state.phase==='playing'&&state.finishOrder.length===0){
 const current=observe(state,state.turn),best=chooseStructuredMove(current);
 if(current.hand.length<=10&&current.lastPlay?.seat!==(current.seat+2)%4&&best?.length!==current.hand.length&&buildAiRequest(current,'play','fixture').actions.length>1)break;
 const ids=chooseStructuredMove(observe(state,state.turn));
 state=ids?playCards(state,state.turn,ids):passTurn(state,state.turn);
}
assert.equal(state.finishOrder.length,0);
const o=observe(state,state.turn);
const sample=sampleSearchState(o,918273);
assert.deepEqual(sample.players[o.seat].hand,o.hand);
assert.deepEqual(sample.players.map(p=>p.hand.length),o.counts);
assert.equal(sample.turn,state.turn);
assert.equal(sample.passes,state.passes);
assert.deepEqual(sample.finishOrder,state.finishOrder);
assert.equal(sample.lastPlay?.seat,state.lastPlay?.seat);
assert.equal(sample.players.flatMap(p=>p.hand).length+o.events.filter(e=>e.type==='play').flatMap(e=>e.cardIds??[]).length,108);
const ids=sample.players.flatMap(p=>p.hand.map(c=>c.id));
assert.equal(new Set(ids).size,ids.length);
const hidden=state.players.filter(p=>p.seat!==o.seat).flatMap(p=>p.hand).reverse();let start=0;
const swapped={...state,players:state.players.map(p=>p.seat===o.seat?p:{...p,hand:hidden.slice(start,start+=p.hand.length)})};
assert.deepEqual(sampleSearchState(observe(swapped,o.seat),918273),sample,'true hidden ownership must not affect sample');
const options={samples:8,maxCandidates:4,maxTotalCards:108,maxHand:27,seed:90210,minGain:0.05};
const result=decideSearch(o,options);
assert.ok(validAiAction(o,result.action));
assert.ok(result.candidates.some(c=>actionKey(c)===actionKey({cards:chooseStructuredMove(o)})));
assert.equal(result.outcomes.length,result.candidates.length);
assert.ok(result.outcomes.every(row=>row.length===8),'all candidates must receive identical sample count');
assert.deepEqual(decideSearch(observe(swapped,o.seat),options),result,'search must not read real hidden hands');
assert.equal(JSON.stringify(o),JSON.stringify(observe(state,state.turn)),'search cannot mutate real game');
assert.throws(()=>sampleSearchState({...o,counts:[0,0,0,0]},1));
assert.throws(()=>decideSearch(o,{samples:0}));
const liveRequest=buildAiRequest(o,'play','search-live-contract',256);
const liveReply=await searchAiProvider.decide(liveRequest);
assert.deepEqual(verifyAiReply(liveRequest,liveReply),liveReply.action,'live search must return an offered action');
const cappedObservation=observe(newGame(1002),2);
const cappedRequest=buildAiRequest(cappedObservation,'play','search-capped-contract',256);
assert.equal(cappedRequest.actions.length,256,'fixture must exercise the 256-action cap');
const cappedReply=await searchAiProvider.decide(cappedRequest);
assert.deepEqual(verifyAiReply(cappedRequest,cappedReply),cappedReply.action,'capped live search must return an offered action');
// A short full game exercises passes, finished players and borrowed leads.
let finished=newGame(22839),checks=0;
while(finished.phase==='playing'){
 const obs=observe(finished,finished.turn),fake=sampleSearchState(obs,42+checks);
 assert.equal(fake.passes,finished.passes);
 assert.deepEqual(fake.finishOrder,finished.finishOrder);
 const move=chooseStructuredMove(obs);
 if(move){assert.ok(legalPlay(fake,obs.seat,move).ok);finished=playCards(finished,obs.seat,move);}
 else finished=passTurn(finished,obs.seat);
 checks++;
}
for(const opponent of ['legacy','counting'] as const){
 const report=evaluateSearch(1,6470000,{},undefined,opponent);
 assert.equal(report.opponent,opponent);
 assert.equal(report.total,2);
 assert.ok(report.decisions>0 && report.over900<=report.decisions);
 assert.equal(report.invalidDecisions,0);
 const control=evaluateStructuredControl(1,6470000,opponent);
 assert.equal(control.total,2);
 assert.deepEqual(control.perSeed.map(row=>row.seed),report.perSeed.map(row=>row.seed));
}
assert.throws(()=>evaluateSearch(1,6470000,{},undefined,'unknown' as 'legacy'));
console.log('sampling search: public-state reconstruction, card conservation, paired samples, hidden-hand permutation, live budget, cross-opponent paired benchmark and latency counters passed');
