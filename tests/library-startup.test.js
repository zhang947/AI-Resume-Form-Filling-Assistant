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
async function startPage(file, initial) {
  const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), elements = new Map();
  for (const match of html.matchAll(/<([\w-]+)[^>]*\bid="([^"]+)"[^>]*>/g)) elements.set(match[2], new Element(match[1]));
  const document = new Element(); document.body = new Element('body');
  document.getElementById = (id) => elements.get(id) || null;
  document.createElement = (tag) => new Element(tag);
  document.createTextNode = (text) => Object.assign(new Element('span'), { textContent: text });
  elements.get('resumeFormHost').parentElement = new Element();
  if (elements.has('fillMethod')) elements.get('fillMethod').value = 'fields';
  const state = structuredClone(initial), area = {
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in state).map((key) => [key, structuredClone(state[key])])),
    set: async (update) => Object.assign(state, structuredClone(update)),
    remove: async (keys) => keys.forEach((key) => delete state[key]),
  };
  const event = { addListener() {}, removeListener() {} }, errors = [];
  const context = { document, console: { ...console, error: (...args) => errors.push(args) }, URL, Blob, setTimeout, clearTimeout,
    chrome: { storage: { local: area, sync: { ...area, get: async () => ({}), remove: async () => {} }, onChanged: event },
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
  return { context, elements, state };
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
