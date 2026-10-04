import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep this order identical to featureNames in neural-policy.ts; this CLI needs no compiled TS.
const ranks = Array.from({ length: 15 }, (_, i) => i + 2);
const suits = ['S', 'H', 'C', 'D'];
const kinds = ['single', 'pair', 'triple', 'triplePair', 'straight', 'tube', 'plate', 'bomb', 'straightFlush', 'jokerBomb'];
export const featureNames = [
  ...['hand', 'remaining', 'played', 'unseen'].flatMap(group => ranks.map(rank => `${group}.rank${rank}`)),
  ...suits.flatMap(suit => Array.from({ length: 13 }, (_, i) => `remaining.${suit}${i + 2}`)),
  ...Array.from({ length: 4 }, (_, i) => `relativeSeat${i}.count`),
  ...kinds.map(kind => `action.${kind}`), ...kinds.map(kind => `last.${kind}`),
  'pass', 'finish', 'size', 'mainPower', 'secondaryPower', 'wildSpent', 'powerSpent', 'remainingSingles', 'brokenGroups',
  'allyLeads', 'opponentThreat', 'freeLead', 'level', 'lastSize', 'lastPower',
  ...Array.from({ length: 4 }, (_, i) => `relativeSeat${i}.recentPass`),
];

function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 无效`);
  return value;
}

function finite(value, name) {
  if (!Number.isFinite(value)) throw new Error(`${name} 必须是有限数`);
  return value;
}

export function validateModel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
      value.kind !== 'guandan-action-mlp' || !Array.isArray(value.features) ||
      value.features.length !== featureNames.length || featureNames.some((name, i) => value.features[i] !== name) ||
      !Array.isArray(value.w1) || !Array.isArray(value.b1) || !Array.isArray(value.w2)) {
    throw new Error('模型格式或特征版本不匹配');
  }
  const hidden = integer(value.w1.length, 1, 256, '模型隐藏层宽度');
  if (value.b1.length !== hidden || value.w2.length !== hidden) throw new Error('模型权重尺寸无效');
  for (let j = 0; j < hidden; j++) {
    const row = value.w1[j];
    if (!Array.isArray(row) || row.length !== featureNames.length) throw new Error('模型权重尺寸无效');
    for (let i = 0; i < row.length; i++) finite(row[i], 'w1');
    finite(value.b1[j], 'b1');
    finite(value.w2[j], 'w2');
  }
  finite(value.b2, 'b2');
  return value;
}

export function validateTrainingRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.schema !== 1 ||
      typeof row.dealId !== 'string' || !row.dealId.length || row.dealId.length > 256 ||
      !Array.isArray(row.features) || !row.features.length || row.features.length > 4096) {
    throw new Error('训练行格式、dealId 或动作集合无效');
  }
  const count = row.features.length;
  for (let a = 0; a < count; a++) {
    const x = row.features[a];
    if (!Array.isArray(x) || x.length !== featureNames.length) throw new Error('动作特征长度无效');
    for (let i = 0; i < x.length; i++) finite(x[i], '动作特征');
  }
  if (row.seat !== undefined) integer(row.seat, 0, 3, 'seat');
  integer(row.teacher, 0, count - 1, 'teacher 索引');
  integer(row.chosen, 0, count - 1, 'chosen 索引');
  if (finite(row.logProbability, 'logProbability') > 0) throw new Error('logProbability 不能为正');
  if (Math.abs(finite(row.reward, 'reward')) > 1) throw new Error('reward 必须在 [-1, 1]');
  return row;
}

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function initialModel(hidden) {
  const random = randomGenerator(0x4755414e);
  const scale1 = 1 / Math.sqrt(featureNames.length);
  const scale2 = 1 / Math.sqrt(hidden);
  return {
    version: 1, kind: 'guandan-action-mlp', features: [...featureNames],
    w1: Array.from({ length: hidden }, () => featureNames.map(() => (random() * 2 - 1) * scale1)),
    b1: Array(hidden).fill(0), w2: Array.from({ length: hidden }, () => (random() * 2 - 1) * scale2), b2: 0,
  };
}

function distribution(model, features, temperature) {
  const activations = [], scores = [];
  for (const x of features) {
    const h = model.w1.map((row, j) => {
      let z = model.b1[j];
      for (let i = 0; i < x.length; i++) z += row[i] * x[i];
      return Math.tanh(finite(z, '隐藏层激活'));
    });
    let score = model.b2;
    for (let j = 0; j < h.length; j++) score += model.w2[j] * h[j];
    activations.push(h);
    scores.push(finite(score, '动作得分'));
  }
  const maximum = Math.max(...scores);
  const weights = scores.map(score => Math.exp((score - maximum) / temperature));
  const sum = finite(weights.reduce((total, weight) => total + weight, 0), 'softmax 分母');
  const logSum = Math.log(sum);
  return { activations, probabilities: weights.map(weight => weight / sum),
    logProbabilities: scores.map(score => (score - maximum) / temperature - logSum) };
}

function zeroGradient(model) {
  return { w1: model.w1.map(row => row.map(() => 0)), b1: model.b1.map(() => 0),
    w2: model.w2.map(() => 0), b2: 0 };
}

function applyGradient(model, gradient, rate) {
  return validateModel({
    version: 1, kind: 'guandan-action-mlp', features: [...featureNames],
    w1: model.w1.map((row, j) => row.map((weight, i) => weight - rate * gradient.w1[j][i])),
    b1: model.b1.map((bias, j) => bias - rate * gradient.b1[j]),
    w2: model.w2.map((weight, j) => weight - rate * gradient.w2[j]),
    b2: model.b2 - rate * gradient.b2,
  });
}

/** Full-batch CE, or exactly one frozen-policy REINFORCE update. Never resample old self-play rows. */
export function trainModel(rows, options) {
  if (!options || !['warmstart', 'selfplay'].includes(options.mode) || !Array.isArray(rows) || !rows.length) {
    throw new Error('训练模式或非空训练行无效');
  }
  const { mode } = options;
  const epochs = integer(options.epochs ?? (mode === 'selfplay' ? 1 : 10), 1, 10000, 'epochs');
  if (mode === 'selfplay' && epochs !== 1) throw new Error('自博弈数据只能训练一个 epoch，不能重复使用同一批 on-policy 样本');
  const lr = finite(options.lr ?? 0.01, 'lr');
  if (lr <= 0) throw new Error('lr 必须大于零');
  const temperature = finite(options.temperature ?? 0.8, 'temperature');
  if (temperature <= 0 || temperature > 5) throw new Error('temperature 必须在 (0, 5]');
  if (mode === 'selfplay' && !options.init) throw new Error('selfplay 必须提供生成此批样本的 --init 模型');
  const init = options.init === undefined ? undefined : validateModel(options.init);
  const hidden = integer(options.hidden ?? init?.w1.length ?? 32, 1, 256, 'hidden');
  if (init && init.w1.length !== hidden) throw new Error('hidden 与初始模型宽度不一致');
  for (let i = 0; i < rows.length; i++) {
    try { validateTrainingRow(rows[i]); } catch (error) { throw new Error(`训练行 ${i + 1}: ${error.message}`); }
  }
  const deals = new Map();
  for (const row of rows) {
    const seats = deals.get(row.dealId) ?? new Map();
    const seat = row.seat ?? -1; // Earlier single-seat datasets did not store the seat.
    if (mode === 'selfplay') {
      if (seats.has(seat) && seats.get(seat) !== row.reward) throw new Error(`同一座位 reward 不一致: ${row.dealId}`);
      for (const [priorSeat, priorReward] of seats) {
        if (Math.abs(Math.abs(priorReward) - Math.abs(row.reward)) > 1e-10 ||
            (seat >= 0 && priorSeat >= 0 && row.reward !== (seat % 2 === priorSeat % 2 ? priorReward : -priorReward))) {
          throw new Error(`同副牌的队伍终局标签不一致: ${row.dealId}`);
        }
      }
    }
    seats.set(seat, row.reward);
    deals.set(row.dealId, seats);
  }
  // A full four-seat deal has opposing team rewards whose seat-level mean is zero.
  // A single-seat deal retains the leave-one-deal-out control variate.
  const outcomes = [...deals.values()].map(seats => [...seats.values()].reduce((sum, reward) => sum + reward, 0) / seats.size);
  const totalReward = outcomes.reduce((total, reward) => total + reward, 0);
  const variableRewards = outcomes.some(reward => reward !== outcomes[0]);
  const baselines = new Map([...deals.keys()].map((id, index) =>
    [id, variableRewards && deals.size > 1 ? (totalReward - outcomes[index]) / (deals.size - 1) : 0]));
  let model = init ? validateModel({
    version: 1, kind: 'guandan-action-mlp', features: [...featureNames],
    w1: init.w1.map(row => [...row]), b1: [...init.b1], w2: [...init.w2], b2: init.b2,
  }) : initialModel(hidden);
  let objective = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradient = zeroGradient(model);
    objective = 0;
    for (const row of rows) {
      const scale = mode === 'selfplay' ? temperature : 1;
      const { activations, probabilities, logProbabilities } = distribution(model, row.features, scale);
      const target = mode === 'selfplay' ? row.chosen : row.teacher;
      const advantage = mode === 'selfplay' ? row.reward - baselines.get(row.dealId) : 1;
      if (mode === 'selfplay' && Math.abs(logProbabilities[target] - row.logProbability) > 1e-6) {
        throw new Error(`dealId ${row.dealId} 的 logProbability 与固定 --init 策略不符；请核对模型和 temperature`);
      }
      objective += finite(-advantage * logProbabilities[target], '训练目标');
      for (let a = 0; a < row.features.length; a++) {
        const delta = advantage * (probabilities[a] - Number(a === target)) / scale;
        const h = activations[a], x = row.features[a];
        gradient.b2 += delta;
        for (let j = 0; j < hidden; j++) {
          gradient.w2[j] += delta * h[j];
          const dz = delta * model.w2[j] * (1 - h[j] * h[j]);
          gradient.b1[j] += dz;
          for (let i = 0; i < x.length; i++) gradient.w1[j][i] += dz * x[i];
        }
      }
    }
    model = applyGradient(model, gradient, lr / rows.length);
  }
  return { model, summary: { mode, rows: rows.length, deals: deals.size, epochs, hidden, lr,
    ...(mode === 'selfplay' ? { temperature, baseline: variableRewards ? 'other-deals-mean' : 'zero' } : {}),
    objective: finite(objective / rows.length, '平均训练目标') } };
}

function parseOptions(args) {
  const allowed = new Set(['--data', '--output', '--mode', '--epochs', '--hidden', '--lr', '--init', '--temperature']);
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || args[i + 1] === undefined || Object.hasOwn(values, args[i])) {
      throw new Error('参数无效；用法: node offline/train-neural.mjs --data ROWS.jsonl --output MODEL.json --mode warmstart|selfplay [--init MODEL.json] [--epochs N] [--hidden N] [--lr F] [--temperature F]');
    }
    values[args[i]] = args[i + 1];
  }
  if (!values['--data'] || !values['--output'] || !values['--mode']) throw new Error('缺少 --data、--output 或 --mode');
  if ([values['--data'], values['--init']].some(p => p && path.resolve(p) === path.resolve(values['--output']))) {
    throw new Error('输出路径不能覆盖数据或初始模型');
  }
  return values;
}

export function main(args = process.argv.slice(2)) {
  const opts = parseOptions(args);
  const rows = fs.readFileSync(opts['--data'], 'utf8').split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch (error) { throw new Error(`JSONL 第 ${index + 1} 行解析失败: ${error.message}`); }
  });
  const init = opts['--init'] ? JSON.parse(fs.readFileSync(opts['--init'], 'utf8')) : undefined;
  const { model, summary } = trainModel(rows, {
    mode: opts['--mode'], init,
    epochs: opts['--epochs'] === undefined ? undefined : Number(opts['--epochs']),
    hidden: opts['--hidden'] === undefined ? undefined : Number(opts['--hidden']),
    lr: opts['--lr'] === undefined ? undefined : Number(opts['--lr']),
    temperature: opts['--temperature'] === undefined ? undefined : Number(opts['--temperature']),
  });
  fs.writeFileSync(opts['--output'], JSON.stringify(model) + '\n', { flag: 'wx' });
  console.error(JSON.stringify({ ...summary, output: opts['--output'] }));
  console.log(`训练完成：${summary.rows} 行，${summary.epochs} epoch；模型已保存（效果尚未验证）`);
  return { model, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
