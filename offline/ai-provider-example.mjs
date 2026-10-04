// Optional AI strategy module. Run with GUANDAN_AI_PROVIDER_MODULE pointing to this file.
// This is a protocol example, not a stronger opponent or a calibrated probability model.
export default {
  id: 'example-fast-shed-v1',
  async decide(request, signal) {
    if (signal?.aborted) throw new Error('AI 请求已取消');
    const moves = request.actions.filter(a => a.cards !== null);
    const action = [...moves].sort((a, b) => b.cards.length - a.cards.length)[0]
      ?? request.actions.find(a => a.cards === null);
    if (!action) throw new Error('缺少合法候选');
    return { version: 1, requestId: request.requestId, provider: this.id, action };
  },
};
