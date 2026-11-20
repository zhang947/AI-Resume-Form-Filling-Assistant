const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { profileFor } = require('./library-fixture.cjs');
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.listeners = {};
    this.value = ''; this.style = {}; this.classList = { add() {}, remove() {}, toggle() {} };
  }
  set innerHTML(value) { this._html = value; this.children = []; }
  get innerHTML() { return this._html || ''; }
  appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
  append(...children) { children.forEach((c) => this.appendChild(c)); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this); }
  setAttribute() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  async emit(type, event = {}) { for (const fn of this.listeners[type] || []) await fn({ target: this, ...event }); }
  scrollIntoView() {}
}
async function startPage(file, initial, sharedState) {
  const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), elements = new Map();
  for (const match of html.matchAll(/<([\w-]+)[^>]*\bid="([^"]+)"[^>]*>/g)) elements.set(match[2], new Element(match[1]));
  const document = new Element(); document.body = new Element('body');
  document.getElementById = (id) => elements.get(id) || null;
  document.createElement = (tag) => new Element(tag);
  document.createTextNode = (text) => Object.assign(new Element('span'), { textContent: text });
  elements.get('resumeFormHost').parentElement = new Element();
  if (elements.has('fillMethod')) elements.get('fillMethod').value = 'fields';
  const state = sharedState || structuredClone(initial), area = {
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in state).map((key) => [key, structuredClone(state[key])])),
    set: async (update) => Object.assign(state, structuredClone(update)),
    remove: async (keys) => keys.forEach((key) => delete state[key]),
  };
  const event = { addListener() {}, removeListener() {} }, errors = [];
  const storageListeners = new Set(), storageEvent = { addListener: (fn) => storageListeners.add(fn), removeListener: (fn) => storageListeners.delete(fn) };
  const context = { document, console: { ...console, error: (...args) => errors.push(args) }, URL, Blob, setTimeout, clearTimeout,
    chrome: { storage: { local: area, sync: { ...area, get: async () => ({}), remove: async () => {} }, onChanged: storageEvent },
      runtime: { id: 'test-extension', onMessage: event, getURL: (url) => url }, tabs: {}, scripting: {} },
    addEventListener() {}, confirm: () => true };
  context.window = context; vm.createContext(context);
  for (const match of html.matchAll(/<script src="([^"]+)"/g)) {
    if (match[1].startsWith('libs/')) continue;
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', match[1]), 'utf8'), context, { filename: match[1] });
  }
  if (context.ResumeLogExport) context.ResumeLogExport = { ...context.ResumeLogExport, loadProjectRootHandle: async () => null };
  await document.emit('DOMContentLoaded');
  assert.deepEqual(errors, []);
  return { context, elements, state, async notify(update) { for (const fn of storageListeners) fn(update, 'local'); await new Promise(setImmediate); } };
}
for (const page of ['popup.html', 'resume-editor.html']) {
  test(`${page} loads the real script bundle with a blank library and all required UI elements`, async () => {
    const h = await startPage(page, { aiModels: [], builtinModelOverride: {}, activeModelId: 'builtin-deepseek' });
    assert.deepEqual(JSON.parse(JSON.stringify(h.state.resumeTemplates['tpl-default'].profile)), { groups: [] });
    assert.ok(h.elements.get('resumeFormHost').children.length > 0);
    assert.equal(h.elements.get('saveResumeBtn').disabled, true);
  });
  test(`${page} reopens newly saved dynamic fields without clearing them`, async () => {
    const profile = profileFor([{ name: '任意字段', value: '已保存的信息' }]);
    const h = await startPage(page, { resumeLibraryVersion: 1, resumeTemplates: { a: { id: 'a', name: '资料', profile } }, activeResumeTemplateId: 'a' });
    assert.deepEqual(h.state.resumeTemplates.a.profile, profile);
    assert.equal(h.elements.get('resumeNav').children.length, 1);
    assert.equal(h.elements.get('resumeTemplateSelect').value, 'a');
  });
}
function initialLibrary() {
  return {
    resumeLibraryVersion: 1, activeResumeTemplateId: 'a',
    resumeTemplates: { a: { id: 'a', name: '当前简历', profile: profileFor([{ name: '字段', value: '当前正文' }]), rawText: '原始导入文本', schemaVersion: 6, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      b: { id: 'b', name: '其他简历', profile: profileFor([{ name: '字段', value: '其他模板正文' }]), rawText: '', schemaVersion: 6, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } },
    resumeMarkdownDocumentsV1: { a: '# 可重新解析的原资料', b: '# 其他 Markdown' },
    resumeSelectionLookupEnabled: true,
  };
}
test('clear button confirms its current-template scope; cancel keeps saved data and unsaved drafts', async () => {
  const h = await startPage('resume-editor.html', initialLibrary()), before = structuredClone(h.state);
  vm.runInContext('customFieldsEditor.addGroup()', h.context);
  let confirmation;
  h.context.confirm = (message) => { confirmation = message; return false; };
  await h.elements.get('clearResumeBtn').emit('click');
  assert.match(confirmation, /当前简历/); assert.match(confirmation, /未保存/);
  assert.deepEqual(h.state, before);
  assert.equal(vm.runInContext('customFieldsEditor.collect().length', h.context), 2);
});
test('confirmed clear immediately saves an empty current template, discards invalid drafts/raw text and retires previews', async () => {
  const h = await startPage('resume-editor.html', initialLibrary());
  const other = structuredClone(h.state.resumeTemplates.b), markdown = structuredClone(h.state.resumeMarkdownDocumentsV1);
  const models = structuredClone(h.state.aiModels), active = h.state.activeResumeTemplateId;
  vm.runInContext('customFieldsEditor.addGroup()', h.context); // Invalid name must not prevent deletion.
  let retired = false;
  h.context.document.querySelectorAll = (selector) => selector === '.library-import-preview' ? [{ remove: () => retired = true }] : [];
  await h.elements.get('clearResumeBtn').emit('click');
  assert.deepEqual(h.state.resumeTemplates.a.profile, { groups: [] }); assert.equal(h.state.resumeTemplates.a.rawText, '');
  assert.deepEqual(h.state.resumeTemplates.b, other); assert.deepEqual(h.state.resumeMarkdownDocumentsV1, markdown);
  assert.deepEqual(h.state.aiModels, models); assert.equal(h.state.activeResumeTemplateId, active);
  assert.equal(h.state.resumeSelectionLookupEnabled, true); assert.equal(retired, true);
  assert.equal(h.elements.get('markdownEditor').value, '# 可重新解析的原资料'); assert.equal(h.elements.get('resumeNav').children.length, 0);
  assert.equal(h.elements.get('saveResumeBtn').disabled, true); assert.equal(h.elements.get('clearResumeBtn').disabled, false);
  assert.equal(h.elements.get('resumeFormHost').inert, false);
});
test('clear failures leave the visible draft and saved library intact and restore usable controls', async () => {
  const h = await startPage('resume-editor.html', initialLibrary()), before = structuredClone(h.state);
  vm.runInContext('customFieldsEditor.addGroup()', h.context);
  h.context.chrome.storage.local.set = async () => { throw new Error('write failure'); };
  await h.elements.get('clearResumeBtn').emit('click');
  assert.deepEqual(h.state, before); assert.equal(vm.runInContext('customFieldsEditor.collect().length', h.context), 2);
  assert.match(h.elements.get('pageStatus').textContent, /清空失败/); assert.equal(h.elements.get('clearResumeBtn').disabled, false);
  assert.equal(h.elements.get('saveResumeBtn').disabled, false); assert.equal(h.elements.get('resumeFormHost').inert, false);
});
test('clear cannot race an in-flight AI/PDF import or delete a template after its active selection changed', async () => {
  const h = await startPage('resume-editor.html', initialLibrary()), before = structuredClone(h.state);
  vm.runInContext('isImporting = true', h.context); await h.elements.get('clearResumeBtn').emit('click');
  assert.deepEqual(h.state, before);
  vm.runInContext('isImporting = false', h.context); h.elements.get('uploadPdfBtn').disabled = true;
  await h.elements.get('clearResumeBtn').emit('click'); assert.deepEqual(h.state, before);
  h.elements.get('uploadPdfBtn').disabled = false; h.state.activeResumeTemplateId = 'b';
  await h.elements.get('clearResumeBtn').emit('click');
  assert.deepEqual(h.state.resumeTemplates, before.resumeTemplates); assert.match(h.elements.get('pageStatus').textContent, /已切换/);
});
test('configuration is the only Markdown editor, saves independently, and notifies the popup saved-source reader', async () => {
  const config = await startPage('resume-editor.html', initialLibrary());
  const popup = await startPage('popup.html', {}, config.state);
  assert.equal(popup.elements.has('markdownEditor'), false);
  assert.equal(vm.runInContext('markdownSource.getMarkdown()', popup.context), '# 可重新解析的原资料');
  const profiles = structuredClone(config.state.resumeTemplates);
  const input = config.elements.get('markdownEditor'); input.value = '# 配置页的新草稿'; await input.emit('input');
  assert.equal(vm.runInContext('markdownSource.getMarkdown()', popup.context), '# 可重新解析的原资料');
  await config.elements.get('saveMarkdownBtn').emit('click');
  await popup.notify({ resumeMarkdownDocumentsV1: {} });
  assert.equal(vm.runInContext('markdownSource.getMarkdown()', popup.context), '# 配置页的新草稿');
  assert.deepEqual(config.state.resumeTemplates, profiles);
});
test('an existing configuration import source is staged as an unsaved draft only when no Markdown document was saved', async () => {
  const initial = initialLibrary(); delete initial.resumeMarkdownDocumentsV1.a;
  const h = await startPage('resume-editor.html', initial);
  assert.equal(h.elements.get('markdownEditor').value, '原始导入文本');
  assert.equal(h.state.resumeMarkdownDocumentsV1.a, undefined);
  await h.elements.get('saveMarkdownBtn').emit('click'); assert.equal(h.state.resumeMarkdownDocumentsV1.a, '原始导入文本');
  h.state.resumeMarkdownDocumentsV1.a = '';
  const empty = await startPage('resume-editor.html', h.state);
  assert.equal(empty.elements.get('markdownEditor').value, '');
});
