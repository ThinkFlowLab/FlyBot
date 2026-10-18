import { createElement as h } from 'react'
import { t } from './i18n.js'

// Who may use a connector through a Bot (#335, #369). Two switches per Bot and connector:
//   - for the owner's own use: on by default, so a connected connector works in every Bot at once;
//   - for other people's use of the Bot (a friend, another member of a room, another owner's Bot):
//     off by default, and the owner can turn it on for that Bot. Sharing a Bot never takes the
//     owner's own use away, and never greys the second switch out.
// The host decides every call (connector-access.js); these switches only write the choice.

// The Bots the owner can switch: their own local Bots, not a friend's.
export function ownBots(roster) {
  const me = roster?.self?.memberId
  return (roster?.bots ?? []).filter(bot => !bot.remote && (me === undefined || me === null || bot.ownerId === undefined || bot.ownerId === me))
}

export const connectedConnectors = roster => (roster?.connectors ?? []).filter(connector => connector.state !== 'off')

export const sharedNames = bot => (Array.isArray(bot.sharedWith) ? bot.sharedWith : []).join(', ')
// Only an explicit false turns it off for the owner; no record means on.
export const isOn = (bot, id) => bot.connectors?.[id] !== false
// Other people's use needs the owner's own switch on as well.
export const othersOn = (bot, id) => isOn(bot, id) && bot.connectorsShared?.[id] === true

function ownHint(bot, id) {
  return isOn(bot, id) ? t('On. This Bot can use it for you.') : t('Off. This Bot will not use it for anyone.')
}

function othersHint(bot, id) {
  const names = sharedNames(bot)
  if (!isOn(bot, id)) return t('Turn it on for yourself first.')
  if (othersOn(bot, id)) return names === '' ? t('On: anyone who uses this Bot, such as a friend or another room member, can use it too.') : t('On: {names} can use it through this Bot.', { names })
  return names === '' ? t('Off. If others use this Bot, they get it only when you turn this on.') : t('Shared with {names}. They cannot use it unless you turn this on.', { names })
}

// "On for 2 of 5 Bots", shown under a connected connector on the Connectors page.
export function usageText(roster, id) {
  const bots = ownBots(roster)
  const own = bots.filter(bot => isOn(bot, id)).length
  const others = bots.filter(bot => othersOn(bot, id)).length
  const base = own === 0 ? t('Off for every Bot. Choose which Bots may use it.')
    : own === bots.length ? t('On for all {total} Bots', { total: bots.length }) : t('On for {count} of {total} Bots', { count: own, total: bots.length })
  return others === 0 ? base : `${base} · ${t('Allowed for others on {count}', { count: others })}`
}

// The two switches of one Bot and connector. `name` labels the first (the Bot's name on the
// Connectors page, the connector's in a Bot's settings).
function BotSwitches({ bot, connector, name, actions, run, SwitchRow }) {
  const set = (scope, on) => void run(actions.setBotConnector(bot.id, connector.id, on, scope))
  return [
    h(SwitchRow, { key: 'own', label: name, hint: ownHint(bot, connector.id), on: isOn(bot, connector.id), disabled: false, onChange: on => set('owner', on) }),
    h('div', { key: 'others', className: 'bt-connector-others' }, h(SwitchRow, {
      label: t('{name}: also when others use it', { name }),
      hint: othersHint(bot, connector.id),
      on: othersOn(bot, connector.id),
      disabled: !isOn(bot, connector.id),
      onChange: on => set('shared', on),
    })),
  ]
}

// The per-Bot switches of one connector, on the Connectors page.
export function ConnectorBots({ connector, roster, actions, run, SwitchRow }) {
  const bots = ownBots(roster)
  return h('div', { className: 'bt-connector-bots' },
    bots.length === 0 ? h('span', { className: 'bt-set-hint' }, t('No Bots')) : bots.map(bot => h('div', { key: bot.id, className: 'bt-connector-bot' },
      h(BotSwitches, { bot, connector, name: bot.name, actions, run, SwitchRow }))),
    h('span', { className: 'bt-set-hint' }, t('On by default for you. When someone else uses a Bot, or it works in a room with other people, such as a friend or another member, it is off unless you allow it for that Bot.')))
}

// A Bot's settings: the two switches per connected connector.
export function BotConnectorsCard({ bot, roster, actions, run, Card, SwitchRow }) {
  const connected = connectedConnectors(roster)
  if (connected.length === 0) return null
  return h(Card, { title: t('Connectors') },
    connected.map(connector => h('div', { key: connector.id, className: 'bt-connector-bot' },
      h(BotSwitches, { bot, connector, name: connector.name, actions, run, SwitchRow }))))
}
