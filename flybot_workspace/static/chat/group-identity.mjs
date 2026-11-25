import { AGENT_PORTRAITS, LOOK_OPTIONS, agentPortraitLook, createLookAvatar, validLook } from '../look/app.mjs';

const TONE_COUNT = 16;
const OWNER_ID = /^[A-Za-z0-9._-]{1,80}$/;
const BOT_ID = /^[A-Za-z0-9._:-]{1,80}$/;
const RASTER_AVATAR = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const PORTRAITS = new Set(AGENT_PORTRAITS.map(({id}) => id));
const botId = target => target?.agent_id || target?.agent_ref || target?.id || '';
const ownerId = target => target?.owner_id || target?.agent_owner_id || '';

export function groupBotKey(target) {
  const owner = ownerId(target);
  const bot = botId(target);
  return typeof owner === 'string' && OWNER_ID.test(owner) && typeof bot === 'string' && BOT_ID.test(bot)
    ? `${owner}/${bot}` : '';
}

function firstTone(key) {
  let hash = 2166136261;
  for (const char of key) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
  return (hash >>> 0) % TONE_COUNT;
}

function botInitials(name) {
  const words = (typeof name === 'string' ? name.normalize('NFC') : '').match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu);
  if (!words?.length) return '◆';
  if (words.length === 1 && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2}/u.test(words[0])) {
    return [...words[0]].slice(0, 2).join('');
  }
  return words.slice(0, 2).map(word => word.match(/^.\p{M}*/u)[0]).join('').toUpperCase();
}

function profileImage(agent) {
  return [agent.avatar?.image, agent.portraitUrl].find(value => typeof value === 'string'
    && value.length <= 164_000 && RASTER_AVATAR.test(value)) || null;
}

function botLook(agent, name, tone) {
  if (PORTRAITS.has(agent.portrait) || validLook(agent.look)) return agentPortraitLook(botId(agent), agent.portrait, agent.look);
  if (typeof name !== 'string' || !name.trim()) return null;
  const preset = AGENT_PORTRAITS[tone % AGENT_PORTRAITS.length];
  const look = agentPortraitLook(botId(agent), preset.id);
  const headwear = LOOK_OPTIONS.headwear;
  const variant = Math.floor(tone / AGENT_PORTRAITS.length);
  return {...look, headwear:headwear[(headwear.indexOf(look.headwear) + variant) % headwear.length]};
}

export function createGroupBotIdentities(agents) {
  const roster = new Map();
  for (const agent of agents || []) {
    const key = groupBotKey(agent);
    if (key && !roster.has(key)) roster.set(key, agent);
  }
  const identities = new Map();
  const taken = new Set();
  // Allocate on sorted IDs so message timing and roster display order cannot change the colors.
  for (const key of [...roster.keys()].sort()) {
    const agent = roster.get(key);
    let tone = firstTone(key);
    if (taken.size < TONE_COUNT) {
      while (taken.has(tone)) tone = (tone + 1) % TONE_COUNT;
      taken.add(tone);
    }
    const name = agent.name || agent.agent_name;
    identities.set(key, {key, id:botId(agent), tone:String(tone), initials:botInitials(name),
      image:profileImage(agent), look:botLook(agent, name, tone)});
  }
  return identities;
}

export function groupBotIdentity(identities, target) {
  if (!identities || !target) return null;
  const key = groupBotKey(target);
  if (ownerId(target)) return key ? identities.get(key) ?? null : null;
  // Older messages omit the owner. Resolve only when the Bot ID is unique in the roster.
  const id = botId(target);
  if (typeof id !== 'string' || !BOT_ID.test(id)) return null;
  let identity = null;
  for (const candidate of identities.values()) {
    if (candidate.id !== id) continue;
    if (identity) return null;
    identity = candidate;
  }
  return identity;
}

export function createGroupBotAvatar(identity, document) {
  if (!identity || !document) return null;
  const avatar = document.createElement('span');
  avatar.className = 'group-bot-avatar';
  avatar.dataset.groupBotTone = identity.tone;
  avatar.setAttribute('aria-hidden', 'true');
  const showFallback = () => {
    const look = createLookAvatar(identity.look, document);
    if (look) avatar.replaceChildren(look);
    else {
      avatar.replaceChildren();
      avatar.dataset.groupBotInitials = identity.initials;
    }
  };
  if (!identity.image) showFallback();
  else {
    const photo = document.createElement('img');
    photo.alt = '';
    photo.decoding = 'async';
    photo.addEventListener('error', showFallback, {once:true});
    photo.src = identity.image;
    avatar.append(photo);
  }
  return avatar;
}
