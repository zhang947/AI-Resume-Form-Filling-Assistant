const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const aliases = require('../shared/alias-enrichment.js');
const importer = require('../shared/library-import.js');
const matcher = require('../shared/selection-lookup-matcher.js');
const { loadSchema, profileFor, plain } = require('./library-fixture.cjs');
const schema = loadSchema(), read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const promptContext = {}; vm.runInNewContext(read('shared/resume-prompts.js'), promptContext);
const prompts = promptContext.ResumePrompts;
function fixture() {
  return profileFor([{ name: '院校记录', aliases: ['手动院校别名'], type: 'text', value: '某已保存大学' },
    { name: '开始时间', role: 'start', type: 'date', value: '2023-09' },
    { name: '结束时间', role: 'end', type: 'date', value: '至今' }], { group: '教育经历', item: '第一条教育' });
}
const catalog = (profile) => schema.getFieldCatalog({ profile });
test('both prompts contain the same alias reference without limiting dynamic fields or introducing semantic types', () => {
  const importPrompt = prompts.buildResumeImportPrompt(schema, '任意原文'), aliasPrompt = prompts.buildAliasPrompt([]);
  for (const prompt of [importPrompt, aliasPrompt]) {
    for (const word of ['毕业院校', '项目描述', '入学时间', '截止日期', '开始和结束方向不能混用']) assert.ok(prompt.includes(word));
    assert.ok(prompt.includes(JSON.stringify(prompts.ALIAS_REFERENCE)));
    assert.equal(prompt.includes('semanticType'), false);
  }
  assert.match(importPrompt, /不是固定字段模板/);
});
test('only aliases are merged; values, manual aliases, names, raw precision and unrelated properties remain intact', () => {
  const profile = fixture(); profile.groups[0].items[0].fields[1].value = '2023/9'; profile.customMetadata = { retained: true };
  const before = plain(profile), fields = catalog(profile);
  const plan = aliases.prepare(schema, profile, [{ path: fields[0].path, aliases: ['手动院校别名', '毕业院校', '学校名称', '学校名称', '某已保存大学'] }]);
  assert.deepEqual(plan.changes[0].added, ['毕业院校', '学校名称']);
  const saved = aliases.apply(schema, plan);
  assert.deepEqual(saved.groups[0].items[0].fields[0].aliases, ['手动院校别名', '毕业院校', '学校名称']);
  const expected = plain(before); expected.groups[0].items[0].fields[0].aliases.push('毕业院校', '学校名称');
  assert.deepEqual(saved, expected); assert.deepEqual(profile, before);
  assert.equal(aliases.prepare(schema, saved, [{ path: fields[0].path, aliases: ['毕业院校', '学校名称'] }]).changes.length, 0);
});
test('new aliases fix a previously missing lookup and preserve long text and multiple candidates', () => {
  const profile = fixture(), field = catalog(profile)[0];
  assert.equal(matcher.match(matcher.buildIndex(profile, schema), '毕业院校').length, 0);
  const plan = aliases.prepare(schema, profile, [{ path: field.path, aliases: ['毕业院校'] }]);
  const saved = aliases.apply(schema, plan);
  assert.equal(matcher.match(matcher.buildIndex(saved, schema), '毕业院校')[0].copyValue, '某已保存大学');
  const second = schema.createItem({ name: '第二条教育', fields: [{ name: '院校记录', aliases: ['毕业院校'], value: '另一所大学' }] });
  saved.groups[0].items.push(second);
  assert.deepEqual(matcher.match(matcher.buildIndex(saved, schema), '毕业院校').map((c) => c.copyValue), ['某已保存大学', '另一所大学']);
});
test('date direction checks remove opposite labels, allow period aliases and never mix start/end candidates', () => {
  const profile = fixture(), fields = catalog(profile);
  const plan = aliases.prepare(schema, profile, [
    { path: fields[1].path, aliases: ['入学时间', '毕业时间', '结束日期', '就读年月'] },
    { path: fields[2].path, aliases: ['毕业时间', '入学日期', '开始日期', '就读年月'] },
  ]);
  assert.deepEqual(plan.changes[0].added, ['入学时间', '就读年月']);
  assert.deepEqual(plan.changes[1].added, ['毕业时间', '就读年月']);
  const index = matcher.buildIndex(aliases.apply(schema, plan), schema);
  assert.deepEqual(matcher.match(index, '入学时间').map((c) => c.copyValue), ['2023-09']);
  assert.deepEqual(matcher.match(index, '毕业时间').map((c) => c.copyValue), ['至今']);
  assert.deepEqual(matcher.match(index, '就读年月').map((c) => c.copyValue), ['2023-09', '至今']);
});
test('school labels containing 入学 or 毕业 are not mistaken for date roles', () => {
  assert.deepEqual(aliases.sanitizeAliases({ name: '毕业院校', type: 'text' }, ['入学院校', '就读学校']), ['入学院校', '就读学校']);
});
test('AI aliases never repeat the name, including case, spacing and full-width variants', () => {
  assert.deepEqual(aliases.sanitizeAliases({ name: 'Email' }, ['Email', ' email ', 'Ｅｍａｉｌ', 'E mail', '邮箱', '电子邮箱', '邮箱：']), ['邮箱', '电子邮箱']);
  assert.deepEqual(aliases.sanitizeAliases({ name: '学校名称' }, ['学校名称', ' 学校名称 ', '学校名称：', '学校', '毕业院校']), ['学校', '毕业院校']);
});
test('alias merge cleans existing name duplicates but keeps manual synonyms and every field value', () => {
  const profile = profileFor([{ name: 'Email', value: 'a@example.test', aliases: ['邮箱'] }]);
  profile.groups[0].items[0].fields[0].aliases.push('Email', 'EMAIL', ' 邮箱 ');
  const plan = aliases.prepare(schema, profile, [{ path: catalog(profile)[0].path, aliases: ['email', 'ＥＭＡＩＬ', '电子邮件'] }]);
  assert.deepEqual(plan.changes[0].before, ['邮箱']);
  assert.deepEqual(plan.changes[0].added, ['电子邮件']);
  const saved = aliases.apply(schema, plan).groups[0].items[0].fields[0];
  assert.deepEqual(saved.aliases, ['邮箱', '电子邮件']); assert.equal(saved.value, 'a@example.test'); assert.equal(saved.name, 'Email');
});
test('Markdown extraction preview removes the name from aliases before any save', () => {
  const parsed = { groups: [{ name: '我的分组', items: [{ name: '条目', fields: [{ name: '学校名称', value: '某大学', aliases: ['学校名称', '学校名称：', '学校', '毕业院校', ' 学校 '] }] }] }] };
  const plan = importer.prepare(schema, { groups: [] }, parsed, '某大学');
  assert.deepEqual(plain(plan.changes[0].field.aliases), ['学校', '毕业院校']);
  assert.deepEqual(plain(importer.apply(schema, plan).groups[0].items[0].fields[0].aliases), ['学校', '毕业院校']);
});
test('validation rejects unknown paths and malformed suggestions and strips invalid aliases without changing manual data', () => {
  const profile = fixture(), field = catalog(profile)[0];
  for (const path of ['__proto__', field.path.replace(/value$/, 'name'), field.path.replace('f-import-0-0-0', 'f-missing')]) {
    assert.throws(() => aliases.prepare(schema, profile, [{ path, aliases: ['学校名称'] }]), /未知字段/);
  }
  assert.throws(() => aliases.prepare(schema, profile, [{ path: field.path, aliases: 'not an array' }]), /无效别名/);
  assert.deepEqual(aliases.sanitizeAliases({}, [' 名 ', 123, {}, '', 'a\nb', 'a'.repeat(41), ' 学校名称 ', '学校名称']), ['学校名称']);
});
test('generation sends metadata only, batches existing fields and never writes or exposes partial results', async () => {
  const profile = profileFor(Array.from({ length: 26 }, (_, i) => ({ name: `信息${i}`, value: `私人正文${i}` })));
  const requests = [];
  const result = await aliases.generate({ schema, profile, buildPrompt: (fields) => JSON.stringify({ fields }), parse: JSON.parse,
    callAI: async (prompt) => {
      const request = JSON.parse(prompt); requests.push(request);
      for (const field of request.fields) { assert.equal('value' in field, false); assert.equal('valuePreview' in field, false); }
      return JSON.stringify({ fields: request.fields.map((field) => ({ path: field.path, aliases: [`匹配${field.name}`], value: 'must be ignored' })) });
    },
  });
  assert.equal(requests.length, 2); assert.equal(result.changes.length, 26);
  assert.ok(profile.groups[0].items[0].fields.every((f) => f.aliases.length === 0));
  assert.equal(aliases.apply(schema, result).groups[0].items[0].fields[0].value, '私人正文0');
});
test('truncated batches are divided and retried; invented paths and later errors prevent any partial result', async () => {
  const profile = fixture(); let calls = 0;
  const options = { schema, profile, buildPrompt: JSON.stringify, parse: JSON.parse };
  const plan = await aliases.generate({ ...options, callAI: async (prompt) => {
    if (++calls === 1) throw Object.assign(new Error('length'), { code: 'AI_OUTPUT_TRUNCATED' });
    return JSON.stringify({ fields: JSON.parse(prompt).map((f) => ({ path: f.path, aliases: ['共同标签'] })) });
  } });
  assert.equal(calls, 3); assert.equal(plan.changes.length, 3);
  await assert.rejects(aliases.generate({ ...options, callAI: async () => JSON.stringify({ fields: [{ path: 'unknown', aliases: [] }] }) }), /未知字段/);
  await assert.rejects(aliases.generate({ ...options, callAI: async () => { throw new Error('failed'); } }), /failed/);
});
test('manual edits or template switches while waiting abort alias generation before parsing', async () => {
  let current = true, parsed = 0;
  await assert.rejects(aliases.generate({ schema, profile: fixture(), buildPrompt: JSON.stringify,
    isCurrent: () => current, callAI: async () => { current = false; return '{}'; }, parse: () => parsed++,
  }), /资料或模板已修改/);
  assert.equal(parsed, 0);
});
test('Markdown import filters contradictory aliases and preserves manual aliases when replacing an accepted conflicting value', () => {
  const before = profileFor([{ name: '开始时间', role: 'start', type: 'date', value: '2023-09', aliases: ['手动时间标签'] }]);
  const parsed = { groups: [{ name: '自主资料', items: [{ name: '我的条目', fields: [{ name: '开始时间', role: 'start', type: 'date', value: '2024-09', aliases: ['入学时间', '毕业时间'] }] }] }] };
  const plan = importer.prepare(schema, before, parsed, '2024-09');
  assert.deepEqual(plain(plan.conflicts[0].field.aliases), ['入学时间']);
  const field = importer.apply(schema, plan, plan.conflicts).groups[0].items[0].fields[0];
  assert.equal(field.value, '2024-09'); assert.deepEqual(plain(field.aliases), ['手动时间标签', '入学时间']);
});
