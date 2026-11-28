/* Shared FlyBot management shell. Enhances chrome only; does not invent
   data, hide functional notes, or replace page APIs or form IDs. */
function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

function currentPath() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  return path;
}

function markNavigation() {
  const here = currentPath();
  const related = here === '/skills' ? '/agents'
    : here === '/memory' && new URLSearchParams(location.search).get('page') === 'todos' ? '/automations' : null;
  for (const link of document.querySelectorAll('nav a[href]')) {
    if (link.closest('.brand-mark, .catalog-tabs, .memory-views')) continue;
    const href = link.getAttribute('href') || '';
    if (!href.startsWith('/')) continue;
    const target = href.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
    const works = (value) => value === '/space' || value === '/artifacts';
    const inSubpage = ['/settings', '/profile'].includes(target) && here.startsWith(target + '/');
    const relatedEntry = target === related && link.matches('.rail-actions > a, .mobile-primary-nav > a');
    if (target === here || inSubpage || (works(target) && works(here))) link.setAttribute('aria-current', 'page');
    else if (relatedEntry) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
  const account = document.getElementById('account-menu-button');
  if (/^\/(profile|settings)(\/|$)/.test(here)) account?.setAttribute('aria-current', 'location');
  else account?.removeAttribute('aria-current');
}

const primaryNavigationLabels = {
  '/chat': ['聊天', 'Chats'],
  '/agents': ['智能体', 'Agents'],
  '/automations': ['任务', 'Tasks'],
  '/discover': ['发现', 'Discover'],
  '/space': ['资料空间', 'Space'],
};

function updateNavigationLanguage(doc, language) {
  const nav = doc.querySelector('.mobile-primary-nav');
  const english = language === 'en';
  const locale = english ? 'en' : 'zh-CN';
  if (nav) {
    if (doc.documentElement.lang === locale) nav.removeAttribute('lang');
    else nav.setAttribute('lang', locale);
    nav.setAttribute('aria-label', english ? 'Main navigation' : '主导航');
  }
  for (const link of doc.querySelectorAll('.app-rail .rail-actions > a, .mobile-primary-nav > a')) {
    const labels = primaryNavigationLabels[link.getAttribute('href')];
    if (!labels) continue;
    const title = labels[english ? 1 : 0];
    link.setAttribute('title', title);
    link.setAttribute('aria-label', title);
    const label = link.querySelector('.rail-label');
    if (label) label.textContent = title;
  }
  const accountLabel = doc.querySelector('.mobile-account-label');
  if (accountLabel) accountLabel.textContent = english ? 'Account' : '账户';
}

function bindMobileNavigation(doc) {
  const rail = doc.querySelector('.app-rail');
  if (!rail) return;
  let nav = doc.querySelector('.mobile-primary-nav');
  if (!nav && doc.body.classList.contains('app-primary')) {
    nav = doc.createElement('nav');
    nav.className = 'mobile-primary-nav';
    doc.body.appendChild(nav);
  }
  if (!nav || nav.dataset.bound === '1') return;
  nav.dataset.bound = '1';
  const links = rail.querySelectorAll('.rail-actions > a[href]');
  nav.append(...Array.from(links, link => link.cloneNode(true)));
  const slot = rail.querySelector('.account-slot');
  const account = doc.getElementById('account-menu-button');
  const menu = doc.getElementById('account-menu');
  const appearance = doc.getElementById('appearance-toggle');
  if (account && slot && menu) {
    const label = doc.createElement('span');
    label.className = 'mobile-account-label';
    account.appendChild(label);
    const media = doc.defaultView?.matchMedia?.('(max-width: 700px)');
    const arrange = () => {
      closeAccountMenu(doc);
      if (media?.matches) {
        nav.appendChild(slot);
        if (appearance) {
          menu.insertBefore(appearance, menu.querySelector('#logout-form'));
          appearance.setAttribute('role', 'menuitem');
        }
      } else {
        rail.appendChild(slot);
        if (appearance) {
          rail.appendChild(appearance);
          appearance.removeAttribute('role');
        }
      }
    };
    media?.addEventListener('change', arrange);
    arrange();
  }
  updateNavigationLanguage(doc, doc.documentElement.lang);
}

/* The account stores no location, so「日落到日出」has no sunrise to read. Until one exists, the
   automatic look falls back to a fixed night window: 22:00 inclusive to 06:00 exclusive is dark.
   A `custom` window keeps the times the account chose and stays ahead of this fallback. */
export const NIGHT_WINDOW = {start: '22:00', end: '06:00'};

function minutes(value) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)/.exec(String(value || ''));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function resolveTheme(values, now = new Date(), media) {
  const appearance = values && values.appearance ? values.appearance : 'system';
  if (appearance === 'light' || appearance === 'dark') return appearance;
  if (appearance === 'auto') {
    const custom = values.appearance_schedule === 'custom';
    const start = minutes(custom ? values.appearance_start : NIGHT_WINDOW.start);
    const end = minutes(custom ? values.appearance_end : NIGHT_WINDOW.end);
    if (start != null && end != null && start !== end) {
      const current = now.getHours() * 60 + now.getMinutes();
      const inRange = start < end ? current >= start && current < end : current >= start || current < end;
      return inRange ? 'dark' : 'light';
    }
  }
  const query = media || (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null);
  return query && query.matches ? 'dark' : 'light';
}

export function applyResolvedTheme(doc, values, now, media) {
  const theme = resolveTheme(values, now, media);
  doc.documentElement.dataset.themeResolved = theme;
  if (doc.body) doc.body.dataset.themeResolved = theme;
  return theme;
}

function looksLoading(text) {
  return /加载|载入|正在|请稍候|等待/.test(text || '');
}

function decorateStatus(node) {
  if (!node) return;
  const text = (node.textContent || '').trim();
  if (!text) {
    node.removeAttribute('data-kind');
    document.body.removeAttribute('aria-busy');
    return;
  }
  if (!node.getAttribute('data-kind') && looksLoading(text)) {
    node.setAttribute('data-kind', 'loading');
  }
  if (node.getAttribute('data-kind') === 'loading' || looksLoading(text)) {
    document.body.setAttribute('aria-busy', 'true');
  } else {
    document.body.removeAttribute('aria-busy');
  }
}

async function loadSettings() {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 3000) : null;
  try {
    const response = await fetch('/v1/settings', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie) },
      signal: controller ? controller.signal : undefined,
    });
    if (!response.ok) return null;
    const body = await response.json();
    const settings = body && body.settings;
    if (!settings) return null;
    return { values: settings.values || {}, revision: settings.revision || 0 };
  } catch (error) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function accountNameFromLabel(text, dataset) {
  if (dataset && dataset.username) return String(dataset.username).trim();
  const raw = String(text || '').trim();
  return raw.replace(/^(已登录为|已登录)\s*[:：]?\s*/, '');
}

function signedInPanel(doc) {
  return doc.getElementById('settings-panel') || doc.getElementById('main-panel');
}

function closeAccountMenu(doc) {
  const menu = doc.getElementById('account-menu');
  const button = doc.getElementById('account-menu-button');
  const help = doc.getElementById('help-menu');
  const helpButton = doc.getElementById('help-menu-button');
  if (menu) menu.setAttribute('hidden', '');
  if (button) button.setAttribute('aria-expanded', 'false');
  if (help) help.setAttribute('hidden', '');
  if (helpButton) helpButton.setAttribute('aria-expanded', 'false');
}

function syncAccountSlot(doc) {
  const slot = doc.querySelector('.account-slot');
  const panel = signedInPanel(doc);
  if (!slot) return;
  const who = doc.getElementById('whoami');
  const name = accountNameFromLabel(who ? who.textContent : '', who ? who.dataset : null);
  const visible = Boolean(panel && !panel.hasAttribute('hidden') && (!panel.hasAttribute('data-guest-access') || name));
  if (visible) slot.removeAttribute('hidden');
  else {
    slot.setAttribute('hidden', '');
    closeAccountMenu(doc);
  }
  const identity = doc.getElementById('account-identity');
  if (identity) identity.textContent = name;
  for (const node of doc.querySelectorAll('.rail-signed-in')) {
    if (visible) node.removeAttribute('hidden');
    else node.setAttribute('hidden', '');
  }
}


export const CHANNELS_MENU_HREF = '/settings/channels';
export const CHANNELS_MENU_LABEL = 'Agent 渠道';
export const CHANNELS_MENU_TITLE = '打开智能体渠道设置';

export const CONNECTORS_MENU_HREF = '/settings/connectors';
export const CONNECTORS_MENU_LABEL = '应用连接器';
export const CONNECTORS_MENU_TITLE = '管理应用连接器';

function menuChildByHref(menu, href) {
  const children = menu && menu.children ? Array.from(menu.children) : [];
  return children.find((node) => {
    const tag = (node.tagName || '').toLowerCase();
    const value = (node.getAttribute && node.getAttribute('href')) || node.href || '';
    return tag === 'a' && value === href;
  }) || null;
}

function menuChildByClass(menu, className) {
  const children = menu && menu.children ? Array.from(menu.children) : [];
  return children.find((node) => {
    const current = ' ' + (node.className || node.getAttribute && node.getAttribute('class') || '') + ' ';
    return current.includes(' ' + className + ' ');
  }) || null;
}

function ensureMenuLink(doc, menu, href, label, title) {
  let link = menuChildByHref(menu, href);
  if (!link) {
    link = doc.createElement('a');
    menu.appendChild(link);
  }
  link.setAttribute('href', href);
  link.setAttribute('role', 'menuitem');
  link.setAttribute('title', title);
  link.textContent = label;
  return link;
}

function placeMenuLink(menu, link, reference) {
  if (reference && link !== reference) menu.insertBefore(link, reference);
  else menu.appendChild(link);
  return link;
}

export function ensureChannelsAndConnectorsMenuItems(doc) {
  const menu = doc.getElementById('account-menu');
  if (!menu) return null;
  const channels = ensureMenuLink(doc, menu, CHANNELS_MENU_HREF, CHANNELS_MENU_LABEL, CHANNELS_MENU_TITLE);
  const connectors = ensureMenuLink(doc, menu, CONNECTORS_MENU_HREF, CONNECTORS_MENU_LABEL, CONNECTORS_MENU_TITLE);
  const before = menuChildByClass(menu, 'account-sub') || menuChildByHref(menu, '/settings');
  placeMenuLink(menu, connectors, before);
  placeMenuLink(menu, channels, connectors);
  return {channels, connectors};
}

function bindAccountMenu(doc) {
  const button = doc.getElementById('account-menu-button');
  const menu = doc.getElementById('account-menu');
  if (!button || !menu || button.dataset.bound === '1') return;
  button.dataset.bound = '1';
  const items = () => [...menu.querySelectorAll('a[href], button:not(:disabled)')]
    .filter(item => item.getClientRects().length > 0);
  const openMenu = () => {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  };
  button.addEventListener('click', event => {
    event.stopPropagation();
    if (menu.hidden) {
      openMenu();
      if (event.detail === 0) items()[0]?.focus({preventScroll: true});
    } else {
      closeAccountMenu(doc);
    }
  });
  button.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    openMenu();
    items().at(event.key === 'ArrowDown' ? 0 : -1)?.focus();
  });
  menu.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const entries = items();
    if (!entries.length) return;
    event.preventDefault();
    const active = entries.indexOf(doc.activeElement);
    if (event.key === 'Home') entries[0].focus();
    else if (event.key === 'End') entries.at(-1).focus();
    else entries[(active + entries.length + (event.key === 'ArrowDown' ? 1 : -1)) % entries.length].focus();
  });
  doc.addEventListener('click', event => {
    const slot = doc.querySelector('.account-slot');
    if (!slot || slot.hasAttribute('hidden')) return;
    if (slot.contains(event.target)) return;
    closeAccountMenu(doc);
  });
  doc.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || menu.hidden) return;
    const focused = doc.activeElement;
    closeAccountMenu(doc);
    if (focused === button || menu.contains(focused)) {
      event.preventDefault();
      button.focus({preventScroll: true});
    }
  });
  const panel = signedInPanel(doc);
  const who = doc.getElementById('whoami');
  if (typeof MutationObserver === 'function') {
    const sync = () => syncAccountSlot(doc);
    if (panel) new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    if (who) new MutationObserver(sync).observe(who, { childList: true, characterData: true, subtree: true });
  }
  syncAccountSlot(doc);
  ensureChannelsAndConnectorsMenuItems(doc);
  bindHelpMenu(doc);
  bindAppearanceToggle(doc);
}

function bindHelpMenu(doc) {
  const button = doc.getElementById('help-menu-button');
  const menu = doc.getElementById('help-menu');
  if (!button || !menu || button.dataset.bound === '1') return;
  button.dataset.bound = '1';
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const open = menu.hasAttribute('hidden');
    if (open) {
      menu.removeAttribute('hidden');
      button.setAttribute('aria-expanded', 'true');
    } else {
      menu.setAttribute('hidden', '');
      button.setAttribute('aria-expanded', 'false');
    }
  });
}

export function syncAppearanceButton(doc, values, now, media) {
  const button = doc.getElementById('appearance-toggle');
  if (!button) return;
  const theme = resolveTheme(values || { appearance: 'system' }, now, media);
  const english = doc.documentElement?.lang === 'en';
  const labels = english ? {light:'Light', dark:'Dark'} : {light:'浅色', dark:'深色'};
  const label = button.querySelector('[data-appearance-label]');
  const title = english ? 'Switch appearance' : '切换外观';
  if (label) label.textContent = title;
  else button.textContent = labels[theme];
  button.setAttribute('title', title);
  button.setAttribute('aria-label', title);
  button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
}

function bindAppearanceToggle(doc) {
  const button = doc.getElementById('appearance-toggle');
  if (!button || button.dataset.bound === '1') return;
  button.dataset.bound = '1';
  button.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M20.1 14.3a8 8 0 0 1-10.4-10.4 8.6 8.6 0 1 0 10.4 10.4Z"/></svg><span data-appearance-label></span>';
  button.addEventListener('click', async event => {
    event.preventDefault();
    if (button.dataset.busy === '1') return;
    button.dataset.busy = '1';
    try {
      const loaded = await loadSettings();
      if (!loaded) return;
      const current = resolveTheme(loaded.values);
      const next = current === 'dark' ? 'light' : 'dark';
      const response = await fetch('/v1/settings', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfCookie(document.cookie),
        },
        body: JSON.stringify({ revision: loaded.revision, changes: { appearance: next } }),
      });
      if (!response.ok) return;
      const body = await response.json();
      const values = (body && body.settings && body.settings.values) || { ...loaded.values, appearance: next };
      applyResolvedTheme(doc, values);
      syncAppearanceButton(doc, values);
      const form = doc.getElementById('settings-form');
      if (form && form.elements && form.elements.appearance) {
        for (const option of form.querySelectorAll('[name="appearance"]')) {
          option.checked = option.value === next;
        }
      }
    } finally {
      button.dataset.busy = '0';
    }
  });
}

function enhanceChrome() {
  document.body.classList.add('app');
  if (!document.querySelector('.skip-link')) {
    const skip = document.createElement('a');
    skip.className = 'skip-link';
    skip.href = '#main';
    skip.textContent = '跳到主要内容';
    document.body.insertBefore(skip, document.body.firstChild);
  }
  for (const nav of document.querySelectorAll('nav')) {
    if (!nav.getAttribute('aria-label')) nav.setAttribute('aria-label', '管理导航');
  }
  bindMobileNavigation(document);
  markNavigation();
  decorateStatus(document.getElementById('status'));
  bindAccountMenu(document);
}

function valuesFromDom(doc) {
  const appearance = (doc.body && doc.body.dataset.theme) || 'system';
  const values = { appearance };
  if (appearance === 'auto') {
    values.appearance_schedule = (doc.body && doc.body.dataset.schedule) || 'sunset_sunrise';
    const form = doc.getElementById('settings-form');
    if (form && form.elements) {
      if (form.elements.appearance_start) values.appearance_start = form.elements.appearance_start.value;
      if (form.elements.appearance_end) values.appearance_end = form.elements.appearance_end.value;
    }
  }
  return values;
}

export function shellValuesFromDocument(doc) {
  const {shellAppearance, shellLanguage, shellStart, shellEnd} = doc.documentElement.dataset;
  if (!['light', 'dark', 'auto', 'system'].includes(shellAppearance)) return null;
  const values = {appearance: shellAppearance, language: shellLanguage};
  if (shellAppearance === 'auto' && shellStart && shellEnd) {
    values.appearance_schedule = 'custom';
    values.appearance_start = shellStart;
    values.appearance_end = shellEnd;
  }
  return values;
}

export function startShell(doc = document, options = {}) {
  const target = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  const run = async () => {
    enhanceChrome();
    const guest = signedInPanel(doc)?.hasAttribute('data-guest-access') && !csrfCookie(doc.cookie);
    const apply = values => {
      const language = values.language || doc.documentElement.lang;
      updateNavigationLanguage(doc, language);
      const account = doc.getElementById('account-menu-button');
      const accountLabel = language === 'en' ? 'Account menu' : '账户菜单';
      account?.setAttribute('aria-label', accountLabel);
      account?.setAttribute('title', accountLabel);
      applyResolvedTheme(doc, values, options.now, options.media);
      syncAppearanceButton(doc, values, options.now, options.media);
    };
    const initial = options.values ?? shellValuesFromDocument(doc);
    apply(initial ?? valuesFromDom(doc));
    if (doc.body && typeof MutationObserver === 'function') {
      new MutationObserver(() => {
        if (doc.body && (doc.body.dataset.theme || doc.body.dataset.schedule)) {
          const next = valuesFromDom(doc);
          applyResolvedTheme(doc, next, options.now, options.media);
          syncAppearanceButton(doc, next, options.now, options.media);
        }
      }).observe(doc.body, { attributes: true, attributeFilter: ['data-theme', 'data-schedule'] });
    }
    const status = doc.getElementById('status');
    if (status && typeof MutationObserver === 'function') {
      new MutationObserver(() => decorateStatus(status)).observe(status, {
        childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['data-kind'],
      });
    }
    if (!initial && !guest) {
      const loaded = await loadSettings();
      if (loaded) apply(loaded.values);
    }
  };
  if (doc.readyState === 'loading' && target) target.addEventListener('DOMContentLoaded', run);
  else run();
}

if (typeof document !== 'undefined') startShell();
