#!/usr/bin/env node
/**
 * Capture the real FlyBot management UI in a CI runner browser.
 * Reads ready.json plus a 0600 login file. Never prints passwords or tokens.
 * Talks only to the loopback origin from ready.json.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function readLogin(file) {
  const text = fs.readFileSync(file, 'utf8');
  const username = /(?:^|\n)username=([^\n]+)/.exec(text)?.[1];
  const password = /(?:^|\n)password=([^\n]+)/.exec(text)?.[1];
  if (!username || !password) {
    throw new Error('login file is missing fields');
  }
  return { username, password };
}

function shanghaiStamp() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const pick = (type) => parts.find((part) => part.type === type).value;
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')} Asia/Shanghai`;
}

async function visibleText(locator) {
  if (!(await locator.count()) || !(await locator.isVisible())) return '';
  return ((await locator.innerText()) || '').trim();
}

async function assertSafeToCapture(page) {
  const filled = await page.$$eval('input[type="password"]', (inputs) => inputs.map((input) => input.value).filter(Boolean));
  if (filled.length) {
    throw new Error('a password field is not empty; refusing to screenshot');
  }
  for (const selector of ['#issued-token', '#share-once']) {
    const box = page.locator(selector);
    if ((await box.count()) && (await box.isVisible())) {
      const text = await box.innerText();
      if (text && /只显示一次/.test(text)) {
        throw new Error(`${selector} is showing a one-time secret; refusing to screenshot`);
      }
    }
  }
}

async function shot(page, outDir, name) {
  await assertSafeToCapture(page);
  const file = path.join(outDir, name);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}


async function openGroupAgentSheet(page) {
  const sheet = page.locator('#group-agent-action details.group-agent-sheet');
  if (!(await sheet.count())) return;
  if (await sheet.getAttribute('open') === null) {
    await sheet.locator(':scope > summary').click();
  }
}

async function openListItem(page, title, listSelector = '#main-panel') {
  const button = page.locator(`${listSelector} button.link`, { hasText: title }).first();
  await button.waitFor({ state: 'visible', timeout: 15000 });
  await button.click();
}

async function waitForInputValue(page, selector, expected, timeout = 15000) {
  await page.locator(selector).waitFor({ state: 'visible', timeout });
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.value === expected,
    { selector, expected },
    { timeout },
  );
}

// The memory editor keeps its markdown in a hidden field behind the WYSIWYG
// surface, so this waits on the stored value without requiring visibility.
async function waitForStoredValue(page, selector, expected, timeout = 15000) {
  await page.locator(selector).waitFor({ state: 'attached', timeout });
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.value === expected,
    { selector, expected },
    { timeout },
  );
}

async function waitForLocatorText(page, selector, expected, timeout = 15000) {
  await page.locator(selector).waitFor({ state: 'visible', timeout });
  try {
    await page.waitForFunction(
      ({ selector, expected }) => (document.querySelector(selector)?.innerText || '').includes(expected),
      { selector, expected },
      { timeout },
    );
  } catch (error) {
    const transport=await page.evaluate(()=>document.querySelector('#workspace-events-status')?.textContent||'not on this page');
    throw new Error(`Text assertion ${selector} expected ${JSON.stringify(expected)}; live status=${transport}; ${String(error)}`);
  }
}


// Poll completed JSON values in Node. An async predicate passed to browser
// waitForFunction can be a truthy Promise rather than the API condition itself.
async function waitForApi(page, apiPath, predicate, timeout = 20000) {
  const deadline=Date.now()+timeout;
  do {
    const data=await page.evaluate(async apiPath=>{const response=await fetch(apiPath);if(!response.ok)throw Error('API status '+response.status);return response.json()},apiPath);
    if(predicate(data))return data;
    if(data.task && ['failed','cancelled','timed_out'].includes(data.task.status))throw Error('Runtime task ended '+data.task.status);
    await new Promise(resolve=>setTimeout(resolve,100));
  } while(Date.now()<deadline);
  throw Error('Expected persisted API condition not reached: '+apiPath);
}

async function writeSendShortcut(page, value) {
  const result = await page.evaluate(async (value) => {
    const token = document.cookie.split(/;\s*/).map((part) => part.split('=')).find((pair) => (
      pair[0] === '__Host-ot_csrf' || pair[0] === 'ot_dev_csrf'
    ));
    const current = await (await fetch('/v1/settings', {
      credentials: 'same-origin',
      headers: {Accept: 'application/json'},
    })).json();
    const response = await fetch('/v1/settings', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': token ? token[1] : '',
      },
      body: JSON.stringify({
        revision: current.settings && current.settings.revision,
        changes: {send_shortcut: value},
      }),
    });
    const body = await response.json();
    return {
      status: response.status,
      value: body.settings && body.settings.values && body.settings.values.send_shortcut,
    };
  }, value);
  if (result.status !== 200 || result.value !== value) {
    throw new Error(`failed to store send_shortcut=${value}: ${JSON.stringify(result)}`);
  }
}

async function selectWorkspace(page, name) {
  const picker = page.locator('#workspace');
  if (!(await picker.count())) return false;
  await picker.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('#workspace option')].some((option) => option.textContent === name),
    name,
    { timeout: 15000 },
  );
  await picker.selectOption({ label: name });
  return true;
}

async function main() {
  const metaPath = argValue('--meta');
  const outDir = argValue('--out');
  if (!metaPath || !outDir) {
    throw new Error('usage: node scripts/ci_ui_screenshots.mjs --meta DIR --out DIR');
  }
  const ready = JSON.parse(fs.readFileSync(path.join(metaPath, 'ready.json'), 'utf8'));
  const origin = ready.origin;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
    throw new Error('ready.json origin is not a loopback http URL');
  }
  const { username, password } = readLogin(ready.login_file);
  if (username !== ready.username) {
    throw new Error('login username does not match ready.json');
  }
  if (!ready.empty_workspace_name) {
    throw new Error('ready.json is missing empty_workspace_name');
  }
  fs.mkdirSync(outDir, { recursive: true });

  const checks = {};
  const screenshots = [];
  let failed = false;
  const record = (name, passed, detail = '', { soft = false } = {}) => {
    checks[name] = { passed: Boolean(passed), detail, soft };
    if (!passed && !soft) failed = true;
  };

  const browser = await chromium.launch({ headless: true });
  try {
    const anonymous = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
    const loginPage = await anonymous.newPage();
    // Wait for `load`, not a quiet network: shell and page scripts issue
    // same-origin API calls after load, which can prevent a quiet-network wait
    // from ever finishing on the loopback runner.
    await loginPage.goto(`${origin}/settings`, { waitUntil: 'load' });
    await loginPage.locator('#login-panel').waitFor({ state: 'visible', timeout: 15000 });
    const userValue = await loginPage.locator('#username').inputValue();
    const passValue = await loginPage.locator('#password').inputValue();
    record(
      'login_page_empty',
      (await loginPage.locator('#login-panel h2').innerText()) === '登录' && userValue === '' && passValue === '',
      'unauthenticated /settings shows an empty login form',
    );
    screenshots.push(path.basename(await shot(loginPage, outDir, '01-settings-login.png')));
    // A genuinely new synthetic account uses the form, actual session cookie,
    // race-free first workspace and ordinary non-operator agent creation.
    try {
      await loginPage.goto(origin+'/',{waitUntil:'load'});
      await loginPage.locator('#login-panel').waitFor({state:'visible'});
      for(const width of [1280,390,471]){
        await loginPage.setViewportSize({width,height:900});
        await loginPage.locator('.login-register-button').waitFor({state:'visible'});
        const geometry=await loginPage.evaluate(()=>{
          const a=document.querySelector('#username'),b=document.querySelector('#password'),ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();
          return {type:a.type,aw:ar.width,bw:br.width,ah:ar.height,bh:br.height,ab:getComputedStyle(a).backgroundColor,bb:getComputedStyle(b).backgroundColor,overflow:document.documentElement.scrollWidth>innerWidth};
        });
        record('mobile_login_entry_'+width,geometry.type==='text'&&Math.abs(geometry.aw-geometry.bw)<1&&Math.abs(geometry.ah-geometry.bh)<1&&geometry.ah>=44&&geometry.ab===geometry.bb&&!geometry.overflow,'Actual computed username/password geometry plus visible registration entry: '+JSON.stringify(geometry));
        if(width===390)screenshots.push(path.basename(await shot(loginPage,outDir,'116a-login-registration-390.png')));
      }
      screenshots.push(path.basename(await shot(loginPage,outDir,'116-mobile-login-registration-entry.png')));
      await loginPage.locator('.login-register-button').click();
      await waitForLocatorText(loginPage,'#register-policy','已开放注册');
      screenshots.push(path.basename(await shot(loginPage,outDir,'109-registration-form.png')));
      await loginPage.locator('#register-username').fill('ci-new-account');
      await loginPage.locator('#register-password').fill(password);
      await loginPage.locator('#register-submit').click();
      await loginPage.waitForURL(origin+'/');
      await waitForLocatorText(loginPage,'#home-greeting','ci-new-account');
      await loginPage.waitForFunction(()=>document.querySelector('#home-workspace')?.options.length>0);
      const session=await(await anonymous.request.get(origin+'/v1/auth/session')).json();
      const spaces=await(await anonymous.request.get(origin+'/v1/workspaces?limit=100')).json();
      record('registration_real_session_first_workspace',session.user?.username==='ci-new-account'&&spaces.items?.length===1,'Form registration verified cookie session before navigating; personal initialization completed before the first workspace listing. Not an operator-admin grant.');
      screenshots.push(path.basename(await shot(loginPage,outDir,'110-new-account-first-home.png')));
      // Keep the new mobile account at471px through normal agent use/reload.
      await loginPage.goto(origin+'/agents#workspace='+spaces.items[0].id,{waitUntil:'load'});
      await loginPage.locator('#open-create').click();
      await loginPage.locator('#create-form input[name="name"]').fill('New account persisted agent');
      await loginPage.locator('#create-form textarea[name="instructions"]').fill('Use only supplied source material. No external operations.');
      await loginPage.locator('#create-form button[type="submit"]').click();
      await waitForLocatorText(loginPage,'#agent-list','New account persisted agent');
      await loginPage.reload({waitUntil:'load'});
      await waitForLocatorText(loginPage,'#agent-list','New account persisted agent');
      record('registration_create_agent_reload',true,'New synthetic account created its own agent via the real form and read it after reload. Controlled-provider full task path is covered separately in Python.');
      screenshots.push(path.basename(await shot(loginPage,outDir,'111-new-account-agent-reload.png')));
    }catch(error){record('registration_full_new_account',false,String(error));}
    await anonymous.close();

    const desktopRegistration = await browser.newContext({viewport:{width:1280,height:900},locale:'zh-CN'});
    try {
      const desktop = await desktopRegistration.newPage();
      await desktop.goto(origin+'/settings',{waitUntil:'load'});
      await desktop.locator('.login-register-button').waitFor({state:'visible'});
      await desktop.locator('.login-register-button').click();
      await waitForLocatorText(desktop,'#register-policy','已开放注册');
      screenshots.push(path.basename(await shot(desktop,outDir,'117-desktop-registration-form.png')));
      await desktop.locator('#register-username').fill('ci-new-desktop');
      await desktop.locator('#register-password').fill(password);
      await desktop.locator('#register-submit').click();
      await desktop.waitForURL(origin+'/');
      await waitForLocatorText(desktop,'#home-greeting','ci-new-desktop');
      await desktop.waitForFunction(()=>document.querySelector('#home-workspace')?.options.length>0);
      const session=await(await desktopRegistration.request.get(origin+'/v1/auth/session')).json();
      const spaces=await(await desktopRegistration.request.get(origin+'/v1/workspaces?limit=100')).json();
      record('desktop_registration_real_session',session.user?.username==='ci-new-desktop'&&spaces.items?.length===1,'Desktop settings login entry -> real form -> cookie session -> initialized personal workspace.');
      await desktop.setViewportSize({width:1019,height:380});
      const account = desktop.getByRole('button',{name:'账户菜单'});
      await account.click();
      await desktop.locator('#help-menu-button').click();
      const accountInRail = await account.evaluate(button => {
        const rail = button.closest('.app-rail').getBoundingClientRect();
        const trigger = button.getBoundingClientRect();
        const menu = document.getElementById('account-menu').getBoundingClientRect();
        return button.querySelector('svg') && !button.textContent.trim() &&
          trigger.left >= rail.left && trigger.right <= rail.right &&
          trigger.bottom <= rail.bottom && rail.bottom - trigger.bottom <= 16 &&
          menu.left >= 0 && menu.right <= innerWidth && menu.top >= 0 && menu.bottom <= innerHeight;
      });
      await desktop.keyboard.press('Escape');
      record('home_short_window_account_menu',accountInRail && await desktop.locator('#account-menu').isHidden(),
        'The account icon stays at the bottom of the rail, and the expanded Help menu fits in the viewport.');
      await desktop.setViewportSize({width:1280,height:900});
      await desktop.goto(origin+'/agents#workspace='+spaces.items[0].id,{waitUntil:'load'});
      await desktop.locator('#open-create').click();
      await desktop.locator('#create-form input[name="name"]').fill('Desktop account persisted agent');
      await desktop.locator('#create-form textarea[name="instructions"]').fill('Synthetic test; no external operations.');
      await desktop.locator('#create-form button[type="submit"]').click();
      await waitForLocatorText(desktop,'#agent-list','Desktop account persisted agent');
      await desktop.reload({waitUntil:'load'});
      await waitForLocatorText(desktop,'#agent-list','Desktop account persisted agent');
      record('desktop_registration_normal_use',true,'Second independent new desktop account can create and reload its own agent.');
      screenshots.push(path.basename(await shot(desktop,outDir,'118-desktop-registration-agent-reload.png')));
    }catch(error){record('desktop_registration_full_new_account',false,String(error));}
    finally{await desktopRegistration.close();}

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
    const login = await context.request.post(`${origin}/v1/auth/login`, {
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      data: { username, password },
    });
    record('login_via_api', login.status() === 200, `POST /v1/auth/login returned ${login.status()}`);
    if (login.status() !== 200) {
      throw new Error('fixture login failed');
    }

    const page = await context.newPage();
    page.on('response', response=>{if(new URL(response.url()).pathname.endsWith('/events'))console.log('Synthetic SSE handshake status='+response.status());});

    await page.goto(`${origin}/settings`, { waitUntil: 'load' });
    await page.locator('#settings-panel').waitFor({ state: 'visible', timeout: 15000 });
    await waitForLocatorText(page, '#model-key-state', '密钥', 15000);
    const who = await visibleText(page.locator('#whoami'));
    const keyState = await visibleText(page.locator('#model-key-state'));
    const appearanceLight = await page.locator('input[name="appearance"][value="light"]').isChecked();
    record(
      'settings_signed_in',
      who === ready.username && appearanceLight && /已保存个人密钥/.test(keyState),
      `whoami=${who || '(empty)'}; keyState=${keyState || '(empty)'}`,
    );
    record(
      'settings_no_api_key_plaintext',
      (await page.locator('#model-api-form input[name="api_key"]').inputValue()) === '' && !/只显示一次/.test(await page.content()),
      'API key field is empty and no one-time secret banner is visible',
    );
    screenshots.push(path.basename(await shot(page, outDir, '02-settings-signed-in.png')));
    try {
      const hubText = `${await visibleText(page.locator('#settings-index'))}`;
      const panelText = `${await visibleText(page.locator('#settings-panel'))}`;
      record(
        'settings_hub_recorded_groups',
        hubText.includes('账户与资料')
          && hubText.includes('AI 与智能体设置')
          && hubText.includes('技能配置')
          && (await page.locator('#model-api').textContent() || '').includes('FlyBot 不用积分')
          && await page.locator('#whoami').isVisible()
          && await page.locator('#settings-usage-card').count() === 0
          && await page.locator('#settings-upgrade').count() === 0
          && !panelText.includes('升级')
          && !panelText.includes('创作者与奖励')
          && !panelText.includes('套餐、账单与用量')
          && !panelText.includes('创作赚钱')
          && !panelText.includes('积分中心')
          && !panelText.includes('套餐与账单')
          && !panelText.includes('教育优惠认证')
          && !panelText.includes('兑换码')
          && !panelText.includes('5 小时窗口')
          && !panelText.includes('0m 后重置')
          && !hubText.includes('已赚取')
          && !hubText.includes('$CASH')
          && !hubText.includes('CREDIT')
          && !hubText.includes('剩余 100%'),
        `panel=${panelText || 'panel empty'} | hub=${hubText || 'hub empty'}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '76-settings-hub-groups.png')));
    } catch (error) {
      record('settings_hub_recorded_groups', false, String(error));
    }
    try {
      await page.goto(`${origin}/settings/appearance`, { waitUntil: 'load' });
      await page.locator('#settings-panel').waitFor({ state: 'visible', timeout: 15000 });
      const appearance = page.locator('#appearance');
      await appearance.waitFor({ state: 'visible', timeout: 15000 });
      const appearanceText = `${await visibleText(page.locator('[data-settings-page="appearance"]'))}`;
      const values = await page.locator('#appearance > label.choice input[name="appearance"]').evaluateAll(
        (inputs) => inputs.map((input) => input.value),
      );
      await page.locator('#appearance input[value="auto"]').check();
      await page.locator('#appearance-schedule-card').waitFor({ state: 'visible', timeout: 15000 });
      await waitForLocatorText(page, '#appearance-status', '当前为');
      const statusText = `${await visibleText(page.locator('#appearance-status'))}`;
      const autoText = `${await visibleText(page.locator('#appearance-schedule-card'))}`;
      record(
        'settings_appearance',
        values.join(',') === 'light,dark,auto,system'
          && appearanceText.includes('始终使用浅色主题。')
          && appearanceText.includes('选择应用在此设备上的显示外观。')
          && /当前为(浅色|深色)，直到 (22:00|06:00)。/.test(statusText)
          && !autoText.includes('当前为')
          && autoText.includes('没有使用实际日出日落时刻')
          && autoText.includes('可选用「自定义时段」')
          && autoText.includes('自动切换'),
        `values=${values.join(',')}; ${appearanceText || 'appearance page empty'} | status=${statusText || 'missing'} | auto=${autoText || 'schedule card empty'}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '27-settings-appearance.png')));
    } catch (error) {
      record('settings_appearance', false, String(error));
    }
    try {
      await page.goto(`${origin}/settings/language`, { waitUntil: 'load' });
      await page.locator('#settings-panel').waitFor({ state: 'visible', timeout: 15000 });
      const language = page.locator('[data-settings-page="language"]');
      await language.waitFor({ state: 'visible', timeout: 15000 });
      const languageText = `${await visibleText(language)}`;
      record(
        'settings_language',
        languageText.includes('系统语言')
          && languageText.includes('聊天语言')
          && languageText.includes('自动翻译消息')
          && languageText.includes('跟随界面语言'),
        languageText || 'language page empty',
      );
      screenshots.push(path.basename(await shot(page, outDir, '47-settings-language.png')));
    } catch (error) {
      record('settings_language', false, String(error));
    }
    try {
      await page.goto(`${origin}/settings/message-folding`, { waitUntil: 'load' });
      await page.locator('#settings-panel').waitFor({ state: 'visible', timeout: 15000 });
      const folding = page.locator('[data-settings-page="message-folding"]');
      await folding.waitFor({ state: 'visible', timeout: 15000 });
      const foldingText = `${await visibleText(folding)}`;
      record(
        'settings_message_folding',
        foldingText.includes('选择长消息在对话里最先展示多少内容。')
          && foldingText.includes('长消息会把对话推得很高。')
          && foldingText.includes('长文档收成卡片')
          && foldingText.includes('‹ 设置'),
        foldingText || 'message-folding page empty',
      );
      screenshots.push(path.basename(await shot(page, outDir, '48-settings-message-folding.png')));
    } catch (error) {
      record('settings_message_folding', false, String(error));
    }
    try {
      await page.goto(`${origin}/settings/privacy`, { waitUntil: 'load' });
      await page.locator('#settings-panel').waitFor({ state: 'visible', timeout: 15000 });
      const privacy = page.locator('[data-settings-page="privacy"]');
      await privacy.waitFor({ state: 'visible', timeout: 15000 });
      const privacyText = `${await visibleText(privacy)}`;
      const saveDisabled = await page.locator('#save').isDisabled();
      record(
        'settings_privacy',
        saveDisabled
          && privacyText.includes('隐私设置')
          && privacyText.includes('管理你的社交动态对他人的可见性')
          && privacyText.includes('点赞列表')
          && privacyText.includes('收藏列表')
          && !privacyText.includes('没有留下这一页的版式截图'),
        `saveDisabled=${saveDisabled}; ${privacyText || 'privacy page empty'}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '49-settings-privacy.png')));
    } catch (error) {
      record('settings_privacy', false, String(error));
    }
    try {
      await page.goto(`${origin}/settings/shortcuts`, { waitUntil: 'load' });
      await page.locator('#settings-panel').waitFor({ state: 'visible', timeout: 15000 });
      const shortcuts = page.locator('[data-settings-page="shortcuts"]');
      await shortcuts.waitFor({ state: 'visible', timeout: 15000 });
      const sendShortcut = page.locator('select[name="send_shortcut"]');
      await sendShortcut.waitFor({ state: 'visible', timeout: 15000 });
      await page.waitForFunction(() => {
        const select = document.querySelector('select[name="send_shortcut"]');
        const keys = document.getElementById('newline-keys');
        return Boolean(select && select.value && keys && keys.textContent.trim());
      }, { timeout: 15000 });
      const sendValue = await sendShortcut.inputValue();
      const shortcutsText = `${await visibleText(shortcuts)}`;
      const newlineText = `${await visibleText(page.locator('#newline-keys'))}`;
      const sendShowsCtrl = sendValue === 'mod_enter';
      record(
        'settings_shortcuts',
        shortcutsText.includes('快捷键')
          && shortcutsText.includes('消息')
          && shortcutsText.includes('发送消息')
          && shortcutsText.includes('换行')
          && (sendShowsCtrl ? shortcutsText.includes('Ctrl + Enter') : shortcutsText.includes('Enter'))
          && newlineText.includes('Enter')
          && (sendShowsCtrl ? !newlineText.includes('Shift') : newlineText.includes('Shift'))
          && !shortcutsText.includes('没有留下这一页的版式截图'),
        `send_shortcut=${sendValue}; newline=${newlineText}; ${shortcutsText || 'shortcuts page empty'}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '50-settings-shortcuts.png')));
    } catch (error) {
      record('settings_shortcuts', false, String(error));
    }
    try {
      await page.goto(`${origin}/settings/channels`, { waitUntil: 'load' });
      await page.locator('#settings-panel').waitFor({ state: 'visible', timeout: 15000 });
      const channels = page.locator('[data-settings-page="channels"]');
      await channels.waitFor({ state: 'visible', timeout: 15000 });
      const channelsText = `${await visibleText(channels)}`;
      const connectButtons = page.locator('[data-settings-page="channels"] button');
      const connectCount = await connectButtons.count();
      const allDisabled = (await connectButtons.evaluateAll((buttons) => buttons.every((button) => button.disabled))) && connectCount === 4;
      record(
        'settings_channels',
        allDisabled
          && channelsText.includes('Agent 渠道')
          && channelsText.includes('WeChat Official Account')
          && channelsText.includes('Apple iMessage')
          && channelsText.includes('Slack')
          && channelsText.includes('WhatsApp')
          && !channelsText.includes('Teamily Agent')
          && !/积分|套餐|升级/.test(channelsText),
        `buttons=${connectCount}; disabled=${allDisabled}; ${channelsText || 'channels page empty'}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '44-settings-channels.png')));
    } catch (error) {
      record('settings_channels', false, String(error));
    }
    try {
      await page.goto(`${origin}/settings/agent-access`, { waitUntil: 'load' });
      await page.locator('#settings-panel').waitFor({ state: 'visible', timeout: 15000 });
      const agentAccess = page.locator('[data-settings-page="agent-access"]');
      await agentAccess.waitFor({ state: 'visible', timeout: 15000 });
      const agentText = `${await visibleText(agentAccess)}`;
      record(
        'settings_agent_access',
        agentText.includes('Agent API')
          && agentText.includes('你的 agent 还没有向本实例之外开放。')
          && agentText.includes('没有已授权的 AI 客户端。')
          && agentText.includes('Claude Code')
          && !/积分|套餐|升级/.test(agentText),
        agentText || 'agent-access page empty',
      );
      screenshots.push(path.basename(await shot(page, outDir, '45-settings-agent-access.png')));
    } catch (error) {
      record('settings_agent_access', false, String(error));
    }
    try {
      await page.goto(`${origin}/settings/connectors`, { waitUntil: 'load' });
      await page.locator('#settings-panel').waitFor({ state: 'visible', timeout: 15000 });
      const connectors = page.locator('[data-settings-page="connectors"]');
      await connectors.waitFor({ state: 'visible', timeout: 15000 });
      const catalogRows = page.locator('#connectors-catalog .connector-row');
      await catalogRows.first().waitFor({ state: 'visible', timeout: 15000 });
      const rowCount = await catalogRows.count();
      const connectButtons = page.locator('#connectors-catalog button');
      const connectCount = await connectButtons.count();
      const allConnectDisabled = connectCount === 39
        && await connectButtons.evaluateAll((nodes) => nodes.every((node) => node.disabled));
      const statuses = await page.locator('#connectors-catalog .connector-status').allTextContents();
      // The screenshot account has not saved its own Composio key, so every
      // row stays disabled: 31 say 未配置 Composio and 8 (no toolkit) say 未接通.
      const allDisconnected = statuses.length === 39
        && statuses.filter((text) => text.trim() === '未配置 Composio').length === 31
        && statuses.filter((text) => text.trim() === '未接通').length === 8;
      const connectorsText = `${await visibleText(connectors)}`;
      const addMcp = page.locator('#add-mcp-server');
      const addMcpDisabled = await addMcp.isDisabled();
      record(
        'settings_connectors',
        !addMcpDisabled
          && rowCount === 39
          && allConnectDisabled
          && allDisconnected
          && connectorsText.includes('应用连接器')
          && connectorsText.includes('添加 MCP 服务器')
          && connectorsText.includes('GitHub')
          && connectorsText.includes('Mailbox')
          && connectorsText.includes('Composio API key')
          && connectorsText.includes('未配置 Composio')
          && !connectorsText.includes('还没有可连接的应用目录。')
          && !connectorsText.includes('已连接')
          && !/积分|套餐|升级/.test(connectorsText),
        `rows=${rowCount}; connect=${connectCount}; addDisabled=${addMcpDisabled}; ${connectorsText || 'connectors page empty'}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '46-settings-connectors.png')));
      await addMcp.click();
      const mcpDialog = page.locator('#mcp-dialog');
      await mcpDialog.waitFor({ state: 'visible', timeout: 15000 });
      const mcpText = `${await visibleText(mcpDialog)}`;
      record(
        'settings_connectors_mcp_dialog',
        mcpText.includes('在智能体里添加自定义 MCP 服务器')
          && mcpText.includes('公开 HTTPS 地址和可选 Bearer token')
          && mcpText.includes('工具由你的 DS-Bot 加载')
          && mcpText.includes('逐次批准')
          && mcpText.includes('知道了'),
        mcpText || 'mcp dialog empty',
      );
      screenshots.push(path.basename(await shot(page, outDir, '75-settings-connectors-mcp.png')));
      await page.locator('#mcp-dialog-ack').click();
      await mcpDialog.waitFor({ state: 'hidden', timeout: 15000 });
      record('settings_connectors_mcp_dialog_closed', await mcpDialog.isHidden(), '知道了 closes the instruction dialog');
      // Save/remove a synthetic configuration only: no upstream MCP request or action.
      const customMcp = page.locator('#custom-mcp-form');
      await customMcp.locator('[name="name"]').fill('CI custom MCP fixture');
      await customMcp.locator('[name="url"]').fill('https://mcp.example.test/mcp');
      await customMcp.locator('[name="bearer_token"]').fill('synthetic-ci-mcp-secret');
      await customMcp.locator('button[type="submit"]').click();
      await page.locator('#custom-mcp-list').getByText('CI custom MCP fixture', {exact: false}).waitFor({state: 'visible'});
      record('settings_custom_mcp_saved',
        (await customMcp.locator('[name="bearer_token"]').inputValue()) === ''
          && !(await visibleText(page.locator('#custom-mcp-card'))).includes('synthetic-ci-mcp-secret'),
        'Per-user custom MCP configuration saved; secret input cleared and no credential echoed');
      await page.locator('#custom-mcp-list button').click();
      await page.locator('#custom-mcp-list').getByText('尚未添加自定义 MCP 服务器。').waitFor({state: 'visible'});
      record('settings_custom_mcp_removed', true, 'Synthetic configuration removed without any upstream action');

    } catch (error) {
      record('settings_connectors', false, String(error));
    }
    try {
      await page.locator('#account-menu-button').click();
      await page.locator('#account-menu').waitFor({ state: 'visible', timeout: 8000 });
      await page.locator('#help-menu-button').click();
      await page.locator('#help-menu').waitFor({ state: 'visible', timeout: 8000 });
      const menuText = await visibleText(page.locator('#account-menu'));
      const settingsHref = await page.locator('#account-menu a[href="/settings"]').getAttribute('href');
      const onboardingHref = await page.locator('#account-menu a[href="/onboarding"]').getAttribute('href');
      const channelsHref = await page.locator('#account-menu a[href="/settings/channels"]').getAttribute('href');
      const connectorsHref = await page.locator('#account-menu a[href="/settings/connectors"]').getAttribute('href');
      const settingsButton = await page.locator('#account-menu-button').evaluate(button =>
        button.textContent.trim() === '' && !!button.querySelector('svg') &&
        button.getBoundingClientRect().right <= button.closest('.app-rail').getBoundingClientRect().right);
      const settingsProfileLinks = await page.locator('.app-rail a[href="/profile"]').count();
      record(
        'account_menu',
        menuText.includes('所有设置') && menuText.includes('退出登录') && menuText.includes('创建团队') && menuText.includes('查看我的资料') && menuText.includes('帮助中心') && menuText.includes('下载') && menuText.includes('工作背景') && menuText.includes('Agent 渠道') && menuText.includes('应用连接器') && settingsHref === '/settings' && onboardingHref === '/onboarding' && channelsHref === '/settings/channels' && connectorsHref === '/settings/connectors' && settingsButton && settingsProfileLinks === 1 && !/积分|套餐|升级/.test(menuText) && !/contact@teamily\.ai/.test(menuText),
        `button=${settingsButton}; ${menuText || 'account menu empty'}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '23-account-menu.png')));
      await page.keyboard.press('Escape');
    } catch (error) {
      record('account_menu', false, String(error));
    }

    await page.goto(`${origin}/agents`, { waitUntil: 'load' });
    await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
    await selectWorkspace(page, ready.workspace_name);
    let agentsList = '';
    try {
      await waitForLocatorText(page, '#agent-list', ready.agent_name);
      agentsList = await visibleText(page.locator('#agent-list'));
    } catch (error) {
      agentsList = String(error);
    }
    record('agents_list', agentsList.includes(ready.agent_name), agentsList || 'agent list empty');
    screenshots.push(path.basename(await shot(page, outDir, '03-agents-list.png')));
    try {
      await openListItem(page, ready.agent_name, '#agent-list');
      await page.locator('#edit-form').waitFor({ state: 'visible', timeout: 15000 });
      await waitForInputValue(page, '#edit-form input[name="name"]', ready.agent_name);
      const nameValue = await page.locator('#edit-form input[name="name"]').inputValue();
      record('agents_editor', nameValue === ready.agent_name, `editor name=${nameValue}`);
      screenshots.push(path.basename(await shot(page, outDir, '04-agents-editor.png')));
    } catch (error) {
      record('agents_editor', false, String(error));
    }
    try {
      await page.locator('#chat-panel').waitFor({ state: 'visible', timeout: 15000 });
      const search = page.locator('#agent-search');
      await search.fill('zz-no-such-agent');
      await waitForLocatorText(page, '#agents-empty', '没有匹配的智能体。试试其他关键词。');
      const countText = ((await page.locator('#agents-count').textContent()) || '').trim();
      const emptyText = ((await page.locator('#agents-empty').textContent()) || '').trim();
      const chatVisible = await page.locator('#chat-panel').isVisible();
      record(
        'agents_search_filter',
        countText === '显示 0 个智能体'
          && emptyText === '没有匹配的智能体。试试其他关键词。'
          && chatVisible,
        `count=${countText}; empty=${emptyText}; chat=${chatVisible}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '87-agents-search-filter.png')));
      await search.press('Escape');
      await waitForLocatorText(page, '#agent-list', ready.agent_name);
    } catch (error) {
      record('agents_search_filter', false, String(error));
    }
    try {
      await page.locator('#edit-form').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('#edit-form select[name="category"]').selectOption('operations');
      await page.locator('#edit-form button[type="submit"]').click();
      // The save reloads the directory (which clears #status), so wait for the card tag instead.
      await waitForLocatorText(page, '#agent-list', 'Operations');
      await page.locator('.filter-row .pill[data-category="operations"]').click();
      const filteredList = await visibleText(page.locator('#agent-list'));
      const filteredUrl = page.url();
      const chatStillOpen = await page.locator('#chat-panel').isVisible();
      await page.locator('.filter-row .pill[data-category="sales"]').click();
      await waitForLocatorText(page, '#agents-empty', '「Sales」类目下还没有智能体。');
      const salesEmpty = ((await page.locator('#agents-empty').textContent()) || '').trim();
      await page.locator('.filter-row .pill[data-category="operations"]').click();
      await waitForLocatorText(page, '#agent-list', ready.agent_name);
      record(
        'agents_category_filter',
        filteredList.includes(ready.agent_name)
          && filteredUrl.includes('category=operations')
          && chatStillOpen
          && salesEmpty === '「Sales」类目下还没有智能体。选「全部」查看其余智能体。',
        `list=${filteredList}; url=${filteredUrl}; chat=${chatStillOpen}; sales=${salesEmpty}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '89-agents-category-filter.png')));
      await page.locator('.filter-row .pill[data-category="all"]').click();
    } catch (error) {
      record('agents_category_filter', false, String(error));
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    const chatUrl = `${origin}/chat#workspace=${ready.workspace_id}&agent=${ready.agent_id}&conversation=${ready.conversation_id}`;
    try {
      await page.goto(chatUrl, { waitUntil: 'load' });
      await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
      await waitForLocatorText(page, '#chat-title', ready.agent_name);
      await waitForLocatorText(page, '#conversation-list', ready.agent_name);
      await waitForLocatorText(page, '#message-list', ready.chat_user_text, 20000);
      await waitForLocatorText(page, '#message-list', ready.provider_text, 20000);
      const history = await visibleText(page.locator('#message-list'));
      const listText = await visibleText(page.locator('#session-pane'));
      record(
        'agents_conversation_history',
        history.includes(ready.chat_user_text) && history.includes(ready.provider_text),
        history.slice(0, 240) || 'conversation history empty',
        { soft: ready.chat_status !== 'succeeded' },
      );
      record(
        'chat_unified_list',
        listText.includes(ready.agent_name)
          && listText.includes(ready.member_username)
          && listText.includes(ready.social_group_title)
          && listText.includes('对话')
          && listText.includes(ready.social_message_text)
          && (listText.includes(ready.provider_text) || listText.includes(ready.chat_user_text)),
        listText || 'unified chat list empty',
      );
      const identity = ((await page.locator('#chat-avatar').textContent()) || '').trim();
      const identityHidden = await page.locator('#chat-avatar').isHidden();
      const inviteDisabled = await page.locator('.chat-actions button[title="未实现：邀请"]').isDisabled();
      const callDisabled = await page.locator('.chat-actions button[title="未实现：语音或视频通话"]').isDisabled();
      const pinnedHidden = await page.locator('#pinned-group').isHidden();
      const filterBox = await page.locator('#session-filter').boundingBox();
      const searchBox = await page.locator('#session-search').boundingBox();
      const addBox = await page.locator('#new-conversation').boundingBox();
      const expectedInitial = ((ready.agent_name || '').match(/\p{L}|\p{N}/u) || ['?'])[0].toUpperCase();
      record(
        'chat_header_identity',
        !identityHidden
          && identity === expectedInitial
          && inviteDisabled
          && callDisabled
          && pinnedHidden
          && Boolean(filterBox && searchBox && addBox)
          && filterBox.x < searchBox.x
          && searchBox.x < addBox.x,
        `avatar=${identity || 'empty'} hidden=${identityHidden} expected=${expectedInitial} order=${[filterBox && Math.round(filterBox.x), searchBox && Math.round(searchBox.x), addBox && Math.round(addBox.x)].join(',')}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '16-agents-conversation.png')));
      const chrome = await page.evaluate(() => ({
        rail: document.querySelector('.app-rail').getBoundingClientRect().width,
        sessions: document.getElementById('session-pane').getBoundingClientRect().width,
        icons: document.querySelectorAll('.chat-actions svg').length,
        shellOverflow: document.documentElement.scrollWidth > innerWidth,
      }));
      record('ui_chat_compact_chrome', chrome.rail <= 64 && chrome.sessions <= 320 && chrome.icons >= 3 && !chrome.shellOverflow,
        JSON.stringify(chrome));

      screenshots.push(path.basename(await shot(page, outDir, '22-chat-desktop.png')));
      screenshots.push(path.basename(await shot(page, outDir, '62-chat-list-previews.png')));
      screenshots.push(path.basename(await shot(page, outDir, '68-chat-header-identity.png')));
    } catch (error) {
      record('agents_conversation_history', false, String(error), { soft: ready.chat_status !== 'succeeded' });
    }

    try {
      await page.locator('#chat-body').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('#chat-body').fill(ready.chat_live_text);
      await page.locator('#chat-form button[type="submit"]').click();
      await waitForLocatorText(page, '#message-list', ready.chat_live_text, 30000);
      await waitForLocatorText(page, '#message-list', ready.provider_text, 30000);
      const live = await visibleText(page.locator('#message-list'));
      record(
        'agents_conversation_send',
        live.includes(ready.chat_live_text) && live.includes(ready.provider_text),
        live.slice(0, 240) || 'live conversation empty',
        { soft: ready.connection_status !== 'online' },
      );
      screenshots.push(path.basename(await shot(page, outDir, '17-agents-conversation-send.png')));
    } catch (error) {
      record('agents_conversation_send', false, String(error), { soft: ready.connection_status !== 'online' });
    }


    try {
      // Leave /chat first: a same-document hash change is not a reliable load.
      // Agent send stays 409 while a reply is queued, so this uses the social thread.
      const enterText = '[CI FIXTURE] Enter shortcut send.';
      const socialUrl = `${origin}/chat#workspace=${ready.workspace_id}&social=${ready.social_group_id}`;
      await page.goto(`${origin}/space`, {waitUntil: 'load'});
      await writeSendShortcut(page, 'enter');
      await page.goto(socialUrl, {waitUntil: 'load'});
      await waitForLocatorText(page, '#chat-title', ready.social_group_title, 20000);
      await page.locator('#chat-body').waitFor({ state: 'visible', timeout: 15000 });
      const storedShortcut = await page.locator('#chat-body').getAttribute('data-send-shortcut');
      if (storedShortcut !== 'enter') {
        throw new Error(`chat composer did not load send_shortcut=enter: ${storedShortcut}`);
      }
      await page.locator('#chat-body').click();
      await page.locator('#chat-body').fill(enterText);
      await page.keyboard.press('Enter');
      try {
        await waitForLocatorText(page, '#message-list', enterText, 15000);
      } catch (error) {
        const snap = await page.evaluate(() => ({
          title: document.getElementById('chat-title') && document.getElementById('chat-title').textContent,
          status: document.getElementById('status') && document.getElementById('status').textContent,
          composer: document.getElementById('chat-body') && document.getElementById('chat-body').value,
          shortcut: document.getElementById('chat-body') && document.getElementById('chat-body').dataset.sendShortcut,
          list: (document.getElementById('message-list') && document.getElementById('message-list').innerText || '').slice(0, 240),
        }));
        throw new Error(`${error.message} ${JSON.stringify(snap)}`);
      }
      const afterEnter = await visibleText(page.locator('#message-list'));
      const composerValue = await page.locator('#chat-body').inputValue();
      record(
        'chat_send_enter_shortcut',
        afterEnter.includes(enterText) && composerValue === '',
        `composer=${JSON.stringify(composerValue)} ${afterEnter.slice(0, 240) || 'enter send empty'}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '61-chat-send-enter.png')));
      try {
        const message = page.locator('#message-list > li').filter({hasText:enterText}).last();
        await message.locator('.message-more').click({force:true});
        await page.locator('[data-menu="save"]').click();
        await page.locator('#save-message-dialog').waitFor({state:'visible'});
        const warning = await page.locator('#save-message-dialog').innerText();
        if (!warning.includes('工作区内所有成员')) throw new Error('workspace sharing disclosure absent');
        // Cancel is a genuine no-op; reopen and explicitly confirm the workspace copy.
        await page.locator('#save-message-cancel').click();
        await message.locator('.message-more').click({force:true});
        await page.locator('[data-menu="save"]').click();
        await page.locator('#save-message-title').fill('[CI FIXTURE] Explicit saved social message');
        const saved = page.waitForResponse(r=>r.request().method()==='POST' && /\/messages\/[a-f0-9]+\/save$/.test(new URL(r.url()).pathname));
        await page.locator('#save-message-submit').click();
        const response = await saved; const result = await response.json();
        if (response.status() !== 201) throw new Error('social save failed: ' + response.status());
        await page.locator('#save-message-dialog').waitFor({state:'hidden'});
        const persisted = await context.request.get(`${origin}/v1/workspaces/${ready.workspace_id}/artifacts/${result.artifact.id}`);
        const copy = await persisted.json();
        record('chat_social_save', persisted.status()===200 && copy.artifact.body===enterText, 'explicit workspace-visible copy persisted');
        screenshots.push(path.basename(await shot(page, outDir, '95-chat-saved-message.png')));
      } catch (error) { record('chat_social_save', false, String(error)); }

    } catch (error) {
      record('chat_send_enter_shortcut', false, String(error));
    } finally {
      try {
        await writeSendShortcut(page, 'mod_enter');
        await page.goto(`${origin}/space`, {waitUntil: 'load'});
        await page.goto(chatUrl, {waitUntil: 'load'});
        await waitForLocatorText(page, '#chat-title', ready.agent_name, 20000);
      } catch (error) {
        record('chat_send_enter_restore', false, String(error), {soft: true});
      }
    }

    try {
      await page.locator('#new-conversation').click();
      const menu = page.locator('#compose-menu');
      await menu.waitFor({ state: 'visible', timeout: 8000 });
      const menuText = `${await visibleText(menu)}`;
      record(
        'chat_new_menu',
        menuText.includes('创建智能体')
          && menuText.includes('新建群组')
          && menuText.includes('添加联系人')
          && menuText.includes('创建 Artifacts')
          && menuText.includes('创建自动化')
          && menuText.includes('创建第三方智能体')
          && menuText.includes('发起视频会议')
          && menuText.includes('加入视频会议')
          && !menuText.includes('积分中心')
          && await page.locator('#compose-new-group').isEnabled()
          && await page.locator('#compose-menu button[disabled]').count() >= 3,
        menuText || 'compose menu empty',
      );
      screenshots.push(path.basename(await shot(page, outDir, '53-chat-new-menu.png')));
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden', timeout: 5000 });
    } catch (error) {
      record('chat_new_menu', false, String(error));
    }

    try {
      await page.locator('#new-conversation').click();
      await page.locator('#compose-new-group').click();
      const dialog = page.locator('#compose-dialog');
      await dialog.waitFor({ state: 'visible', timeout: 8000 });
      const dialogText = `${await visibleText(dialog)}`;
      const namePlaceholder = await page.locator('#compose-title').getAttribute('placeholder');
      const searchPlaceholder = await page.locator('#compose-member-search').getAttribute('placeholder');
      record(
        'chat_group_create_chrome',
        dialogText.includes('新建群组')
          && dialogText.includes('添加名称，然后邀请好友并添加 AI 智能体。')
          && dialogText.includes('自定义群组')
          && dialogText.includes('AI 智能体团队')
          && dialogText.includes('群组名称')
          && dialogText.includes('已选 0')
          && namePlaceholder === '输入群组名称（可选）'
          && searchPlaceholder === '搜索'
          && await page.locator('#compose-dialog-submit').isDisabled()
          && await page.locator('#compose-mode-custom').getAttribute('aria-selected') === 'true'
          && !dialogText.includes('积分')
          && !dialogText.includes('成员付费')
          && !dialogText.includes('群主付费')
          && !/套餐|升级/.test(dialogText),
        dialogText || 'group create dialog empty',
      );
      screenshots.push(path.basename(await shot(page, outDir, '78-chat-group-create.png')));
      await page.locator('#compose-dialog-cancel').click();
      await dialog.waitFor({ state: 'hidden', timeout: 5000 });
    } catch (error) {
      record('chat_group_create_chrome', false, String(error));
    }

    try {
      await page.locator('#new-conversation').click();
      await page.locator('#compose-new-group').click();
      const agent = page.locator(`#member-choices input[name="agent-member"][value="${ready.agent_id}"]`);
      const human = page.locator('#member-choices input[name="member"]').first();
      await agent.check();
      record('chat_group_agent_only_disabled',
        await page.locator('#compose-dialog-submit').isDisabled()
          && (await visibleText(page.locator('#compose-selected-count'))).includes('已选 1'),
        'Selecting an agent alone does not satisfy the two-human rule');
      await page.locator('#compose-member-search').fill('no-matching-member-fixture');
      record('chat_group_agent_search', await agent.isHidden() && await human.isHidden(),
        'Search filters human and agent choices without discarding selections');
      await page.locator('#compose-member-search').fill('');
      await human.check();
      await page.locator('#compose-title').fill('[CI FIXTURE] Agent members group');
      record('chat_group_agent_picker',
        await page.locator('#compose-dialog-submit').isEnabled()
          && (await visibleText(page.locator('#compose-selected-count'))).includes('已选 2')
          && (await visibleText(page.locator('#member-choices'))).includes('AI 智能体（自动回复未接通）'),
        'An existing human and agent are selected; custom group create is enabled');
      await page.locator('#compose-mode-team').click();
      await page.locator('#team-template-choices input[value="product-squad"]').waitFor({state: 'visible', timeout: 8000});
      const disabledBeforePick = await page.locator('#compose-dialog-submit').isDisabled();
      await page.locator('#team-template-choices input[value="product-squad"]').check();
      record('chat_group_agent_team_template',
        disabledBeforePick && await page.locator('#compose-dialog-submit').isEnabled()
          && (await visibleText(page.locator('#team-template-choices'))).includes('产品研发小队'),
        'AI-team mode requires picking a real template before create is enabled');
      await page.locator('#compose-mode-custom').click();
      screenshots.push(path.basename(await shot(page, outDir, '79-chat-group-agent-picker.png')));
      await page.locator('#compose-dialog-submit').click();
      await page.locator('#compose-dialog').waitFor({state: 'hidden', timeout: 8000});
      await waitForLocatorText(page, '#chat-title', '[CI FIXTURE] Agent members group', 8000);
      await page.reload({waitUntil: 'load'});
      await waitForLocatorText(page, '#chat-title', '[CI FIXTURE] Agent members group', 8000);
      const summary = await visibleText(page.locator('#social-agent-members'));
      record('chat_group_agent_saved',
        summary.includes(ready.agent_name) && summary.includes('未接通：群内自动回复'),
        summary || 'Saved agent participants missing after reload');
      screenshots.push(path.basename(await shot(page, outDir, '80-chat-group-agent-members.png')));
      await page.locator('#new-conversation').click();
      await page.locator('#compose-add-contact').click();
      record('chat_group_agent_contact_separate',
        await page.locator('#member-choices input[name="agent-member"]').count() === 0
          && await page.locator('#member-choices input[type="radio"]').count() > 0,
        'Adding a contact still offers human-only single selection');
      await page.locator('#compose-dialog-cancel').click();
    } catch (error) {
      record('chat_group_agent_members', false, String(error));
    } finally {
      await page.goto(chatUrl, {waitUntil: 'load'});
      await waitForLocatorText(page, '#chat-title', ready.agent_name, 20000);
    }

    try {
      await page.locator('#conversation-list button').filter({hasText: '[CI FIXTURE] Agent members group'}).click();
      await page.locator('#group-agent-action').waitFor({state: 'visible', timeout: 8000});
      await openGroupAgentSheet(page);
      const groupAgentChoice = page.locator(`#group-agent-choices input[name="group-agent"][value="${ready.agent_id}"]`);
      await groupAgentChoice.waitFor({state: 'visible', timeout: 8000});
      await groupAgentChoice.check();
      await page.locator('#group-agent-prompt').fill('[CI FIXTURE] Explicit one-shot group request to the labeled fake provider');
      screenshots.push(path.basename(await shot(page, outDir, '81-group-agent-request.png')));
      await page.locator('#group-agent-submit').click();
      await page.locator('#group-agent-requests [data-reply-status="succeeded"]').waitFor({state: 'visible', timeout: 30000});
      await page.reload({waitUntil: 'load'});
      await waitForLocatorText(page, '#message-list', ready.provider_text, 20000);
      const transcript = await visibleText(page.locator('#message-list'));
      record('group_agent_explicit_reply',
        transcript.includes('AI 智能体 · 运行时回复') && transcript.includes(ready.provider_text)
          && await page.locator('#group-agent-requests [data-reply-status="succeeded"]').count() === 1,
        'Explicit request completed through the runtime fixture and persisted after reload: ' + transcript);
      screenshots.push(path.basename(await shot(page, outDir, '82-group-agent-reply.png')));
    } catch (error) {
      record('group_agent_explicit_reply', false, String(error));
    } finally {
      await page.goto(chatUrl, {waitUntil: 'load'});
      await waitForLocatorText(page, '#chat-title', ready.agent_name, 20000);
    }

    try {
      await page.locator('#session-search').click();
      const panel = page.locator('#search-panel');
      await panel.waitFor({ state: 'visible', timeout: 8000 });
      const emptyText = `${await visibleText(panel)}`;
      record(
        'chat_search_empty',
        emptyText.includes('全部')
          && emptyText.includes('Artifacts')
          && emptyText.includes('联系人')
          && emptyText.includes('群组')
          && emptyText.includes('智能体')
          && emptyText.includes('消息')
          && emptyText.includes('当前工作区')
          && emptyText.includes(ready.agent_name)
          && emptyText.includes(ready.social_group_title)
          && !/积分|套餐|升级/.test(emptyText),
        emptyText || 'empty search panel missing',
      );
      screenshots.push(path.basename(await shot(page, outDir, '54-chat-search-empty.png')));
    } catch (error) {
      record('chat_search_empty', false, String(error));
    }

    try {
      await page.locator('#session-search').click();
      const panel = page.locator('#search-panel');
      await panel.waitFor({ state: 'visible', timeout: 8000 });
      await page.locator('#session-search').fill(ready.social_message_text);
      await page.locator('#search-panel [data-search-tab="messages"]').click();
      await waitForLocatorText(page, '#search-results', ready.social_message_text, 15000);
      const messageText = `${await visibleText(panel)}`;
      record(
        'chat_search_messages',
        messageText.includes('消息')
          && messageText.includes(ready.social_message_text)
          && messageText.includes(ready.social_group_title),
        messageText || 'message search empty',
      );
      screenshots.push(path.basename(await shot(page, outDir, '55-chat-search-messages.png')));
      await page.locator('#search-close').click();
      await panel.waitFor({ state: 'hidden', timeout: 5000 });
    } catch (error) {
      record('chat_search_messages', false, String(error));
    }

    try {
      // The header action must scope on the server, not filter a global first page.
      await page.locator('#message-search').click();
      await waitForLocatorText(page, '#search-source-note', '仅搜索当前对话');
      await page.locator('#session-search').fill('[CI FIXTURE]');
      await waitForLocatorText(page, '#search-results', ready.chat_user_text, 15000);
      const scopedAgent = await visibleText(page.locator('#search-results'));
      record('chat_search_agent_scope', scopedAgent.includes(ready.agent_name)
        && !scopedAgent.includes(ready.social_group_title)
        && !scopedAgent.includes(ready.social_message_text), scopedAgent);
      screenshots.push(path.basename(await shot(page, outDir, '59-chat-search-current-agent.png')));
      // Leaving the message scope restores workspace-wide message hits.
      await page.locator('#search-panel [data-search-tab="all"]').click();
      await page.locator('#search-panel [data-search-tab="messages"]').click();
      await waitForLocatorText(page, '#search-results', ready.social_message_text, 15000);
      record('chat_search_scope_reset', (await visibleText(page.locator('#search-results'))).includes(ready.social_group_title),
        'non-message tab clears conversation restriction');
      await page.goto(`${origin}/chat#workspace=${ready.workspace_id}&social=${ready.social_group_id}`, {waitUntil: 'load'});
      await waitForLocatorText(page, '#chat-title', ready.social_group_title);
      await page.locator('#message-search').click();
      await waitForLocatorText(page, '#search-source-note', '仅搜索当前对话');
      await page.locator('#session-search').fill('[CI FIXTURE]');
      await waitForLocatorText(page, '#search-results', ready.social_message_text, 15000);
      const scopedSocial = await visibleText(page.locator('#search-results'));
      record('chat_search_social_scope', scopedSocial.includes(ready.social_group_title)
        && !scopedSocial.includes(ready.agent_name) && !scopedSocial.includes(ready.chat_user_text), scopedSocial);
      screenshots.push(path.basename(await shot(page, outDir, '60-chat-search-current-group.png')));
      await page.locator('#search-close').click();
    } catch (error) {
      record('chat_search_conversation_scope', false, String(error));
    }

    // Appended backend-search integration; keep previous capture blocks intact.
    try {
      await page.locator('#conversation-list button').filter({hasText: '[CI FIXTURE] Agent members group'}).click();
      await waitForLocatorText(page, '#message-list', ready.provider_text, 15000);
      await page.locator('#message-search').click();
      await waitForLocatorText(page, '#search-source-note', '仅搜索当前对话');
      await page.locator('#session-search').fill(ready.provider_text);
      await waitForLocatorText(page, '#search-results', ready.provider_text, 15000);
      const hits = await visibleText(page.locator('#search-results'));
      record('chat_search_group_agent_reply', hits.includes('[CI FIXTURE] Agent members group')
        && hits.includes(ready.provider_text), 'Persisted fake-provider group reply found: ' + hits);
      screenshots.push(path.basename(await shot(page, outDir, '85-chat-group-agent-search.png')));
      const groupId = await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('social'));
      const reopened = page.waitForResponse(response => response.request().method() === 'GET'
        && new URL(response.url()).pathname === `/v1/workspaces/${ready.workspace_id}/social/conversations/${groupId}`);
      await page.locator('#search-results button').filter({hasText: '[CI FIXTURE] Agent members group'}).click();
      const response = await reopened;
      const saved = await response.json();
      await waitForLocatorText(page, '#message-list', ready.provider_text, 15000);
      record('chat_search_group_agent_open', response.status() === 200 && saved.conversation.id === groupId
        && saved.items.some(item => item.role === 'agent' && item.body === ready.provider_text)
        && (await visibleText(page.locator('#message-list'))).includes('AI 智能体 · 运行时回复'),
        'Search result fetched the same saved group and runtime-authored reply');
    } catch (error) {
      record('chat_search_group_agent_reply', false, String(error));
    }
    // The next existing step navigates to /automations (a new document), avoiding
    // a fragment-only cleanup navigation racing the async result-open handler.

    await page.setViewportSize({ width: 1280, height: 900 });

    await page.goto(`${origin}/automations`, { waitUntil: 'load' });
    await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
    await selectWorkspace(page, ready.workspace_name);
    let autoList = '';
    try {
      await waitForLocatorText(page, '#automation-list', ready.automation_title);
      autoList = await visibleText(page.locator('#automation-list'));
    } catch (error) {
      autoList = String(error);
    }
    record('automations_list', autoList.includes(ready.automation_title), autoList || 'automation list empty');
    screenshots.push(path.basename(await shot(page, outDir, '05-automations-list.png')));
    try {
      await openListItem(page, ready.automation_title);
      await page.locator('#editor-form').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('#run-panel').waitFor({ state: 'visible', timeout: 15000 });
      const runs = await visibleText(page.locator('#run-list'));
      const emptyRuns = await visibleText(page.locator('#run-empty'));
      const hasHistory = runs.includes(ready.provider_text) || /已完成|运行中|等待已连接的代理/.test(runs);
      record(
        'automations_run_history',
        hasHistory,
        hasHistory ? (runs.slice(0, 200) || 'run list has status text') : (emptyRuns || 'no run history rendered'),
        { soft: true },
      );
      screenshots.push(path.basename(await shot(page, outDir, '06-automations-editor-runs.png')));
    } catch (error) {
      record('automations_run_history', false, String(error), { soft: true });
    }

    await page.goto(`${origin}/space`, { waitUntil: 'load' });
    await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
    await selectWorkspace(page, ready.workspace_name);
    const artifactTitles = [ready.document_title, ready.media_title, ready.board_title, ready.website_title, ready.saved_message_title];
    let artifacts = '';
    try {
      for (const title of artifactTitles) {
        await waitForLocatorText(page, '#artifact-list', title);
      }
      artifacts = await visibleText(page.locator('#artifact-list'));
      const libraryLayout = () => page.locator('#artifact-list').evaluate(node => ({layout: node.dataset.layout, display: getComputedStyle(node).display}));
      const initialLayout = await libraryLayout();
      await page.locator('#layout-toggle [data-layout="list"]').click();
      const listLayout = await libraryLayout();
      await page.locator('#layout-toggle [data-layout="grid"]').click();
      const restoredLayout = await libraryLayout();
      record('ui_library_real_layout_toggle', initialLayout.layout === 'grid' && initialLayout.display === 'grid'
        && listLayout.layout === 'list' && restoredLayout.layout === 'grid', JSON.stringify({initialLayout,listLayout,restoredLayout}));

    } catch (error) {
      artifacts = String(error);
    }
    record(
      'artifacts_list',
      artifactTitles.every((title) => artifacts.includes(title)),
      artifacts || 'artifact list empty',
    );
    const catalog = await visibleText(page.locator('#list-panel'));
    const top = await visibleText(page.locator('.artifacts-top'));
    record(
      'artifacts_catalog',
      top.includes('全部') && top.includes('我创建的') && top.includes('收藏') && top.includes('Memory')
        && catalog.includes('资料空间') && catalog.includes('全部作品') && catalog.includes('Websites') && catalog.includes('文档')
        && catalog.includes('媒体') && catalog.includes('消息') && catalog.includes('会议')
        && catalog.includes('新建') && !/积分|套餐|升级/.test(top + catalog),
      `${top} :: ${catalog || 'catalog empty'}`,
    );
    screenshots.push(path.basename(await shot(page, outDir, '07-artifacts-list.png')));
    try {
      await page.locator('#new-menu-button').click();
      await page.locator('#new-menu').waitFor({ state: 'visible', timeout: 8000 });
      const menu = await visibleText(page.locator('#new-menu'));
      record(
        'artifacts_new_menu',
        menu.includes('云文档') && menu.includes('白板') && menu.includes('上传') && !menu.includes('新建网站'),
        menu || 'new menu empty',
      );
      screenshots.push(path.basename(await shot(page, outDir, '30-artifacts-new-menu.png')));
      await page.keyboard.press('Escape');
    } catch (error) {
      record('artifacts_new_menu', false, String(error));
    }
    try {
      await page.locator('.artifact-kinds [data-kind="meetings"]').click();
      await page.locator('#empty-meetings').waitFor({ state: 'visible', timeout: 8000 });
      const meetings = await visibleText(page.locator('#empty-meetings'));
      record(
        'artifacts_meetings_empty',
        meetings.includes('还没有会议纪要') && !meetings.includes('未实现'),
        meetings || 'meetings empty missing',
      );
      screenshots.push(path.basename(await shot(page, outDir, '31-artifacts-meetings-empty.png')));
      const joined = await visibleText(page.locator('#meetings-chrome'));
      record(
        'artifacts_meetings_chrome',
        joined.includes('我的会议') && joined.includes('这个工作区的会议纪要，最新的在前。') && !(await page.locator('#filter-button').isVisible()) && !(await page.locator('#layout-toggle').isVisible()),
        joined || 'meetings chrome missing',
      );
      await page.locator('.artifact-kinds [data-kind="all"]').click();
      await page.waitForTimeout(300);
      const chromeRetired = await page.locator('#meetings-chrome').evaluate((node) => node.hidden);
      record(
        'artifacts_meetings_leaves',
        chromeRetired && await page.locator('#filter-button').isVisible(),
        chromeRetired ? 'meetings chrome retired, filters back' : 'meetings chrome still shown',
      );
      screenshots.push(path.basename(await shot(page, outDir, '37-artifacts-back-from-meetings.png')));
      await page.locator('.artifact-kinds [data-kind="meetings"]').click();
      await page.locator('#empty-meetings').waitFor({ state: 'visible', timeout: 8000 });
      const meetingsChromeView = await visibleText(page.locator('#main-panel'));
      record(
        'space_meetings_chrome',
        meetingsChromeView.includes('我的会议')
          && meetingsChromeView.includes('还没有会议纪要')
          && meetingsChromeView.includes('在「会议」页记下纪要后，这里会按时间倒序列出。')
          && await page.locator('#empty-meetings .empty-hero svg').count() === 1
          && await page.locator('#meetings-title').isVisible()
          && await page.locator('#artifact-notify').getAttribute('aria-label') === '通知'
          && await page.locator('#artifact-notify').isDisabled()
          && await page.locator('#workspace').isVisible()
          && !/积分|套餐|升级/.test(meetingsChromeView),
        meetingsChromeView || 'meetings heading or icon missing',
      );
      screenshots.push(path.basename(await shot(page, outDir, '73-space-meetings-chrome.png')));
      await page.locator('.artifact-kinds [data-kind="all"]').click();
      await waitForLocatorText(page, '#artifact-list', ready.document_title);
    } catch (error) {
      record('artifacts_meetings_unimplemented', false, String(error));
    }
    try {
      await page.locator('#filter-button').click();
      await page.locator('#filter-panel').waitFor({ state: 'visible', timeout: 8000 });
      await page.locator('.filter-section[data-section="types"] .filter-accordion').click();
      const types = await visibleText(page.locator('#filter-panel'));
      record(
        'artifacts_filter_file_types',
        types.includes('文件类型') && types.includes('云文档') && types.includes('Markdown') && types.includes('DOCX') && types.includes('PDF') && types.includes('电子表格') && types.includes('幻灯片') && types.includes('Web 应用') && types.includes('网页') && types.includes('图片') && types.includes('视频') && types.includes('音频') && types.includes('白板') && types.includes('消息'),
        types || 'filter types missing',
      );
      screenshots.push(path.basename(await shot(page, outDir, '32-space-filter-file-type.png')));
      await page.locator('.filter-section[data-section="modified"] .filter-accordion').click();
      const modified = await visibleText(page.locator('#filter-panel'));
      record(
        'artifacts_filter_modified',
        modified.includes('修改时间') && modified.includes('不限时间') && modified.includes('今天') && modified.includes('最近 7 天') && modified.includes('最近 30 天') && modified.includes('最近 90 天') && modified.includes('自定义范围'),
        modified || 'filter modified missing',
      );
      screenshots.push(path.basename(await shot(page, outDir, '33-space-filter-modified.png')));
      await page.locator('.filter-section[data-section="creators"] .filter-accordion').click();
      const creators = await visibleText(page.locator('#filter-panel'));
      record(
        'artifacts_filter_creators',
        creators.includes('创建人') && creators.includes(ready.username) && !creators.includes('暂无可筛选的创建人'),
        creators || 'filter creators missing',
      );
      screenshots.push(path.basename(await shot(page, outDir, '64-space-filter-creator.png')));
      await page.locator('.filter-section[data-section="sessions"] .filter-accordion').click();
      const sessions = await visibleText(page.locator('#filter-panel'));
      const hexId = /^[0-9a-f]{32}$/i;
      const sessionLabels = await page.locator('#filter-session-list label').allTextContents();
      record(
        'artifacts_filter_sessions',
        sessions.includes('来源会话')
          && sessions.includes(ready.conversation_title)
          && !sessions.includes('没有匹配的会话')
          && sessionLabels.some((label) => label.includes(ready.conversation_title))
          && sessionLabels.every((label) => !hexId.test(label.trim())),
        sessions || 'filter sessions missing',
      );
      screenshots.push(path.basename(await shot(page, outDir, '65-space-filter-source-session.png')));
      await page.keyboard.press('Escape');
    } catch (error) {
      record('artifacts_filter_file_types', false, String(error));
    }
    try {
      await page.goto(`${origin}/space?view=starred`, { waitUntil: 'load' });
      await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
      await selectWorkspace(page, ready.workspace_name);
      await page.locator('#empty-starred').waitFor({ state: 'visible', timeout: 8000 });
      const starred = await visibleText(page.locator('#empty-starred'));
      // The picture entry is a real link into /chat; the old disabled button
      // claimed there was no way to save a chat picture, which was false.
      const picture = await page.evaluate(() => {
        const node = document.getElementById('empty-save-image');
        if (!node) return null;
        return {tag: node.tagName, href: node.getAttribute('href'),
                disabled: node.hasAttribute('disabled'),
                text: (node.textContent || '').replace(/\s+/g, ' ')};
      });
      record(
        'artifacts_starred_empty',
        starred.includes('暂无收藏') && starred.includes('保存聊天中的消息') && starred.includes('保存聊天中的图片') && starred.includes('保存智能体成果')
          && picture !== null && picture.tag === 'A' && picture.href === '/chat' && !picture.disabled && !picture.text.includes('未实现'),
        JSON.stringify({starred, picture}),
      );
      screenshots.push(path.basename(await shot(page, outDir, '34-space-starred-empty.png')));
    } catch (error) {
      record('artifacts_starred_empty', false, String(error));
    }
    try {
      await page.goto(`${origin}/space?view=memory`, { waitUntil: 'load' });
      await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
      await selectWorkspace(page, ready.workspace_name);
      await page.locator('#empty-memory').waitFor({ state: 'visible', timeout: 8000 });
      const memoryView = await visibleText(page.locator('#empty-memory'));
      record(
        'artifacts_memory_empty',
        memoryView.includes('没有匹配的作品') && memoryView.includes('智能体生成的作品将显示在此处。') && !memoryView.includes('新建云文档'),
        memoryView || 'memory empty missing',
      );
      screenshots.push(path.basename(await shot(page, outDir, '35-space-memory-empty.png')));
    } catch (error) {
      record('artifacts_memory_empty', false, String(error));
    }
    try {
      await page.goto(`${origin}/space`, { waitUntil: 'load' });
      await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
      await selectWorkspace(page, ready.empty_workspace_name);
      await page.locator('#empty-all').waitFor({ state: 'visible', timeout: 8000 });
      const emptyAll = await visibleText(page.locator('#empty-all'));
      record(
        'artifacts_empty_all',
        emptyAll.includes('你的资料空间从这里开始') && emptyAll.includes('都会出现在这里。') && emptyAll.includes('新建云文档') && emptyAll.includes('让智能体搭建网站') && emptyAll.includes('保存聊天中的消息'),
        emptyAll || 'empty all missing',
      );
      screenshots.push(path.basename(await shot(page, outDir, '38-space-empty-all.png')));
      try {
        const dirText = await visibleText(page.locator('#artifact-dir'));
        const newLabel = await visibleText(page.locator('#new-menu-button'));
        record(
          'artifacts_dir_chrome',
          dirText.includes('资料空间') && dirText.includes('全部作品') && newLabel.includes('新建')
            && await page.locator('#dir-collapse').getAttribute('aria-label') === '收起侧边栏'
            && await page.locator('#layout-toggle [data-layout="grid"]').getAttribute('aria-label') === '网格视图',
          `${dirText} :: ${newLabel}`,
        );
        await page.locator('#dir-collapse').click();
        await page.locator('#dir-expand').waitFor({ state: 'visible', timeout: 8000 });
        const collapsedHidden = await page.locator('#artifact-dir').isHidden();
        const expandVisible = await page.locator('#dir-expand').isVisible();
        const collapsedClass = (await page.locator('#list-panel').getAttribute('class') || '').includes('dir-collapsed');
        record(
          'artifacts_dir_collapsed',
          collapsedHidden && expandVisible && collapsedClass,
          `hidden=${collapsedHidden} expand=${expandVisible} class=${collapsedClass}`,
        );
        screenshots.push(path.basename(await shot(page, outDir, '68-space-dir-collapsed.png')));
        await page.locator('#dir-expand').click();
        await page.locator('#artifact-dir').waitFor({ state: 'visible', timeout: 8000 });
      } catch (error) {
        record('artifacts_dir_chrome', false, String(error));
        try { await page.locator('#dir-expand').click({ timeout: 2000 }); } catch (_) {}
      }
      await page.locator('#filter-button').click();
      await page.locator('#filter-panel').waitFor({ state: 'visible', timeout: 8000 });
      await page.locator('.filter-section[data-section="creators"] .filter-accordion').click();
      const emptyCreators = await visibleText(page.locator('#filter-panel'));
      record(
        'artifacts_filter_creators_empty',
        emptyCreators.includes('创建人') && emptyCreators.includes('暂无可筛选的创建人'),
        emptyCreators || 'empty filter creators missing',
      );
      screenshots.push(path.basename(await shot(page, outDir, '66-space-filter-creator-empty.png')));
      await page.locator('.filter-section[data-section="sessions"] .filter-accordion').click();
      const emptySessions = await visibleText(page.locator('#filter-panel'));
      record(
        'artifacts_filter_sessions_empty',
        emptySessions.includes('来源会话') && emptySessions.includes('没有匹配的会话'),
        emptySessions || 'empty filter sessions missing',
      );
      screenshots.push(path.basename(await shot(page, outDir, '67-space-filter-source-session-empty.png')));
      await page.keyboard.press('Escape');
      await page.locator('.artifact-scopes [data-scope="mine"]').click();
      await page.locator('#empty-all').waitFor({ state: 'visible', timeout: 8000 });
      const emptyMine = await visibleText(page.locator('#empty-all'));
      record(
        'artifacts_empty_created',
        emptyMine.includes('你的资料空间从这里开始') && emptyMine.includes('新建云文档'),
        emptyMine || 'empty created missing',
      );
      screenshots.push(path.basename(await shot(page, outDir, '39-space-empty-created.png')));
      await selectWorkspace(page, ready.workspace_name);
      await waitForLocatorText(page, '#artifact-list', ready.document_title);
    } catch (error) {
      record('artifacts_empty_all', false, String(error));
    }

    const openArtifact = async (title, file, checkName, extra, { soft = true } = {}) => {
      try {
        await page.goto(`${origin}/space`, { waitUntil: 'load' });
        await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
        await selectWorkspace(page, ready.workspace_name);
        await page.locator('#artifact-list').waitFor({ state: 'visible', timeout: 15000 });
        await openListItem(page, title, '#artifact-list');
        await page.locator('#editor-form').waitFor({ state: 'visible', timeout: 15000 });
        await waitForInputValue(page, '#editor-form input[name="title"]', title);
        const ok = await extra();
        record(checkName, ok, title, { soft });
        screenshots.push(path.basename(await shot(page, outDir, file)));
      } catch (error) {
        record(checkName, false, String(error), { soft });
      }
    };
    await openArtifact(ready.document_title, '08-artifacts-document.png', 'artifacts_document', async () => {
      await page.locator('#document-rich').waitFor({state: 'visible'});
      await waitForStoredValue(page, '#editor-form textarea[name="body"]', ready.document_body);
      const body = await page.locator('#editor-form textarea[name="body"]').inputValue();
      return body === ready.document_body;
    }, { soft: false });
    try {
      await page.locator('#cancel-editor').click();
      await page.locator('#new-menu-button').click();
      await page.locator('#new-artifact').click();
      const title = '[CI FIXTURE] Rich document round trip';
      await page.locator('#editor-form input[name="title"]').fill(title);
      await page.locator('#document-rich').fill('First rich paragraph');
      await waitForStoredValue(page, '#editor-form textarea[name="body"]', 'First rich paragraph');
      await page.locator('#document-rich').evaluate(root => {
        root.focus();
        const selection = window.getSelection();
        selection.selectAllChildren(root);
      });
      await page.locator('[data-doc-format="h2"]').click();
      await waitForLocatorText(page, '#document-rich h2', 'First rich paragraph');
      await waitForStoredValue(page, '#editor-form textarea[name="body"]', '## First rich paragraph');
      await page.locator('#document-source-toggle').click();
      const markdown = '# Rich heading\n\n- First point\n- Second point';
      await page.locator('#document-source').fill(markdown);
      await page.locator('#document-source-toggle').click();
      await waitForLocatorText(page, '#document-rich h1', 'Rich heading');
      const saved = page.waitForResponse(response => response.request().method() === 'POST' && /\/artifacts$/.test(new URL(response.url()).pathname));
      await page.locator('#save-artifact').click();
      const response = await saved;
      const result = await response.json();
      if (response.status() !== 201) throw new Error('rich document not created: ' + response.status());
      await waitForLocatorText(page, '#status', '已保存');
      await page.reload();
      await selectWorkspace(page, ready.workspace_name);
      await openListItem(page, title, '#artifact-list');
      await waitForStoredValue(page, '#editor-form textarea[name="body"]', markdown);
      await page.locator('#document-rich h1').waitFor({state:'visible'});
      record('artifacts_rich_roundtrip', await page.locator('#document-rich li').count() === 2 && !!result.artifact.id, 'rich typing + heading toolbar + Markdown toggle + save + reload');
      screenshots.push(path.basename(await shot(page, outDir, '93-space-rich-document.png')));
      await page.locator('#cancel-editor').click();
      const row = page.locator('#artifact-list .artifact-item').filter({has: page.locator('.artifact-open', {hasText: title})});
      // Use the returned title to select this exact saved card, not the first fixture row.
      const card = (await row.count()) ? row : page.locator('#artifact-list .artifact-item').filter({hasText:title});
      const favorite = card.locator('.artifact-bookmark');
      const marked = page.waitForResponse(r => r.request().method()==='POST' && r.url().endsWith('/favorite'));
      await favorite.click();
      if ((await marked).status() !== 200) throw new Error('favorite not persisted');
      await page.reload();
      await selectWorkspace(page, ready.workspace_name);
      await page.locator('.artifact-scopes [data-scope="favorites"]').click();
      await waitForLocatorText(page, '#artifact-list', title);
      record('artifacts_favorite_persisted', await page.locator('#artifact-list .artifact-bookmark[aria-pressed="true"]').count() >= 1, 'private favorite survives reload');
      screenshots.push(path.basename(await shot(page, outDir, '94-space-favorites.png')));
    } catch (error) { record('artifacts_rich_roundtrip', false, String(error)); }

    await openArtifact(ready.media_title, '09-artifacts-media.png', 'artifacts_media', async () => {
      const image = page.locator('#media-image');
      await image.waitFor({ state: 'visible', timeout: 15000 });
      return image.isVisible();
    });
    await openArtifact(ready.board_title, '10-artifacts-whiteboard.png', 'artifacts_whiteboard', async () => {
      const canvas = page.locator('#board-canvas');
      await canvas.waitFor({ state: 'visible', timeout: 15000 });
      return canvas.isVisible();
    });
    await openArtifact(ready.website_title, '11-artifacts-website.png', 'artifacts_website', async () => {
      const preview = page.locator('#website-preview');
      await preview.waitFor({ state: 'visible', timeout: 15000 });
      return preview.isVisible();
    });

    await page.goto(`${origin}/members`, { waitUntil: 'load' });
    await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
    await selectWorkspace(page, ready.workspace_name);
    let members = '';
    let invites = '';
    try {
      await waitForLocatorText(page, '#member-list', ready.username);
      await waitForLocatorText(page, '#member-list', ready.member_username);
      members = await visibleText(page.locator('#member-list'));
      invites = await visibleText(page.locator('#invite-list'));
    } catch (error) {
      members = members || String(error);
    }
    record(
      'members',
      members.includes(ready.username) && members.includes(ready.member_username),
      `members=${members || '(empty)'}; invites=${invites || '(empty)'}`,
    );
    screenshots.push(path.basename(await shot(page, outDir, '12-members.png')));

    await page.goto(`${origin}/team`, { waitUntil: 'load' });
    await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
    const teamHeading = await visibleText(page.locator('h1'));
    const step1 = await page.locator('#wizard-form #step-1').isVisible();
    const nameField = await page.locator('#wizard-form input[name="name"]').isVisible();
    const slugField = await page.locator('#wizard-form input[name="slug"]').isVisible();
    const nextDisabled = await page.locator('#next').isDisabled();
    const step1Text = await visibleText(page.locator('#step-1'));
    record(
      'team_wizard',
      teamHeading.includes('创建团队') && step1 && nameField && slugField && nextDisabled
        && step1Text.includes('为团队命名')
        && step1Text.includes('创建独立的团队工作区')
        && step1Text.includes('转化我当前的工作区'),
      `heading=${teamHeading}; nextDisabled=${nextDisabled}`,
    );
    screenshots.push(path.basename(await shot(page, outDir, '13-team-wizard-step1.png')));
    try {
      await page.locator('#wizard-form input[name="name"]').fill('CI Fixture Preview Team');
      await page.locator('#wizard-form input[name="slug"]').fill('ci-preview-team');
      await page.locator('#next').click();
      await page.locator('#step-2').waitFor({ state: 'visible', timeout: 10000 });
      const step2Text = await visibleText(page.locator('#step-2'));
      record(
        'team_wizard_continuation',
        await page.locator('#step-2').isVisible()
          && await page.locator('#invite-role').isVisible()
          && await page.locator('#invite-skip').isVisible()
          && await page.locator('#submit').isVisible()
          && step2Text.includes('邀请成员'),
        'name and slug accepted; invite step visible, not submitted',
        { soft: true },
      );
      screenshots.push(path.basename(await shot(page, outDir, '13b-team-wizard-continuation.png')));
    } catch (error) {
      record('team_wizard_continuation', false, String(error), { soft: true });
    }

    await page.goto(`${origin}/runtimes`, { waitUntil: 'load' });
    await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
    const runtimePanel = await visibleText(page.locator('#runtimes-panel'));
    record(
      'runtimes',
      runtimePanel.includes('自托管 FlyBot') && runtimePanel.includes('托管云端 Agent') && runtimePanel.includes('托管电脑') && runtimePanel.includes('已检测到的运行时') && runtimePanel.includes('连接远程机器'),
      runtimePanel || 'runtimes tab missing',
    );
    screenshots.push(path.basename(await shot(page, outDir, '14-runtimes.png')));
    await page.locator('[data-tab="connect"]').click();
    await page.locator('#connect-panel').waitFor({ state: 'visible', timeout: 15000 });
    const connect = await visibleText(page.locator('#connect-panel'));
    // main-panel is shown before loadKeys()/connections finish. Wait on the
    // actual seeded state, not visibility of the still-empty connect container.
    await waitForLocatorText(page, '#key-list', ready.runtime_key_name);
    await waitForLocatorText(page, '#connection-list', ready.runtime_key_name);
    await page.locator('#daemon-script').waitFor({state: 'visible', timeout: 15000});
    const keys = await visibleText(page.locator('#key-list'));
    const connections = await visibleText(page.locator('#connection-list'));
    const generateDisabled = await page.locator('#generate-key').isDisabled();
    const daemonVisible = await page.locator('#daemon-script').isVisible();
    const daemonText = await visibleText(page.locator('#daemon-command'));
    const unixInstall = await visibleText(page.locator('#install-unix'));
    record(
      'runtimes_connect_layout',
      connect.includes('连接一台机器') && connect.includes('生成 API key') && connect.includes('设备 ID') && connect.includes('macOS / Linux') && connect.includes('Windows') && connect.includes('Never') && generateDisabled && !/积分|套餐|升级/.test(connect) && !connect.toLowerCase().includes('teamily.com') && !unixInstall.includes('curl -fsSL'),
      connect.slice(0, 400) || 'connect panel empty',
    );
    record(
      'runtimes_connect_key_prefix_only',
      keys.includes(ready.runtime_key_name) && keys.includes('…') && !(await page.locator('#issued-token').isVisible()),
      keys || 'key list empty',
    );
    record(
      'runtimes_connect_daemon_after_key',
      daemonVisible && daemonText.includes('python3 flybot.pyz daemon start') && daemonText.includes(origin) && !(await page.locator('#daemon-pending').isVisible()),
      daemonText || 'daemon command hidden',
    );
    record(
      'runtimes_connection',
      connections.includes(ready.runtime_key_name) && /在线|离线/.test(connections),
      connections || 'connection list empty',
      { soft: true },
    );
    screenshots.push(path.basename(await shot(page, outDir, '15-runtimes-connect.png')));
    try {
      await page.locator('.os-tabs [data-os="windows"]').click();
      await page.locator('#install-windows').waitFor({ state: 'visible', timeout: 8000 });
      const windowsInstall = await visibleText(page.locator('#install-windows'));
      const lang = await visibleText(page.locator('#install-lang'));
      record(
        'runtimes_connect_windows_install',
        lang.includes('powershell') && windowsInstall.includes('/install/flybot.pyz') && windowsInstall.includes('Invoke-WebRequest') && !windowsInstall.toLowerCase().includes('install.ps1') && !windowsInstall.toLowerCase().includes('teamily'),
        windowsInstall || 'windows install missing',
      );
      screenshots.push(path.basename(await shot(page, outDir, '40-runtimes-connect-windows.png')));
      await page.locator('.os-tabs [data-os="unix"]').click();
    } catch (error) {
      record('runtimes_connect_windows_install', false, String(error));
    }

    await page.goto(`${origin}/memory`, { waitUntil: 'load' });
    await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
    await selectWorkspace(page, ready.workspace_name);
    await waitForLocatorText(page, '#memory-list', ready.memory_title);
    const memoryList = await visibleText(page.locator('#memory-list'));
    const overview = await visibleText(page.locator('#list-panel'));
    record('memory_list', memoryList.includes(ready.memory_title) && memoryList.includes(`${ready.memory_topic} 1`) && memoryList.includes(ready.memory_body) && memoryList.includes(`#${ready.memory_topic}`) && !memoryList.includes('Teamily Wiki') && !memoryList.includes('Getting Started') && !memoryList.includes('新'), memoryList || 'memory list empty');
    record(
      'memory_overview',
      overview.includes('总览') && overview.includes('我的资料') && overview.includes('下一步行动') && overview.includes('我的作品') && overview.includes('我的会议') && overview.includes('话题亮点') && overview.includes('新建') && await page.locator('#graph-canvas').isVisible() && !/积分|套餐|升级/.test(overview),
      overview || 'memory overview empty',
    );
    const dirText = await visibleText(page.locator('#memory-dir'));
    const newLabel = (await visibleText(page.locator('#new-page'))).trim();
    record(
      'memory_dir_chrome',
      dirText.includes('记忆') && dirText.includes('全部') && dirText.includes('更新') && dirText.includes('标签')
        && newLabel.includes('新建') && await page.locator('#dir-collapse').getAttribute('aria-label') === '收起侧边栏'
        && await page.locator('.memory-views [data-view="overview"] .view-icon').count() === 1
        && !/积分|套餐|升级/.test(dirText),
      dirText || 'memory directory chrome missing',
    );
    screenshots.push(path.basename(await shot(page, outDir, '18-memory-list.png')));
    try {
      const emptyHint = page.locator('#graph-empty');
      await emptyHint.waitFor({ state: 'visible', timeout: 8000 });
      const emptyText = ((await visibleText(emptyHint)) || '').trim();
      const createLabel = ((await visibleText(page.locator('#graph-empty-new'))) || '').trim();
      record(
        'memory_graph_empty',
        emptyText.includes('创建两个或更多记忆页后，这里会把它们连成图谱')
          && createLabel === '新建记忆页'
          && await page.locator('#graph-empty-new').isEnabled(),
        emptyText || 'memory graph empty hint missing',
      );
      screenshots.push(path.basename(await shot(page, outDir, '90-memory-graph-empty.png')));
      const previous = page.viewportSize();
      await page.setViewportSize({ width: 390, height: 844 });
      await emptyHint.waitFor({ state: 'visible', timeout: 8000 });
      await emptyHint.scrollIntoViewIfNeeded();
      const viewport = page.viewportSize();
      const inViewport = (box) => Boolean(box && viewport && box.x >= 0 && box.y >= 0
        && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height);
      const hintBox = await emptyHint.boundingBox();
      const zoomBox = await page.locator('.graph-zoom').boundingBox();
      const zoomVisible = await page.locator('.graph-zoom').isVisible();
      const overlaps = Boolean(
        hintBox && zoomBox
          && hintBox.x < zoomBox.x + zoomBox.width
          && hintBox.x + hintBox.width > zoomBox.x
          && hintBox.y < zoomBox.y + zoomBox.height
          && hintBox.y + hintBox.height > zoomBox.y,
      );
      record(
        'memory_graph_empty_narrow',
        zoomVisible && hintBox && zoomBox && hintBox.width >= 180
          && inViewport(hintBox) && inViewport(zoomBox) && !overlaps,
        `overlap=${overlaps}; hintInViewport=${inViewport(hintBox)}; zoomInViewport=${inViewport(zoomBox)}; hint=${JSON.stringify(hintBox)}; zoom=${JSON.stringify(zoomBox)}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '91-memory-graph-empty-390.png')));
      await page.setViewportSize(previous || { width: 1440, height: 900 });
    } catch (error) {
      record('memory_graph_empty', false, String(error));
      try {
        await page.setViewportSize({ width: 1440, height: 900 });
      } catch {
        // Keep going so later memory shots still use the default viewport.
      }
    }
    record(
      'memory_dir_previews',
      await page.locator('#memory-list .memory-page-preview').count() === 1
        && (await visibleText(page.locator('#memory-list .memory-page-preview'))) === ready.memory_body
        && await page.locator('#memory-list .memory-page-icon svg').count() === 1
        && !memoryList.includes('新'),
      memoryList || 'memory directory preview missing',
    );
    screenshots.push(path.basename(await shot(page, outDir, '70-memory-dir-previews.png')));
    try {
      const graphNode = page.locator('#graph-canvas .graph-item').first();
      await graphNode.waitFor({ state: 'visible', timeout: 8000 });
      await graphNode.locator('.graph-node').hover();
      await page.waitForTimeout(400);
      const hoverCard = page.locator('#graph-hover-card');
      const hoverText = await visibleText(hoverCard);
      record(
        'memory_graph_hover',
        await hoverCard.isVisible()
          && hoverText.includes(ready.memory_title)
          && hoverText.includes(ready.memory_body)
          && hoverText.includes(`#${ready.memory_topic}`)
          && (await visibleText(page.locator('.graph-hint'))).includes('单击查看 · 双击打开 · 悬停预览'),
        hoverText || 'graph hover card missing',
      );
      screenshots.push(path.basename(await shot(page, outDir, '83-memory-graph-hover.png')));
      await graphNode.dblclick();
      await page.locator('#editor-form').waitFor({ state: 'visible', timeout: 8000 });
      const openedTitle = await page.locator('#editor-form [name="title"]').inputValue();
      record('memory_graph_open', openedTitle === ready.memory_title, openedTitle || 'graph double-click did not open the page');
      screenshots.push(path.basename(await shot(page, outDir, '84-memory-graph-open.png')));
      await page.locator('#close-editor').click();
      await page.locator('#overview-panel').waitFor({ state: 'visible', timeout: 8000 });
    } catch (error) {
      record('memory_graph_hover', false, String(error));
    }
    try {
      await page.locator('#dir-collapse').click();
      await page.locator('#dir-expand').waitFor({ state: 'visible', timeout: 8000 });
      const collapsedClass = (await page.locator('#list-panel').getAttribute('class') || '').includes('dir-collapsed');
      const expandVisible = await page.locator('#dir-expand').isVisible();
      const dirHidden = await page.locator('#memory-dir').isHidden();
      record(
        'memory_dir_collapsed',
        collapsedClass && expandVisible && dirHidden && (await page.locator('#dir-expand').getAttribute('aria-label')) === '展开侧边栏',
        `collapsed=${collapsedClass} expand=${expandVisible} hidden=${dirHidden}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '69-memory-dir-collapsed.png')));
      await page.locator('#dir-expand').click();
      await page.locator('#memory-dir').waitFor({ state: 'visible', timeout: 8000 });
    } catch (error) {
      record('memory_dir_collapsed', false, String(error));
    }
    await page.locator('.memory-views [data-view="actions"]').click();
    await page.locator('#actions-panel').waitFor({ state: 'visible', timeout: 15000 });
    await waitForLocatorText(page, '#action-list', ready.action_title);
    const actionList = await visibleText(page.locator('#action-list'));
    record(
      'actions_list',
      actionList.includes(ready.action_title) && actionList.includes('未完成') && actionList.includes(ready.action_due),
      actionList || 'action list empty',
    );
    screenshots.push(path.basename(await shot(page, outDir, '29-memory-actions.png')));
    try {
      await page.goto(`${origin}/memory?page=profile`, { waitUntil: 'load' });
      await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
      await selectWorkspace(page, ready.workspace_name);
      await page.locator('#profile-panel').waitFor({ state: 'visible', timeout: 15000 });
      const profileView = await visibleText(page.locator('#profile-panel'));
      const profileDir = await visibleText(page.locator('#memory-list'));
      record(
        'memory_profile_layout',
        profileView.includes('我的资料')
          && profileView.includes('Professional Profile')
          && profileView.includes('Work Style')
          && profileView.includes('Communication & Writing Style')
          && profileView.includes('保存画像')
          && profileView.includes('尚未自动注入模型')
          && profileDir.includes(ready.memory_title)
          && profileDir.includes(`${ready.memory_topic} 1`)
          && profileDir.includes(ready.memory_body)
          && profileDir.includes(`#${ready.memory_topic}`)
          && await page.locator('#dream-profile').isDisabled()
          && !profileView.includes('Develops and maintains software')
          && !profileDir.includes('Teamily Wiki')
          && !/积分|套餐|升级/.test(profileView),
        profileView || 'memory profile empty',
      );
      screenshots.push(path.basename(await shot(page, outDir, '42-memory-profile.png')));
      await page.waitForFunction(() => !document.getElementById('save-memory-profile').disabled);
      await page.locator('#profile-professional').fill('[CI FIXTURE] Personal professional context');
      await page.locator('#profile-work_style').fill('[CI FIXTURE] Async work style');
      await page.locator('#profile-communication').fill('[CI FIXTURE] Concise communication');
      await page.locator('#save-memory-profile').click();
      await waitForLocatorText(page, '#memory-profile-status', '画像已保存');
      await page.reload({waitUntil: 'load'});
      await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
      // The profile is private per workspace; reopen the same fixture workspace after reload.
      await selectWorkspace(page, ready.workspace_name);
      await page.locator('#profile-panel').waitFor({state: 'visible'});
      await page.waitForFunction(
        () => !document.getElementById('save-memory-profile').disabled
          && document.getElementById('profile-professional').value === '[CI FIXTURE] Personal professional context',
        null, {timeout: 15000},
      ).catch(() => {});
      record('memory_profile_persists', (await page.locator('#profile-professional').inputValue()) === '[CI FIXTURE] Personal professional context'
        && (await page.locator('#profile-work_style').inputValue()) === '[CI FIXTURE] Async work style',
        'synthetic personal profile persisted after reload; no model injection');

    } catch (error) {
      record('memory_profile_layout', false, String(error));
    }
    try {
      await page.goto(`${origin}/memory?page=todos`, { waitUntil: 'load' });
      await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
      await selectWorkspace(page, ready.empty_workspace_name);
      await page.locator('#actions-panel').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('#action-empty').waitFor({ state: 'visible', timeout: 8000 });
      const todosEmpty = await visibleText(page.locator('#actions-panel'));
      record(
        'memory_todos_empty',
        todosEmpty.includes('下一步行动')
          && todosEmpty.includes('当前没有可预期的事项。')
          && todosEmpty.includes('新建行动')
          && await page.locator('#new-action-open').isVisible()
          && await page.locator('#new-action-form').isHidden()
          && !todosEmpty.includes('截止日期')
          && await page.locator('#dream-actions').isDisabled()
          && !todosEmpty.includes(ready.action_title)
          && !/积分|套餐|升级/.test(todosEmpty),
        todosEmpty || 'memory todos empty missing',
      );
      screenshots.push(path.basename(await shot(page, outDir, '43-memory-todos-empty.png')));
    } catch (error) {
      record('memory_todos_empty', false, String(error));
    }
    await page.goto(`${origin}/memory`, { waitUntil: 'load' });
    await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
    await selectWorkspace(page, ready.workspace_name);
    await waitForLocatorText(page, '#memory-list', ready.memory_title);
    // The later memory editor uses the left directory, which stays visible,
    // but action create/edit needs the next-actions panel shown again.
    await page.locator('.memory-views [data-view="actions"]').click();
    await page.locator('#actions-panel').waitFor({ state: 'visible', timeout: 15000 });
    await waitForLocatorText(page, '#action-list', ready.action_title);
    try {
      await page.locator('#account-menu-button').click();
      await page.locator('#account-menu').waitFor({ state: 'visible', timeout: 8000 });
      const memoryButton = await page.locator('#account-menu-button').evaluate(button =>
        button.textContent.trim() === '' && !!button.querySelector('svg'));
      const identity = (await visibleText(page.locator('#account-identity'))).trim();
      record(
        'memory_account_button',
        memoryButton && identity === ready.username && !identity.includes('已登录'),
        `button=${memoryButton}; identity=${identity}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '24-memory-account.png')));
      await page.keyboard.press('Escape');
    } catch (error) {
      record('memory_account_button', false, String(error));
    }

    try {
      const search = page.locator('#search');
      await search.fill('zz-no-such-memory');
      await waitForLocatorText(page, '#list-empty', '没有匹配的记忆页。试试其他关键词。');
      const emptyText = ((await page.locator('#list-empty').textContent()) || '').trim();
      const listPanelVisible = await page.locator('#list-panel').isVisible();
      const allCount = ((await page.locator('#filter-all-count').textContent()) || '').trim();
      record(
        'memory_search_filter',
        emptyText === '没有匹配的记忆页。试试其他关键词。'
          && listPanelVisible,
        `empty=${emptyText}; count=${allCount}; listPanel=${listPanelVisible}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '88-memory-search-filter.png')));
      await search.press('Escape');
      await waitForLocatorText(page, '#memory-list', ready.memory_title);
    } catch (error) {
      record('memory_search_filter', false, String(error));
    }

    try {
      await page.locator('#memory-list button', { hasText: ready.memory_title }).first().click();
      await waitForInputValue(page, '#editor-form input[name="title"]', ready.memory_title);
      await waitForStoredValue(page, '#editor-form textarea[name="body"]', ready.memory_body);
      record('memory_editor_seeded', true, await visibleText(page.locator('#editor-meta')));
      await page.locator('#close-editor').click();
      await page.locator('#list-panel').waitFor({ state: 'visible', timeout: 15000 });
    } catch (error) {
      record('memory_editor_seeded', false, String(error));
    }

    try {
      await page.locator('#new-page').click();
      await waitForInputValue(page, '#editor-form input[name="title"]', '未命名页面');
      await waitForLocatorText(page, '#status', '已创建记忆页');
      await page.locator('#editor-form input[name="title"]').fill(ready.memory_create_title);
      // WYSIWYG first: typing into the rich surface must land as markdown in the saved field.
      await page.locator('#editor-rich').fill(ready.memory_create_body);
      await waitForStoredValue(page, '#editor-form textarea[name="body"]', ready.memory_create_body);
      await page.locator('#save-page').click();
      await waitForLocatorText(page, '#status', '已保存');
      await waitForLocatorText(page, '#editor-meta', '修订 2');
      await page.locator('#editor-form input[name="title"]').fill(ready.memory_edited_title);
      // Then the Markdown source toggle edits the same stored body directly.
      if ((await page.locator('#editor-source-toggle').getAttribute('aria-pressed')) !== 'true') {
        await page.locator('#editor-source-toggle').click();
      }
      await page.locator('#editor-form textarea[name="body"]').fill(ready.memory_edited_body);
      await page.locator('#save-page').click();
      await waitForLocatorText(page, '#status', '已保存');
      await waitForLocatorText(page, '#editor-meta', '修订 3');
      await waitForInputValue(page, '#editor-form input[name="title"]', ready.memory_edited_title);
      await waitForStoredValue(page, '#editor-form textarea[name="body"]', ready.memory_edited_body);
      await page.locator('#editor-source-toggle').click();
      await waitForLocatorText(page, '#editor-rich', ready.memory_edited_body);
      const memoryMeta = await visibleText(page.locator('#editor-meta'));
      record(
        'memory_create_edit',
        memoryMeta.includes('修订 3') && memoryMeta.includes(ready.username),
        memoryMeta,
      );
      screenshots.push(path.basename(await shot(page, outDir, '19-memory-editor.png')));
    } catch (error) {
      record('memory_create_edit', false, String(error));
    }

    try {
      await page.locator('#delete-page').click();
      await page.locator('#page-delete-confirm').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('#page-delete-confirm-submit').click();
      await waitForLocatorText(page, '#status', '已删除');
      await page.locator('#list-panel').waitFor({ state: 'visible', timeout: 15000 });
      await waitForLocatorText(page, '#memory-list', ready.memory_title);
      const memoryAfterDelete = await visibleText(page.locator('#memory-list'));
      record(
        'memory_delete',
        memoryAfterDelete.includes(ready.memory_title)
          && !memoryAfterDelete.includes(ready.memory_edited_title)
          && !memoryAfterDelete.includes(ready.memory_create_title),
        memoryAfterDelete || 'memory list empty after delete',
      );
    } catch (error) {
      record('memory_delete', false, String(error));
    }

    try {
      await page.locator('#new-action-title').fill(ready.action_create_title);
      await page.locator('#new-action-notes').fill(ready.action_create_notes);
      await page.locator('#new-action-due').fill(ready.action_create_due);
      await page.locator('#new-action-page').selectOption({ label: ready.memory_title });
      await page.locator('#new-action').click();
      await waitForInputValue(page, '#action-editor-form input[name="title"]', ready.action_create_title);
      await waitForLocatorText(page, '#status', '已创建下一步行动');
      await page.locator('#action-editor-form input[name="title"]').fill(ready.action_edited_title);
      await page.locator('#action-editor-form textarea[name="notes"]').fill(ready.action_edited_notes);
      await page.locator('#save-action').click();
      await waitForLocatorText(page, '#status', '已保存');
      await waitForLocatorText(page, '#action-editor-meta', '修订 2');
      await waitForInputValue(page, '#action-editor-form input[name="title"]', ready.action_edited_title);
      await waitForInputValue(page, '#action-editor-form textarea[name="notes"]', ready.action_edited_notes);
      const actionMeta = await visibleText(page.locator('#action-editor-meta'));
      const actionDue = await page.locator('#action-editor-form input[name="due"]').inputValue();
      record(
        'action_create_edit',
        actionMeta.includes('修订 2') && actionMeta.includes(ready.username) && actionDue === ready.action_create_due,
        `${actionMeta} due=${actionDue}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '20-action-editor.png')));
    } catch (error) {
      record('action_create_edit', false, String(error));
    }

    try {
      await page.locator('#delete-action').click();
      await page.locator('#action-delete-confirm').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('#action-delete-confirm-submit').click();
      await waitForLocatorText(page, '#status', '已删除');
      await page.locator('#list-panel').waitFor({ state: 'visible', timeout: 15000 });
      await waitForLocatorText(page, '#action-list', ready.action_title);
      const memoryFinal = await visibleText(page.locator('#memory-list'));
      const actionAfterDelete = await visibleText(page.locator('#action-list'));
      record(
        'action_delete',
        memoryFinal.includes(ready.memory_title)
          && !memoryFinal.includes(ready.memory_edited_title)
          && actionAfterDelete.includes(ready.action_title)
          && actionAfterDelete.includes('未完成')
          && !actionAfterDelete.includes(ready.action_edited_title)
          && !actionAfterDelete.includes(ready.action_create_title),
        `memory=${memoryFinal || 'empty'} action=${actionAfterDelete || 'empty'}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '21-memory-after-delete.png')));
    } catch (error) {
      record('action_delete', false, String(error));
    }

    try {
      await page.goto(`${origin}/profile`, { waitUntil: 'load' });
      await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
      await waitForLocatorText(page, '#profile-username', ready.username);
      const profileName = (await visibleText(page.locator('#profile-username'))).trim();
      record('profile_username', profileName === ready.username, profileName || 'profile empty');
      screenshots.push(path.basename(await shot(page, outDir, '25-profile.png')));
    } catch (error) {
      record('profile_username', false, String(error));
    }

    try {
      await page.goto(`${origin}/download`, { waitUntil: 'load' });
      await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('#download-runtime').waitFor({ state: 'visible', timeout: 8000 });
      const downloadText = await visibleText(page.locator('#main-panel'));
      record(
        'download_page',
        downloadText.includes('flybot.pyz') && downloadText.includes('未实现') && downloadText.includes('iOS'),
        downloadText || 'download empty',
      );
      screenshots.push(path.basename(await shot(page, outDir, '26-download.png')));
    } catch (error) {
      record('download_page', false, String(error));
    }

    try {
      await page.goto(`${origin}/guide`, { waitUntil: 'load' });
      await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('#guide-list').waitFor({ state: 'visible', timeout: 8000 });
      await waitForLocatorText(page, '#guide-count', '当前显示');
      const guideText = await visibleText(page.locator('#main-panel'));
      record(
        'guide_page',
        guideText.includes('功能指引') && guideText.includes('打开聊天') && guideText.includes('通话窗口') && guideText.includes('0') && !guideText.includes('折叠会话列表'),
        guideText.slice(0, 240) || 'guide empty',
      );
      screenshots.push(path.basename(await shot(page, outDir, '70-guide.png')));
      await page.getByRole('button', { name: '打开聊天', exact: true }).click();
      await page.locator('#guide-dialog').waitFor({ state: 'visible', timeout: 8000 });
      await waitForLocatorText(page, '#guide-dialog-title', '打开聊天');
      await waitForLocatorText(page, '#guide-dialog-path', '应用栏 › 聊天');
      const dialogText = await visibleText(page.locator('#guide-dialog'));
      record(
        'guide_dialog',
        dialogText.includes('打开聊天') && dialogText.includes('操作路径') && dialogText.includes('应用栏 › 聊天'),
        dialogText.slice(0, 240) || 'guide dialog empty',
      );
      screenshots.push(path.basename(await shot(page, outDir, '71-guide-item-dialog.png')));
    } catch (error) {
      record('guide_page', false, String(error));
    }

    try {
      await page.goto(`${origin}/messenger`, { waitUntil: 'load' });
      await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
      const redirected = page.url().replace(/#.*$/, '');
      record(
        'messenger_redirects_to_chat',
        redirected.endsWith('/chat')
          && await page.locator('#compose-menu').count() > 0
          && await page.locator('#create-conversation').count() === 0
          && await page.locator('body.app-workspace > .app-rail a[href="/chat"]').count() > 0
          && await page.locator('body.app-workspace > .app-rail a[href="/messenger"]').count() === 0,
        `url=${redirected || '(empty)'}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '51-messenger.png')));
    } catch (error) {
      record('messenger_redirects_to_chat', false, String(error));
    }

    try {
      await page.goto(`${origin}/discover`, { waitUntil: 'load' });
      await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
      const discoverText = `${await visibleText(page.locator('#main-panel'))}`;
      const discoverWho = `${await visibleText(page.locator('#whoami'))}`;
      const discoverCurrent = await page.locator('body.app-workspace > .app-rail a[href="/discover"][aria-current="page"]').count();
      record(
        'discover_page',
        discoverWho === ready.username
          && discoverText.includes('发现')
          && discoverCurrent > 0
          && discoverText.includes('关注')
          && discoverText.includes('动态')
          && discoverText.includes('搜索动态、创作者')
          && discoverText.includes('[CI FIXTURE] Document')
          && discoverText.includes('文档')
          && discoverText.includes('支持点赞、收录和关注作者')
          && !discoverText.includes('动态信息流还没有接口')
          && discoverText.includes('热门')
          && discoverText.includes('/discover?tab=agents')
          && await page.locator('#feed-panel').isVisible()
          && await page.locator('#catalog-view').isHidden()
          && !/积分|套餐|升级/.test(discoverText),
        `whoami=${discoverWho || '(empty)'}; current=${discoverCurrent}; ${discoverText || 'discover empty'}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '52-discover.png')));
      await page.locator('#feed-kind-website').click();
      await waitForLocatorText(page, '#feed-count', '已显示 1 件公开作品');
      record('discover_work_type_filter',
        await page.locator('#feed-grid a[href="/w/ci-fixture-site"]').count() === 1
          && await page.locator('#feed-grid a[href="/w/ci-fixture-doc"]').count() === 0
          && await page.locator('#feed-kind-website').getAttribute('aria-current') === 'true',
        'website type filter uses the opted-in website fixture');
      await page.locator('#feed-kind-all').click();
      await waitForLocatorText(page, '#feed-count', '已显示 2 件公开作品');
      await page.locator('#feed-tab-following').click();
      await waitForLocatorText(page, '#feed-following-empty', '关注列表暂无动态');
      const followingText = `${await visibleText(page.locator('#feed-panel'))}`;
      record(
        'discover_following',
        (await page.locator('#feed-tab-following').getAttribute('aria-selected')) === 'true'
          && (await page.locator('#feed-following-empty').isVisible())
          && followingText.includes('关注列表暂无动态')
          && followingText.includes('你关注的人发布动态后会显示在这里。')
          && followingText.includes('你关注的作者已公开')
          && !followingText.includes('没有对照截图')
          && !/积分|套餐|升级|CREDITS/.test(followingText),
        followingText.slice(0, 240) || 'following empty',
      );
      screenshots.push(path.basename(await shot(page, outDir, '63-discover-following.png')));
      await page.locator('#feed-tab-activity').click();
      await waitForLocatorText(page, '#feed-count', '已显示 2 件公开作品');
      await page.locator('#feed-grid article button').filter({hasText: /^点赞/}).first().click();
      await page.locator('#feed-grid article button[aria-pressed="true"]').first().waitFor({state: 'visible'});
      record('discover_like_persists', await page.locator('#feed-grid article button').filter({hasText: /取消点赞/}).count() === 1,
        'a synthetic fixture work was liked through the real CSRF-protected endpoint');
      await page.locator('#feed-grid article button').filter({hasText: /^收录/}).first().click();
      await page.locator('#feed-tab-collected').click();
      await waitForLocatorText(page, '#feed-count', '已显示 1 件公开作品');
      record('discover_collection_feed', await page.locator('#feed-grid article').count() === 1,
        'private collection feed contains the saved synthetic work');
      await page.goto(`${origin}/discover?tab=agents`, { waitUntil: 'load' });
      await page.locator('#catalog-view').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('#discover-list article').first().waitFor({state: 'visible'});
      record('discover_cards', await page.locator('#discover-list article').count() === 12
        && await page.locator('#catalog-more').isVisible()
        && await page.locator('#discover-list article button:disabled').count() === 12,
        await visibleText(page.locator('#catalog-count')));
      const geometry = await page.locator('#discover-list article').evaluateAll(cards => {
        const boxes = cards.map(card => card.getBoundingClientRect());
        return boxes.every((a, index) => boxes.slice(index + 1).every(b =>
          a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top));
      });
      const catalogWidth = await page.locator('#main-panel').evaluate(node => node.getBoundingClientRect().width);
      record('discover_layout', geometry && catalogWidth > 900,
        `nonoverlap=${geometry}; panelWidth=${catalogWidth}`);
      const catalogChrome = `${await visibleText(page.locator('#catalog-view'))}`;
      const creatorText = `${await visibleText(page.locator('#catalog-creator'))}`;
      const currentChip = `${(await page.locator('#catalog-filters [aria-current="true"]').textContent()) || ''}`;
      record(
        'discover_catalog_filters',
        currentChip.includes('全部')
          && catalogChrome.includes('Content Creation')
          && catalogChrome.includes('Marketing')
          && catalogChrome.includes('创建者')
          && await page.locator('#catalog-filters button:disabled').count() >= 15
          && await page.locator('#catalog-filter-search').isDisabled()
          && await page.locator('#catalog-filter-more').isDisabled()
          && await page.locator('#catalog-creator').isDisabled()
          && creatorText.includes('创建者')
          && !/Teamily AI|teamily\.ai|积分|CREDITS/i.test(creatorText)
          && !/60 个智能体/.test(catalogChrome),
        `${creatorText} | ${catalogChrome.slice(0, 280) || 'catalog filters empty'}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '56-discover-catalog.png')));
      screenshots.push(path.basename(await shot(page, outDir, '72-discover-catalog-filters.png')));
      await page.locator('#catalog-more').click();
      await waitForLocatorText(page, '#catalog-count', '13 个智能体');
      record('discover_pagination', await page.locator('#discover-list article').count() === 13
        && await page.locator('#catalog-more').isHidden(), '13 real fixture entries after cursor page');
      await page.locator('#catalog-query').fill(ready.agent_name);
      await page.locator('#catalog-search button[type="submit"]').click();
      await waitForLocatorText(page, '#catalog-count', '1 个智能体');
      record('discover_search', await page.locator('#discover-list article').count() === 1
        && (await visibleText(page.locator('#discover-list'))).includes(ready.agent_name),
        await visibleText(page.locator('#catalog-count')));
      screenshots.push(path.basename(await shot(page, outDir, '57-discover-search.png')));
      await page.locator('#catalog-query').fill('ci-no-match-702194');
      await page.locator('#catalog-search button[type="submit"]').click();
      await page.locator('#discover-empty').waitFor({state: 'visible'});
      record('discover_search_empty', (await visibleText(page.locator('#discover-empty'))).includes('没有匹配'),
        await visibleText(page.locator('#discover-empty')));
      screenshots.push(path.basename(await shot(page, outDir, '58-discover-search-empty.png')));
      await page.locator('#catalog-clear').click();
      await waitForLocatorText(page, '#catalog-count', '12 个智能体');
      record('discover_search_clear', await page.locator('#catalog-query').inputValue() === ''
        && await page.locator('#catalog-more').isVisible(), 'clear resets the first page');
      await page.goto(`${origin}/discover?tab=agents&section=groups`, { waitUntil: 'load' });
      await page.locator('#catalog-view').waitFor({ state: 'visible', timeout: 15000 });
      await waitForLocatorText(page, '#teams-note', '公开 AI 团队目录还没有接口');
      const teamsChrome = `${await visibleText(page.locator('#catalog-view'))}`;
      const teamsCreator = `${await visibleText(page.locator('#catalog-creator'))}`;
      const teamsChip = `${(await page.locator('#teams-filters [aria-current="true"]').textContent()) || ''}`;
      record(
        'discover_teams_chrome',
        (await page.locator('#catalog-tab-teams').getAttribute('aria-current')) === 'page'
          && (await page.locator('#catalog-tab-agents').getAttribute('aria-current')) !== 'page'
          && await page.locator('#teams-filters').isVisible()
          && await page.locator('#catalog-filters').isHidden()
          && teamsChip.includes('All')
          && teamsChrome.includes('Marketing')
          && teamsChrome.includes('Sales')
          && teamsChrome.includes('Operations')
          && teamsChrome.includes('Research')
          && teamsChrome.includes('+ 创建我的 AI 团队')
          && (await page.locator('#catalog-query').getAttribute('placeholder') || '').includes('搜索 AI 团队')
          && await page.locator('#catalog-create-team').isDisabled()
          && await page.locator('#teams-note').isVisible()
          && teamsChrome.includes('公开 AI 团队目录还没有接口')
          && await page.locator('#discover-list article').count() === 0
          && await page.locator('#catalog-manage').isHidden()
          && teamsCreator.includes('创建者')
          && !/Teamily AI|Full-Stack Delivery Guild|积分|CREDITS/i.test(teamsChrome + teamsCreator),
        `${teamsCreator} | ${teamsChrome.slice(0, 280) || 'teams chrome empty'}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '74-discover-teams.png')));

    } catch (error) {
      record('discover_page', false, String(error));
    }

    try {
      if (!ready.homepage_file) {
        throw new Error('ready.json is missing homepage_file');
      }
      const homepagePath = fs.readFileSync(ready.homepage_file, 'utf8').trim();
      if (!/^\/a\/[A-Za-z0-9_-]{43}$/.test(homepagePath)) {
        throw new Error('homepage-path sidecar is not a public share path');
      }
      await page.goto(`${origin}${homepagePath}`, {waitUntil: 'load'});
      const homeText = await visibleText(page.locator('body'));
      // textContent keeps source casing; innerText follows text-transform once
      // the homepage CSP is the only policy and the inline stylesheet applies.
      const statusLabel = ((await page.locator('p.status').textContent()) || '').trim();
      const talkHeading = ((await page.locator('.section h2').first().textContent()) || '').trim();
      const sendDisabled = await page.locator('.composer button').isDisabled();
      const createHref = await page.locator('.create-agent').getAttribute('href');
      const composerDisabled = await page.locator('#public-composer').isDisabled();
      const quickStartsHeading = ((await page.locator('.quick-starts h3').textContent()) || '').trim();
      const token = homepagePath.slice(3);
      record(
        'agent_public_homepage',
        homeText.includes('FlyBot')
          && homeText.includes('Agent profile')
          && statusLabel === 'Public page'
          && homeText.includes(ready.agent_name)
          && homeText.includes('Synthetic CI directory entry.')
          && talkHeading === 'Talk via'
          && homeText.includes('Start a conversation')
          && homeText.includes('Web conversation')
          && homeText.includes('Ask how this fixture agent is organized')
          && homeText.includes('Request a walkthrough of the directory')
          && homeText.includes('List what this fixture assistant covers')
          && quickStartsHeading === 'Quick starts'
          && homeText.includes('Built with FlyBot')
          && homeText.includes('Create your own Agent')
          && homeText.includes('未接通')
          && sendDisabled
          && createHref === '/agents'
          && composerDisabled
          && !homeText.includes("Help me organize today's priorities")
          && !homeText.includes('Create something with my team')
          && !homeText.includes('Connect a messaging channel')
          && !/Teamily|AVAILABLE NOW|\bLIVE\b/.test(homeText)
          && !homeText.includes(ready.workspace_id)
          && !homeText.includes(ready.agent_id)
          && !homeText.includes(token),
        (homeText || 'homepage empty').slice(0, 280),
      );
      screenshots.push(path.basename(await shot(page, outDir, '77-agent-public-homepage.png')));
    } catch (error) {
      record('agent_public_homepage', false, String(error).replace(/\/a\/[A-Za-z0-9_-]{20,}/g, '/a/<redacted>'));
    }

    // PR151 integration: real UI save/reopen, with current personal-agent startup retained.
    try {
      await page.goto(`${origin}/onboarding`, {waitUntil: 'load'});
      await page.locator('#industry option[value="科技与软件"]').waitFor({state: 'attached'});
      await page.locator('#industry').selectOption('科技与软件');
      await page.locator('#role-choices input[value="产品经理"]').check();
      await page.locator('#onboarding-save').click();
      // Step 1 now continues to step 2 like the recorded wizard; the saved context must already
      // clear the chat banner even if the user leaves the wizard here (进入 FlyBot sits on step 4).
      await page.locator('#onboarding-steps').waitFor({state: 'visible'});
      await page.locator('[data-step="2"]').waitFor({state: 'visible'});
      await page.goto(`${origin}/chat`, {waitUntil: 'load'});
      await page.locator('#main-panel').waitFor({state: 'visible'});
      await page.waitForFunction(() => document.getElementById('onboarding-banner').hidden);
      const personalResponse = await page.request.get(`${origin}/v1/personal-agent`);
      const personalState = await personalResponse.json();
      await page.goto(`${origin}/onboarding`, {waitUntil: 'load'});
      await waitForLocatorText(page, '#onboarding-meta', '科技与软件');
      record('onboarding_save_reopen', await page.locator('#industry').inputValue() === '科技与软件'
        && await page.locator('#role-choices input[value="产品经理"]').isChecked()
        && Boolean(personalState.personal_agent && personalState.personal_agent.agent),
        'Saved work context survives reload alongside the personal agent; no recommendations or connector claims');
      screenshots.push(path.basename(await shot(page, outDir, '86-onboarding-saved-context.png')));
      try {
        await page.locator('#onboarding-save').click();
        await page.locator('#onboarding-steps').waitFor({state: 'visible'});
        const appsText = await visibleText(page.locator('#onboarding-apps'));
        const connectDisabled = await page.locator('#onboarding-apps .app-connect').evaluateAll(
          (buttons) => buttons.length > 0 && buttons.every((button) => button.disabled));
        await page.locator('[data-step="2"] button[data-go="3"]:not(.onboarding-later)').click();
        await page.locator('#onboarding-picks input[value="release-notes"]').check();
        await page.locator('#onboarding-picks-form button[type="submit"]').click();
        await waitForLocatorText(page, '#onboarding-steps-meta', '已选 1 项');
        await page.locator('#onboarding-look select[name="color"]').selectOption('天空蓝');
        await page.locator('#onboarding-look-form button[type="submit"]').click();
        await waitForLocatorText(page, '#onboarding-look-preview', '颜色：天空蓝');
        // Step 2 reads the user's real Composio connections now. This fixture has no
        // personal Composio key, so GET /v1/composio/connections answers 409 and the
        // list cannot be read: every row must say 未接入 (8 of them), and no row may
        // claim 已连接 -- 未连接 would assert the app is known to be disconnected,
        // which nobody asked. The connected wording (state=connected -> 已连接) is
        // pinned in tests/onboarding_step2.test.mjs instead of here: this harness has
        // no Composio key, and seeding a fake connection would make the screenshot a
        // false claim about the real Composio state.
        const appStates = await page.locator('#onboarding-apps .app-state').allTextContents();
        const rowsUnreadable = appStates.length === 8 && appStates.every((text) => text.trim() === '· 未接入');
        record('onboarding_connectors_honest',
          rowsUnreadable && !appsText.includes('已连接'),
          `No Composio key: ${appStates.length}/8 rows say 未接入, none claims 已连接 | ${(appsText || 'apps empty').slice(0, 240)}`);
        record('onboarding_steps_2_4',
          connectDisabled
          && (await visibleText(page.locator('#onboarding-steps-meta'))).includes('形象已保存'),
          `Steps 2-4 wizard: connect buttons disabled, picks and look saved | ${(appsText || 'apps empty').slice(0, 240)}`);
        screenshots.push(path.basename(await shot(page, outDir, '87-onboarding-steps.png')));
        await page.locator('#onboarding-enter').click();
        await page.waitForURL(url => url.pathname === '/chat');
        record('onboarding_enter_chat', true, 'Step 4 进入 FlyBot opens chat');
      } catch (error) {
        record('onboarding_steps_2_4', false, String(error));
      }
      await page.goto(`${origin}/onboarding`, {waitUntil: 'load'});
      await page.locator('#industry option[value="其他"]').waitFor({state: 'attached'});
      await page.locator('#industry').selectOption('其他');
      await page.locator('#custom-industry').fill('[CI FIXTURE] Independent research');
      await page.locator('#custom-role').fill('[CI FIXTURE] Analyst');
      await page.locator('#onboarding-save').click();
      await page.locator('#onboarding-steps').waitFor({state: 'visible'});
      await page.goto(`${origin}/onboarding`, {waitUntil: 'load'});
      await waitForLocatorText(page, '#onboarding-meta', '[CI FIXTURE] Independent research');
      record('onboarding_custom_reopen',
        await page.locator('#custom-industry').inputValue() === '[CI FIXTURE] Independent research'
        && await page.locator('#custom-role').inputValue() === '[CI FIXTURE] Analyst',
        'Custom industry and role are both restored, not lost on the Other form');
    } catch (error) {
      record('onboarding_save_reopen', false, String(error));
    }

    // Real management/runtime lifecycle, using only the labelled synthetic provider fixture.
    try {
      await page.goto(`${origin}/skills`, {waitUntil:'load'});
      const install=page.locator('button[data-skill="meeting-notes"]');
      await install.waitFor({state:'visible'});
      await install.click();
      const skillConfirmation=page.locator('#skills-review-confirm');
      record('skills_permission_required',await skillConfirmation.isDisabled(),'No binding can be created before permission for the reviewed skill');
      await page.locator('#skills-permission').check();
      await skillConfirmation.click();
      await waitForLocatorText(page,'#skills-error','已安装到所选范围');
      await page.reload({waitUntil:'load'});
      await page.waitForFunction(()=>document.querySelector('button[data-skill="meeting-notes"]')?.textContent==='卸载');
      record('skills_binding_reload',true,'Actual SQLite-backed account binding survives page reload');
      screenshots.push(path.basename(await shot(page,outDir,'96-skills-installed.png')));
      const task=await page.evaluate(async()=>{
        const csrf=document.cookie.split(/;\s*/).find(v=>v.startsWith('ot_dev_csrf=')).split('=')[1];
        const response=await fetch('/v1/runtime/tasks',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({kind:'infer',prompt:'[SYNTHETIC CI] Summarize: We decided to test the skill lifecycle.'})});
        const data=await response.json();if(!response.ok)throw Error(JSON.stringify(data));return data.task.id;
      });
      await waitForApi(page,'/v1/runtime/tasks/'+task,d=>d.task?.status==='succeeded');
      await waitForApi(page,'/v1/skills/bindings',d=>d.items?.some(i=>i.skill_id==='meeting-notes'&&i.last_loaded_task===task));
      await page.reload({waitUntil:'load'});
      await waitForLocatorText(page,'#skills-list','历史任务已有加载回执');
      record('skills_daemon_loaded',await page.evaluate(async id=>{const d=await(await fetch('/v1/skills/bindings')).json();return d.items.some(i=>i.skill_id==='meeting-notes'&&i.last_loaded_task===id)},task),'Upgraded daemon verified exact package digests and acknowledged context loading before successful synthetic inference; Python tests inspect model request content');
      await page.locator('.skill-card').filter({has:page.locator('button[data-skill="meeting-notes"]')}).locator('.skill-use').click();
      await page.waitForFunction(()=>!document.getElementById('skill-run-submit').disabled);
      // Computed enabled primary states, not token-only or mixed-theme inference.
      const skillContrasts=[];
      for(const theme of ['light','dark']) {
        await page.evaluate(value=>{document.documentElement.dataset.themeResolved=value},theme);
        for(const state of ['normal','hover']) {
          if(state==='hover')await page.locator('#skill-run-submit').hover();else await page.mouse.move(0,0);
          const measured=await page.locator('#skill-run-submit').evaluate(e=>{
            for(const animation of e.getAnimations())animation.finish();
            const s=getComputedStyle(e),lum=color=>{const c=color.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4});return .2126*c[0]+.7152*c[1]+.0722*c[2]};
            const a=lum(s.color),b=lum(s.backgroundColor);
            return {ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),color:s.color,background:s.backgroundColor,image:s.backgroundImage,opacity:s.opacity};
          });
          skillContrasts.push({theme,state,...measured});
        }
        if(theme==='dark')screenshots.push(path.basename(await shot(page,outDir,'107-skills-run-dark-hover.png')));
      }
      record('skills_run_primary_contrast',skillContrasts.every(s=>s.ratio>=4.5&&s.image==='none'&&s.opacity==='1'),'Actual enabled normal/hover, light/dark primary contrast: '+JSON.stringify(skillContrasts));
      await page.evaluate(()=>{document.documentElement.dataset.themeResolved='light'});
      await page.mouse.move(0,0);
      await page.locator('#skill-run-prompt').fill('[SYNTHETIC CI] Use only the selected meeting skill on: We decided to test the full run and document path.');
      await page.locator('#skill-run-submit').click();
      await waitForApi(page,'/v1/skills/runs',d=>d.items?.some(r=>r.verified&&r.task.prompt.includes('full run and document path')));
      await page.locator('#skills-refresh').click();
      await waitForLocatorText(page,'#skill-run-history',ready.provider_text);
      record('skills_explicit_run_verified',true,'Real selected-skill task completed in the daemon with exact material receipt; synthetic provider only, no tools or vendor acceptance');
      await page.locator('.skills-execution').scrollIntoViewIfNeeded();
      screenshots.push(path.basename(await shot(page,outDir,'104-skills-explicit-run.png')));
      await page.reload({waitUntil:'load'});
      await waitForLocatorText(page,'#skill-run-history',ready.provider_text);
      record('skills_run_history_reload',true,'Actual selected-skill result and load proof survive reload');
      await page.locator('#skill-result-workspace').selectOption(ready.workspace_id);
      await page.getByRole('button',{name:'保存结果为工作区文档',exact:true}).first().click();
      const savedSkill=page.locator('#skill-run-history a').first();await savedSkill.waitFor({state:'visible'});
      record('skills_result_document',await savedSkill.getAttribute('href')!=='','Explicit result save returned a real authorized document, not a simulated download');
      screenshots.push(path.basename(await shot(page,outDir,'105-skills-result-document.png')));
      const savedHref=await savedSkill.getAttribute('href');
      await page.goto(origin+savedHref,{waitUntil:'load'});
      await page.locator('#editor-form').waitFor({state:'visible'});
      await waitForStoredValue(page,'#editor-form textarea[name="body"]',ready.provider_text);
      record('skills_saved_document_real_editor',true,'Saved-result deep link selected the authorized workspace and loaded the actual persisted text in the rich editor');
      screenshots.push(path.basename(await shot(page,outDir,'106-skills-result-editor.png')));
      await page.goto(origin+'/skills',{waitUntil:'load'});
      await page.waitForFunction(()=>document.querySelector('button[data-skill="meeting-notes"]')?.textContent==='卸载');

      await page.locator('.skill-card').filter({has:page.locator('button[data-skill="meeting-notes"]')}).scrollIntoViewIfNeeded();
      await page.locator('.skill-card').filter({has:page.locator('button[data-skill="meeting-notes"]')}).locator('summary').click();
      screenshots.push(path.basename(await shot(page,outDir,'97-skills-loaded-content.png')));
      await page.setViewportSize({width:390,height:844});
      record('skills_narrow_no_overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Digest/content wrap at 390px; no hidden controls');
      screenshots.push(path.basename(await shot(page,outDir,'98-skills-narrow.png')));
      await page.setViewportSize({width:1280,height:900});
      await page.locator('button[data-skill="meeting-notes"]').click();
      await waitForLocatorText(page,'#skills-error','已撤销绑定');
      await page.reload({waitUntil:'load'});
      await page.waitForFunction(()=>document.querySelector('button[data-skill="meeting-notes"]')?.textContent==='安装');
      record('skills_uninstall_reload',await page.evaluate(async()=>!(await(await fetch('/v1/skills/bindings')).json()).items.some(i=>i.skill_id==='meeting-notes')),'Actual binding removed; Python/container tests assert subsequent model prompts omit the removed skill');
      screenshots.push(path.basename(await shot(page,outDir,'99-skills-uninstalled.png')));
    } catch(error) { record('skills_runtime_lifecycle',false,String(error)+'; '+await page.locator('#skills-error').textContent().catch(()=>'(not on skill page)')+'; '+(await page.locator('#skills-list').textContent().catch(()=>''))); }

    try {
      await page.goto(origin+'/skills',{waitUntil:'load'});
      await page.locator('details:has(#skill-import-form) > summary').click();
      await page.locator('#skill-import-template').click();
      await page.locator('#skill-import-consent').check();
      await page.locator('#skill-import-submit').click();
      await waitForLocatorText(page,'#skill-import-status','未自动安装');
      await page.reload({waitUntil:'load'});
      const imported=page.locator('.skill-card').filter({has:page.locator('button[data-skill="import-evidence-check"]')});
      await imported.waitFor({state:'visible'});
      await imported.locator('.skill-install').click();
      await page.locator('#skills-permission').check();
      await page.locator('#skills-review-confirm').click();
      await waitForLocatorText(page,'#skills-error','已安装到所选范围');
      await imported.locator('.skill-use').click();
      await page.waitForFunction(()=>!document.getElementById('skill-run-submit').disabled);
      await page.locator('#skill-run-prompt').fill('[SYNTHETIC CI IMPORT] Verify the evidence: the supplied fixture completed.');
      await page.locator('#skill-run-submit').click();
      await waitForApi(page,'/v1/skills/runs',d=>d.items?.some(r=>r.skill_id==='import-evidence-check'&&r.verified));
      await page.locator('#skills-refresh').click();
      await waitForLocatorText(page,'#skill-run-history',ready.provider_text);
      record('imported_skill_actual_runtime_v2',true,'Original user-imported JSON persisted through reload, separately installed, loaded/acknowledged by the actual daemon and used by the controlled model. Python asserts exact imported model context. No executable or publisher-signature claim.');
      screenshots.push(path.basename(await shot(page,outDir,'112-imported-skill-real-run.png')));
      await imported.getByRole('button',{name:'管理版本',exact:true}).click();
      await waitForLocatorText(page,'#skill-import-status','编辑已有包');
      const newer=JSON.parse(await page.locator('#skill-import-json').inputValue());newer.version='1.1.0';newer.content+=' Version two evidence requires explicit renewed consent.';delete newer.digest;
      await page.locator('#skill-import-json').fill(JSON.stringify(newer,null,2));
      await page.locator('#skill-import-consent').check();await page.locator('#skill-import-submit').click();
      await waitForLocatorText(page,'#skill-import-status','未自动安装');
      await waitForLocatorText(page,'#skills-list','版本已更新');
      await imported.getByRole('button',{name:'重新安装当前版本',exact:true}).click();
      await page.locator('#skills-permission').check();
      await page.locator('#skills-review-confirm').click();
      await waitForLocatorText(page,'#skills-error','已安装到所选范围');
      screenshots.push(path.basename(await shot(page,outDir,'113-imported-skill-version-upgrade.png')));
      page.once('dialog',dialog=>dialog.accept());await imported.getByRole('button',{name:'撤销私有包',exact:true}).click();
      await waitForLocatorText(page,'#skill-import-status','包已撤销');await page.reload({waitUntil:'load'});
      record('imported_skill_revoke_reload',await page.locator('button[data-skill="import-evidence-check"]').count()===0,'Revocation removed the package from available catalogue and all persisted bindings. Historical owned export remains available; later task model context omission is asserted in Python.');
    }catch(error){record('imported_skill_lifecycle',false,String(error));}

    try {
      // A real server revision invalidation must preserve the editor draft.
      const created=await page.evaluate(async wid=>{
        const csrf=document.cookie.split(/;\s*/).find(v=>v.startsWith('ot_dev_csrf=')).split('=')[1];
        const response=await fetch(`/v1/workspaces/${wid}/artifacts`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,'Idempotency-Key':'functional-export-live001'},body:JSON.stringify({title:'Functional export evidence',body:'Original Chinese evidence 中文 123.'})});
        const data=await response.json();if(!response.ok)throw Error('Synthetic artifact creation failed');return data.artifact;
      },ready.workspace_id);
      await page.goto(origin+'/space?workspace='+ready.workspace_id+'&artifact='+created.id,{waitUntil:'load'});
      await page.locator('#editor-form').waitFor({state:'visible'});
      await waitForLocatorText(page,'#workspace-events-status','已连接');
      await page.evaluate(async({wid,id})=>{
        const csrf=document.cookie.split(/;\s*/).find(v=>v.startsWith('ot_dev_csrf=')).split('=')[1];
        const response=await fetch(`/v1/workspaces/${wid}/artifacts/${id}`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({revision:1,changes:{body:'SERVER VERSION TWO 中文 456.'}})});
        if(!response.ok)throw Error('Synthetic second revision failed');
      },{wid:ready.workspace_id,id:created.id});
      await page.locator('#artifact-live-update').waitFor({state:'visible'});
      record('document_sse_preserves_local_draft',await page.locator('#editor-form textarea[name="body"]').inputValue()==='Original Chinese evidence 中文 123.','Real authenticated SSE notified an actual SQLite revision change without replacing the local editor; no CRDT/collaboration claim.');
      screenshots.push(path.basename(await shot(page,outDir,'114-document-live-revision-preserved.png')));
      page.once('dialog',dialog=>dialog.accept());await page.locator('#artifact-live-load').click();
      await waitForStoredValue(page,'#editor-form textarea[name="body"]','SERVER VERSION TWO 中文 456.');
      for(const format of ['docx','pdf']){
        await page.locator('#export-format').selectOption(format);
        const downloadPromise=page.waitForEvent('download');await page.locator('#export-artifact').click();const download=await downloadPromise;
        const file=path.join(outDir,'export-evidence.'+format);await download.saveAs(file);
        const bytes=fs.readFileSync(file);record('real_'+format+'_download',format==='docx'?bytes.subarray(0,2).toString()==='PK':bytes.subarray(0,5).toString()==='%PDF-','Actual browser attachment download, not renamed plain text. Python inspects XML, immutable revisions, Unicode PDF extraction and negative permissions.');
      }
      screenshots.push(path.basename(await shot(page,outDir,'115-real-typed-export-controls.png')));
    }catch(error){record('document_live_export_path',false,String(error));}

    try {
      const created=await page.evaluate(async wid=>{
        const csrf=document.cookie.split(/;\s*/).find(v=>v.startsWith('ot_dev_csrf=')).split('=')[1];
        const response=await fetch(`/v1/workspaces/${wid}/artifacts`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,'Idempotency-Key':'functional-pptx-export001'},body:JSON.stringify({title:'PPTX evidence 中文',kind:'slides',slides:{schema:'flybot-workspace.slides.v1',slides:[{title:'目标',bullets:['统一入口','中文 123']},{title:'下一步',bullets:['接入运行时']}]}})});
        const data=await response.json();if(!response.ok)throw Error('Synthetic slides artifact creation failed: '+JSON.stringify(data));return data.artifact;
      },ready.workspace_id);
      await page.goto(origin+'/space?workspace='+ready.workspace_id+'&artifact='+created.id,{waitUntil:'load'});
      await page.locator('#export-format').selectOption('pptx');
      const downloadPromise=page.waitForEvent('download');await page.locator('#export-artifact').click();const download=await downloadPromise;
      const file=path.join(outDir,'export-evidence.pptx');await download.saveAs(file);
      const bytes=fs.readFileSync(file);
      record('real_pptx_download',bytes.subarray(0,2).toString()==='PK','Actual browser PPTX attachment for a slides artifact; Python asserts title/bullet XML, history, and the absence of macros or external relationships.');
      screenshots.push(path.basename(await shot(page,outDir,'116-real-pptx-export-controls.png')));
    }catch(error){record('slides_pptx_export_path',false,String(error));}

    try {
      await page.goto(`${origin}/chat#workspace=${ready.workspace_id}&social=${ready.social_group_id}`,{waitUntil:'load'});
      await waitForLocatorText(page,'#chat-title',ready.social_group_title);
      await waitForLocatorText(page,'#message-list',ready.social_message_text);
      const countBefore=await page.evaluate(async({wid,cid})=>(await(await fetch(`/v1/workspaces/${wid}/social/conversations/${cid}`)).json()).items.length,{wid:ready.workspace_id,cid:ready.social_group_id});
      const source=page.locator('#message-list > li').filter({hasText:ready.social_message_text}).first();
      await source.locator('.message-more').click({force:true});
      await page.locator('[data-menu="translate"]').click();
      await page.locator('#message-assist-instruction').fill('English');
      await page.locator('#message-assist-submit').click();
      await waitForLocatorText(page,'#message-assist-history',ready.provider_text,20000);
      record('message_translation_actual_runtime',true,'Private persisted task returned through the configured synthetic provider; no hardcoded translation');
      screenshots.push(path.basename(await shot(page,outDir,'100-chat-translation-result.png')));
      await page.locator('#message-assist-close').click();
      await source.locator('.message-more').click({force:true});
      await page.locator('[data-menu="ask"]').click();
      await page.locator('#message-assist-instruction').fill('Summarize the key point without taking action.');
      await page.locator('#message-assist-submit').click();
      await waitForApi(page,`/v1/workspaces/${ready.workspace_id}/social/conversations/${ready.social_group_id}/assists`,d=>d.items?.some(i=>i.operation==='ask'&&i.status==='succeeded'));
      await waitForLocatorText(page,'#message-assist-history','问 AI');
      record('message_ask_ai_actual_runtime',true,'Separate persisted ask task completed through real runtime path with synthetic provider');
      await page.locator('#message-assist-close').click();
      const countAfter=await page.evaluate(async({wid,cid})=>(await(await fetch(`/v1/workspaces/${wid}/social/conversations/${cid}`)).json()).items.length,{wid:ready.workspace_id,cid:ready.social_group_id});
      record('message_assistance_never_posts',countBefore===countAfter,'Model assistance does not create or send a group message');
      await page.locator('#group-info-toggle').click();
      await page.locator('#group-announcement-open').click();
      await page.waitForFunction(()=>!document.getElementById('announcement-save').disabled);
      await page.locator('#announcement-body').fill('[SYNTHETIC CI] Review before sending external messages.');
      await page.locator('#announcement-save').click();
      await waitForLocatorText(page,'#group-announcement-preview','[SYNTHETIC CI]');
      await page.reload({waitUntil:'load'});
      await waitForLocatorText(page,'#chat-title',ready.social_group_title);
      await page.locator('#group-info-toggle').click();
      await page.locator('#group-announcement-open').click();
      await page.waitForFunction(()=>document.getElementById('announcement-body').value.includes('[SYNTHETIC CI]'));
      record('group_announcement_reload',true,'Real revisioned group announcement survives reload and editor reopening');
      screenshots.push(path.basename(await shot(page,outDir,'101-group-announcement-editor.png')));
      await page.evaluate(()=>{document.documentElement.dataset.themeResolved='dark'});
      const contrast=await page.locator('#announcement-save').evaluate(async e=>{
        getComputedStyle(e).color;await Promise.all(e.getAnimations().map(a=>a.finished.catch(()=>{})));
        const s=getComputedStyle(e),lum=color=>color.match(/[0-9.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4}).reduce((a,n,i)=>a+n*[.2126,.7152,.0722][i],0),a=lum(s.color),b=lum(s.backgroundColor);
        return s.backgroundImage==='none'?(Math.max(a,b)+.05)/(Math.min(a,b)+.05):0;
      });
      record('new_modal_dark_primary_contrast',contrast>=4.5,'Actual settled dark submit contrast '+contrast.toFixed(2)+':1; opaque background, no mixed-theme inference');
      const dialogContrasts=await page.evaluate(()=>{
        const lum=color=>color.match(/[0-9.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4}).reduce((a,n,i)=>a+n*[.2126,.7152,.0722][i],0);
        return ['message-assist-dialog','announcement-dialog','resource-picker','composer-emoji-dialog'].map(id=>{
          const dialog=document.getElementById(id),s=getComputedStyle(dialog),bg=lum(s.backgroundColor);
          const ratios=[dialog,...dialog.querySelectorAll('h2,label,p')].map(e=>{const fg=lum(getComputedStyle(e).color);return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)});
          return {id,background:s.backgroundColor,minimum:Math.min(...ratios)};
        });
      });
      record('new_modal_dark_text_contrast',dialogContrasts.every(x=>x.minimum>=4.5),'Actual heading/label/helper text against all four dark dialog surfaces: '+JSON.stringify(dialogContrasts));
      screenshots.push(path.basename(await shot(page,outDir,'101b-group-announcement-dark.png')));
      await page.evaluate(()=>{document.documentElement.dataset.themeResolved='light'});
      await page.locator('#announcement-close').click();
      await page.locator('#group-info-close').click();
      await page.locator('#composer-memory-open').click();
      await page.locator('#resource-picker-list button').first().waitFor({state:'visible'});
      screenshots.push(path.basename(await shot(page,outDir,'102-chat-resource-picker.png')));
      await page.locator('#resource-picker-list button').first().click();
      await page.waitForFunction(()=>!document.getElementById('resource-picker').open);
      record('composer_saved_resource_insert',/参考资料：.+（修订 \d+）/u.test(await page.locator('#chat-body').inputValue()),'Authorized saved memory content is inserted for review, not auto-sent');
      await page.locator('#chat-body').fill('');
      await page.locator('#composer-emoji-open').click();
      await page.locator('#composer-emoji-list button').first().click();
      record('composer_emoji_insert',await page.locator('#chat-body').inputValue()==='😀','Native emoji changes the draft only');
      screenshots.push(path.basename(await shot(page,outDir,'103-chat-composer-functional.png')));
      await page.locator('#chat-body').fill('');
    } catch(error) { record('visible_message_utilities',false,String(error)); }

    await context.close();
  } finally {
    await browser.close();
  }

  const manifest = {
    captured_at: shanghaiStamp(),
    git_sha: ready.git_sha || process.env.GITHUB_SHA || '',
    github_run_id: process.env.GITHUB_RUN_ID || '',
    github_run_url: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : '',
    origin_kind: 'throwaway GitHub Actions loopback app from this commit',
    ready: {
      username: ready.username,
      workspace_name: ready.workspace_name,
      empty_workspace_name: ready.empty_workspace_name,
      team_slug: ready.team_slug,
      run_status: ready.run_status,
      connection_status: ready.connection_status,
      chat_status: ready.chat_status,
      note: ready.note,
    },
    screenshots,
    checks,
    limitations: [
      'Captured from a throwaway management app on a GitHub Actions runner, not a local box desktop browser and not production.',
      'Model responses come from a local fake provider, not a real vendor.',
      'Fixture data is synthetic and clearly labeled. Login secrets were not written into this manifest or the PNG artifacts.',
      'The browser fixture exercises the management app. Container and Bot Social integration have separate checks.',
    ],
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const hard = Object.entries(checks).filter(([, value]) => !value.passed && !value.soft).map(([name]) => name);
  const soft = Object.entries(checks).filter(([, value]) => !value.passed && value.soft).map(([name]) => name);
  console.log(`screenshots=${screenshots.length} hard_failures=${hard.join(',') || 'none'} soft_failures=${soft.join(',') || 'none'}`);
  if (failed) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error && error.message ? error.message : 'screenshot script failed');
  process.exit(1);
});
