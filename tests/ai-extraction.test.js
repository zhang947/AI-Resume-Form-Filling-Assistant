const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const importer = require('../shared/library-import.js');
const { loadSchema } = require('./library-fixture.cjs');
const schema = loadSchema();
const text = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function gateway(response) {
  let listener;
  const context = { URL, AbortController, setTimeout, clearTimeout, console,
    chrome: { runtime: { id: 'test', onMessage: { addListener: (fn) => listener = fn }, onInstalled: { addListener() {} } }, action: { onClicked: { addListener() {} } } },
    fetch: async () => ({ ok: true, json: async () => response }),
  };
  context.importScripts = () => {
    context.ResumeModelStorage = { getModelConfig: async () => ({ baseUrl: 'https://example.test/v1', apiKey: 'test-only', model: 'test-model' }) };
    context.ResumeFormPlan = { SYSTEM_PROMPT: 'test-only' };
  };
  vm.createContext(context); vm.runInContext(text('background.js'), context);
  return { context, dispatch: (request) => new Promise((resolve) => listener(request, { id: 'test' }, resolve)) };
}
function truncated() { return Object.assign(new Error('truncated'), { code: 'AI_OUTPUT_TRUNCATED' }); }
function responseFor(value, index = 0) {
  return JSON.stringify({ groups: [{ name: '自主分组', items: [{ name: '完整原文', fields: [{ name: `字段${index}`, type: 'textarea', value, aliases: [], role: '' }] }] }] });
}
const buildPrompt = (_schema, source) => `==SOURCE==\n${source}`;
const sourceFrom = (prompt) => prompt.slice(prompt.lastIndexOf('==SOURCE==\n') + '==SOURCE==\n'.length);
test('the reported 8192-token length response is identified before attempting to parse its truncated JSON', async () => {
  const h = gateway({ choices: [{ message: { content: '{"groups":[{"name":"unfinished' }, finish_reason: 'length' }], usage: { completion_tokens: 8192 } });
  await assert.rejects(h.context.callAI('model', 'source', 'resume_import'), (error) => error.code === 'AI_OUTPUT_TRUNCATED' && /长度上限/.test(error.message));
  const result = await h.dispatch({ action: 'callAI', modelId: 'model', prompt: 'source', mode: 'resume_import' });
  assert.equal(result.success, false); assert.equal(result.code, 'AI_OUTPUT_TRUNCATED'); assert.equal('data' in result, false);
});
test('the AI client preserves the structured truncation error for retry while successful gateways return exact content', async () => {
  const context = { chrome: { runtime: { sendMessage: (_request, callback) => callback({ success: false, error: 'output cut', code: 'AI_OUTPUT_TRUNCATED' }) } } };
  vm.createContext(context); vm.runInContext(text('shared/ai-client.js'), context);
  await assert.rejects(context.ResumeAiClient.callAI('model', 'source', 'resume_import'), (error) => error.code === 'AI_OUTPUT_TRUNCATED');
  const h = gateway({ choices: [{ message: { content: '{"groups":[]}' }, finish_reason: 'stop' }] });
  assert.equal(await h.context.callAI('model', 'source', 'resume_import'), '{"groups":[]}');
});
test('splitting respects headings and full paragraphs and retains every original character and the final tail', () => {
  const source = '# 我的资料\r\n\r\n' + Array.from({ length: 12 }, (_, i) => `## 条目 ${i}\r\n完整段落 ${i}：${'已确认内容。'.repeat(30)}\r\n\r\n`).join('') + '最后一段\n';
  const chunks = importer.splitSource(source, 700);
  assert.ok(chunks.length > 1); assert.equal(chunks.map((c) => c.source).join(''), source);
  for (const chunk of chunks) assert.equal(chunk.source, source.slice(chunk.start, chunk.end));
  assert.ok(chunks.at(-1).source.endsWith('最后一段\n'));
  const paragraph = '不可截断的长段落'.repeat(600);
  assert.equal(importer.splitSource(paragraph, 500).length, 1);
});
test('long Markdown is parsed sequentially with context and yields an aggregate only after every part succeeds', async () => {
  const source = '# 分组\n\n' + Array.from({ length: 8 }, (_, i) => `## 条目 ${i}\n${'完整经历正文。'.repeat(100)}\n\n`).join('');
  let active = 0, peak = 0, calls = 0; const progress = [], prompts = [];
  const parsed = await importer.extract({ schema, source, buildPrompt, parse: JSON.parse, onProgress: (p) => progress.push(p),
    callAI: async (prompt) => {
      active++; peak = Math.max(peak, active); prompts.push(prompt);
      await Promise.resolve(); const result = responseFor(sourceFrom(prompt), calls++); active--; return result;
    },
  });
  assert.ok(calls > 1); assert.equal(peak, 1);
  assert.ok(prompts[1].includes('标题/邻近原文'));
  assert.equal(parsed.groups.flatMap((g) => g.items.flatMap((i) => i.fields.map((f) => f.value))).join(''), source);
  assert.deepEqual(progress.at(-1), { completed: calls, total: calls });
});
test('a truncated part is retried as smaller complete paragraphs; incomplete JSON is never parsed or kept', async () => {
  const source = Array.from({ length: 6 }, (_, i) => `已确认信息${i}：${'内容'.repeat(70)}\n\n`).join('');
  let calls = 0, parses = 0;
  const parsed = await importer.extract({ schema, source, buildPrompt, parse: (value) => { parses++; return JSON.parse(value); },
    callAI: async (prompt) => { if (++calls === 1) throw truncated(); return responseFor(sourceFrom(prompt), calls); },
  });
  assert.ok(calls > 2); assert.equal(parses, calls - 1);
  assert.equal(parsed.groups.flatMap((g) => g.items.flatMap((i) => i.fields.map((f) => f.value))).join(''), source);
});
test('a later failure returns no partial library; non-length failures are not blindly retried', async () => {
  const source = Array.from({ length: 8 }, () => '实际段落。'.repeat(100) + '\n\n').join('');
  let calls = 0, result;
  await assert.rejects(async () => { result = await importer.extract({ schema, source, buildPrompt, parse: JSON.parse,
    callAI: async (prompt) => { if (++calls === 2) throw new Error('network error'); return responseFor(sourceFrom(prompt), calls); },
  }); }, /network error/);
  assert.equal(result, undefined); assert.equal(calls, 2);
});
test('an indivisible oversized paragraph produces an actionable error without trying to repair incomplete JSON', async () => {
  let parses = 0, calls = 0;
  await assert.rejects(importer.extract({ schema, source: '一个完整段落。'.repeat(800), buildPrompt,
    callAI: async () => { calls++; throw truncated(); }, parse: () => parses++,
  }), /拆成几个完整段落/);
  assert.equal(parses, 0); assert.equal(calls, 1);
});
test('manual edits or template switches while waiting stop the remaining requests before parsing or previewing', async () => {
  let current = true, parses = 0;
  await assert.rejects(importer.extract({ schema, source: '原文', buildPrompt, isCurrent: () => current,
    callAI: async () => { current = false; return responseFor('原文'); }, parse: () => parses++,
  }), /资料或模板已修改/);
  assert.equal(parses, 0);
});
test('compact extraction verifies values against source without repeating evidence and tolerates Markdown line indentation only', () => {
  const value = '1. 原文第一行\n2. 原文第二行\n3. 保留换行';
  const parsed = JSON.parse(responseFor(value));
  const plan = importer.prepare(schema, {}, parsed, '- 工作内容：\n  1. 原文第一行\n  2. 原文第二行\n  3. 保留换行');
  assert.equal(plan.changes[0].field.value, value);
  assert.throws(() => importer.prepare(schema, {}, JSON.parse(responseFor('无来源的新事实')), '实际原文'), /原文/);
});
