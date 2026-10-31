import { describe, expect, it } from 'vitest';
import { fillPromptGetArguments } from './http-handler.js';

const GET = (params?: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params });

describe('fillPromptGetArguments', () => {
  it('prompts/get で arguments が無ければ {} を補う', () => {
    expect(fillPromptGetArguments(GET({ name: 'work_log' }))).toEqual(
      GET({ name: 'work_log', arguments: {} }),
    );
  });

  it('arguments を明示していれば触らない(null も含む)', () => {
    for (const args of [{}, { project: 'X' }, null]) {
      const body = GET({ name: 'work_log', arguments: args });
      expect(fillPromptGetArguments(body)).toEqual(body);
    }
  });

  it('prompts/get 以外の method は触らない', () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } };
    expect(fillPromptGetArguments(body)).toEqual(body);
  });

  it('params が無い・オブジェクトでない・body がオブジェクトでないときは触らない', () => {
    for (const body of [GET(undefined), GET(null), GET('x'), GET([1]), null, 'text', 42, undefined]) {
      expect(fillPromptGetArguments(body)).toEqual(body);
    }
  });

  it('入力のオブジェクトを変更しない', () => {
    const params = { name: 'work_log' };
    const body = GET(params);
    const snapshot = structuredClone(body);
    const out = fillPromptGetArguments(body);
    expect(body).toEqual(snapshot);
    expect(params).toEqual({ name: 'work_log' });
    expect(out).not.toBe(body);
  });

  it('batch(配列)では要素ごとに処理する', () => {
    const tools = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
    const explicit = GET({ name: 'a', arguments: { project: 'X' } });
    const out = fillPromptGetArguments([GET({ name: 'work_log' }), tools, explicit, null]);
    expect(out).toEqual([GET({ name: 'work_log', arguments: {} }), tools, explicit, null]);
  });
});
