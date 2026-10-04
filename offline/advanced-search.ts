import type { Observation } from '../lib/game/ai';
import { chooseStructuredMove } from './strong-ai';
import { actionKey, buildAiRequest } from './ai-gateway';
import { encodeActions, scoreFeatures, type NeuralModel } from './neural-policy';
import { decideSearchWithBaseline, type SearchOptions } from './search-ai';
export const advancedSearchVariants:Record<'rules-ensemble'|'rules-wide'|'model-wide',Partial<SearchOptions>>={
 'rules-ensemble':{samples:24,maxCandidates:6,maxTotalCards:48,maxHand:12},
 'rules-wide':{samples:24,maxCandidates:6,maxTotalCards:64,maxHand:16},
 'model-wide':{samples:24,maxCandidates:6,maxTotalCards:64,maxHand:16}
};
export type AdvancedVariant=keyof typeof advancedSearchVariants;
export function decideAdvancedSearch(o:Observation,model:NeuralModel,variant:AdvancedVariant){
 if(!Object.hasOwn(advancedSearchVariants,variant))throw new Error('Unknown search variant');
 const encoded=encodeActions(buildAiRequest(o,'play','advanced-search'));
 const ranked=encoded.actions.map((a,i)=>({action:a,score:scoreFeatures(model,encoded.features[i])}))
  .sort((a,b)=>b.score-a.score||actionKey(a.action).localeCompare(actionKey(b.action),'en'));
 const baseline=variant==='model-wide'?ranked[0].action:{cards:chooseStructuredMove(o)};
 return decideSearchWithBaseline(o,baseline,advancedSearchVariants[variant],'match',256,ranked.slice(0,2).map(x=>x.action));
}
