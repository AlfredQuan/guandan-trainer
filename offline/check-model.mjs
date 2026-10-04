import fs from 'node:fs';
import assert from 'node:assert/strict';
import {validateModel, scoreFeatures} from './neural-policy.js';
const model=validateModel(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));
const fixture=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
fixture.features.forEach((x,i)=>assert.ok(Math.abs(scoreFeatures(model,x)-fixture.scores[i])<2e-5,'Python/JS inference mismatch'));
console.log('Python / TypeScript inference parity passed');
