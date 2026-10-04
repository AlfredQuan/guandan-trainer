import { selectNeuralAction, type NeuralModel } from './neural-policy';
import { buildAiRequest } from './ai-gateway';
import { decideSearchWithBaseline } from './search-ai';
import type { Observation } from '../lib/game/ai';
export function decideModelSearch(o:Observation,model:NeuralModel){
 const baseline=selectNeuralAction(model,buildAiRequest(o,'play','model-search'));
 return decideSearchWithBaseline(o,baseline,{},'match',256);
}
