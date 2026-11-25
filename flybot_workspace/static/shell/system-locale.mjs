import {SETTINGS_MESSAGES, SHELL_MESSAGES} from './system-locale-catalog.mjs';

const messages = {...SHELL_MESSAGES, ...SETTINGS_MESSAGES};
const fields = Object.freeze({
  'data-ui-title':'title',
  'data-ui-label':'aria-label',
  'data-ui-placeholder':'placeholder',
  'data-ui-alt':'alt',
  'data-ui-option-group':'label',
});

export function supportsSystemLocale(value) {
  return value === 'zh-CN' || value === 'en';
}

export function systemLocale(value) {
  return supportsSystemLocale(value) ? value : 'zh-CN';
}

export function uiText(locale, key, values, pageMessages = {}) {
  const documentLanguage = locale?.documentElement?.lang;
  const pair = Object.hasOwn(pageMessages, key) ? pageMessages[key] : Object.hasOwn(messages, key) ? messages[key] : undefined;
  const phrase = pair?.[systemLocale(documentLanguage || locale) === 'en' ? 1 : 0];
  if (!phrase || !values) return phrase;
  return phrase.replace(/\{([a-z]+)\}/g, (placeholder, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder);
}

export function applySystemLocale(document, configured) {
  const locale = systemLocale(configured);
  if (document.documentElement) document.documentElement.lang = locale;
  for (const node of document.querySelectorAll?.('[data-ui-text]') || []) {
    const key = node.getAttribute('data-ui-text');
    if (!node.childElementCount && Object.hasOwn(messages, key) && messages[key].includes(node.textContent)) {
      node.textContent = uiText(locale, key);
    }
  }
  for (const [marker, attribute] of Object.entries(fields)) {
    for (const node of document.querySelectorAll?.('[' + marker + ']') || []) {
      const key = node.getAttribute(marker);
      if (Object.hasOwn(messages, key) && messages[key].includes(node.getAttribute(attribute))) {
        node.setAttribute(attribute, uiText(locale, key));
      }
    }
  }
  return locale;
}

const attrTokens = tag => [...tag.matchAll(/\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)];
const htmlChars = {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'};
const escapeHtml = value => value.replace(/[&<>"']/g, character => htmlChars[character]);
const markerValue = (tokens, name) => {
  const token = tokens.find(match => match[1] === name);
  return token?.[2] ?? token?.[3];
};

// Slots in the shipped templates are either a literal leaf or an existing
// display attribute. Escaping is applied at the HTML boundary only.
export function renderSystemLocale(html, configured, pageMessages) {
  const locale = systemLocale(configured);
  if (locale === 'zh-CN') return html;
  const phraseFor = key => uiText(locale, key, undefined, pageMessages);
  const translated = html.replace(/<[a-z][\w-]*(?=[\s>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, tag => {
    if (!tag.includes('data-ui-')) return tag;
    const tokens = attrTokens(tag);
    for (const match of tokens.reverse()) {
      const field = Object.keys(fields).find(key => fields[key] === match[1]);
      const phrase = field && phraseFor(markerValue(tokens, field));
      if (phrase) {
        tag = tag.slice(0, match.index) + ' ' + match[1] + '="' + escapeHtml(phrase) + '"'
          + tag.slice(match.index + match[0].length);
      }
    }
    return tag;
  }).replace(/(<([a-z][\w-]*)(?=[\s>])(?:[^"'<>]|"[^"]*"|'[^']*')*>)([^<]*)(<\/\2>)/gi,
    (leaf, opening, _name, _text, closing) => {
      if (!opening.includes('data-ui-text')) return leaf;
      const phrase = phraseFor(markerValue(attrTokens(opening), 'data-ui-text'));
      return phrase === undefined ? leaf : opening + escapeHtml(phrase) + closing;
    });
  return translated.replace('<html lang="zh-CN">', '<html lang="en">');
}
