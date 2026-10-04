import fs from 'node:fs';
import { validateModel } from './neural-policy.js';
import { decideModelSearch } from './model-search.js';
import { actionKey } from './ai-gateway.js';
const modelPath=process.env.GUANDAN_AI_MODEL;
if(!modelPath)throw new Error('Set GUANDAN_AI_MODEL to the frozen v017 model.json');
const model=validateModel(JSON.parse(fs.readFileSync(modelPath,'utf8')));
export default {id:'kaggle-neural-public-match-search-v020',async decide(request){
 const v=request.view,seat=v.seat;
 const o={...v,role:['you','boss','partner','opponent'][seat],persona:['learner','control','partnerFirst','tempo'][seat]};
 const result=decideModelSearch(o,model);
 const action=request.actions.find(a=>actionKey(a)===actionKey(result.action))??request.actions.find(a=>actionKey(a)===actionKey(result.baseline));
 if(!action)throw new Error('No matching legal inference candidate');
 return {version:1,requestId:request.requestId,provider:this.id,action};
}};
