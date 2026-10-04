import fs from 'node:fs';
import { validateModel, selectNeuralAction } from './neural-policy.js';
const modelPath = process.env.GUANDAN_AI_MODEL;
if (!modelPath) throw new Error('请设置 GUANDAN_AI_MODEL 为 Kaggle 导出的 model.json');
const model = validateModel(JSON.parse(fs.readFileSync(modelPath, 'utf8')));
export default {
 id: 'kaggle-action-mlp-v1',
 async decide(request) {
  return {version:1,requestId:request.requestId,provider:this.id,action:selectNeuralAction(model,request)};
 }
};
