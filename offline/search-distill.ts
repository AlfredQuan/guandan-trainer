import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { observe, type Observation } from '../lib/game/ai';
import { newGame, legalPlay, playCards, passTurn } from '../lib/game/engine';
import type { Rank } from '../lib/game/types';
import { actionKey, buildAiRequest } from './ai-gateway';
import { decideSearch, type SearchResult } from './search-ai';
import { encodeActions, featureNames, scoreFeatures, validateModel, type NeuralModel } from './neural-policy';
import { assertPhysicalCardConservation } from './selfplay';

/** Canonical action indices must match inference's 256-action budget, including declarations. */
export function distillRow(o:Observation,d:SearchResult,dealId:string){
 const {actions,features}=encodeActions(buildAiRequest(o,'play','distillation'));
 const teacher=actions.findIndex(a=>actionKey(a)===actionKey(d.action));
 const baseline=actions.findIndex(a=>actionKey(a)===actionKey(d.baseline));
 if(teacher<0||baseline<0)throw new Error('Target outside inference candidates');
 return {schema:2,dealId,seat:o.seat,actions,features,teacher,baseline,changed:d.changed,searched:d.searched,gain:d.gain};
}

export function generateDistillDeal(seed:number,reference?:NeuralModel,index=0){
 assert.ok(Number.isSafeInteger(seed));
 let state=newGame(seed,(2+((seed>>>0)%13)) as Rank),steps=0;
 const dealId=randomUUID(),rows:Omit<ReturnType<typeof distillRow>,'actions'>[]=[];
 const stats={decisions:0,searched:0,changed:0,missingTargets:0};
 while(state.phase==='playing'&&steps<350){
  const o=observe(state,state.turn),d=decideSearch(o);stats.decisions++;
  stats.searched+=Number(d.searched);stats.changed+=Number(d.changed);
  let encoded:ReturnType<typeof distillRow>|undefined;
  try{encoded=distillRow(o,d,dealId);}catch(error){
   if(error instanceof Error&&error.message==='Target outside inference candidates')stats.missingTargets++;
   else throw error;
  }
  // Keep all critical positions and a deterministic, bounded sample of ordinary anchors.
  if(encoded&&(d.searched||(steps+index)%8===0)){
   const {actions:_,...row}=encoded;rows.push(row);
  }
  // Alternate teacher trajectories and reference-model trajectories to cover distribution shift.
  let action=d.action;
  if(reference&&index%2===0&&encoded){
   const scores=encoded.features.map(x=>scoreFeatures(reference,x));
   action=encoded.actions[scores.indexOf(Math.max(...scores))];
  }
  const seat=state.turn;
  if(action.cards===null){assert.ok(state.lastPlay);state=passTurn(state,seat);}
  else{assert.ok(legalPlay(state,seat,action.cards,action.declared).ok);state=playCards(state,seat,action.cards,action.declared);}
  assertPhysicalCardConservation(state);steps++;
 }
 assert.equal(state.phase,'finished');
 return {rows,stats,finished:true};
}

if(/(?:^|[\\/])search-distill\.js$/.test(process.argv[1]??'')){
 const [countText,offsetText,output,modelPath]=process.argv.slice(2),count=Number(countText),offset=Number(offsetText);
 assert.ok(Number.isSafeInteger(count)&&count>0&&count<=100000&&Number.isSafeInteger(offset)&&offset>=0&&output);
 const reference=modelPath?validateModel(JSON.parse(fs.readFileSync(modelPath,'utf8'))):undefined;
 const fd=fs.openSync(output,'w'),stats={decisions:0,searched:0,changed:0,missingTargets:0};let rows=0;
 try{for(let i=0;i<count;i++){
  const result=generateDistillDeal(7001+(offset+i)*7919,reference,offset+i);
  for(const row of result.rows){fs.writeSync(fd,JSON.stringify(row)+'\n');rows++;}
  for(const k of Object.keys(stats) as (keyof typeof stats)[])stats[k]+=result.stats[k];
 }}finally{fs.closeSync(fd);}
 const meta={schema:2,features:featureNames,deals:count,offset,rows,stats,teacher:'visible-sampling-search-v1',candidateBudget:256};
 fs.writeFileSync(output+'.meta.json',JSON.stringify(meta));console.log(JSON.stringify(meta));
}
