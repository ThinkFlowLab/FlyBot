// Plain helpers for the Create Bot form, kept free of React so tests can load them.

export function freshBotName(roster, base = 'New Bot') {
  const taken = new Set(roster.bots.map(bot => bot.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  let index = 2
  while (taken.has(`${base.toLowerCase()} ${index}`)) index += 1
  return `${base} ${index}`
}

// The form starts on the model the Main Bot runs on now (its chosen model, else the
// one it last ran on). When that one is not served anymore it falls back to the DSH
// default, then to the first served model. Only served models are picked, so a
// provider without a credential is never preselected.
export function startModel(roster) {
  const models = roster.models ?? []
  const served = ref => (ref ? models.find(model => model.ref === ref) : undefined)
  const main = roster.byId?.[roster.mainBotId] ?? (roster.bots ?? []).find(bot => bot.id === roster.mainBotId)
  return (served(main?.model) ?? served(main?.appliedModel) ?? served(roster.defaultModel) ?? models[0])?.ref ?? ''
}

// The model is always sent: the host fixes it on the Bot at creation.
export function createPayload({ name, look, image, model, effort, brief }) {
  const payload = { name, color: look.color, avatar: image ? { shape: look.shape, image } : { shape: look.shape } }
  if (model) payload.model = model
  if (effort) payload.effort = effort
  if (brief) payload.brief = brief
  return payload
}
