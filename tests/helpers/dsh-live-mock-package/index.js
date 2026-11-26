import { LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm';

class KimiLiveMockAdapter extends LlmAdapter {
  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('off'), name: 'Off' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    };
  }

  async * stream(options) {
    const hasToolResult = options.messages.some(message => message.role === 'tool');
    if (!hasToolResult) {
      let args = process.env.DSH_MOCK_ARGS;
      if (!args) {
        const payload = {};
        if (process.env.DSH_MOCK_MODE) payload.mode = process.env.DSH_MOCK_MODE;
        if (process.env.DSH_MOCK_PROMPT) payload.prompt = process.env.DSH_MOCK_PROMPT;
        args = JSON.stringify(payload);
      }
      const name = process.env.DSH_MOCK_TOOL;
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('kimi-live-smoke'), name, argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('kimi-live-smoke'), name, arguments: args } };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    const last = options.messages.at(-1);
    const text = last?.role === 'tool'
      ? last.content.filter(block => block.type === 'text').map(block => block.text).join('')
      : 'Delegated Kimi operation completed.';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export const name = 'kimi-live-mock';
export const inject = ['llm'];

export function apply(ctx) {
  ctx.llm.registerAdapter(['mock'], new KimiLiveMockAdapter());
}
