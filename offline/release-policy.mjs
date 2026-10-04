import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const releasePolicyFiles=[
 'lib/game/ai.js','lib/game/cards.js','lib/game/types.js','lib/game/rules.js','lib/game/engine.js',
 'offline/strong-ai.js','offline/card-memory.js','offline/search-ai.js','offline/model-search.js',
 'offline/advanced-search.js','offline/neural-policy.js','offline/ai-gateway.js'
];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function verifyRelease(runtimeRoot){
 const root=path.resolve(runtimeRoot),manifest=JSON.parse(fs.readFileSync(path.join(root,'release-manifest.json'),'utf8'));
 const a=manifest.acceptance;
 if(manifest.schema!==1||!['v020','rules-ensemble','rules-wide','model-wide'].includes(manifest.variant)||
  !/^[a-f0-9]{64}$/.test(manifest.engineSha256??'')||!/^[a-f0-9]{64}$/.test(manifest.modelSha256??''))throw new Error('Invalid release identity');
 if(!a||a.metric!=='team-head-vs-frozen-structured'||!Number.isSafeInteger(a.pairs)||a.pairs<200||
  a.games!==2*a.pairs||!Number.isSafeInteger(a.wins)||a.wins<0||a.wins>a.games||a.invalidDecisions!==0)throw new Error('Incomplete acceptance evidence');
 const rate=a.wins/a.games,lower=Math.max(0,rate-Math.sqrt(Math.log(40)/(2*a.pairs)));
 if(!Number.isFinite(a.rate)||!Number.isFinite(a.lower95)||Math.abs(rate-a.rate)>1e-12||Math.abs(lower-a.lower95)>1e-12||
  rate<.55||lower<=.5)throw new Error('Release has not passed the frozen delivery gate');
 if(!manifest.policyFiles||JSON.stringify(Object.keys(manifest.policyFiles).sort())!==JSON.stringify([...releasePolicyFiles].sort()))throw new Error('Missing or unexpected policy files');
 for(const name of releasePolicyFiles){
  if(hash(fs.readFileSync(path.join(root,name)))!==manifest.policyFiles[name])throw new Error('Evaluated policy differs from release: '+name);
 }
 const modelBytes=fs.readFileSync(path.join(root,'models/selected-model.json'));
 if(hash(modelBytes)!==manifest.modelSha256)throw new Error('Evaluated model differs from release');
 return {manifest,modelBytes};
}
