import fs from 'node:fs';
import { validateModel } from './neural-policy.js';
import { decideAdvancedSearch, advancedSearchVariants } from './advanced-search.js';
import { decideModelSearch } from './model-search.js';
import { actionKey } from './ai-gateway.js';
const modelPath=process.env.GUANDAN_AI_MODEL;
const variant=process.env.GUANDAN_AI_VARIANT;
if(!modelPath)throw new Error('GUANDAN_AI_MODEL is required');
if(variant!=='v020'&&!Object.hasOwn(advancedSearchVariants,variant??''))throw new Error('Set GUANDAN_AI_VARIANT to a frozen evaluated variant');
const model=validateModel(JSON.parse(fs.readFileSync(modelPath,'utf8')));
export default {id:'guandan-advanced-search-v021/'+variant,async decide(request){
 const view=request.view,seat=view.seat;
 const o={...view,role:['you','boss','partner','opponent'][seat],persona:['learner','control','partnerFirst','tempo'][seat]};
 const result=variant==='v020'?decideModelSearch(o,model):decideAdvancedSearch(o,model,variant);
 const action=request.actions.find(a=>actionKey(a)===actionKey(result.action))??request.actions.find(a=>actionKey(a)===actionKey(result.baseline));
 if(!action)throw new Error('The inference candidate budget does not contain the selected action');
 return {version:1,requestId:request.requestId,provider:this.id,action};
}};
