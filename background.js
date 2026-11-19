// Background Service Worker
// 统一代理调用 OpenAI 兼容接口（如 DeepSeek），避免侧边栏/内容脚本的 CORS 问题。

importScripts("shared/model-storage.js", "shared/form-plan.js");

// 初始化：点击扩展图标时打开侧边栏
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.action !== "callAI") return;
  if (sender?.id && sender.id !== chrome.runtime.id) return;

  const mode = request.mode || "field_values";
  callAI(request.modelId, request.prompt, mode)
    .then((response) => sendResponse({ success: true, data: response }))
    .catch((error) =>
      sendResponse({ success: false, error: error?.message || String(error) })
    );

  return true; // 保持消息通道，用于异步响应
});

async function callAI(modelId, prompt, mode) {
  const modelStorage = globalThis.ResumeModelStorage;
  if (!modelStorage) {
    throw new Error("模型配置模块未加载，请重新加载扩展");
  }

  const config = await modelStorage.getModelConfig(modelId);
  const { baseUrl, apiKey, model } = config || {};

  if (!baseUrl || !apiKey || !model) {
    throw new Error("模型配置不完整：请检查 Base URL / API Key / 模型ID");
  }

  const url = buildApiUrl(baseUrl);
  const normalizedModel = String(model).trim();
  if (!url.endsWith("/chat/completions")) {
    throw new Error("Base URL 必须指向 API 根路径或 /chat/completions");
  }

  const systemPrompts = { field_values: globalThis.ResumeFormPlan.SYSTEM_PROMPT };

  const system = systemPrompts[mode];
  if (!system) {
    throw new Error(`不支持的 AI 模式：${mode}`);
  }

  const timeoutMs = 120_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: normalizedModel,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: String(prompt || "") },
        ],
      }),
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("API 请求超时：请检查网络/Key/模型是否可用后重试");
    }
    throw new Error(`网络请求失败：${err?.message || String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorText = await response.text();
    let errorMsg = `API 请求失败 (${response.status})`;

    try {
      const errorJson = JSON.parse(errorText);
      const msg = errorJson?.error?.message || errorJson?.message || "";
      if (response.status === 401) {
        errorMsg = "API Key 无效，请检查配置";
      } else if (response.status === 403) {
        errorMsg = "API 访问被拒绝，请检查 Key/权限/余额";
      } else if (response.status === 429) {
        errorMsg = "API 请求过于频繁，请稍后重试";
      } else if ([500, 502, 503].includes(response.status)) {
        errorMsg = "API 服务暂时不可用，请稍后重试";
      } else if (msg) {
        errorMsg = `API 错误：${msg}`;
      }
    } catch (_) {
      // ignore
    }

    console.error("[简历填表助手] API 请求失败:", {
      status: response.status,
      url: sanitizeUrlForLog(url),
      response: redactAndTruncate(errorText),
    });
    throw new Error(errorMsg);
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error("API 返回不是有效 JSON");
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("API 返回格式错误：缺少 choices[0].message.content");
  }
  return content;
}

function buildApiUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(String(baseUrl || "").trim());
  } catch (_) {
    throw new Error("Base URL 不是有效地址");
  }

  const isLocalDevelopmentHost = ["localhost", "127.0.0.1", "::1"].includes(
    parsed.hostname
  );
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalDevelopmentHost)) {
    throw new Error("Base URL 必须使用 HTTPS（本机开发地址可使用 HTTP）");
  }

  parsed.search = "";
  parsed.hash = "";
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path.endsWith("/chat/completions")
    ? path
    : `${path || ""}/chat/completions`;
  return parsed.toString().replace(/\/$/, "");
}

function sanitizeUrlForLog(value) {
  try {
    const parsed = new URL(String(value || ""));
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch (_) {
    return "[invalid-url]";
  }
}

function redactAndTruncate(value, maxLength = 500) {
  return String(value || "")
    .replace(/(authorization|api[-_ ]?key|token|password|secret)\s*[:=]\s*[^,\s}]+/gi, "$1=[redacted]")
    .slice(0, maxLength);
}
