import {fileURLToPath} from 'node:url';
import {verifyRelease} from './release-policy.mjs';
import {validateModel} from './neural-policy.js';
import {decideAdvancedSearch,advancedSearchVariants} from './advanced-search.js';
import {decideModelSearch} from './model-search.js';
import {defaultSearchOptions} from './search-ai.js';
import {actionKey} from './ai-gateway.js';
const {manifest,modelBytes}=verifyRelease(fileURLToPath(new URL('..',import.meta.url)));
const model=validateModel(JSON.parse(modelBytes.toString('utf8'))),variant=manifest.variant;
const expected={...defaultSearchOptions,...(variant==='v020'?{}:advancedSearchVariants[variant])};
if(!manifest.searchConfig||Object.keys(manifest.searchConfig).length!==Object.keys(expected).length||
 Object.entries(expected).some(([k,v])=>manifest.searchConfig[k]!==v))throw new Error('Release search configuration differs from acceptance');
export default {id:'guandan-accepted/'+variant,async decide(request){
 const view=request.view,seat=view.seat;
 const o={...view,role:['you','boss','partner','opponent'][seat],persona:['learner','control','partnerFirst','tempo'][seat]};
 const result=variant==='v020'?decideModelSearch(o,model):decideAdvancedSearch(o,model,variant);
 const action=request.actions.find(a=>actionKey(a)===actionKey(result.action));
 if(!action)throw new Error('Accepted policy requires the evaluated 256-action candidate budget');
 return {version:1,requestId:request.requestId,provider:this.id,action};
}};
