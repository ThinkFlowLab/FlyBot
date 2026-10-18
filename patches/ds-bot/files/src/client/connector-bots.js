import { createElement as h } from 'react'
import { t } from './i18n.js'

// Which Bots may use a connector (#335). Off for every Bot until the owner turns it on; a Bot
// that is shared with anyone cannot have it on (the host refuses the tools whatever the switch).

// The Bots the owner can switch: their own local Bots, not a friend's.
export function ownBots(roster) {
  const me = roster?.self?.memberId
  return (roster?.bots ?? []).filter(bot => !bot.remote && (me === undefined || me === null || bot.ownerId === undefined || bot.ownerId === me))
}

export const connectedConnectors = roster => (roster?.connectors ?? []).filter(connector => connector.state !== 'off')

export const sharedNames = bot => (Array.isArray(bot.sharedWith) ? bot.sharedWith : []).join(', ')
export const isOn = (bot, id) => bot.connectors?.[id] === true && sharedNames(bot) === ''

function hint(bot, id) {
  const names = sharedNames(bot)
  if (names !== '') return t('Not available: shared with {names}.', { names })
  return bot.connectors?.[id] === true ? t('This Bot can use it.') : t('Off. Turn on to let this Bot use it.')
}

// "On for 2 of 5 Bots", shown under a connected connector on the Connectors page.
export function usageText(roster, id) {
  const bots = ownBots(roster)
  const count = bots.filter(bot => isOn(bot, id)).length
  return count === 0 ? t('Off for every Bot. Choose which Bots may use it.') : t('On for {count} of {total} Bots', { count, total: bots.length })
}

// The per-Bot switches of one connector, on the Connectors page.
export function ConnectorBots({ connector, roster, actions, run, SwitchRow }) {
  const bots = ownBots(roster)
  return h('div', { className: 'bt-connector-bots' },
    bots.length === 0 ? h('span', { className: 'bt-set-hint' }, t('No Bots')) : bots.map(bot => h(SwitchRow, {
      key: bot.id,
      label: bot.name,
      hint: hint(bot, connector.id),
      on: isOn(bot, connector.id),
      disabled: sharedNames(bot) !== '',
      onChange: on => void run(actions.setBotConnector(bot.id, connector.id, on)),
    })),
    h('span', { className: 'bt-set-hint' }, t('A Bot that is shared with anyone never gets connector tools.')))
}

// A Bot's settings: one switch per connected connector.
export function BotConnectorsCard({ bot, roster, actions, run, Card, SwitchRow }) {
  const connected = connectedConnectors(roster)
  if (connected.length === 0) return null
  return h(Card, { title: t('Connectors') },
    connected.map(connector => h(SwitchRow, {
      key: connector.id,
      label: connector.name,
      hint: hint(bot, connector.id),
      on: isOn(bot, connector.id),
      disabled: sharedNames(bot) !== '',
      onChange: on => void run(actions.setBotConnector(bot.id, connector.id, on)),
    })))
}
