import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Webview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { message } from '@tauri-apps/plugin-dialog';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

// 声明 Tauri 全局对象类型
declare global {
  interface Window {
    __TAURI__?: {
      notification?: {
        sendNotification: (options: { title: string; body: string }) => Promise<void>;
      };
    };
  }
}

type TabRecord = {
  id: string;
  title: string;
  url: string;
  view: Webview | null;
  isDefault?: boolean;
  urlLocked?: boolean;
};

type Bounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const ORIGINAL_DEFAULT_URL = 'https://www.007proxy.uk/dock/login';
const DEFAULT_URL_STORAGE_KEY = 'dock.defaultLoginUrl';

const readStoredDefaultUrl = () => {
  try {
    const stored = localStorage.getItem(DEFAULT_URL_STORAGE_KEY);
    return stored && stored.trim() ? stored.trim() : ORIGINAL_DEFAULT_URL;
  } catch {
    return ORIGINAL_DEFAULT_URL;
  }
};

let DEFAULT_URL = readStoredDefaultUrl();
const appWindow = getCurrentWindow();

// 检测平台并添加类名
const detectPlatform = () => {
  const userAgent = navigator.userAgent.toLowerCase();
  const platformName = navigator.platform.toLowerCase();
  
  if (platformName.includes('win') || userAgent.includes('win')) {
    document.documentElement.classList.add('platform-win32');
    console.log('🖥️ 检测到平台: Windows');
  } else if (platformName.includes('mac') || userAgent.includes('mac')) {
    document.documentElement.classList.add('platform-darwin');
    console.log('🖥️ 检测到平台: macOS');
  } else if (platformName.includes('linux') || userAgent.includes('linux')) {
    document.documentElement.classList.add('platform-linux');
    console.log('🖥️ 检测到平台: Linux');
  }
};

// 立即执行平台检测
detectPlatform();

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('根节点 #app 缺失');
}

app.innerHTML = `
  <div class="app-shell">
    <header class="toolbar">
      <div class="tabs" id="tab-list"></div>
      <button type="button" id="settings-btn" class="tab add settings-btn" aria-label="设置默认登录地址" title="设置默认登录地址">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </button>
      <button type="button" id="add-tab" class="tab add" aria-label="新建页签">+</button>
    </header>
    <section class="webview-container">
      <div id="viewport" class="viewport">
        <p class="viewport__placeholder">创建页签后，页面会在这里加载。</p>
        <div class="viewport__loading" id="viewport-loading" aria-hidden="true">
          <span class="spinner" aria-hidden="true"></span>
          <span class="viewport__loading-text">加载中…</span>
        </div>
      </div>
    </section>
    <div class="modal-overlay" id="settings-modal" aria-hidden="true">
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="设置默认登录地址">
        <h3 class="modal-title">设置默认登录地址</h3>
        <input type="text" id="settings-url-input" class="address-input modal-input" placeholder="https://www.example.com/dock/login" spellcheck="false" autocomplete="off" />
        <div class="modal-actions">
          <button type="button" id="settings-reset" class="modal-btn modal-btn--reset">重置</button>
          <button type="button" id="settings-save" class="modal-btn modal-btn--save">保存</button>
        </div>
      </div>
    </div>
  </div>
`;

const viewportEl = document.querySelector<HTMLDivElement>('#viewport')!;
const viewportLoadingEl = document.querySelector<HTMLDivElement>('#viewport-loading')!;
const tabListEl = document.querySelector<HTMLDivElement>('#tab-list')!;
const addTabBtn = document.querySelector<HTMLButtonElement>('#add-tab')!;
const settingsBtnEl = document.querySelector<HTMLButtonElement>('#settings-btn')!;
const settingsModalEl = document.querySelector<HTMLDivElement>('#settings-modal')!;
const settingsInputEl = document.querySelector<HTMLInputElement>('#settings-url-input')!;
const settingsSaveBtnEl = document.querySelector<HTMLButtonElement>('#settings-save')!;
const settingsResetBtnEl = document.querySelector<HTMLButtonElement>('#settings-reset')!;

const tabs: TabRecord[] = [];
let activeTabId: string | null = null;
const urlWatchers = new Map<string, number>();

// 初始化通知权限
const initNotificationPermission = async () => {
  try {
    // 先检查权限状态
    const permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      console.log('📢 请求通知权限...');
      const permission = await requestPermission();
      if (permission === 'granted') {
        console.log('✅ 通知权限已授予');
      } else {
        console.warn('⚠️ 通知权限被拒绝:', permission);
      }
    } else {
      console.log('✅ 通知权限已授予');
    }
  } catch (error) {
    console.warn('⚠️ 通知权限问题:', error);
  }
};

const getViewportBounds = (): Bounds => {
  const rect = viewportEl.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
};

const refreshViewportBounds = () => {
  tabs.forEach((tab) => {
    void syncBounds(tab);
  });
};

const resizeObserver = new ResizeObserver(() => {
  refreshViewportBounds();
});
resizeObserver.observe(viewportEl);
window.addEventListener('resize', refreshViewportBounds);

const randomId = () => {
  const coreId =
    typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `tab-${coreId}`;
};

const ensureProtocol = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  // 允许省略 http/https，但必须像域名或主机名的格式
  const patched = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(patched);

    const host = url.hostname;
    // 简单域名/主机名校验：
    // - 允许 localhost
    // - 允许 IPv4
    // - 允许常见域名（a.b、a.b.c 等）
    const isLocalhost = host === 'localhost';
    const isIPv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
    const isDomain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host);

    if (!isLocalhost && !isIPv4 && !isDomain) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
};

const computeTitle = (url: string, order: number) => {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return hostname || `页签 ${order}`;
  } catch {
    return `页签 ${order}`;
  }
};

const getActiveTab = () => (activeTabId ? tabs.find((tab) => tab.id === activeTabId) ?? null : null);

const hasEditableTab = () => tabs.some((tab) => !tab.isDefault && !tab.urlLocked);

const renderTabs = () => {
  tabListEl.innerHTML = tabs
    .map((tab) => {
      const isActive = activeTabId === tab.id;
      const isDefault = !!tab.isDefault;
      const isEditable = isActive && !tab.urlLocked && !isDefault;
      const displayTitle = tab.title || '新标签页';

      return `
      <div class="tab ${isActive ? 'active' : ''}" data-tab-id="${tab.id}">
        ${isEditable
          ? `<input type="text" class="tab-input" value="${tab.url ?? ''}" placeholder="输入或粘贴链接" />
             <button type="button" class="tab-go" aria-label="加载">
               <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                 <path d="M3 8H13M13 8L9 4M13 8L9 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
               </svg>
             </button>`
          : `<span class="tab-title">${displayTitle}</span>`
        }
        ${isDefault ? '' : '<button type="button" class="tab-close" aria-label="关闭标签页">&times;</button>'}
      </div>
    `;
    })
    .join('');

  // 存在编辑态标签时，禁用右侧新增按钮
  addTabBtn.disabled = hasEditableTab();
};

const updateButtonsState = (_tab: TabRecord | null) => {
  // 顶部地址栏已移除，这里保持空实现以兼容原有调用。
};

const syncViewportState = () => {
  if (tabs.length > 0) {
    viewportEl.dataset.loaded = 'true';
  } else {
    delete viewportEl.dataset.loaded;
  }
};

const setLoading = (loading: boolean) => {
  if (loading) {
    viewportLoadingEl.classList.add('open');
    viewportLoadingEl.setAttribute('aria-hidden', 'false');
  } else {
    viewportLoadingEl.classList.remove('open');
    viewportLoadingEl.setAttribute('aria-hidden', 'true');
  }
};

const syncBounds = async (tab: TabRecord) => {
  if (!tab.view) return;
  const bounds = getViewportBounds();
  await tab.view.setPosition(new LogicalPosition(bounds.x, bounds.y));
  await tab.view.setSize(new LogicalSize(bounds.width, bounds.height));
};

// 轮询子 webview 的 document.readyState，加载完成（或超时）后再展示，避免白屏
const waitForWebviewLoad = (view: Webview, timeoutMs = 12000) =>
  new Promise<void>((resolve) => {
    const startedAt = Date.now();
    const tick = async () => {
      try {
        const ready = (await (view as any).eval('document.readyState')) as string;
        if (ready === 'complete') {
          resolve();
          return;
        }
      } catch {
        // webview 尚未就绪，忽略后继续轮询
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve();
        return;
      }
      window.setTimeout(tick, 200);
    };
    window.setTimeout(tick, 150);
  });

// 通过 Rust 侧命令创建子 webview：只有这样才能在构建时挂上 on_download 下载处理器，
// 页面里的下载（图片/视频/文件）才会弹出"另存为"对话框。JS 的 new Webview(...) 不行。
const instantiateView = async (id: string, url: string, shouldFocus: boolean) => {
  const bounds = getViewportBounds();

  await invoke('create_tab_webview', {
    label: id,
    url,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width || 1280,
    height: bounds.height || 720,
  });

  const view = await Webview.getByLabel(id);
  if (!view) {
    throw new Error(`webview ${id} not found after creation`);
  }

  view.once('tauri://error', () => {
    const target = tabs.find((tab) => tab.id === id);
    if (target?.isDefault) {
      return;
    }
    const removed = detachTab(id);
    removed?.view?.close();
  });

  if (!shouldFocus) {
    void view.hide().catch(() => undefined);
  }

  return view;
};

// 创建子 webview：始终先隐藏，加载完成（显示 loading）后再显示，避免加载期间白屏
const presentWebview = async (tab: TabRecord, url: string) => {
  const isActive = tab.id === activeTabId;
  tab.view = await instantiateView(tab.id, url, false);

  if (!isActive || !tab.view) {
    tab.view?.hide().catch(() => undefined);
    return;
  }

  setLoading(true);
  try {
    await syncBounds(tab);
    await waitForWebviewLoad(tab.view);
  } finally {
    setLoading(false);
  }
  await tab.view.show().catch(() => undefined);
  await tab.view.setFocus().catch(() => undefined);
};

const setActiveTab = async (id: string | null) => {
  if (id === activeTabId) {
    return;
  }

  const previousTab = getActiveTab();
  if (previousTab && previousTab.view) {
    await previousTab.view.hide().catch(() => undefined);
  }

  activeTabId = id;
  const tab = getActiveTab();

  if (tab && tab.view) {
    await syncBounds(tab);
    await tab.view.show().catch(() => undefined);
    await tab.view.setFocus().catch(() => undefined);
  }

  renderTabs();
  updateButtonsState(tab);
  syncViewportState();
};

const detachTab = (id: string) => {
  const idx = tabs.findIndex((tab) => tab.id === id);
  if (idx === -1) return null;
  const target = tabs[idx];
  if (target?.isDefault) {
    return null;
  }
  cleanupUrlWatcher(id);
  const [tab] = tabs.splice(idx, 1);
  syncViewportState();
  const nextTarget = tabs[idx] ?? tabs[idx - 1] ?? null;
  if (activeTabId === id) {
    void setActiveTab(nextTarget ? nextTarget.id : null);
  } else {
    renderTabs();
  }
  return tab;
};

const recreateTabView = async (tab: TabRecord, targetUrl: string) => {
  cleanupUrlWatcher(tab.id);

  if (tab.view) {
    await tab.view.hide().catch(() => undefined);
    await tab.view.close().catch(() => undefined);
  }

  applyTabUrl(tab, targetUrl);
  await presentWebview(tab, targetUrl);
  startUrlWatcher(tab);
};

const loadUrlInTab = async (tab: TabRecord, url: string) => {
  try {
    const finalUrl = ensureProtocol(url);
    if (!finalUrl) {
      await message('请输入合法的网址', { title: '提示', kind: 'warning' });
      return;
    }

    await recreateTabView(tab, finalUrl);
    tab.url = finalUrl;
    tab.urlLocked = true;

    renderTabs();
  } catch (error) {
    console.error('加载URL失败:', error);
    await message('页面加载失败，请检查网址。', { title: '错误', kind: 'error' });
  }
};

const createTab = async () => {
  try {
    const id = randomId();
    const isFirst = tabs.length === 0;

    // 1. 先创建并渲染标签，保证默认标签始终可见
    const tab: TabRecord = {
      id,
      title: isFirst ? '智能客服' : '新标签页',
      url: isFirst ? DEFAULT_URL : '',
      view: null,
      isDefault: isFirst,
      urlLocked: isFirst ? true : false,
    };

    tabs.push(tab);
    await setActiveTab(id);
    renderTabs();
    updateButtonsState(tab);
    syncViewportState();

    // 2. 对默认标签，再异步创建 Webview；即使失败也不影响标签本身显示
    if (isFirst) {
      try {
        await presentWebview(tab, DEFAULT_URL);
        startUrlWatcher(tab);
      } catch (viewError) {
        setLoading(false);
        console.error('默认标签 Webview 创建失败:', viewError);
      }
    }
  } catch (error) {
    console.error('创建标签页失败:', error);
  }
};

const cleanupUrlWatcher = (id: string) => {
  const handle = urlWatchers.get(id);
  if (handle) {
    window.clearInterval(handle);
    urlWatchers.delete(id);
  }
};

const pollTabUrl = async (tab: TabRecord) => {
  if (!tab.view) return;
  try {
    const latest = (await (tab.view as any).eval(
      '({ href: window.location.href, title: document.title || "" })'
    )) as { href: string; title: string };

    if (latest && typeof latest.href === 'string' && latest.href) {
      applyTabUrl(tab, latest.href, latest.title);
    }
  } catch {
    // ignore cross-origin / timing errors
  }
};

const startUrlWatcher = (tab: TabRecord) => {
  cleanupUrlWatcher(tab.id);
  const poll = () => {
    void pollTabUrl(tab);
  };
  const handle = window.setInterval(poll, 1500);
  urlWatchers.set(tab.id, handle);
  poll();
};

const applyTabUrl = (tab: TabRecord, nextUrl: string, pageTitle?: string) => {
  // 默认首个标签使用固定名称与地址，不跟随页面跳转更新
  if (tab.isDefault) {
    return;
  }
  if (!nextUrl || tab.url === nextUrl) {
    return;
  }
  tab.url = nextUrl;
  const order = tabs.findIndex((item) => item.id === tab.id);
  // 优先使用页面的 document.title，缺失时再退回到基于 URL 的标题
  tab.title = pageTitle && pageTitle.trim().length > 0
    ? pageTitle.trim()
    : computeTitle(nextUrl, order >= 0 ? order + 1 : 1);
  renderTabs();
};

const updateActiveTabUrl = async (url: string) => {
  const tab = getActiveTab();
  if (!tab) return;
  await recreateTabView(tab, url);
  tab.urlLocked = true;
  if (tab.id === activeTabId) {
    updateButtonsState(tab);
  }
};

const refreshActiveTab = async () => {
  const tab = getActiveTab();
  if (!tab || tab.isDefault || !tab.url) return;
  await recreateTabView(tab, tab.url);
};

const closeTab = async (id: string) => {
  const tab = tabs.find((item) => item.id === id);
  if (!tab || tab.isDefault) return;
  if (tab.view) {
    await tab.view.close().catch(() => undefined);
  }
  detachTab(id);
};

const closeActiveTab = async () => {
  if (!activeTabId) return;
  await closeTab(activeTabId);
};

const showUrlError = async () => {
  await message('请输入合法的网址', { title: '提示', kind: 'warning' });
};

const reloadDefaultTab = async (url: string) => {
  const defaultTab = tabs.find((tab) => tab.isDefault);
  if (!defaultTab) return;
  defaultTab.url = url;
  await recreateTabView(defaultTab, url).catch((error) => {
    console.error('重载默认标签失败:', error);
  });
};

// 子 webview 是叠在主窗口之上的原生窗口，弹窗期间需要全部隐藏，否则会被遮住
const hideAllWebviews = () =>
  Promise.all(
    tabs.map((tab) => (tab.view ? tab.view.hide().catch(() => undefined) : Promise.resolve()))
  );

const showActiveWebview = async () => {
  const active = getActiveTab();
  if (!active?.view) return;
  await syncBounds(active);
  await active.view.show().catch(() => undefined);
  await active.view.setFocus().catch(() => undefined);
};

// ==== 易歪歪 Clipboard Bridge（仅 Windows 会收到事件，macOS 走系统原生行为）====
// Rust 侧监听到"失焦期间易歪歪写入剪贴板"后 emit `clipboard-quick-reply`，
// 这里把文本插入活动页签的输入框（光标处追加，不覆盖已有内容）。
const isSettingsModalOpen = () => settingsModalEl.classList.contains('open');

// 注入外部页面的插入脚本。IIFE + 表达式返回，兼容 (view as any).eval 模式（见 pollTabUrl）。
// 文本经 JSON.stringify 内嵌，任意引号/换行/unicode 均安全。
const buildQuickReplyInsertScript = (text: string) => `
(() => {
  const isEditable = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'search', 'url', 'tel', 'email', ''].includes(t);
    }
    if (tag === 'TEXTAREA') return true;
    return el.isContentEditable === true;
  };
  // 目标：当前聚焦的可编辑元素，否则退回 MEDIA_FIX_SCRIPT 追踪的最近输入框
  const tracked = window.__yyLastEditable;
  const target = isEditable(document.activeElement)
    ? document.activeElement
    : (isEditable(tracked) && tracked.isConnected ? tracked : null);
  if (!target) return JSON.stringify({ ok: false, reason: 'no-editable' });
  try { target.focus(); } catch (e) {}
  const text = ${JSON.stringify(text)};
  // 首选 execCommand：触发原生 input 事件，React/Vue 受控组件能正常同步状态
  let inserted = false;
  try { inserted = document.execCommand('insertText', false, text); } catch (e) {}
  if (!inserted) {
    if (typeof target.setRangeText === 'function') {
      // <input>/<textarea> 降级：光标处拼接 + 手动派发 input 事件
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      target.setRangeText(text, start, end, 'end');
      target.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      inserted = true;
    } else if (target.isContentEditable) {
      // contenteditable 降级：Range 插入文本节点 + 派发 input 事件
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        range.collapse(false);
        target.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
        inserted = true;
      }
    }
  }
  return JSON.stringify({ ok: inserted, tag: target.tagName });
})()
`;

const initQuickReplyListener = async () => {
  await listen<{ text: string }>('clipboard-quick-reply', async (event) => {
    console.log('[YY-DEBUG] Frontend received clipboard-quick-reply (len=%d)', event.payload.text.length);
    // 守卫 1：设置弹窗打开 → 忽略
    if (isSettingsModalOpen()) {
      console.log('[YY-DEBUG] skip: settings modal open');
      return;
    }
    // 守卫 2：无活动页签 / webview 未就绪 → 忽略
    const tab = getActiveTab();
    if (!tab?.view) {
      console.log('[YY-DEBUG] skip: no active tab');
      return;
    }
    try {
      const result = await (tab.view as any).eval(buildQuickReplyInsertScript(event.payload.text));
      console.log('[YY-DEBUG] insert result:', String(result).slice(0, 120));
      // 诊断信号：系统通知告知链路已通（结果可能是 no-editable，内容见通知）
      void sendNotification({
        title: 'YY-Bridge 收到快捷回复',
        body: String(result).slice(0, 80),
      });
    } catch (error) {
      console.warn('[YY-DEBUG] insert eval failed:', error);
      void sendNotification({
        title: 'YY-Bridge 插入失败',
        body: String(error).slice(0, 80),
      });
    }
  });
  console.log('[YY-DEBUG] clipboard-quick-reply listener installed');
};

const hideSettingsModal = () => {
  settingsModalEl.classList.remove('open');
  settingsModalEl.setAttribute('aria-hidden', 'true');
};

const openSettingsModal = async () => {
  settingsInputEl.value = DEFAULT_URL;
  await hideAllWebviews();
  settingsModalEl.classList.add('open');
  settingsModalEl.setAttribute('aria-hidden', 'false');
  settingsInputEl.focus();
  settingsInputEl.select();
};

const closeSettingsModal = async () => {
  hideSettingsModal();
  await showActiveWebview();
};

const saveDefaultUrl = async () => {
  const finalUrl = ensureProtocol(settingsInputEl.value);
  if (!finalUrl) {
    await message('请输入合法的网址', { title: '提示', kind: 'warning' });
    return;
  }
  DEFAULT_URL = finalUrl;
  try {
    localStorage.setItem(DEFAULT_URL_STORAGE_KEY, finalUrl);
  } catch (error) {
    console.warn('保存默认登录地址失败:', error);
  }
  hideSettingsModal();
  await reloadDefaultTab(finalUrl);
  await showActiveWebview();
};

const resetDefaultUrl = async () => {
  DEFAULT_URL = ORIGINAL_DEFAULT_URL;
  try {
    localStorage.removeItem(DEFAULT_URL_STORAGE_KEY);
  } catch (error) {
    console.warn('重置默认登录地址失败:', error);
  }
  hideSettingsModal();
  await reloadDefaultTab(ORIGINAL_DEFAULT_URL);
  await showActiveWebview();
};

addTabBtn.addEventListener('click', () => {
  void createTab();
});

settingsBtnEl.addEventListener('click', openSettingsModal);
settingsSaveBtnEl.addEventListener('click', () => {
  void saveDefaultUrl();
});
settingsResetBtnEl.addEventListener('click', () => {
  void resetDefaultUrl();
});
settingsModalEl.addEventListener('click', (event) => {
  if (event.target === settingsModalEl) {
    void closeSettingsModal();
  }
});
settingsInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void saveDefaultUrl();
  } else if (event.key === 'Escape') {
    void closeSettingsModal();
  }
});

// 添加全局测试函数，可以在控制台直接调用
(window as any).sendTestNotification = async () => {
  console.log('==========================================');
  console.log('发送测试通知...');
  console.log('==========================================');
  try {
    await sendNotification({
      title: '007 Desk 测试通知',
      body: '这是一条测试通知消息！'
    });
    console.log('✅ 通知发送成功！请查看屏幕右上角');
    return '成功';
  } catch (error) {
    console.error('❌ 通知发送失败:', error);
    return '失败: ' + error;
  }
};

console.log('==========================================');
console.log('📝 使用说明：');
console.log('在控制台执行: sendTestNotification()');
console.log('即可发送测试通知');
console.log('==========================================');

// 禁用菜单栏的右键菜单
document.addEventListener('contextmenu', (event) => {
  const target = event.target as HTMLElement;
  // 如果在 toolbar 区域，阻止右键菜单
  if (target.closest('.toolbar')) {
    event.preventDefault();
  }
});

tabListEl.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;

  const closeBtn = target.closest<HTMLButtonElement>('.tab-close');
  if (closeBtn) {
    const tabEl = closeBtn.closest<HTMLDivElement>('.tab[data-tab-id]');
    const id = tabEl?.dataset.tabId;
    if (id) {
      const targetTab = tabs.find((tab) => tab.id === id);
      if (targetTab?.isDefault) {
        return;
      }
      event.stopPropagation();
      void closeTab(id);
    }
    return;
  }

  const goBtn = target.closest<HTMLButtonElement>('.tab-go');
  if (goBtn) {
    const tabEl = goBtn.closest<HTMLDivElement>('.tab[data-tab-id]');
    const id = tabEl?.dataset.tabId;
    if (!id) return;
    const tab = tabs.find((item) => item.id === id);
    if (!tab) return;
    const input = tabEl.querySelector<HTMLInputElement>('.tab-input');
    const value = input?.value ?? '';
    void loadUrlInTab(tab, value);
    return;
  }

  const tabButton = target.closest<HTMLDivElement>('.tab[data-tab-id]');
  if (!tabButton) return;
  const id = tabButton.dataset.tabId;
  if (!id) return;
  void setActiveTab(id);
});

// 测试通知
(window as any).testNotify = async () => {
  console.log('==========================================');
  console.log('📤 发送测试通知...');
  try {
    await sendNotification({
      title: '007 Desk 测试通知',
      body: '这是一条测试消息'
    });
    console.log('✅ 通知已发送');
    return '已发送';
  } catch (error: any) {
    console.error('❌ 失败:', error);
    return '失败: ' + error.message;
  }
};

// 初始化
console.log('🚀 应用初始化开始...');
console.log('💡 在主窗口控制台执行: testNotify()');
void initNotificationPermission();
refreshViewportBounds();
void initQuickReplyListener();
void createTab();
console.log('✅ 应用初始化完成');

