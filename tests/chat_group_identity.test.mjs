import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroupBotAvatar, createGroupBotIdentities, groupBotIdentity, groupBotKey } from '../flybot_workspace/static/chat/group-identity.mjs';

const look = {color:'天空蓝', expression:'微笑', headwear:'耳机', glasses:'圆框眼镜', hand:'笔记本'};
const image = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.events = {};
    this.textContent = '';
  }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.events[name] = listener; }
}

const document = {createElement: tag => new Element(tag)};

test('a Bot keeps its tone across roster order, metadata changes, and message shapes', () => {
  const bots = Array.from({length:16}, (_, index) => ({owner_id:'team', id:`bot-${index}`, name:'Same name'}));
  const first = createGroupBotIdentities(bots);
  const second = createGroupBotIdentities(bots.toReversed().map(bot => ({...bot, name:'Renamed'})));
  assert.equal(new Set([...first.values()].map(identity => identity.tone)).size, 16);
  assert.equal(new Set([...first.values()].map(identity => JSON.stringify(identity.look))).size, 16);
  for (const bot of bots) {
    assert.equal(groupBotIdentity(first, bot).tone, groupBotIdentity(second, bot).tone);
    const message = {id:'a-message-id', agent_id:bot.id, agent_owner_id:bot.owner_id};
    assert.equal(groupBotKey(message), `team/${bot.id}`);
    assert.equal(groupBotIdentity(first, message), groupBotIdentity(first, bot));
  }
});

test('Bots with the same name and ID under different owners retain separate identities', () => {
  const first = {owner_id:'owner-one', id:'qa', name:'QA Engineer'};
  const second = {owner_id:'owner-two', id:'qa', name:'QA Engineer'};
  const byOwner = createGroupBotIdentities([first, second]);
  assert.notEqual(groupBotIdentity(byOwner, first).tone, groupBotIdentity(byOwner, second).tone);
  assert.equal(groupBotIdentity(byOwner, {agent_id:'qa'}), null);
  assert.equal(groupBotIdentity(byOwner, {agent_id:'qa', agent_owner_id:'unrelated'}), null);
  assert.equal(groupBotIdentity(createGroupBotIdentities([first]), {agent_ref:'qa'}).key, 'owner-one/qa');
});

test('a trusted raster photo is shown before the saved portrait, with portrait fallback', () => {
  const bot = {owner_id:'local', id:'qa', name:'QA Engineer', avatar:{image}, look};
  const identity = groupBotIdentity(createGroupBotIdentities([bot]), bot);
  const avatar = createGroupBotAvatar(identity, document);
  assert.equal(avatar.className, 'group-bot-avatar');
  assert.equal(avatar.dataset.groupBotTone, identity.tone);
  assert.equal(avatar.attributes['aria-hidden'], 'true');
  const [photo] = avatar.children;
  assert.equal(photo.tagName, 'img');
  assert.equal(photo.src, image);
  assert.equal(photo.alt, '');
  photo.events.error();
  assert.deepEqual(avatar.children[0].dataset, look);
});

test('missing and unsafe photo data fall back to illustrations and preserve saved presets', () => {
  const bots = [
    {owner_id:'local', id:'qa', name:'测试工程师', portraitUrl:'https://elsewhere.example/avatar.png'},
    {owner_id:'local', id:'ux', name:'Équipe Design', avatar:{image:'data:image/svg+xml;base64,PHN2Zz4='}},
    {owner_id:'local', id:'dev', name:'Developer', portrait:'mint'},
    {owner_id:'local', id:'unnamed'},
  ];
  const avatars = createGroupBotIdentities(bots);
  const render = bot => createGroupBotAvatar(groupBotIdentity(avatars, bot), document);
  assert.equal(groupBotIdentity(avatars, bots[0]).initials, '测试');
  assert.equal(groupBotIdentity(avatars, bots[1]).initials, 'ÉD');
  assert.equal(render(bots[0]).children[0].className, 'look-avatar');
  assert.equal(render(bots[1]).children[0].className, 'look-avatar');
  assert.equal(render(bots[2]).children[0].dataset.color, '薄荷绿');
  assert.equal(render(bots[3]).dataset.groupBotInitials, '◆');
  assert.equal(render(bots[3]).textContent, '');
});
