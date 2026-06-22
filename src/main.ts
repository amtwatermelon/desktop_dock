import './style.css';
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

const DEFAULT_URL = 'https://www.007chats.xyz/dock/login';
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
      <button type="button" id="add-tab" class="tab add" aria-label="新建页签">+</button>
    </header>
    <section class="webview-container">
      <div id="viewport" class="viewport">
        <p class="viewport__placeholder">创建页签后，页面会在这里加载。</p>
      </div>
    </section>
  </div>
`;

const viewportEl = document.querySelector<HTMLDivElement>('#viewport')!;
const tabListEl = document.querySelector<HTMLDivElement>('#tab-list')!;
const addTabBtn = document.querySelector<HTMLButtonElement>('#add-tab')!;

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

const syncBounds = async (tab: TabRecord) => {
  if (!tab.view) return;
  const bounds = getViewportBounds();
  await tab.view.setPosition(new LogicalPosition(bounds.x, bounds.y));
  await tab.view.setSize(new LogicalSize(bounds.width, bounds.height));
};

const instantiateView = (id: string, url: string, shouldFocus: boolean) => {
  const bounds = getViewportBounds();
  
  const view = new Webview(appWindow, id, {
    url,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width || 1280,
    height: bounds.height || 720,
    focus: shouldFocus,
  });

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

  const isActive = tab.id === activeTabId;
  tab.view = instantiateView(tab.id, targetUrl, isActive);
  applyTabUrl(tab, targetUrl);
  startUrlWatcher(tab);

  if (isActive && tab.view) {
    await syncBounds(tab);
    await tab.view.show().catch(() => undefined);
    await tab.view.setFocus().catch(() => undefined);
  } else if (tab.view) {
    await tab.view.hide().catch(() => undefined);
  }
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
        tab.view = instantiateView(id, DEFAULT_URL, true);
        await syncBounds(tab);
        startUrlWatcher(tab);
      } catch (viewError) {
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

addTabBtn.addEventListener('click', () => {
  void createTab();
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
void createTab();
console.log('✅ 应用初始化完成');

