import assert from 'node:assert/strict';
import { newGame, playCards } from '../lib/game/engine';
import { observe } from '../lib/game/ai';
import { actionKey, buildAiRequest, validAiAction } from './ai-gateway';
import { encodeActions, featureNames, validateModel, scoreFeatures, selectNeuralAction } from './neural-policy';
import { cloudDeal } from './cloud-selfplay';

const state = newGame(7001);
const request = buildAiRequest(observe(state, state.turn), 'play', 'fixture');
const encoded = encodeActions(request);
assert.ok(encoded.features.length > 1);
assert.equal(encoded.features[0].length, featureNames.length);
assert.ok(encoded.features.flat().every(Number.isFinite));
// Removing another player's hidden hand must not change features or model output.
const hiddenChanged = { ...state, players: state.players.map(p => p.seat === state.turn ? p : {...p, hand: [...p.hand].reverse()}) };
assert.deepEqual(encoded, encodeActions(buildAiRequest(observe(hiddenChanged, state.turn), 'play', 'other-id')));
assert.deepEqual(encoded, encodeActions({...request, actions: [...request.actions].reverse()}), 'teacher insertion order must not become a feature');
const model = validateModel({version:1, kind:'guandan-action-mlp', features:featureNames,
 w1:[featureNames.map(name => name === 'finish' ? 2 : 0)], b1:[0], w2:[3], b2:0});
assert.ok(Math.abs(scoreFeatures(model, featureNames.map(n => n === 'finish' ? 1 : 0)) - 3*Math.tanh(2)) < 1e-12);
const small = { ...request, view: {...request.view, hand:request.view.hand.slice(0,1), counts:request.view.counts.map((c,s)=>s===request.view.seat?1:c)}, actions:[{cards:[request.view.hand[0].id]}] };
assert.deepEqual(selectNeuralAction(model, small).cards, small.actions[0].cards);
assert.ok(validAiAction(request.view, selectNeuralAction(model, request)));
assert.throws(()=>validateModel({...model, features:['wrong']}));
assert.throws(()=>validateModel({...model, w2:[NaN]}));
assert.throws(()=>encodeActions({...request,actions:[{cards:['not-owned']}]}));
const chosen = request.actions.find(a=>a.cards && a.cards.length > 1)!;
const next = playCards(state,state.turn,chosen.cards!,chosen.declared);
const reply = buildAiRequest(observe(next,next.turn),'play','response');
const replyEncoded = encodeActions(reply);
assert.ok(replyEncoded.actions.some(a=>a.cards===null));
assert.ok(replyEncoded.features.flat().every(Number.isFinite));
const oneSeat = cloudDeal(7001, 0);
const allSeats = cloudDeal(7001, 0, undefined, 0.8, undefined, 4);
assert.ok(allSeats.rows.length > oneSeat.rows.length, '四座位采样应增加训练行动');
assert.deepEqual(new Set(allSeats.rows.map(row => row.seat)), new Set([0, 1, 2, 3]));
assert.equal(new Set(allSeats.rows.map(row => row.dealId)).size, 1, '同一副牌必须整体隔离');
assert.ok(allSeats.rows.every(row => row.reward === (row.seat % 2 === allSeats.winnerParity ? 1 : -1) * allSeats.upgrade / 3));
assert.ok(allSeats.rows.every(row => row.teacher === row.chosen && row.logProbability === 0));
assert.equal(new Set(oneSeat.rows.map(row => row.seat)).size, 1, '单座位旧模式保持兼容');
assert.deepEqual(allSeats.rows.filter(row => row.seat === 0).map(({seat: _seat, dealId: _id, ...row}) => row),
 oneSeat.rows.map(({seat: _seat, dealId: _id, ...row}) => row), '仅扩充记录座位，不应改变相同副牌的策略轨迹');
console.log('neural inference: visibility, legality, model validation, four-seat grouped rewards passed');
