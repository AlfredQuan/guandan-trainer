import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {verifyRelease, releasePolicyFiles} from './release-policy.mjs';
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'guandan-release-check-'));
const hash=x=>createHash('sha256').update(x).digest('hex');
const files={};
for(const name of releasePolicyFiles){const target=path.join(fixture,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'fixture '+name);files[name]=hash(fs.readFileSync(target));}
fs.mkdirSync(path.join(fixture,'models'),{recursive:true});
fs.writeFileSync(path.join(fixture,'models/selected-model.json'),'{}');
const n=2000,wins=2200,rate=wins/(2*n),lower=rate-Math.sqrt(Math.log(40)/(2*n));
const valid={schema:1,variant:'rules-wide',modelSha256:hash('{}'),policyFiles:files,
 acceptance:{pairs:n,games:2*n,wins,rate,lower95:lower,invalidDecisions:0,metric:'team-head-vs-frozen-structured'},
 engineSha256:'a'.repeat(64)};
const save=value=>fs.writeFileSync(path.join(fixture,'release-manifest.json'),JSON.stringify(value));
save(valid);assert.equal(verifyRelease(fixture).manifest.variant,'rules-wide');
save({...valid,acceptance:{...valid.acceptance,rate:.60}});assert.throws(()=>verifyRelease(fixture));
save({...valid,acceptance:{...valid.acceptance,wins:2199,rate:2199/4000,lower95:2199/4000-Math.sqrt(Math.log(40)/4000)}});assert.throws(()=>verifyRelease(fixture));
save({...valid,acceptance:{...valid.acceptance,pairs:199,games:398,wins:398,rate:1,lower95:1-Math.sqrt(Math.log(40)/398)}});assert.throws(()=>verifyRelease(fixture));
save({...valid,acceptance:{...valid.acceptance,invalidDecisions:1}});assert.throws(()=>verifyRelease(fixture));
save({...valid,variant:'unknown'});assert.throws(()=>verifyRelease(fixture));
save({...valid,policyFiles:{...files,'../escape.js':hash('bad')}});assert.throws(()=>verifyRelease(fixture));
save(valid);fs.writeFileSync(path.join(fixture,releasePolicyFiles[0]),'changed');assert.throws(()=>verifyRelease(fixture));
fs.writeFileSync(path.join(fixture,releasePolicyFiles[0]),'fixture '+releasePolicyFiles[0]);
fs.writeFileSync(path.join(fixture,'models/selected-model.json'),'changed model');assert.throws(()=>verifyRelease(fixture));
// Fixture remains in the temp directory for inspection; this test does not delete user files.
console.log('release gate: exact counters, thresholds, sample size, legality, variants, model and policy hashes passed');
