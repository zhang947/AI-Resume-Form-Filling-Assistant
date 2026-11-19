// Side panel: Markdown documents, AI answers, and local fill.

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

const tabsEl = document.getElementById("tabs");
const tabFillEl = document.getElementById("tab-fill");
const tabResumeEl = document.getElementById("tab-resume");
const openResumeEditorBtn = document.getElementById("openResumeEditorBtn");

const fieldCountEl = document.getElementById("fieldCount");
const mappedCountEl = document.getElementById("mappedCount");
const filledCountEl = document.getElementById("filledCount");

const startFillBtn = document.getElementById("startFillBtn");
const startFillBtnText = document.getElementById("startFillBtnText");
const startIncrementalFillBtn = document.getElementById("startIncrementalFillBtn");
const startIncrementalFillBtnText = document.getElementById(
  "startIncrementalFillBtnText"
);
const startSelectionFillBtn = document.getElementById("startSelectionFillBtn");
const startSelectionFillBtnText = document.getElementById(
  "startSelectionFillBtnText"
);
const clearMappingCacheBtn = document.getElementById("clearMappingCacheBtn");
const fillTipEl = document.getElementById("fillTip");

const logContent = document.getElementById("logContent");
const clearLogBtn = document.getElementById("clearLog");
const selectLogDirectoryBtn = document.getElementById("selectLogDirectoryBtn");
const logExportStatusEl = document.getElementById("logExportStatus");

const settingsModal = document.getElementById("settingsModal");
const openSettingsBtn = document.getElementById("openSettingsBtn");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const closeSettingsBackdrop = document.getElementById("closeSettingsBackdrop");
const modelList = document.getElementById("modelList");
const addModelBtn = document.getElementById("addModelBtn");

const editModelModal = document.getElementById("editModelModal");
const closeEditBtn = document.getElementById("closeEditBtn");
const closeEditBackdrop = document.getElementById("closeEditBackdrop");
const editModalTitle = document.getElementById("editModalTitle");
const editNameInput = document.getElementById("editName");
const editBaseUrlInput = document.getElementById("editBaseUrl");
const editApiKeyInput = document.getElementById("editApiKey");
const editModelInput = document.getElementById("editModel");
const editStatus = document.getElementById("editStatus");
const saveModelBtn = document.getElementById("saveModelBtn");
const toggleEditApiKeyBtn = document.getElementById("toggleEditApiKey");

const modelStorage = window.ResumeModelStorage;
if (!modelStorage) {
  throw new Error("Model storage is not available");
}

const logExport = window.ResumeLogExport;
if (!logExport) {
  throw new Error("Resume log export is not available");
}

const logVisibility = window.ResumeLogVisibility;
if (!logVisibility) {
  throw new Error("Resume log visibility is not available");
}

const contentBridge = window.ResumeContentBridge;
if (!contentBridge) {
  throw new Error("Resume content bridge is not available");
}

const MAPPING_CACHE_KEY = "fieldMappingCacheV3";

const BUILTIN_MODEL = modelStorage.DEFAULT_MODEL;

let editingModelId = null;
let isFilling = false;
let documentEditor = null;
let logProjectRootHandle = null;
let activeFillSession = null;

const FILL_ACTIONS = {
  overwritePage: {
    triggerText: "开始填充",
    runningText: "填充中...",
    statusText: "生成答案中...",
    startLog: "开始识别页面字段，准备根据 Markdown 生成填写内容...",
    doneLog: "填充完成",
    fillMode: "overwrite",
    scope: "page",
  },
  incrementalPage: {
    triggerText: "增量填入",
    runningText: "增量中...",
    statusText: "增量生成答案中...",
    startLog: "开始增量填入：已有内容的字段会自动跳过。",
    doneLog: "增量填入完成",
    fillMode: "incremental",
    scope: "page",
  },
  selection: {
    triggerText: "选区填入",
    runningText: "等待选区...",
    statusText: "等待选区...",
    startLog: "准备选区填入：请回到网页并拖拽框选要填写的区域。",
    doneLog: "选区填入完成",
    fillMode: "overwrite",
    scope: "selection",
  },
};

document.addEventListener("DOMContentLoaded", async () => {
  try {
    initTabs();
    initModalEvents();
    initLogExportEvents();
    documentEditor = window.ResumeDocumentEditor.create({ onLog: addLog, onChange: updateStartFillAvailability });
    await documentEditor.ready;
    await initModels();
    await refreshLogExportStatus();
    updateStartFillAvailability();
  } catch (error) {
    addLog("error", `初始化失败：${error.message}`);
    updateStatus("error", "资料加载失败");
  }
});

function initTabs() {
  tabsEl.addEventListener("click", (event) => {
    const tabBtn = event.target.closest(".tab");
    if (!tabBtn) return;
    switchTab(tabBtn.dataset.tab);
  });
}

if (openResumeEditorBtn) {
  openResumeEditorBtn.addEventListener("click", async () => {
    const url = chrome.runtime.getURL("resume-editor.html");
    await chrome.tabs.create({ url });
  });
}

function switchTab(tabKey) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabKey);
  });
  tabFillEl.classList.toggle("active", tabKey === "fill");
  tabResumeEl.classList.toggle("active", tabKey === "resume");
}

function initModalEvents() {
  openSettingsBtn.addEventListener("click", openModal);
  closeSettingsBtn.addEventListener("click", closeModal);
  closeSettingsBackdrop.addEventListener("click", closeModal);
  addModelBtn.addEventListener("click", () => openEditModal());
  closeEditBtn.addEventListener("click", closeEditModal);
  closeEditBackdrop.addEventListener("click", closeEditModal);

  toggleEditApiKeyBtn.addEventListener("click", () => {
    const nextType = editApiKeyInput.type === "password" ? "text" : "password";
    editApiKeyInput.type = nextType;
    toggleEditApiKeyBtn.style.opacity = nextType === "text" ? "1" : "0.6";
  });
}

function initLogExportEvents() {
  selectLogDirectoryBtn.addEventListener("click", async () => {
    if (!logExport.supportsDirectoryPicker()) {
      addLog("error", "当前浏览器不支持项目目录写入");
      return;
    }

    selectLogDirectoryBtn.disabled = true;
    try {
      const rootHandle = await window.showDirectoryPicker({
        id: "resume-log-project-root",
        mode: "readwrite",
      });

      const permission = await logExport.getPermissionState(rootHandle, {
        request: true,
      });
      if (permission !== "granted") {
        throw new Error("目录写入权限未授予");
      }

      await logExport.ensureLogsDirectoryHandle(rootHandle);
      await logExport.saveProjectRootHandle(rootHandle);
      logProjectRootHandle = rootHandle;
      await refreshLogExportStatus();
      addLog(
        "success",
        `诊断日志将自动保存到 ${rootHandle.name}/${logExport.LOGS_DIR_NAME}/`
      );
    } catch (error) {
      if (error?.name === "AbortError") {
        addLog("info", "已取消选择项目目录");
      } else {
        addLog("error", `设置日志目录失败：${error.message}`);
      }
    } finally {
      selectLogDirectoryBtn.disabled = false;
    }
  });
}

async function refreshLogExportStatus() {
  if (!logExport.supportsDirectoryPicker()) {
    logProjectRootHandle = null;
    selectLogDirectoryBtn.disabled = true;
    selectLogDirectoryBtn.textContent = "不支持目录写入";
    logExportStatusEl.textContent =
      "当前浏览器不支持项目目录自动写入。你仍然可以在侧边栏里查看运行日志。";
    return;
  }

  selectLogDirectoryBtn.disabled = false;

  let handle = null;
  try {
    handle = await logExport.loadProjectRootHandle();
  } catch (error) {
    logProjectRootHandle = null;
    selectLogDirectoryBtn.textContent = "选择项目目录";
    logExportStatusEl.textContent = `读取日志目录配置失败：${error.message}`;
    return;
  }

  if (!handle) {
    logProjectRootHandle = null;
    selectLogDirectoryBtn.textContent = "选择项目目录";
    logExportStatusEl.textContent =
      "未配置自动导出。点击“选择项目目录”后，填充诊断日志会自动保存到所选目录下的 debug-logs/。";
    return;
  }

  const permission = await logExport.getPermissionState(handle);
  if (permission !== "granted") {
    logProjectRootHandle = null;
    selectLogDirectoryBtn.textContent = "重新选择项目目录";
    logExportStatusEl.textContent =
      "之前记住的项目目录权限已失效。点击“重新选择项目目录”后，将继续自动保存到 debug-logs/。";
    return;
  }

  logProjectRootHandle = handle;
  selectLogDirectoryBtn.textContent = "重新选择项目目录";
  logExportStatusEl.textContent = `已配置自动导出：${handle.name}/${logExport.LOGS_DIR_NAME}/`;
}

function createFillSession(tab) {
  return {
    id: `fill-${Date.now()}`,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: "running",
    errorMessage: "",
    tab: {
      id: tab?.id ?? null,
      url: tab?.url || "",
      title: tab?.title || "",
    },
    stats: {
      fieldCount: 0,
      mappedCount: 0,
      filledCount: 0,
    },
    logs: [],
  };
}

function beginFillSession(tab) {
  activeFillSession = createFillSession(tab);
}

function recordSessionLog(level, message, timestamp) {
  if (!activeFillSession) return;
  activeFillSession.logs.push({
    level,
    message,
    timestamp,
  });
}

function recordFillSessionStats(fieldCount, mappedCount, filledCount) {
  if (!activeFillSession) return;
  activeFillSession.stats = {
    fieldCount: Number(fieldCount || 0),
    mappedCount: Number(mappedCount || 0),
    filledCount: Number(filledCount || 0),
  };
}

function getCurrentFillStats() {
  return {
    fieldCount: Number(fieldCountEl.textContent || 0),
    mappedCount: Number(mappedCountEl.textContent || 0),
    filledCount: Number(filledCountEl.textContent || 0),
  };
}

async function finalizeFillSession({ status, stats, errorMessage = "" } = {}) {
  if (!activeFillSession) return;

  const session = activeFillSession;
  activeFillSession = null;
  session.endedAt = new Date().toISOString();
  session.status = status || "unknown";
  session.errorMessage = errorMessage;
  session.stats = {
    ...session.stats,
    ...(stats || {}),
  };

  if (!logProjectRootHandle) {
    return;
  }

  try {
    const permission = await logExport.getPermissionState(logProjectRootHandle);
    if (permission !== "granted") {
      logProjectRootHandle = null;
      addLog(
        "warning",
        "项目目录授权已失效，本次未自动保存日志。请重新点击“选择项目目录”。"
      );
      await refreshLogExportStatus();
      return;
    }

    const saved = await logExport.writeSessionLogFile(logProjectRootHandle, session);
    addLog("info", `诊断日志已自动保存到 ${saved.relativePath}`);
  } catch (error) {
    addLog("error", `诊断日志保存失败：${error.message}`);
  }
}

function openModal() {
  settingsModal.classList.add("open");
  renderModelList();
}

function closeModal() {
  settingsModal.classList.remove("open");
}

function openEditModal(modelId = null) {
  editingModelId = modelId;
  editModelModal.classList.add("open");

  if (modelId) {
    editModalTitle.textContent = "编辑模型";
    loadModelForEdit(modelId);
    return;
  }

  editModalTitle.textContent = "添加模型";
  editNameInput.value = "DeepSeek";
  editBaseUrlInput.value = "https://api.deepseek.com/v1";
  editApiKeyInput.value = "";
  editModelInput.value = BUILTIN_MODEL.model;
}

function closeEditModal() {
  editModelModal.classList.remove("open");
  editingModelId = null;
}

async function initModels() {
  await modelStorage.loadModelState();
}

async function getAllModels() {
  const state = await modelStorage.loadModelState();
  return [modelStorage.buildBuiltinModel(state.builtinOverride), ...state.models];
}

async function getActiveModel() {
  const state = await modelStorage.loadModelState();
  const models = await getAllModels();
  const activeId = state.activeModelId || BUILTIN_MODEL.id;
  return models.find((model) => model.id === activeId) || BUILTIN_MODEL;
}

async function renderModelList() {
  const models = await getAllModels();
  const state = await modelStorage.loadModelState();
  const activeId = state.activeModelId || BUILTIN_MODEL.id;

  modelList.innerHTML = models
    .map(
      (model) => `
        <div class="model-item ${model.id === activeId ? "active" : ""}" data-model-id="${escapeHtml(model.id)}">
          <input type="radio" name="activeModel" class="model-radio" value="${escapeHtml(model.id)}" ${
            model.id === activeId ? "checked" : ""
          }>
          <div class="model-info">
            <div class="model-name">
              ${escapeHtml(model.name)}
              ${model.builtin ? '<span class="model-badge">内置</span>' : ""}
            </div>
            <div class="model-meta">${escapeHtml(model.model)}</div>
          </div>
          <div class="model-actions">
              <button class="icon-btn edit-model-btn" data-model-id="${escapeHtml(model.id)}">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
            </button>
            ${
              model.builtin
                ? ""
                : `<button class="icon-btn delete-model-btn" data-model-id="${escapeHtml(model.id)}">
                     <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                   </button>`
            }
          </div>
        </div>
      `
    )
    .join("");

  document.querySelectorAll(".model-item").forEach((item) => {
    item.addEventListener("click", async (event) => {
      if (
        event.target.closest(".edit-model-btn") ||
        event.target.closest(".delete-model-btn")
      ) {
        return;
      }

      const modelId = item.dataset.modelId;
      const model = models.find((entry) => entry.id === modelId);
      await modelStorage.saveActiveModelId(modelId);
      addLog("success", `已切换模型：${model?.name || modelId}`);
      closeModal();
    });
  });

  document.querySelectorAll(".model-radio").forEach((radio) => {
    radio.addEventListener("change", async (event) => {
      event.stopPropagation();
      await modelStorage.saveActiveModelId(event.target.value);
      renderModelList();
    });
  });

  document.querySelectorAll(".edit-model-btn").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openEditModal(event.currentTarget.dataset.modelId);
    });
  });

  document.querySelectorAll(".delete-model-btn").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const modelId = event.currentTarget.dataset.modelId;
      if (!confirm("确定要删除这个模型吗？")) return;

      const state = await modelStorage.loadModelState();
      const modelsWithoutCurrent = state.models.filter(
        (model) => model.id !== modelId
      );

      await modelStorage.saveModelState({
        models: modelsWithoutCurrent,
        builtinOverride: state.builtinOverride,
      });
      if (state.activeModelId === modelId) {
        await modelStorage.saveActiveModelId(BUILTIN_MODEL.id);
      }
      renderModelList();
    });
  });
}

async function loadModelForEdit(modelId) {
  const models = await getAllModels();
  const model = models.find((item) => item.id === modelId);
  if (!model) return;

  editNameInput.value = model.name;
  editBaseUrlInput.value = model.baseUrl;
  editApiKeyInput.value = model.apiKey;
  editModelInput.value = model.model;
}

saveModelBtn.addEventListener("click", async () => {
  const name = editNameInput.value.trim();
  const baseUrl = editBaseUrlInput.value.trim();
  const apiKey = editApiKeyInput.value.trim();
  const model = editModelInput.value.trim();

  if (!name || !baseUrl || !apiKey || !model) {
    showEditStatus("error", "请填写所有配置项");
    return;
  }

  saveModelBtn.disabled = true;
  saveModelBtn.textContent = "保存中...";

  try {
    modelStorage.validateBaseUrl(baseUrl);
    const state = await modelStorage.loadModelState();
    const models = [...state.models];

    if (editingModelId === BUILTIN_MODEL.id) {
      await modelStorage.saveModelState({
        models,
        builtinOverride: { name, baseUrl, apiKey, model },
      });
    } else if (editingModelId) {
      const index = models.findIndex((item) => item.id === editingModelId);
      if (index !== -1) {
        models[index] = { ...models[index], name, baseUrl, apiKey, model };
      }
      await modelStorage.saveModelState({
        models,
        builtinOverride: state.builtinOverride,
      });
    } else {
      models.push({
        id: `custom-${Date.now()}`,
        name,
        baseUrl,
        apiKey,
        model,
        builtin: false,
      });
      await modelStorage.saveModelState({
        models,
        builtinOverride: state.builtinOverride,
      });
    }

    showEditStatus("success", "保存成功");
    setTimeout(() => {
      closeEditModal();
      renderModelList();
    }, 300);
  } catch (error) {
    console.error("[popup] 保存模型配置失败:", error);
    showEditStatus("error", `保存失败：${error.message}`);
  } finally {
    setTimeout(() => {
      saveModelBtn.disabled = false;
      saveModelBtn.textContent = "保存";
    }, 300);
  }
});

function showEditStatus(type, message) {
  editStatus.textContent = message;
  editStatus.className = `config-status ${type}`;
  setTimeout(() => {
    editStatus.textContent = "";
    editStatus.className = "config-status";
  }, 3000);
}

function isModelConfigured(model) {
  return Boolean(model?.baseUrl && model?.apiKey && model?.model);
}

startFillBtn.addEventListener("click", async () => {
  await runFill("overwritePage");
});

startIncrementalFillBtn?.addEventListener("click", async () => {
  await runFill("incrementalPage");
});

startSelectionFillBtn?.addEventListener("click", async () => {
  await runFill("selection");
});

async function runFill(actionKey) {
  if (isFilling || !documentEditor || documentEditor.isBusy()) return;
  const actionConfig = FILL_ACTIONS[actionKey];
  if (!actionConfig) return;
  isFilling = true;
  documentEditor.setBusy(true);
  updateFillActionButtons({ isRunning: true, runningActionKey: actionKey });
  try {
    await documentEditor.ready;
    await documentEditor.save();
    await documentEditor.reload();
    if (!documentEditor.getMarkdown().trim()) {
      addLog("warning", "请先在“个人资料”里填写 Markdown 内容");
      switchTab("resume");
      return;
    }
    const activeModel = await getActiveModel();
    if (!isModelConfigured(activeModel)) {
      addLog("error", "请先在设置中配置模型"); openModal(); return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { addLog("error", "无法获取当前标签页"); return; }
    if (!tab.url) {
      addLog("error", "无法读取当前网页地址，请重新加载扩展后再试"); updateStatus("error", "网页权限不可用"); return;
    }
    if (!isSupportedWebPageUrl(tab.url)) {
      addLog("error", "请切换到要填写的网页（非系统页面）"); updateStatus("error", "系统页面"); return;
    }
    renderFillReport([]);
    fillTipEl.hidden = true;
    updateStatus("running", actionConfig.statusText);
    beginFillSession(tab);
    addLog("info", actionConfig.startLog);
    if (!await ensureContentScriptInjected(tab.id)) {
      throw new Error("页面脚本无法使用或版本过旧，请刷新当前网页后重试");
    }
    const response = await sendTabMessage(tab.id, {
      action: "startFill", modelId: activeModel.id,
      markdown: documentEditor.getMarkdown(),
      fillMode: actionConfig.fillMode,
      scope: actionConfig.scope,
    });
    if (!response?.success) {
      if (response?.canceled) {
        addLog("info", response.message || "已取消"); updateStatus("ready", "已取消");
        await finalizeFillSession({ status: "canceled", stats: getCurrentFillStats() }); return;
      }
      throw new Error(response?.message || "填充失败");
    }
    const stats = { fieldCount: response.fieldCount || 0, mappedCount: response.mappedCount || 0, filledCount: response.filledCount || 0 };
    updateFillStats(stats.fieldCount, stats.mappedCount, stats.filledCount);
    renderFillReport(response.report || []);
    fillTipEl.textContent = buildFillTipText(actionKey); fillTipEl.hidden = false;
    addLog("success", `${actionConfig.doneLog}：识别 ${stats.fieldCount} 个字段，生成答案 ${stats.mappedCount} 个，成功填充 ${stats.filledCount} 个。`);
    updateStatus("ready", "完成");
    await finalizeFillSession({ status: "success", stats });
  } catch (error) {
    addLog("error", `填充失败：${error.message}`); updateStatus("error", "失败");
    if (activeFillSession) await finalizeFillSession({ status: "error", stats: getCurrentFillStats(), errorMessage: error.message });
  } finally {
    isFilling = false; documentEditor.setBusy(false); updateStartFillAvailability();
  }
}

clearMappingCacheBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove(MAPPING_CACHE_KEY);
  addLog("success", "旧版映射缓存已清空；Markdown 答案每次重新生成");
  fillTipEl.hidden = true;
});

function renderFillReport(report) {
  const host = document.getElementById("fillReport");
  host.replaceChildren();
  host.hidden = report.length === 0;
  const statuses = { filled: "已填写", generated: "AI 生成 · 请检查", missing: "待补充", failed: "填写失败", skipped: "已有内容 · 已跳过" };
  for (const item of report) {
    const row = document.createElement("details");
    row.className = "fill-report-item";
    const summary = document.createElement("summary");
    summary.textContent = `${statuses[item.status] || item.status}：${item.sectionLabel ? item.sectionLabel + " / " : ""}${item.label || item.fieldId}`;
    const body = document.createElement("p");
    body.textContent = [item.value != null ? `填写内容：${Array.isArray(item.value) ? item.value.join("、") : item.value}` : "", item.reason || "", item.evidence?.length ? `资料依据：${item.evidence.join("；")}` : ""].filter(Boolean).join("\n");
    row.append(summary, body); host.append(row);
  }
}

function updateFillStats(fieldCount, mappedCount, filledCount) {
  fieldCountEl.textContent = fieldCount;
  mappedCountEl.textContent = mappedCount;
  filledCountEl.textContent = filledCount;
  recordFillSessionStats(fieldCount, mappedCount, filledCount);
}

function updateStartFillAvailability() {
  const hasData = Boolean(documentEditor?.getMarkdown().trim());
  updateFillActionButtons({ hasData, isRunning: isFilling || Boolean(documentEditor?.isBusy()) });
}

function updateFillActionButtons({
  hasData = Boolean(documentEditor?.getMarkdown().trim()),
  isRunning = isFilling,
  runningActionKey = "",
} = {}) {
  const buttonMap = [
    {
      key: "overwritePage",
      button: startFillBtn,
      labelEl: startFillBtnText,
    },
    {
      key: "incrementalPage",
      button: startIncrementalFillBtn,
      labelEl: startIncrementalFillBtnText,
    },
    {
      key: "selection",
      button: startSelectionFillBtn,
      labelEl: startSelectionFillBtnText,
    },
  ];

  for (const item of buttonMap) {
    if (!item.button || !item.labelEl) continue;
    const config = FILL_ACTIONS[item.key];
    const isCurrent = runningActionKey === item.key;
    item.button.disabled = !hasData || isRunning;
    if (!hasData) {
      item.labelEl.textContent = "请先填写个人资料";
    } else if (isCurrent && isRunning) {
      item.labelEl.textContent = config.runningText;
    } else {
      item.labelEl.textContent = config.triggerText;
    }
  }
}

function buildFillTipText(actionKey) {
  const modeLabel =
    actionKey === "incrementalPage"
      ? "增量填入"
      : actionKey === "selection"
        ? "选区填入"
        : "本次填充";

  return `${modeLabel}已根据当前 Markdown 生成答案。请检查 AI 生成内容及待补充项目，然后手动提交。`;
}

function isSupportedWebPageUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch (_) {
    return false;
  }
}

async function ensureContentScriptInjected(tabId) {
  let staleScriptDetected = false;

  try {
    const pong = await sendTabMessage(tabId, { action: "ping" });
    if (contentBridge.contentScriptHasDiagnosticsSupport(pong)) {
      return true;
    }

    if (pong?.success) {
      staleScriptDetected = true;
    }
  } catch (_) {
    // Ignore and inject below when there is no reachable content script.
  }

  if (staleScriptDetected) {
    return false;
  }

  return injectContentScript(tabId);
}

async function injectContentScript(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isSupportedWebPageUrl(tab.url)) {
      return false;
    }

    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content.css"],
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        "shared/form-plan.js",
        "shared/diagnostics.js",
        "shared/field-text.js",
        "shared/field-semantics.js",
        "shared/fill-runtime.js",
        "shared/content-bridge.js",
        "shared/ai-client.js",
        "content.js",
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    const pong = await sendTabMessage(tabId, { action: "ping" });
    return Boolean(contentBridge.contentScriptHasDiagnosticsSupport(pong));
  } catch (error) {
    console.error("[popup] 注入 content script 失败:", error);
    return false;
  }
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response);
    });
  });
}

function updateStatus(type, text) {
  statusDot.className = `status-dot ${type}`;
  statusText.textContent = text;
}

function addLog(type, message) {
  const now = new Date();
  const time = now.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });

  recordSessionLog(type, message, now.toISOString());

  if (!logVisibility.shouldRenderLogInUi(type, message)) {
    return;
  }

  const item = document.createElement("div");
  item.className = `log-item log-${type}`;
  item.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-msg">${escapeHtml(message)}</span>
  `;
  logContent.appendChild(item);
  logContent.scrollTop = logContent.scrollHeight;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

clearLogBtn.addEventListener("click", () => {
  logContent.innerHTML = "";
  addLog("info", "日志已清空");
});

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "log":
      addLog(message.level || "info", message.text || "");
      break;
    case "updateStats":
      updateFillStats(
        message.fieldCount ?? 0,
        message.mappedCount ?? 0,
        message.filledCount ?? 0
      );
      break;
    case "error":
      updateStatus("error", "错误");
      addLog("error", message.text || "未知错误");
      break;
    default:
      break;
  }
});
