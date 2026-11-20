const test = require('node:test');
const assert = require('node:assert/strict');
const sourceModule = require('../shared/markdown-source.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function harness() {
  const listeners = new Set(), data = { a: '# saved A', b: '# saved B' }, errors = [];
  let reads = 0;
  const storage = { KEY: 'documents', load: async (id) => { reads++; return data[id] || ''; } };
  const changes = { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) };
  const source = sourceModule.create({ storage, changes, onError: (error) => errors.push(error.message) });
  const change = async (update, area = 'local') => {
    for (const fn of listeners) fn(update, area);
    await new Promise(setImmediate);
  };
  return { source, storage, data, errors, listeners, change, reads: () => reads };
}
test('popup source has no editor or write API and reads the active template saved Markdown only', async () => {
  const h = harness(); assert.equal(h.source.getMarkdown(), '');
  assert.equal(h.source.save, undefined); assert.equal(h.source.setMarkdown, undefined);
  await h.source.load('a'); assert.equal(h.source.getMarkdown(), '# saved A');
  await h.source.load('b'); assert.equal(h.source.getMarkdown(), '# saved B');
  await h.source.load('missing'); assert.equal(h.source.getMarkdown(), '');
});
test('configuration saves refresh the popup read-only cache; unrelated changes do not reload it', async () => {
  const h = harness(); await h.source.load('a');
  h.data.a = '# updated in configuration';
  await h.change({ otherSetting: {} }); assert.equal(h.source.getMarkdown(), '# saved A'); assert.equal(h.reads(), 1);
  await h.change({ documents: {} }); assert.equal(h.source.getMarkdown(), '# updated in configuration');
  assert.equal(h.reads(), 2); assert.deepEqual(h.errors, []);
});
test('an in-progress fill keeps its captured saved Markdown while future fills see the new saved version', async () => {
  const h = harness(); const snapshot = await h.source.load('a');
  h.data.a = '# next version'; await h.change({ documents: {} });
  assert.equal(snapshot, '# saved A'); assert.equal(h.source.getMarkdown(), '# next version');
});
test('late template reads cannot overwrite a newly selected template or expose the preceding template during loading', async () => {
  const pending = {};
  const source = sourceModule.create({ storage: { load: (id) => new Promise((resolve) => pending[id] = resolve) } });
  const a = source.load('a'), b = source.load('b');
  assert.equal(source.isBusy(), true); assert.equal(source.getMarkdown(), '');
  pending.b('# B'); await b; pending.a('# stale A'); await a;
  assert.equal(source.getMarkdown(), '# B'); assert.equal(source.isBusy(), false);
});
test('read failures remove stale data and report an error without restoring or writing any old source', async () => {
  const h = harness(); await h.source.load('a');
  h.storage.load = async () => { throw new Error('unavailable'); };
  await h.change({ documents: {} }); assert.deepEqual(h.errors, ['unavailable']);
  assert.equal(h.source.getMarkdown(), ''); assert.equal(h.source.isBusy(), false);
  h.source.dispose(); assert.equal(h.listeners.size, 0);
});
test('the actual popup fill action reads a saved source without any editor DOM and sends an immutable snapshot', async () => {
  let saved = '# saved before fill', sent, loads = 0;
  const context = {
    isFilling: false, isResumeDirty: false, activeTemplateId: 'a', resumeProfile: {},
    FILL_ACTIONS: { overwritePage: { fillMode: 'overwrite', scope: 'page', statusText: 'running', doneLog: 'done' } },
    getFillMethod: () => 'markdown', markdownSource: { load: async (id) => { assert.equal(id, 'a'); loads++; return saved; } },
    getActiveModel: async () => ({ id: 'model' }), isModelConfigured: () => true,
    chrome: { tabs: { query: async () => [{ id: 1, url: 'https://example.test/form' }] } },
    isSupportedWebPageUrl: () => true, document: { getElementById: () => ({ hidden: false }) },
    fillTipEl: {}, updateFillActionButtons() {}, updateStatus() {}, beginFillSession() {}, addLog() {},
    ensureContentScriptInjected: async () => { saved = '# edited in configuration during fill'; return true; },
    sendTabMessage: async (_id, message) => { sent = message; return { success: true, fieldCount: 1, mappedCount: 1, filledCount: 1 }; },
    updateFillStats() {}, renderMarkdownFillReport() {}, finalizeFillSession: async () => {}, updateStartFillAvailability() {},
  };
  const source = fs.readFileSync(path.join(__dirname, '../popup.js'), 'utf8');
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function runFill('), source.indexOf('clearMappingCacheBtn.addEventListener')), context);
  await context.runFill('overwritePage');
  assert.equal(loads, 1); assert.equal(sent.markdown, '# saved before fill'); assert.equal(sent.fillMethod, 'markdown');
  assert.equal(context.isFilling, false); assert.equal('resumeProfile' in sent, false);
});
