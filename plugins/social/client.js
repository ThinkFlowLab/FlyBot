// flybot-social browser half: plain JS, loaded by DSH as a classic script. Registers
// into the FlyBot slot registry that ds-bot's client renders (src/client/flybot-slots.js).
window.__ModuleLoader__.load({
  id: '@flybot/social',
  factory(require) {
    const { createElement: h, useEffect, useState, useRef } = require('react')
    const slots = () => {
      // Same bootstrap as ds-bot's flybot-registry.js: whichever bundle loads first creates it.
      if (globalThis.__flybot__ === undefined) throw new Error('flybot-social needs ds-bot with FlyBot slots')
      return globalThis.__flybot__.slots
    }
    const call = (endpoint, payload) => globalThis.__flybot__.call(endpoint, payload)

    // Errors in English. ds-bot's api.js may localize transport errors ("HTTP 404" becomes
    // Chinese in a zh UI), so the panel words them from the error code instead.
    const isSocialMissing = (e) => {
      const code = String(e?.code ?? '')
      const message = String(e?.message ?? e ?? '')
      return code === 'bot/not-found' || /Unknown FlyBot endpoint social\//i.test(message)
    }
    const errorText = (e) => {
      const code = String(e?.code ?? '')
      const http = code.match(/^HTTP_(\d+)$/)
      if (http) return `The FlyBot host did not answer (HTTP ${http[1]}). Reload the page; if this keeps happening, restart FlyBot web.`
      if (code === 'NETWORK') return 'Could not reach FlyBot. Check that it is still running.'
      if (isSocialMissing(e)) {
        return 'Social is not running: the plugin did not start. See Settings → Feedback.'
      }
      const message = String(e?.message ?? e ?? '')
      if (/relationship_exists/i.test(message)) return "You're already friends. That Bot is in Friends' Bots again."
      if (/invite_unavailable|invite is used|invite_used|already used/i.test(message)) return 'This invite was already used. Ask your friend for a new one.'
      return message
    }

    // Styles reuse ds-bot's sidebar tokens (--bt-ink, --bt-ink-2, --bt-ink-3, --bt-hover, --bt-line,
    // --bt-line-2, --bt-card, --bt-accent, --bt-tag-bg/-ink), like @flybot/tree, so both themes follow the app.
    const CSS = `
.fs{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--bt-ink,#141414);padding:0 4px 6px;overflow:hidden;box-sizing:border-box;max-width:100%}
.fs *,.fs *::before,.fs *::after{box-sizing:border-box}
.fs-head{display:flex;align-items:center;gap:4px;padding:0 0 0 0}
.fs-head-main{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink-2,rgba(20,20,20,.6));font:inherit;font-size:12px;line-height:16px;font-weight:500;text-align:left;cursor:pointer;transition:background-color .12s ease}
.fs-head-main:hover,.fs-icon:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-chev{display:inline-flex;width:12px;justify-content:center;color:var(--bt-ink-3,rgba(20,20,20,.36));transition:transform .12s ease}
.fs-head-main[aria-expanded=false] .fs-chev{transform:rotate(-90deg)}
.fs-title{flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fs-count,.fs-tag{flex:none;font-size:11px;line-height:14px;padding:1px 6px;border-radius:4px;background:var(--bt-tag-bg,rgba(20,20,20,.06));color:var(--bt-tag-ink,rgba(20,20,20,.56));font-weight:500}
.fs-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink-2,rgba(20,20,20,.6));font:inherit;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap}
.fs-icon[aria-expanded=true]{background:var(--bt-active,rgba(119,119,119,.17));color:var(--bt-ink,#141414)}
.fs-body{display:flex;flex-direction:column;gap:2px;padding:2px 0 0}
.fs-empty,.fs-hint{padding:4px 10px;font-size:12px;line-height:17px;color:var(--bt-ink-2,rgba(20,20,20,.6));overflow-wrap:anywhere}
.fs-join-as{align-items:baseline;flex-wrap:wrap;overflow-wrap:normal;word-break:normal}
.fs-join-as-label{flex:none;white-space:nowrap;overflow-wrap:normal;word-break:keep-all}
.fs-empty{padding:6px 10px 8px;font-size:13px;line-height:18px}
.fs-label{padding:8px 10px 2px;font-size:11px;line-height:14px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--bt-ink-3,rgba(20,20,20,.36));display:flex;align-items:center;gap:6px}
.fs-home-head{display:flex;align-items:center;gap:4px;min-width:0;padding:2px 4px 0 0}
.fs-home{display:flex;align-items:baseline;gap:6px;flex:1 1 auto;min-width:0;padding:4px 8px;border:0;border-radius:8px;background:transparent;font:inherit;font-size:12px;line-height:16px;font-weight:500;color:var(--bt-ink-2,rgba(20,20,20,.6));text-align:left;cursor:pointer}
.fs-home:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-home .fs-chev[data-closed]{transform:rotate(-90deg)}
.fs-home-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.fs-home-handle{font-weight:400;color:var(--bt-ink-3,rgba(20,20,20,.36));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.fs-auto{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:14px;color:var(--bt-ink-3,rgba(20,20,20,.36));cursor:pointer;white-space:nowrap}
.fs-auto input{margin:0;accent-color:var(--bt-accent,#4d6bfe)}
.bt-social-rows{display:flex;flex-direction:column}
.fs-row{display:flex;align-items:center;gap:8px;min-width:0;padding:5px 8px 5px 10px;border-radius:8px;transition:background-color .12s ease}
.fs-row:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-avatar{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--bt-tag-bg,rgba(20,20,20,.06));color:var(--bt-ink-2,rgba(20,20,20,.6));font-size:12px;font-weight:600;overflow:hidden}
.fs-avatar img{width:100%;height:100%;object-fit:cover;display:block}
.fs-face-mark{flex:none;display:inline-flex;align-items:center;justify-content:center;width:var(--fs-face-size,24px);height:var(--fs-face-size,24px)}
.fs-face-mark .bt-mark,.fs-face-mark .fs-avatar{width:100%;height:100%;font-size:calc(var(--fs-face-size,24px)*.5)}
.fs-text{display:flex;flex-direction:column;flex:1 1 auto;min-width:0}
.fs-name{font-size:14px;line-height:19px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fs-sub{font-size:12px;line-height:16px;color:var(--bt-ink-2,rgba(20,20,20,.6));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fs-msg{white-space:normal;overflow-wrap:anywhere}
.fs-actions{flex:none;display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;max-width:100%}
.fs-card{margin:4px 4px 2px;padding:10px;border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:10px;background:var(--bt-card,#fff);display:flex;flex-direction:column;gap:8px}
.fs-friend-settings{gap:10px;max-width:280px}
.fs-friend-settings .fs-auto{align-self:flex-start}
.fs-friend-settings .fs-link{align-self:flex-start;color:var(--bt-ink-3,rgba(20,20,20,.36))}
.fs-card .fs-hint{padding:0}
.fs-line{display:flex;gap:6px;min-width:0;align-items:center}
.fs-input{flex:1 1 auto;min-width:0;width:0;height:30px;padding:0 9px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;outline:none;text-overflow:ellipsis}
.fs-input:focus{border-color:var(--bt-accent,#4d6bfe)}
.fs-input[readonly]{background:var(--bt-tag-bg,rgba(20,20,20,.06));border-color:transparent}
.fs-btn{flex:none;height:30px;padding:0 12px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:8px;background:transparent;color:var(--bt-ink,#141414);font:inherit;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background-color .12s ease}
.fs-btn:hover:not(:disabled){background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-btn:disabled{opacity:.45;cursor:default}
.fs-btn-primary{border-color:transparent;background:var(--bt-accent,#4d6bfe);color:#fff;width:100%}
.fs-btn-primary:hover:not(:disabled){background:var(--bt-accent,#4d6bfe);filter:brightness(1.08)}
.fs-btn-sm{height:26px;padding:0 9px;font-size:12px}
.fs-link{padding:0;border:0;background:none;color:var(--bt-accent,#4d6bfe);font:inherit;font-size:12px;cursor:pointer}
.fs-link:hover{text-decoration:underline}
.fs-status{padding:0;font-size:12px;line-height:17px;color:var(--bt-ink-2,rgba(20,20,20,.6));overflow-wrap:anywhere}
.fs-status[data-tone=error]{color:#e5484d}
.fs-pending-tag{background:var(--bt-accent,#4d6bfe);color:#fff}
.fs-refresh{flex:none;font-size:11px;line-height:14px;color:var(--bt-ink-3,rgba(20,20,20,.36));font-weight:400}
.fs-me{display:flex;align-items:center;gap:6px;padding:0 10px 4px;font-size:11px;line-height:14px;color:var(--bt-ink-3,rgba(20,20,20,.36))}
.fs-me-handle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-me .fs-link{flex:none}
.fs-pending{margin:4px 4px 6px;padding:6px 8px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:10px;background:var(--bt-card,#fff);display:flex;flex-direction:column;gap:4px;min-width:0;max-width:100%}
.fs-pending .fs-label{padding:0}
.fs-pending-item{display:flex;align-items:center;gap:8px;width:100%;max-width:100%;min-width:0;padding:4px 4px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;flex-wrap:nowrap}
.fs-pending-item:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-pending-item .fs-text{min-width:0;flex:1 1 auto;overflow:hidden;display:flex;flex-direction:row;align-items:baseline;gap:8px}
.fs-pending-item .fs-name{flex:0 1 auto;max-width:40%;min-width:0}
.fs-pending-one{flex:1 1 auto;font-size:12px;line-height:16px;color:var(--bt-ink-2,rgba(20,20,20,.6));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.fs-draft{font-size:13px;line-height:18px;color:var(--bt-ink,#141414);white-space:pre-wrap;overflow-wrap:anywhere;max-height:96px;overflow:auto}
.fs-digits{flex:1 1 auto;min-width:0;width:0;height:30px;padding:0 9px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:16px;letter-spacing:.24em;font-variant-numeric:tabular-nums;outline:none;text-align:center}
.fs-digits:focus{border-color:var(--bt-accent,#4d6bfe)}
.fs-face{margin:4px 4px 6px;padding:8px 10px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:10px;background:var(--bt-card,#fff);display:flex;flex-direction:column;gap:6px;min-width:0}
.fs-face-item{display:flex;flex-direction:column;gap:2px;min-width:0;width:100%;overflow:hidden}
.fs-face-row{display:flex;align-items:center;gap:6px;min-width:0;width:100%;padding:2px 0;flex-wrap:nowrap;overflow:hidden}
.fs-face-row .fs-name{flex:1 1 0;min-width:0}
.fs-face-row[data-open]{cursor:pointer}
.fs-face-actions{display:flex;gap:4px;flex:none;flex-wrap:nowrap}
.fs-face-actions .fs-btn-sm{height:22px;padding:0 6px;font-size:11px}
.fs-stack{display:flex;flex-direction:row;align-items:center;flex:none}
.fs-stack .fs-face-mark,.fs-stack [data-flybot=face-card-member]{margin-left:-6px}
.fs-stack .fs-face-mark:first-child,.fs-stack [data-flybot=face-card-member]:first-child{margin-left:0}
.fs-stack [data-flybot=face-card-member]{display:inline-flex;border-radius:50%;box-shadow:0 0 0 2px var(--bt-card,#fff)}
.fs-stack-more{flex:none;font-size:11px;line-height:14px;color:var(--bt-ink-3,rgba(20,20,20,.36));margin-left:4px}
.fs-chip{flex:none;font-size:11px;line-height:14px;padding:1px 6px;border-radius:4px;background:var(--bt-tag-bg,rgba(20,20,20,.06));color:var(--bt-tag-ink,rgba(20,20,20,.56));white-space:nowrap}
.fs-face-head{display:flex;align-items:center;gap:8px;justify-content:space-between}
.fs-face-head .fs-auto{margin-left:auto}
.fs-past{margin:2px 0 4px}
.fs-past-head{display:flex;align-items:center;gap:6px;width:100%;padding:4px 8px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink-3,rgba(20,20,20,.36));font:inherit;font-size:11px;line-height:14px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;text-align:left;cursor:pointer}
.fs-past-head:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-past-head .fs-chev[data-closed]{transform:rotate(-90deg)}
.fs-face-auto-wrap{display:inline-flex;align-items:center;gap:2px;padding:0}
.fs-face-auto{white-space:nowrap;font-size:11px;line-height:14px;color:var(--bt-ink-3,rgba(20,20,20,.36))}
.fs-face-note{padding:0;display:none}
.fs-chat-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
[data-flybot=chat-approvals]{display:flex;flex-direction:column;align-items:flex-start;gap:8px;width:100%;box-sizing:border-box;padding:4px 0 8px}
.fs-hold{box-sizing:border-box;width:100%;max-width:min(460px,100%);min-width:0;margin:0;padding:10px 12px;border:.5px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:14px;background:var(--bt-card,#fff);color:var(--bt-ink,#141414);display:flex;flex-direction:column;gap:6px;box-shadow:0 1px 2px rgba(20,20,20,.06);overflow:hidden}
.fs-hold .fs-label{padding:0;font-size:11px;line-height:14px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--bt-ink-3,rgba(20,20,20,.36))}
.fs-hold .fs-sub{font-size:13px;line-height:18px;font-weight:500;color:var(--bt-ink,#141414);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fs-hold .fs-draft{margin:0;font-size:13px;line-height:18px;color:var(--bt-ink-2,rgba(20,20,20,.6));overflow-wrap:break-word;word-break:normal;white-space:pre-wrap;max-height:none}
.fs-hold .fs-draft[data-clamp]{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;white-space:normal;overflow-wrap:break-word;word-break:normal;max-height:calc(18px * 3)}
.fs-hold-more{align-self:flex-start;margin:0;padding:0;border:0;background:none;color:var(--bt-accent,#4d6bfe);font:inherit;font-size:12px;line-height:16px;cursor:pointer}
.fs-hold-more:hover{text-decoration:underline}
.fs-hold-always{flex:none;margin:0;padding:0 2px;height:28px;border:0;background:none;color:var(--bt-ink-2,rgba(20,20,20,.6));font:inherit;font-size:12px;line-height:16px;font-weight:500;cursor:pointer;white-space:nowrap}
.fs-hold-always:hover:not(:disabled){color:var(--bt-ink,#141414);text-decoration:underline}
.fs-hold-always:disabled{opacity:.45;cursor:default}
.fs-hold .fs-actions{margin-top:2px;justify-content:flex-end;gap:8px;flex-wrap:nowrap}
.fs-hold .fs-btn{flex:none;height:28px;padding:0 12px;border-radius:999px;font-size:12px}
.fs-hold .fs-btn-primary{width:auto;color:#fff}
.fs-hold[data-state] .fs-name{font-size:13px;line-height:18px;font-weight:500;color:var(--bt-ink-2,rgba(20,20,20,.6))}
.fs-row-wrap{position:relative;display:flex;align-items:center;gap:2px;min-width:0}
.fs-row-wrap .fs-row,.fs-row-wrap > :first-child{flex:1 1 auto;min-width:0}
.fs-remove{flex:none;width:20px;height:20px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--bt-ink-3,rgba(20,20,20,.36));font:inherit;font-size:14px;line-height:1;cursor:pointer;opacity:0}
.fs-row-wrap:hover .fs-remove,.fs-row-wrap:focus-within .fs-remove,.fs-remove:focus-visible,.fs-remove:disabled{opacity:1}
.fs-remove:hover:not(:disabled),.fs-remove:focus-visible{background:var(--bt-hover,rgba(119,119,119,.09));color:var(--bt-ink,#141414)}
.fs-remove:disabled{cursor:default;opacity:.55}
.fs-menu{position:absolute;right:4px;top:100%;z-index:5;min-width:160px;padding:4px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:8px;background:var(--bt-card,#fff);box-shadow:0 4px 16px rgba(0,0,0,.12)}
.fs-menu button{display:block;width:100%;text-align:left;height:28px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer}
.fs-menu button:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-chat-approval{margin:0;min-width:0}
.fs-chat-approval[data-state=approved] .fs-label,.fs-chat-approval[data-state=rejected] .fs-label,.fs-chat-approval[data-state=approved] .fs-name,.fs-chat-approval[data-state=rejected] .fs-name{color:var(--bt-ink-2,rgba(20,20,20,.6))}
.fs-dialog-back{position:fixed;inset:0;z-index:40;background:rgba(20,20,20,.4);display:flex;align-items:center;justify-content:center;padding:12px}
.fs-dialog{width:min(420px,100%);max-height:min(640px,92vh);overflow:hidden;margin:0;padding:14px;border:1px solid var(--bt-line-2,rgba(20,20,20,.15));border-radius:14px;background:var(--bt-card,#fff);display:flex;flex-direction:column;gap:10px;box-shadow:0 12px 40px rgba(0,0,0,.18)}
.fs-dialog-head{display:flex;align-items:center;gap:8px;flex:none}
.fs-dialog-head .fs-name{flex:1 1 auto}
.fs-dialog > form{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px}
.fs-tiles{margin:0;padding:4px 0 0;list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:10px 6px;align-content:start}
.fs-pick{max-height:220px;overflow:auto}
.fs-tile{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0;padding:6px 2px;border-radius:10px}
.fs-tile-hit{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0;width:100%;margin:0;cursor:pointer;font:inherit;position:relative}
.fs-tile-hit:hover,.fs-tile-on{background:var(--bt-hover,rgba(119,119,119,.09))}
.fs-tile-mark{position:relative;flex:none;display:inline-flex}
.fs-tile-name{display:block;width:100%;font-size:12px;line-height:16px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--bt-ink,#141414)}
.fs-tile-owner{display:block;width:100%;font-size:11px;line-height:14px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--bt-ink-2,rgba(20,20,20,.6))}
.fs-wait-overview{margin:0 0 8px;padding:8px 10px;border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:12px;background:var(--bt-card,#fff);display:flex;flex-direction:column;gap:8px;min-width:0;max-width:100%}
.fs-wait-overview .fs-wait-foot{margin-top:2px}
.fs-tile-mine{position:absolute;right:-1px;bottom:-1px;width:8px;height:8px;border-radius:50%;background:var(--bt-accent,#4d6bfe);box-shadow:0 0 0 2px var(--bt-card,#fff);pointer-events:none}
.fs-tile-on .fs-face-mark{border-radius:50%;box-shadow:0 0 0 2px var(--bt-accent,#4d6bfe)}
.fs-tile-check{position:absolute;right:-2px;bottom:-2px;width:16px;height:16px;border-radius:50%;background:var(--bt-accent,#4d6bfe);color:#fff;font-size:11px;line-height:16px;text-align:center;pointer-events:none;box-shadow:0 0 0 2px var(--bt-card,#fff)}
.fs-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.fs-wait{display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0;overflow:hidden}
.fs-wait-count{flex:none;padding:0}
.fs-wait-code{flex:none;display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 0 2px}
.fs-wait-code-label{font-size:11px;line-height:14px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--bt-ink-3,rgba(20,20,20,.36))}
.fs-wait-code-digits{font-size:28px;line-height:34px;font-weight:600;letter-spacing:.28em;font-variant-numeric:tabular-nums;color:var(--bt-ink,#141414)}
.fs-wait-body{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:4px}
.fs-wait-foot{display:flex;align-items:stretch;gap:8px;flex:none}
.fs-wait-foot .fs-btn{height:36px}
.fs-wait-foot .fs-btn-primary{flex:1 1 auto;width:auto;min-width:0}
.fs-fail{padding:0}
`
    function useStyles() {
      useEffect(() => {
        if (typeof document === 'undefined' || document.getElementById('flybot-social-css')) return
        const style = document.createElement('style')
        style.id = 'flybot-social-css'
        style.textContent = CSS
        document.head.appendChild(style)
      }, [])
    }
    const initial = name => (String(name ?? '?').replace(/^@/, '').trim()[0] ?? '?').toUpperCase()

    // Same FNV-1a as core lookOf, so a missing host BotMark still paints a stable per-Bot
    // color (never the shared gray letter badge) and two ids do not collide.
    const FACE_INKS = ['#e5484d', '#e54666', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#3e63dd', '#5b5bd6', '#8e4ec6']
    function inkOf(seed) {
      const text = String(seed ?? '')
      let value = 2166136261
      for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619)
      return FACE_INKS[(value >>> 0) % FACE_INKS.length]
    }
    function faceSeed(bot) {
      const handle = typeof bot?.remote?.handle === 'string' && bot.remote.handle.trim()
        ? bot.remote.handle
        : typeof bot?.handle === 'string' && bot.handle.trim() && bot.remote
          ? bot.handle
          : ''
      if (handle) return `remote:${handle.trim().replace(/^@+/, '').toLowerCase()}`
      if (bot?.id !== undefined) return String(bot.id)
      if (typeof bot?.handle === 'string' && bot.handle.trim()) return `remote:${bot.handle.trim().replace(/^@+/, '').toLowerCase()}`
      return String(bot?.name ?? '')
    }
    function rosterBot(roster, id) {
      if (!id) return undefined
      return roster?.byId?.[id] ?? (roster?.bots ?? []).find(bot => bot.id === id)
    }
    function chatByHandle(remoteChats, handle) {
      if (!handle) return undefined
      return (remoteChats ?? []).find(chat => chat.remote?.handle === handle)
    }
    // Local picker rows use the team roster record (configured image / shape / color).
    // Waiting-room "mine" matches the same local Bot; a friend's Bot uses its chat
    // record or a handle-seeded remote look, plus any avatar the member payload carries.
    function faceLook({ roster, remoteChats, bots, local, member } = {}) {
      if (local) {
        const full = rosterBot(roster, local.id)
        return full ? { ...local, ...full } : local
      }
      if (!member) return undefined
      const mine = (bots ?? []).find(bot => bot.handle && bot.handle === member.handle)
      if (mine) return faceLook({ roster, bots, local: mine })
      const extra = {}
      if (member.color) extra.color = member.color
      if (member.avatar) extra.avatar = member.avatar
      const chat = chatByHandle(remoteChats, member.handle)
      if (chat) {
        return {
          ...chat,
          name: member.displayName || chat.name,
          remote: chat.remote ?? { handle: member.handle },
          ...extra,
        }
      }
      return {
        id: member.botId || member.handle,
        name: member.displayName || member.label || member.handle,
        handle: member.handle,
        remote: member.handle ? { handle: member.handle } : undefined,
        ...extra,
      }
    }
    function FaceAvatar({ bot, size = 24 } = {}) {
      const Avatar = globalThis.__flybot__?.BotAvatar
      const Mark = globalThis.__flybot__?.BotMark
      const seed = faceSeed(bot)
      const color = typeof bot?.color === 'string' && bot.color.startsWith('#') ? bot.color : inkOf(seed)
      let inner
      if (typeof Avatar === 'function' && bot) inner = h(Avatar, { bot, size, badge: false, live: false })
      else if (typeof Mark === 'function' && bot) inner = h(Mark, { bot, size })
      else {
        const image = bot?.avatar?.image
        const emoji = bot?.avatar?.emoji
        inner = h('span', {
          className: 'fs-avatar',
          'data-color': color,
          style: image ? undefined : { background: color, color: '#fff' },
        }, image ? h('img', { src: image, alt: '' }) : (emoji || initial(bot?.name)))
      }
      return h('span', {
        className: 'fs-face-mark',
        'data-flybot': 'face-avatar',
        'data-bot-id': bot?.id,
        'data-handle': bot?.remote?.handle || bot?.handle,
        'data-color': color,
        'data-size': size,
        'aria-hidden': true,
        style: { width: size, height: size, '--fs-face-size': `${size}px` },
      }, inner)
    }

    function faceTileParts(member) {
      const owner = String(member?.ownerName ?? member?.owner_name ?? '').trim()
      const raw = String(member?.displayName || member?.name || '').trim()
      let name = raw
      if (!name || /^bot$/i.test(name) || (owner && name.toLowerCase() === owner.toLowerCase())) {
        const fromLabel = String(member?.label ?? '').split('·')[0].replace(/'s Chief$/i, 'Chief').trim()
        if (fromLabel && !/^bot$/i.test(fromLabel) && (!owner || fromLabel.toLowerCase() !== owner.toLowerCase())) name = fromLabel
        else {
          const handleText = typeof member?.handle === 'object' && member.handle
            ? String(member.handle.handle ?? '')
            : String(member?.handle ?? '')
          const part = handleText.replace(/^@/, '').split('.')[0]
          name = part && part !== 'home' && part !== 'bot'
            ? part.charAt(0).toUpperCase() + part.slice(1)
            : (raw || 'Bot')
        }
      }
      if (/^chief$/i.test(name)) name = 'Chief'
      return { name: name || 'Bot', owner }
    }

    function FaceTile({ bot, name, owner, member, handle, mine, pick, selected, onToggle } = {}) {
      const parts = member ? faceTileParts(member) : { name: name || 'Bot', owner: owner || '' }
      const title = [parts.name, parts.owner].filter(Boolean).join(' · ')
      const mark = h('span', { className: 'fs-tile-mark' },
        h(FaceAvatar, { bot, size: 48 }),
        mine
          ? h('span', { className: 'fs-tile-mine', 'data-flybot': 'face-mine', title: 'mine', 'aria-label': 'mine' })
          : null,
        pick && selected
          ? h('span', { className: 'fs-tile-check', 'data-flybot': 'face-pick-check', 'aria-hidden': true }, '✓')
          : null)
      const caption = [
        h('span', { key: 'n', className: 'fs-tile-name', title }, parts.name),
        parts.owner ? h('span', { key: 'o', className: 'fs-tile-owner', 'data-flybot': 'face-owner', title: parts.owner }, parts.owner) : null,
      ]
      if (pick) {
        return h('li', { className: selected ? 'fs-tile fs-tile-on' : 'fs-tile' },
          h('label', { className: 'fs-tile-hit' },
            h('input', {
              type: 'checkbox',
              className: 'fs-sr',
              checked: !!selected,
              'aria-label': title,
              onChange: onToggle,
            }),
            mark,
            caption))
      }
      return h('li', {
        className: 'fs-tile',
        'data-flybot': 'face-member',
        'data-mine': mine || undefined,
        'data-handle': handle,
        title,
      }, mark, caption)
    }

    const AUTO_SEND_NOTE = "Don't ask each time."

    function FaceAutoSend({ on, busy, onChange, error } = {}) {
      return h('div', { className: 'fs-face-auto-wrap', 'data-flybot': 'face-auto-send' },
        h('label', { className: 'fs-auto fs-face-auto', title: AUTO_SEND_NOTE },
          h('input', {
            type: 'checkbox',
            checked: on === true,
            disabled: !!busy,
            'aria-label': "Auto-send my Bot's room messages",
            onChange: e => onChange?.(e.target.checked),
          }),
          'Auto-send'),
        error ? h('div', { className: 'fs-status', 'data-tone': 'error', role: 'status' }, error) : null)
    }

    function FaceAutoSendControl() {
      const [on, setOn] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      useEffect(() => {
        call('social/status', {}).then(value => setOn(value?.autoApproveFaceRooms === true), () => {})
      }, [])
      const toggle = async (next) => {
        setBusy(true)
        setError('')
        try {
          const result = await call('social/face-auto', { on: next })
          setOn(result?.autoApproveFaceRooms === true)
        } catch (e) { setError(errorText(e)) }
        finally { setBusy(false) }
      }
      return h(FaceAutoSend, { on, busy, onChange: toggle, error })
    }

    const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
    const looksLikeBotId = (value) => /^bot_[a-z0-9]+$/i.test(String(value ?? '').trim())
    const looksLikeHandle = (value) => /^@[\w.-]+$/.test(String(value ?? '').trim())
    function readableParty(value, fallback = '') {
      const text = (typeof value === 'object' && value
        ? String(value.owner_display_name || value.display_name || value.handle || value.name || '')
        : String(value ?? '')).trim()
      if (!text || looksLikeBotId(text)) return fallback
      if (looksLikeHandle(text)) {
        const body = text.replace(/^@+/, '').split('.')[0]
        if (!body || looksLikeBotId(body)) return fallback
        return body.charAt(0).toUpperCase() + body.slice(1)
      }
      return text
    }
    function pendingTitle(item) {
      const from = readableParty(item.from, 'Bot')
      const to = readableParty(item.toName) || (item.kind === 'face_room_message' ? 'the room' : readableParty(item.to, 'friend'))
      return item.from || item.to || item.toName ? `${from} → ${to}` : (to || 'Outbound reply')
    }

    // Compact jump list. Approve / Reject live on the in-chat card.
    function PendingApprovals({ items, onOpen }) {
      if (!items?.length) return null
      return h('div', { className: 'fs-pending', 'data-flybot': 'pending-approvals', role: 'region', 'aria-label': 'Messages waiting for your approval' },
        h('div', { className: 'fs-label' }, 'Waiting for your approval', h('span', { className: 'fs-count' }, String(items.length))),
        items.map(item => h('button', {
          key: item.id, type: 'button', className: 'fs-pending-item', 'data-flybot': 'pending-item',
          title: oneLine(item.text || item.summary || pendingTitle(item)),
          onClick: () => onOpen?.(item),
        },
          h('span', { className: 'fs-text' },
            h('span', { className: 'fs-name' }, pendingTitle(item)),
            h('span', { className: 'fs-pending-one' }, oneLine(item.text || item.summary || ''))))))
    }

    const STOP_JOIN = /6-digit|no longer valid|Too many (failed )?attempts|signed you out/i
    function shouldStopJoin(e) {
      const code = String(e?.code ?? '')
      if (['invalid_code', 'code_void', 'locked_out', 'unauthorized', 'rate_limited'].includes(code)) return true
      return STOP_JOIN.test(String(e?.message ?? e ?? ''))
    }
    function memberIsMine(member, bots, room) {
      if (member?.remote === false) return true
      const handle = typeof member?.handle === 'object' && member.handle
        ? String(member.handle.handle ?? '')
        : String(member?.handle ?? '')
      if (!handle) return false
      if ((room?.mineHandles ?? []).includes(handle)) return true
      return (bots ?? []).some(bot => bot.handle === handle)
    }

    function faceWaitCode(room, typed) {
      const fromRoom = String(room?.joinCode || room?.code || '').replace(/\D/g, '').slice(0, 6)
      if (fromRoom.length === 6) return fromRoom
      const fromTyped = String(typed || '').replace(/\D/g, '').slice(0, 6)
      return fromTyped.length === 6 ? fromTyped : ''
    }
    function FaceWaitCode({ code } = {}) {
      const digits = String(code || '').replace(/\D/g, '').slice(0, 6)
      if (digits.length !== 6) return null
      return h('div', { className: 'fs-wait-code', 'data-flybot': 'face-wait-code', 'aria-label': `Room number ${digits}` },
        h('div', { className: 'fs-wait-code-label' }, 'Room number'),
        h('div', { className: 'fs-wait-code-digits', 'data-flybot': 'face-wait-code-digits' }, digits))
    }
    function shownHoldText(value) {
      const raw = String(value ?? '')
      const mark = 'FLYBOT-FACE-HUMAN'
      const at = raw.indexOf(mark)
      if (at < 0) return stripHoldPrefix(raw)
      const start = raw.indexOf('{', at)
      if (start < 0) return raw.slice(0, at).trim()
      let depth = 0
      let end = -1
      for (let i = start; i < raw.length; i += 1) {
        const ch = raw[i]
        if (ch === '{') depth += 1
        else if (ch === '}') {
          depth -= 1
          if (depth === 0) { end = i; break }
        }
      }
      if (end < 0) return stripHoldPrefix(raw.slice(0, at).trim())
      try {
        const parsed = JSON.parse(raw.slice(start, end + 1))
        const text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
        if (text) return stripHoldPrefix(text)
      } catch { /* fall through */ }
      return stripHoldPrefix(raw.slice(0, at).trim())
    }
    function stripHoldPrefix(text) {
      return String(text ?? '').replace(/^(to (the )?face[ -]?room|to the room)\s*:\s*/i, '').trim()
    }

    // Separate Face-to-face group screen (#92): pick Bots, join by number, live waiting room.
    function FaceToFaceGroup({ actions, onClose, roster, remoteChats } = {}) {
      const [step, setStep] = useState('setup')
      const [bots, setBots] = useState([])
      const [selected, setSelected] = useState([])
      const [code, setCode] = useState('')
      const [busy, setBusy] = useState(false)
      const [status, setStatus] = useState(null)
      const [failures, setFailures] = useState([])
      const [room, setRoom] = useState(null)
      const [tick, setTick] = useState(0)
      const opened = useRef(false)
      useEffect(() => {
        call('social/status', {}).then(value => {
          const list = value?.bots ?? []
          setBots(list)
          setSelected(current => {
            if (current.length) return current
            const main = list.find(bot => bot.isMain) ?? list[0]
            return main ? [main.id] : []
          })
        }, () => {})
      }, [])
      useEffect(() => {
        if (step !== 'waiting' || !(room?.faceRoomId || room?.roomId)) return undefined
        const faceId = room.faceRoomId
        const localId = room.roomId
        const load = () => call('social/face-rooms', { poll: true }).then(value => {
          const list = Array.isArray(value?.rooms) ? value.rooms : []
          const next = list.find(item => (faceId && item.faceRoomId === faceId) || (localId && item.roomId === localId))
          if (next) setRoom(current => current ? { ...current, ...next } : next)
        }, () => {})
        load()
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(load, 2000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [step, room?.faceRoomId, room?.roomId])
      useEffect(() => {
        if (step !== 'waiting' || room?.status !== 'candidate' || !room?.expiresAt) return undefined
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(() => setTick(n => n + 1), 1000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [step, room?.status, room?.expiresAt])
      useEffect(() => {
        if (step !== 'waiting' || room?.status !== 'open' || opened.current) return undefined
        const id = room.roomId
        if (!id || typeof actions?.openSession !== 'function') return undefined
        opened.current = true
        actions.openSession(id)
        onClose?.()
        return undefined
      }, [step, room?.status, room?.roomId])
      const join = async (event) => {
        event?.preventDefault?.()
        const digits = String(code).replace(/\D/g, '').slice(0, 6)
        if (digits.length !== 6) {
          setStatus({ tone: 'error', text: 'Enter a 6-digit number.' })
          return
        }
        if (!selected.length) {
          setStatus({ tone: 'error', text: 'Choose which of your Bots join.' })
          return
        }
        setBusy(true)
        setStatus(null)
        setFailures([])
        const mine = []
        const failed = []
        let last
        for (const botId of selected) {
          const bot = bots.find(item => item.id === botId)
          try {
            const result = await call('social/face-join', { code: digits, botId })
            last = result
            if (result?.joinedAs?.handle) mine.push(result.joinedAs.handle)
          } catch (e) {
            failed.push({ botId, name: bot?.name || 'Bot', text: errorText(e) })
            if (shouldStopJoin(e) && !last) {
              setStatus({ tone: 'error', text: errorText(e) })
              setFailures(failed)
              setBusy(false)
              return
            }
            if (shouldStopJoin(e)) break
          }
        }
        setFailures(failed)
        if (!last) {
          setStatus({ tone: 'error', text: failed[0]?.text || 'Could not join that room. Try another number.' })
          setBusy(false)
          return
        }
        setRoom({ ...last, mineHandles: mine, joinCode: last.joinCode || digits })
        setStep('waiting')
        setBusy(false)
      }
      const enter = async () => {
        if (!room || opened.current) return
        setBusy(true)
        setStatus(null)
        try {
          let next = room
          if (room.status === 'candidate') {
            next = await call('social/face-start', { roomId: room.roomId, faceRoomId: room.faceRoomId })
            setRoom(current => current ? { ...current, ...next, status: 'open' } : { ...next, status: 'open' })
          }
          const id = next?.roomId || room.roomId
          opened.current = true
          if (id && typeof actions?.openSession === 'function') actions.openSession(id)
          onClose?.()
        } catch (e) {
          setStatus({ tone: 'error', text: errorText(e) })
        } finally { setBusy(false) }
      }
      const leave = async () => {
        setBusy(true)
        setStatus(null)
        try {
          if (room?.faceRoomId || room?.roomId) {
            await call('social/face-leave', { roomId: room.roomId, faceRoomId: room.faceRoomId })
          }
          onClose?.()
        } catch (e) {
          setStatus({ tone: 'error', text: errorText(e) })
        } finally { setBusy(false) }
      }
      const toggle = (id) => {
        setSelected(list => list.includes(id) ? list.filter(item => item !== id) : [...list, id])
      }
      const members = room?.members ?? []
      const candidate = room?.status === 'candidate'
      const waiting = step === 'waiting' && room
      return h('div', { className: 'fs-dialog-back', 'data-flybot': 'face-group', role: 'dialog', 'aria-label': 'Face-to-face group' },
        h('div', { className: 'fs-dialog' },
          h('div', { className: 'fs-dialog-head' },
            h('div', { className: 'fs-name' }, 'Face-to-face group'),
            h('button', { type: 'button', className: 'fs-btn fs-btn-sm', onClick: () => onClose?.() }, 'Close')),
          waiting ? h('div', { className: 'fs-wait', 'data-flybot': 'face-wait' },
            h(FaceWaitCode, { code: faceWaitCode(room, code) }),
            h('div', { className: 'fs-hint fs-wait-count', 'data-flybot': 'face-wait-count', 'data-tick': tick }, candidate
              ? (room.expiresAt ? countdown(room.expiresAt) : 'Anyone with the number can still join.')
              : 'The room is open. The number is no longer valid.'),
            h('div', { className: 'fs-wait-body' },
              h('ul', { className: 'fs-tiles fs-wait-roster', 'data-flybot': 'face-wait-roster', 'aria-label': 'Who has joined' },
                members.map(member => h(FaceTile, {
                  key: member.handle || member.id,
                  bot: faceLook({ roster, remoteChats, bots, member }),
                  member,
                  handle: member.handle,
                  mine: memberIsMine(member, bots, room),
                }))),
              members.length === 0 ? h('div', { className: 'fs-hint' }, 'Waiting for others to join…') : null,
              failures.length ? h('div', { className: 'fs-status', 'data-tone': 'error', 'data-flybot': 'face-join-fail', role: 'status' },
                failures.map(item => `${item.name}: ${item.text}`).join(' ')) : null,
              status ? h('div', { className: 'fs-status', 'data-tone': status.tone, role: 'status' }, status.text) : null),
            h('div', { className: 'fs-wait-foot', 'data-flybot': 'face-wait-foot' },
              h('button', { type: 'button', className: 'fs-btn', 'data-flybot': 'face-leave', disabled: !!busy, onClick: leave }, 'Leave'),
              h('button', {
                type: 'button', className: 'fs-btn fs-btn-primary', 'data-flybot': 'face-enter',
                disabled: !!busy || !room.roomId, onClick: enter,
              }, 'Enter chat'))) : h('form', { onSubmit: join, 'data-flybot': 'face-join' },
            h('div', { className: 'fs-hint' }, "Choose which of your Bots to bring, then type the same 6-digit number as the people next to you. You'll wait together until someone enters the chat."),
            h('ul', { className: 'fs-tiles fs-pick', 'data-flybot': 'face-pick', 'aria-label': 'Your Bots' },
              bots.map(bot => h(FaceTile, {
                key: bot.id,
                bot: faceLook({ roster, local: bot }),
                name: bot.name,
                pick: true,
                selected: selected.includes(bot.id),
                onToggle: () => toggle(bot.id),
              }))),
            bots.length === 0 ? h('div', { className: 'fs-hint' }, 'Loading your Bots…') : null,
            h('div', { className: 'fs-hint', 'data-flybot': 'face-join-room' },
              'Available to this room only. Friends cannot see these Bots unless you invite them.'),
            h('div', { className: 'fs-line' },
              h('input', {
                className: 'fs-digits', value: code, inputMode: 'numeric', autoComplete: 'off', maxLength: 6,
                placeholder: '000000', 'aria-label': '6-digit room number',
                onChange: e => setCode(String(e.target.value).replace(/\D/g, '').slice(0, 6)),
              }),
              h('button', {
                type: 'submit', className: 'fs-btn',
                disabled: busy || String(code).replace(/\D/g, '').length !== 6 || !selected.length,
              }, 'Join')),
            failures.length ? h('div', { className: 'fs-status fs-fail', 'data-tone': 'error', 'data-flybot': 'face-join-fail', role: 'status' },
              failures.map(item => `${item.name}: ${item.text}`).join(' ')) : null,
            status ? h('div', { className: 'fs-status', role: 'status', 'data-tone': status.tone }, status.text) : null)))
    }

    function faceChip(room) {
      if (room.status === 'closed') return 'closed'
      if (room.status === 'left') return 'left'
      if (room.status === 'candidate') {
        if (!room.expiresAt) return 'joining'
        const at = Date.parse(room.expiresAt)
        if (!Number.isFinite(at)) return 'joining'
        const left = Math.max(0, at - Date.now())
        if (left <= 0) return 'ended'
        const minutes = Math.ceil(left / 60_000)
        if (minutes >= 1) return `${minutes}m`
        return `${Math.max(1, Math.ceil(left / 1000))}s`
      }
      return 'open'
    }
    function shownFaceTitle(room) {
      const named = String(room?.name || '').trim()
      if (named && named !== 'Face-to-face room') return named
      const owners = []
      const seen = new Set()
      for (const member of room?.members ?? []) {
        const owner = String(member.ownerName || member.owner_name || '').trim()
        const key = owner.toLowerCase()
        if (!owner || seen.has(key)) continue
        seen.add(key)
        owners.push(owner)
      }
      const code = String(room?.joinCode || room?.code || '').replace(/\D/g, '').slice(0, 6)
      const bits = ['Face-to-face']
      if (owners.length) bits.push(owners.slice(0, 3).join(', '))
      if (code.length === 6) bits.push(code)
      else {
        const at = Date.parse(room?.startedAt || room?.expiresAt || '')
        const when = Number.isFinite(at) ? new Date(at) : new Date()
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        bits.push(`${months[when.getMonth()]} ${when.getDate()} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`)
      }
      return bits.join(' · ')
    }
    function FaceRoomCard({ room, actions, onChange, roster, remoteChats, past } = {}) {
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState(null)
      const run = async (label, fn) => {
        setBusy(label)
        setNote(null)
        try {
          await fn()
          onChange?.()
        } catch (e) { setNote({ tone: 'error', text: errorText(e) }) }
        finally { setBusy('') }
      }
      const members = room.members ?? []
      const shown = members.slice(0, 3)
      const extra = Math.max(0, members.length - shown.length)
      const look = (m) => (m.remote === false || m.id && roster?.byId?.[m.id]
        ? faceLook({ roster, local: roster?.byId?.[m.id] || { id: m.id, name: m.displayName } })
        : faceLook({ roster, remoteChats, member: m }))
      const open = () => { if (room.roomId) actions?.openSession?.(room.roomId) }
      return h('div', { className: 'fs-face-item', 'data-flybot': 'face-room', 'data-status': room.status, 'data-past': past || undefined },
        h('div', {
          className: 'fs-face-row',
          'data-open': room.roomId ? true : undefined,
          onClick: room.roomId ? open : undefined,
        },
          h('span', { className: 'fs-stack', 'aria-label': 'Members' },
            shown.map(m => h('span', { key: m.handle || m.id, 'data-flybot': 'face-card-member', 'data-handle': m.handle },
              h(FaceAvatar, { bot: look(m), size: 20 }))),
            extra ? h('span', { className: 'fs-stack-more' }, `+${extra}`) : null),
          h('span', { className: 'fs-name' }, shownFaceTitle(room)),
          h('span', { className: 'fs-chip', 'data-flybot': 'face-status' }, faceChip(room)),
          h('span', { className: 'fs-face-actions', onClick: event => event.stopPropagation() },
            past
              ? h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: !!busy || !room.roomId, onClick: open }, 'Open')
              : h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: !!busy, onClick: () => run('leave', () => call('social/face-leave', { roomId: room.roomId, faceRoomId: room.faceRoomId })) }, 'Leave'))),
        note ? h('div', { className: 'fs-status', 'data-tone': note.tone }, note.text) : null)
    }

    const WAITING_OWNER = 'Waiting for approval'
    const WAITING_OTHERS = "Waiting for the owner's approval"

    function holdParties(item) {
      const from = readableParty(item?.from, 'Bot')
      const to = readableParty(item?.toName) || (item?.kind === 'face_room_message' ? 'the room' : readableParty(item?.to, 'friend'))
      return { from, to }
    }
    const autoSendToast = (from, to) => `Auto-send on for ${from} → ${to}. Change it anytime in settings.`
    function homeOfHandle(value) {
      const raw = typeof value === 'object' && value
        ? String(value.handle ?? value.home ?? '')
        : String(value ?? '')
      const body = raw.trim().replace(/^@+/, '').toLowerCase()
      if (!body) return ''
      const parts = body.split('.')
      if (parts.length >= 2 && parts.at(-1) === 'home') return `@${parts.at(-2)}.home`
      return `@${body}`
    }

    function ChatApproval({ item, canDecide = true, busy, onDecide } = {}) {
      const [open, setOpen] = useState(false)
      if (!item) return null
      if (item.status === 'approved' || item.status === 'rejected') {
        return h('div', { className: 'fs-hold fs-chat-approval', 'data-flybot': 'chat-approval', 'data-state': item.status, role: 'status' },
          h('div', { className: 'fs-name' }, item.status === 'approved' ? 'Approved' : 'Rejected'))
      }
      if (canDecide !== true) {
        return h('div', { className: 'fs-hold fs-chat-approval', 'data-flybot': 'chat-approval', 'data-role': 'other', role: 'status' },
          h('div', { className: 'fs-name' }, WAITING_OTHERS))
      }
      const { from, to } = holdParties(item)
      const text = shownHoldText(item.text || item.summary || '')
      const long = text.length > 160 || text.split(/\n/).length > 3
      return h('div', { className: 'fs-hold fs-chat-approval', 'data-flybot': 'chat-approval', 'data-role': 'owner', role: 'region', 'aria-label': WAITING_OWNER },
        h('div', { className: 'fs-label' }, WAITING_OWNER),
        item.from || item.to || item.toName || item.kind === 'face_room_message'
          ? h('div', { className: 'fs-sub' }, `${from} → ${to}`)
          : null,
        text ? h('div', { className: 'fs-draft', 'data-clamp': !open && long ? true : undefined }, text) : null,
        long ? h('button', {
          type: 'button', className: 'fs-hold-more', 'data-flybot': 'hold-expand',
          onClick: () => setOpen(value => !value),
        }, open ? 'Show less' : 'Show more') : null,
        h('div', { className: 'fs-actions fs-chat-actions' },
          h('button', { type: 'button', className: 'fs-btn fs-btn-sm fs-btn-primary', disabled: !!busy, onClick: () => onDecide?.(item, 'approve') }, 'Approve'),
          h('button', { type: 'button', className: 'fs-hold-always', 'data-flybot': 'hold-always', disabled: !!busy, onClick: () => onDecide?.(item, 'always') }, 'Always approve'),
          h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: !!busy, onClick: () => onDecide?.(item, 'reject') }, 'Reject')))
    }

    function approvalsForOpenChat(items, { sessionId, room, bot } = {}) {
      const list = Array.isArray(items) ? items : []
      const handle = bot?.remote?.handle
      const faceId = room?.face?.roomId
      const face = room?.origin === 'face-to-face' || Boolean(faceId)
      const handles = new Set((room?.participants ?? []).map(p => p.handle).filter(Boolean))
      if (handle) handles.add(handle)
      return list.filter(item => {
        if (item.kind === 'face_room_message') {
          if (faceId && (!item.roomId || item.roomId === faceId)) return true
          if (room?.id && item.roomId === room.id) return true
          return Boolean(face && !item.roomId)
        }
        if (faceId && item.roomId === faceId) return true
        if (room?.id && item.roomId === room.id) return true
        if (item.roomId) return false
        if (item.to && handles.has(item.to)) return true
        if (sessionId && item.sessionId === sessionId) return true
        return false
      })
    }

    function localHoldView(approval) {
      if (!approval?.id) return undefined
      const to = approval.targetName ?? (typeof approval.request?.to === 'object' ? approval.request.to.handle : approval.request?.to)
      const composer = approval.request?.via === 'composer'
      return {
        id: approval.id,
        source: 'local',
        from: composer ? 'You' : approval.senderName,
        to,
        toName: approval.targetName || to,
        text: approval.request?.text || approval.reason,
        roomId: approval.request?.meta?.roomId || approval.request?.to,
        sessionId: approval.request?.meta?.sessionId,
      }
    }
    function ChatApprovalDock({ sessionId, roster, room, bot, actions } = {}) {
      useStyles()
      const [items, setItems] = useState([])
      const [local, setLocal] = useState([])
      const [busy, setBusy] = useState('')
      const load = () => {
        call('social/status', {}).then(value => {
          setItems(Array.isArray(value?.approvals) ? value.approvals : [])
        }, () => {})
        call('approvals', { status: ['pending', 'failed'] }).then(list => {
          setLocal((Array.isArray(list) ? list : []).map(localHoldView).filter(Boolean))
        }, () => {})
      }
      useEffect(() => {
        load()
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(load, 5000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [])
      const session = { sessionId, roster, room, bot, handle: bot?.remote?.handle }
      const mine = [
        ...approvalsForOpenChat(items, session),
        ...approvalsForOpenChat(local, session),
      ]
      const waitingOthers = mine.length === 0 && (room?.pendingCount ?? 0) > 0
      if (!mine.length && !waitingOthers) return null
      const decide = async (item, decision) => {
        setBusy(item.id)
        try {
          const always = decision === 'always'
          const mapped = always || decision === 'approve' || decision === 'approved' ? 'approve' : decision
          if (item.source === 'local') {
            await call('decide', { id: item.id, decision: mapped })
            if (always) {
              if (item.kind === 'face_room_message' || room?.origin === 'face-to-face') await call('social/face-auto', { on: true })
              else {
                const home = item.home || homeOfHandle(item.to)
                if (home) await call('social/auto-accept', { home, on: true })
              }
            }
          } else {
            await call('social/decide-approval', { approvalId: item.id, decision: mapped, ...(always ? { always: true } : {}) })
          }
          const status = mapped === 'reject' || mapped === 'rejected' ? 'rejected' : 'approved'
          const mark = list => list.map(entry => entry.id === item.id ? { ...entry, status } : entry)
          setItems(mark)
          setLocal(mark)
          if (always && status === 'approved') {
            const { from, to } = holdParties(item)
            actions?.notify?.(autoSendToast(from, to))
          }
        } finally { setBusy('') }
      }
      const approveAll = async () => {
        for (const item of mine.filter(entry => !entry.status)) await decide(item, 'approve')
      }
      if (waitingOthers) {
        return h('div', { 'data-flybot': 'chat-approvals' },
          h(ChatApproval, { item: { id: 'waiting' }, canDecide: false }))
      }
      return h('div', { 'data-flybot': 'chat-approvals' },
        mine.length > 1 && mine.some(entry => !entry.status)
          ? h('div', { className: 'fs-chat-actions' },
            h('button', { type: 'button', className: 'fs-btn fs-btn-sm', 'data-flybot': 'approve-all', disabled: !!busy, onClick: approveAll }, 'Approve all'))
          : null,
        mine.map(item => h(ChatApproval, {
          key: item.id, item, canDecide: true, busy: busy === item.id, onDecide: decide,
        })))
    }

    function FriendBotRow({ bot, chat, renderBot, busy, onRemove }) {
      const [menu, setMenu] = useState(false)
      const label = busy ? 'Removing…' : 'Remove this Bot'
      return h('div', {
        className: 'fs-row-wrap',
        'data-flybot': 'friend-bot',
        'data-handle': bot.handle,
        onContextMenu: (event) => { event?.preventDefault?.(); setMenu(true) },
      },
        chat && typeof renderBot === 'function'
          ? renderBot(chat)
          : h('div', { className: 'fs-row', title: bot.handle },
            h(FaceAvatar, { bot: faceLook({ member: { handle: bot.handle, displayName: bot.name, color: bot.color, avatar: bot.avatar } }), size: 24 }),
            h('span', { className: 'fs-text' }, h('span', { className: 'fs-name' }, bot.name), h('span', { className: 'fs-sub' }, bot.handle))),
        h('button', {
          type: 'button',
          className: 'fs-remove',
          'data-flybot': 'remove-friend-bot',
          title: 'Remove this Bot from Friends\' Bots and from your groups. This does not unfriend the owner.',
          'aria-label': label,
          'aria-busy': busy || undefined,
          disabled: !!busy,
          onClick: (event) => { event?.stopPropagation?.(); onRemove?.(bot) },
        }, busy ? '…' : '×'),
        menu ? h('div', { className: 'fs-menu', role: 'menu', 'data-flybot': 'friend-bot-menu' },
          h('button', { type: 'button', role: 'menuitem', onClick: () => { setMenu(false); onRemove?.(bot) } }, 'Remove this Bot')) : null)
    }

    function countdown(expiresAt) {
      const at = Date.parse(expiresAt)
      if (!Number.isFinite(at)) return 'Anyone with the number can still join'
      const left = Math.max(0, at - Date.now())
      if (left <= 0) return 'Joining has ended'
      const minutes = Math.ceil(left / 60_000)
      if (minutes >= 2) return `${minutes} minutes left to join`
      const seconds = Math.max(1, Math.ceil(left / 1000))
      return seconds === 1 ? '1 second left to join' : `${seconds} seconds left to join`
    }

    const isPastFace = (room) => {
      if (!room) return false
      if (room.status === 'closed' || room.status === 'left') return true
      return faceChip(room) === 'ended'
    }
    function uniqueFaceRooms(list) {
      const seen = new Set()
      const out = []
      for (const room of Array.isArray(list) ? list : []) {
        const id = room?.faceRoomId || room?.roomId
        if (id) {
          if (seen.has(id)) continue
          seen.add(id)
        }
        out.push(room)
      }
      return out
    }
    function FaceRooms({ actions, enabled = true, roster, remoteChats } = {}) {
      const [rooms, setRooms] = useState([])
      const [pastOpen, setPastOpen] = useState(false)
      const unique = uniqueFaceRooms(rooms)
      const past = unique.filter(isPastFace)
      const load = (poll = true) => call('social/face-rooms', { poll }).then(value => {
        setRooms(Array.isArray(value?.rooms) ? value.rooms : [])
      }, () => {})
      useEffect(() => {
        if (!enabled) return undefined
        load(true)
        if (typeof setInterval !== 'function') return undefined
        const tick = () => {
          if (typeof document !== 'undefined' && document.hidden) return
          load(true)
        }
        const timer = setInterval(tick, 5000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [enabled])
      if (!past.length) return null
      const card = (room, folded) => h(FaceRoomCard, {
        key: room.faceRoomId || room.roomId, room, past: folded, actions, onChange: () => load(true), roster, remoteChats,
      })
      return h('div', { 'data-flybot': 'face-rooms' },
        h('div', { className: 'fs-past', 'data-flybot': 'face-past' },
          h('button', { type: 'button', className: 'fs-past-head', 'aria-expanded': pastOpen, onClick: () => setPastOpen(open => !open) },
            h('span', { className: 'fs-chev', 'aria-hidden': true, 'data-closed': pastOpen ? undefined : true }, '▾'),
            'Past rooms',
            h('span', { className: 'fs-count' }, String(past.length))),
          pastOpen ? past.map(room => card(room, true)) : null))
    }

    function FaceRoomOverview({ room, roster, actions } = {}) {
      useStyles()
      const face = room?.origin === 'face-to-face' ? room.face : undefined
      if (room?.origin !== 'face-to-face') return null
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState(null)
      const [tick, setTick] = useState(0)
      const [snapshot, setSnapshot] = useState(null)
      const candidate = (snapshot?.status || face?.status) === 'candidate'
      const live = candidate || (snapshot?.status || face?.status) === 'open'
      useEffect(() => {
        if (!live && face?.status !== 'candidate' && face?.status !== 'open') return undefined
        const load = () => call('social/face-rooms', { poll: true }).then(value => {
          const list = Array.isArray(value?.rooms) ? value.rooms : []
          const next = list.find(item => (face?.roomId && item.faceRoomId === face.roomId) || item.roomId === room.id)
          if (next) setSnapshot(next)
        }, () => {})
        load()
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(load, 3000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [live, face?.roomId, room?.id])
      useEffect(() => {
        const expiresAt = snapshot?.expiresAt || face?.expiresAt
        if (!candidate || !expiresAt) return undefined
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(() => setTick(n => n + 1), 1000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [candidate, snapshot?.expiresAt, face?.expiresAt])
      const run = async (label, fn) => {
        setBusy(label)
        setNote(null)
        try { await fn() } catch (e) { setNote({ tone: 'error', text: errorText(e) }) }
        finally { setBusy('') }
      }
      const members = snapshot?.members
        ?? (room.presentedParticipants ?? room.participants ?? []).filter(p => p.leftSeq === undefined)
      const expiresAt = snapshot?.expiresAt || face?.expiresAt
      if (candidate) {
        return h('div', { className: 'fs-wait-overview', 'data-flybot': 'face-overview', 'data-wait': true },
          h(FaceWaitCode, { code: faceWaitCode(snapshot || face || room) }),
          h('div', { className: 'fs-hint fs-wait-count', 'data-tick': tick, 'data-flybot': 'face-wait-count' },
            expiresAt ? countdown(expiresAt) : 'Anyone with the number can still join.'),
          h('ul', { className: 'fs-tiles fs-wait-roster', 'data-flybot': 'face-wait-roster', 'aria-label': 'Who has joined' },
            members.map(member => h(FaceTile, {
              key: member.handle || member.id,
              bot: faceLook({ roster, member }),
              member,
              handle: member.handle,
              mine: member.remote === false || Boolean(member.id && roster?.byId?.[member.id]),
            }))),
          members.length === 0 ? h('div', { className: 'fs-hint' }, 'Waiting for others to join…') : null,
          h('div', { className: 'fs-wait-foot', 'data-flybot': 'face-wait-foot' },
            h('button', {
              type: 'button', className: 'fs-btn', 'data-flybot': 'face-leave', disabled: !!busy,
              onClick: () => run('leave', () => call('social/face-leave', { roomId: room.id, faceRoomId: face?.roomId })),
            }, 'Leave'),
            h('button', {
              type: 'button', className: 'fs-btn fs-btn-primary', 'data-flybot': 'face-enter', disabled: !!busy,
              onClick: () => run('start', async () => {
                await call('social/face-start', { roomId: room.id, faceRoomId: face?.roomId })
                if (room.id && typeof actions?.openSession === 'function') actions.openSession(room.id)
              }),
            }, 'Enter chat')),
          note ? h('div', { className: 'fs-status', 'data-tone': note.tone }, note.text) : null)
      }
      return h('div', { className: 'fs-face-row', 'data-flybot': 'face-overview' },
        h('span', { className: 'fs-chip' }, faceChip({ status: snapshot?.status || face?.status || 'open' })),
        h(FaceAutoSendControl),
        h('span', { className: 'fs-face-actions' },
          h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: !!busy, onClick: () => run('leave', () => call('social/face-leave', { roomId: room.id, faceRoomId: face?.roomId })) }, 'Leave')),
        note ? h('div', { className: 'fs-status', 'data-tone': note.tone }, note.text) : null)
    }

    function makeOpener() {
      let handler = null
      let pending = false
      return {
        open() {
          if (handler) handler()
          else pending = true
        },
        bind(fn) {
          handler = fn
          if (pending) { pending = false; fn() }
          return () => { if (handler === fn) handler = null }
        },
      }
    }
    const facePanel = makeOpener()
    const addFriendPanel = makeOpener()
    const openFaceToFace = () => facePanel.open()
    const openAddFriend = () => addFriendPanel.open()

    function FriendsBots({ remoteChats, actions, roster } = {}) {
      useStyles()
      const [error, setError] = useState('')
      const [adding, setAdding] = useState(false)
      const [faceOpen, setFaceOpen] = useState(false)
      const loadApprovals = () => call('social/status', {}).then(() => {
        setError('')
      }, e => setError(errorText(e)))
      useEffect(() => {
        loadApprovals()
        if (typeof setInterval !== 'function') return undefined
        const tick = () => {
          if (typeof document !== 'undefined' && document.hidden) return
          loadApprovals()
        }
        const timer = setInterval(tick, 15_000)
        timer?.unref?.()
        return () => clearInterval(timer)
      }, [])
      useEffect(() => facePanel.bind(() => setFaceOpen(true)), [])
      useEffect(() => addFriendPanel.bind(() => setAdding(true)), [])
      const unavailable = String(error).startsWith('Social is not running:')
      if (unavailable) {
        return h('section', { className: 'fs bt-social', 'aria-label': 'Social' },
          h('div', { className: 'fs-empty', 'data-flybot': 'social-unavailable' }, error))
      }
      return h('section', { className: 'fs bt-social', 'aria-label': 'Social' },
        error ? h('div', { className: 'fs-status', 'data-tone': 'error', style: { padding: '4px 10px' } }, error) : null,
        h(FaceRooms, { actions, enabled: true, roster, remoteChats }),
        adding ? h(AddFriend, { onChange: loadApprovals, onDone: () => setAdding(false) }) : null,
        faceOpen ? h(FaceToFaceGroup, { actions, roster, remoteChats, onClose: () => setFaceOpen(false) }) : null)
    }

    // Add friend: join a friend's link and answer requests (invites are made from a Bot's right-click menu).
    function AddFriend({ onChange, onDone } = {}) {
      const [overview, setOverview] = useState(null)
      const [code, setCode] = useState('')
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)
      // Which of my Bots joins: the friend sees and reaches only that one (default: the Main Bot).
      const [mine, setMine] = useState([])
      const [joiner, setJoiner] = useState('')
      const refresh = () => call('social/overview', {}).then(setOverview, e => setStatus({ tone: 'error', text: errorText(e) }))
      useEffect(() => {
        refresh()
        call('social/status', {}).then(value => {
          const bots = value?.bots ?? []
          setMine(bots)
          setJoiner(current => current || (bots.find(bot => bot.isMain) ?? bots[0])?.id || '')
        }, () => {})
      }, [])
      const run = async (label, fn) => {
        setBusy(true)
        setStatus(null)
        try {
          const message = await fn()
          if (message) setStatus({ tone: 'ok', text: message })
          await refresh()
          onChange?.()
        } catch (e) {
          const text = errorText(e)
          setStatus({ tone: 'error', text: /already used|already friends/i.test(text) ? text : `${label} failed: ${text}` })
        } finally {
          setBusy(false)
        }
      }
      const mint = () => run('Invite', async () => {
        const botId = joiner || mine.find(bot => bot.isMain)?.id || mine[0]?.id
        if (!botId) throw new Error('Choose one of your Bots to invite a friend to')
        const invite = await call('social/create-invite', { botId })
        const link = invite?.link || invite?.url
        if (!link) throw new Error('The invite came back without its link')
        const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
        if (clip?.writeText) {
          try {
            await clip.writeText(link)
            return 'Invite link copied. Send it to a friend.'
          } catch {
            return `Could not copy. Link: ${link}`
          }
        }
        return `Invite link: ${link}`
      })
      const join = e => {
        e.preventDefault()
        return run('Joining', async () => {
          const r = await call('social/join-invite', { code, ...(joiner ? { botId: joiner } : {}) })
          setCode('')
          const who = r.inviterName ?? r.inviter ?? 'Your friend'
          const shared = r.inviterBotName || r.sharedBot
          if (r.status === 'active') return shared ? `${who} shared ${shared} with you.` : `${who} shared a Bot with you.`
          return `Request sent to ${who}. They show up here once they accept.`
        })
      }
      const respond = (item, decision) => run(decision === 'accept' ? 'Accepting' : 'Declining', async () => {
        await call('social/respond', { relationshipId: item.relationshipId, decision })
        return decision === 'accept' ? `${item.name ?? item.handle} is now a friend.` : `Declined ${item.name ?? item.handle}.`
      })
      const incoming = overview?.incoming ?? []
      const outgoing = overview?.outgoing ?? []
      return h('div', { className: 'bt-social-add', 'data-flybot': 'add-friend' },
        h('div', { className: 'fs-face-head' },
          h('div', { className: 'fs-label' }, 'Add friend'),
          onDone ? h('button', { type: 'button', className: 'fs-btn fs-btn-sm', onClick: onDone }, 'Done') : null),
        h('div', { className: 'fs-line', style: { padding: '4px 10px 0' } },
          h('button', { type: 'button', className: 'fs-btn', 'data-flybot': 'mint-invite', disabled: busy, onClick: mint }, 'Copy invite link')),
        h('div', { className: 'fs-hint', 'data-flybot': 'invite-hint' }, 'Or paste a friend’s invite below.'),
        h('form', { onSubmit: join, className: 'fs-card bt-social-join' },
          h('div', { className: 'fs-hint' }, 'Got a link from a friend?'),
          h('div', { className: 'fs-line' },
            h('input', { className: 'fs-input', value: code, placeholder: 'Paste invite link or code', 'aria-label': 'Invite link or code', onChange: e => setCode(e.target.value) }),
            h('button', { type: 'submit', className: 'fs-btn', disabled: busy || !code.trim() }, 'Join')),
          mine.length ? h('label', { className: 'fs-line fs-hint fs-join-as', 'data-flybot': 'join-as' },
            h('span', { className: 'fs-join-as-label', 'data-flybot': 'talk-through' }, 'Talk through '),
            h('select', { className: 'fs-input', value: joiner, 'aria-label': 'Which of your Bots talks', onChange: e => setJoiner(e.target.value) },
              mine.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name))),
            ' (not shared unless you invite them to it)') : null),
        status ? h('div', { className: 'fs-status', role: 'status', 'data-tone': status.tone, style: { padding: '2px 10px' } }, status.text) : null,
        incoming.length ? h('div', { className: 'bt-social-requests' },
          h('div', { className: 'fs-label' }, 'Friend requests', h('span', { className: 'fs-count' }, String(incoming.length))),
          incoming.map(item => h('div', { key: item.relationshipId, className: 'fs-row bt-social-row' },
            h(FaceAvatar, { bot: faceLook({ member: { handle: item.handle, displayName: item.name } }), size: 24 }),
            h('span', { className: 'fs-text' },
              h('span', { className: 'fs-name' }, item.name ?? item.handle),
              h('span', { className: 'fs-sub' }, item.handle),
              item.message ? h('span', { className: 'fs-sub fs-msg' }, item.message) : null),
            h('span', { className: 'fs-actions' },
              h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: busy, onClick: () => respond(item, 'accept') }, 'Accept'),
              h('button', { type: 'button', className: 'fs-btn fs-btn-sm', disabled: busy, onClick: () => respond(item, 'decline') }, 'Decline'))))) : null,
        outgoing.length ? h('div', { className: 'bt-social-outgoing' },
          h('div', { className: 'fs-label' }, 'Waiting for them to accept'),
          outgoing.map(item => h('div', { key: item.relationshipId ?? item.handle, className: 'fs-row' },
            h(FaceAvatar, { bot: faceLook({ member: { handle: item.handle, displayName: item.name } }), size: 24 }),
            h('span', { className: 'fs-text' },
              h('span', { className: 'fs-name' }, item.name ?? item.handle),
              item.name ? h('span', { className: 'fs-sub' }, item.handle) : null),
            h('span', { className: 'fs-tag' }, 'pending')))) : null)
    }

    // Which local Bots can be invited to (social/status), cached for the synchronous canInvite.
    let status = { at: 0, value: null }
    let statusTask
    const statusListeners = new Set()
    const loadStatus = () => {
      statusTask ??= call('social/status', {}).then(value => {
        const changed = JSON.stringify(value) !== JSON.stringify(status.value)
        status = { at: Date.now(), value }
        if (changed) for (const fn of [...statusListeners]) { try { fn() } catch (error) { console.error('flybot-social: status listener failed', error) } }
        return value
      }).finally(() => { statusTask = undefined })
      return statusTask
    }
    // Fires when what canInvite answers may have changed (first status, connect/disconnect, Bots added).
    const onStatusChange = (fn) => { statusListeners.add(fn); return () => statusListeners.delete(fn) }
    // Sync: true when Bot Social is connected and botId is one of this team's Bots. Until the first
    // status answer it is false (and starts loading); the cache refreshes every 30 s.
    function canInvite(botId) {
      if (Date.now() - status.at > 30_000) void loadStatus().catch(() => {})
      return Boolean(status.value?.connected && status.value.bots.some(bot => bot.id === botId))
    }

    const ACCESS_NOTE = 'Each grant is this Bot to one person. Accepting Invite to this Bot creates a grant. Revoke one person without touching the others. Default: nobody, including for the Chief.'
    function ManageAccess({ bot }) {
      const [view, setView] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const load = async () => {
        if (!bot?.id) return
        try {
          setView(await call('social/access', { botId: bot.id }))
          setError('')
        } catch (e) { setError(errorText(e)) }
      }
      useEffect(() => { void load() }, [bot?.id])
      if (!bot?.id) return null
      const revoke = async (grant) => {
        setBusy(grant.id)
        setError('')
        try {
          setView(await call('social/revoke-grant', { botId: bot.id, grantId: grant.id, relationshipId: grant.relationshipId, grantee: grant.grantee }))
          const next = await call('social/access', { botId: bot.id })
          setView(next)
        } catch (e) { setError(errorText(e)) }
        finally { setBusy('') }
      }
      const grants = view?.grants ?? []
      return h('div', { className: 'fs fs-card', 'data-flybot': 'manage-access' },
        h('div', { className: 'fs-name' }, 'Manage access'),
        h('div', { className: 'fs-hint fs-face-note' }, ACCESS_NOTE),
        grants.length === 0 ? h('div', { className: 'fs-hint' }, 'Nobody has this Bot yet. Invite a friend to grant it.') : null,
        grants.map(grant => h('div', { key: grant.id || grant.grantee, className: 'fs-line', 'data-flybot': 'access-grant' },
          h('div', { className: 'fs-col' },
            h('span', { className: 'fs-name' }, grant.name || grant.grantee),
            grant.home && grant.name && !String(grant.name).includes(grant.home)
              ? h('span', { className: 'fs-sub' }, grant.home)
              : null,
            (grant.rooms ?? []).length ? h('span', { className: 'fs-hint' }, `In use: ${(grant.rooms ?? []).map(room => room.name || room.id).join(', ')}`) : null),
          h('button', {
            type: 'button', className: 'fs-btn', disabled: Boolean(busy),
            'data-flybot': 'revoke-grant', 'aria-label': `Revoke ${grant.name || grant.grantee}`,
            onClick: () => revoke(grant),
          }, busy === grant.id ? 'Revoking…' : 'Revoke'))),
        (view?.rooms ?? []).filter(room => room.origin === 'face-to-face').length
          ? h('div', { className: 'fs-hint' }, `This room only: ${(view.rooms ?? []).filter(room => room.origin === 'face-to-face').map(room => room.name || room.id).join(', ')}`)
          : null,
        error ? h('div', { className: 'fs-status', 'data-tone': 'error', role: 'status' }, error) : null)
    }

    function FriendChatSettings({ bot, actions } = {}) {
      const remote = bot?.remote
      const home = remote?.home
      const handle = remote?.handle
      const [auto, setAuto] = useState(false)
      const [saving, setSaving] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      useEffect(() => {
        if (!home) return undefined
        call('social/settings', {}).then(value => setAuto(value?.autoAccept?.[home] === true), () => {})
      }, [home])
      if (!handle) return null
      const toggleAuto = async (on) => {
        if (!home) return
        setSaving(true)
        setAuto(on)
        setError('')
        try {
          const result = await call('social/auto-accept', { home, on })
          setAuto(result?.autoAccept === true)
        } catch (e) {
          setError(errorText(e))
          setAuto(!on)
        } finally { setSaving(false) }
      }
      const removeBot = async () => {
        const who = remote.homeName || remote.owner || home || 'Your friend'
        const ask = typeof globalThis.confirm === 'function' ? globalThis.confirm : undefined
        if (ask && !ask(`Remove ${bot.name}? ${who} can share it again.`)) return
        setBusy(true)
        setError('')
        try {
          // social/hide-remote already leaves every room holding this Bot; a second
          // removal from here would race it and show "not in the room" after a good Remove.
          await call('social/hide-remote', { handle })
          actions?.closeSettings?.()
          actions?.closeOverlay?.()
        } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
      }
      return h('div', { className: 'fs fs-card fs-friend-settings', 'data-flybot': 'friend-chat-settings' },
        h('label', { className: 'fs-auto', title: AUTO_SEND_NOTE, 'data-flybot': 'friend-auto-send' },
          h('input', { type: 'checkbox', checked: auto === true, disabled: saving || !home, onChange: e => toggleAuto(e.target.checked) }),
          'Auto-send'),
        h('button', {
          type: 'button',
          className: 'fs-link',
          'data-flybot': 'remove-friend-bot',
          title: 'Remove this Bot from your list and from your groups. This does not unfriend the owner.',
          'aria-label': busy ? 'Removing…' : 'Remove this Bot',
          'aria-busy': busy || undefined,
          disabled: !!busy,
          onClick: () => { void removeBot() },
        }, busy ? 'Removing…' : 'Remove this Bot'),
        error ? h('div', { className: 'fs-status', 'data-tone': 'error', role: 'status' }, error) : null)
    }

    function BotSocialDetails({ bot, actions } = {}) {
      useStyles()
      if (bot?.remote) {
        return h('div', { 'data-flybot': 'bot-social-details' },
          h(FriendChatSettings, { bot, actions }))
      }
      return h('div', { 'data-flybot': 'bot-social-details' },
        h(InviteToBot, { bot }),
        h(ManageAccess, { bot }))
    }

    // In a Bot's settings: invite a friend to this Bot.
    function InviteToBot({ bot }) {
      useStyles()
      const [invite, setInvite] = useState(null)
      const [note, setNote] = useState(null)
      const [busy, setBusy] = useState(false)
      if (!bot?.id) return null
      const create = async () => {
        setBusy(true); setNote(null)
        try { setInvite(await call('social/create-invite', { botId: bot.id })) } catch (e) { setNote({ tone: 'error', text: errorText(e) }) } finally { setBusy(false) }
      }
      // Called straight from the click, so the clipboard write keeps its permission.
      const copy = text => {
        const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
        if (clip?.writeText) clip.writeText(text).then(() => setNote({ tone: 'ok', text: 'Copied.' }), () => setNote({ tone: 'error', text: 'Could not copy. Select the link and copy it by hand.' }))
      }
      return h('div', { className: 'fs fs-card', 'data-flybot': 'invite-to-bot' },
        h('div', { className: 'fs-hint' }, `Invite a friend to ${bot.name}. Accepting the invite grants them ${bot.name} only. You can revoke that grant later.`),
        h('button', { type: 'button', className: 'fs-btn', disabled: busy, onClick: create }, invite ? 'Create another invite link' : 'Invite to this Bot'),
        invite ? h('div', { className: 'fs-line' },
          h('input', { className: 'fs-input', readOnly: true, value: invite.link, 'aria-label': 'Invite link', onFocus: e => e.target.select() }),
          h('button', { type: 'button', className: 'fs-btn', 'data-flybot': 'copy-link', onClick: () => copy(invite.link) }, 'Copy link'),
          h('button', { type: 'button', className: 'fs-btn', 'data-flybot': 'copy-invite-text', onClick: () => copy(invite.text) }, 'Copy invite with instructions')) : null,
        note ? h('div', { className: 'fs-status', 'data-tone': note.tone }, note.text) : null)
    }

    let cache = { at: 0, list: [] }
    const friendRows = async (query) => {
      if (Date.now() - cache.at > 30_000) cache = { at: Date.now(), list: await call('social/friends', {}) }
      const needle = query.trim().toLowerCase().replace(/^@/, '')
      return cache.list
        .filter(friend => friend.handle.includes(needle) || String(friend.name).toLowerCase().includes(needle))
        // The inserted text asks the Bot to use message_friend_bot; the send is held for approval.
        .map(friend => ({ name: `${friend.name} · remote`, description: `${friend.handle} · ${friend.home}`, section: 'Friends\' Bots', value: `${friend.handle} ` }))
    }

    return {
      name: 'flybot-social',
      inject: [],
      errorText,
      canInvite,
      InviteToBot,
      ManageAccess,
      BotSocialDetails,
      AddFriend,
      PendingApprovals,
      ChatApproval,
      ChatApprovalDock,
      FriendBotRow,
      FriendChatSettings,
      FaceToFaceGroup,
      FaceAvatar,
      FaceRoomOverview,
      FaceRoomCard,
      FaceRooms,
      FaceAutoSend,
      apply(ctx) {
        let offs = []
        let tries = 0
        // ds-bot's client creates the registry in its apply; wait for it if this loads first.
        const attach = () => {
          if (globalThis.__flybot__ === undefined) {
            if (++tries < 100) timer = setTimeout(attach, 100)
            else console.error('flybot-social: ds-bot FlyBot slots not found')
            return
          }
          offs = [
            slots().register('flybot.sidebar.section', { id: 'social', order: 100, component: FriendsBots }),
            slots().register('flybot.new-chat.action', {
              id: 'social-face-group',
              order: 15,
              label: 'Face-to-face group',
              hint: 'Meet the people next to you. Pick your Bots and type the same 6-digit number.',
              run: ({ close } = {}) => { openFaceToFace(); close?.() },
            }),
            slots().register('flybot.new-chat.action', {
              id: 'social-add-friend',
              order: 16,
              label: 'Add friend',
              hint: 'Paste an invite link or code.',
              run: ({ close } = {}) => { openAddFriend(); close?.() },
            }),
            slots().register('flybot.new-chat.action', {
              id: 'social-accept-invite',
              order: 17,
              label: 'Accept invite',
              hint: "Paste a friend’s invite link or code.",
              run: ({ close } = {}) => { openAddFriend(); close?.() },
            }),
            slots().register('flybot.new-chat.action', {
              id: 'social-copy-invite',
              order: 18,
              label: 'Copy invite link',
              hint: 'Copy a link a friend can paste in Add friend.',
              run: async ({ close } = {}) => {
                close?.()
                const status = await call('social/status', {})
                const bots = status?.bots ?? []
                const botId = (bots.find(bot => bot.isMain) ?? bots[0])?.id
                if (!botId) return 'Choose one of your Bots first.'
                const invite = await call('social/create-invite', { botId })
                const link = invite?.link || invite?.url
                if (!link) return 'The invite came back without its link.'
                const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
                if (clip?.writeText) {
                  try {
                    await clip.writeText(link)
                    return 'Invite link copied. Send it to a friend.'
                  } catch {
                    return `Could not copy. Link: ${link}`
                  }
                }
                return `Invite link: ${link}`
              },
            }),
            slots().register('flybot.new-chat.action', {
              id: 'social-copy-handle',
              order: 19,
              label: 'Copy my handle',
              hint: 'Your Bot Social handle',
              run: async ({ close } = {}) => {
                close?.()
                const status = await call('social/status', {})
                const handle = status?.home
                if (!handle) return 'Social is not connected yet.'
                const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
                if (clip?.writeText) {
                  try {
                    await clip.writeText(handle)
                    return `Copied. Your handle is ${handle}`
                  } catch {
                    return `Could not copy. Your handle is ${handle}`
                  }
                }
                return `Your handle is ${handle}`
              },
            }),
            slots().register('flybot.composer.mention', { id: 'social', order: 100, candidates: friendRows }),
            slots().register('flybot.bot.details', { id: 'social-invite', order: 100, component: BotSocialDetails }),
            slots().register('flybot.room.overview', { id: 'social-face', order: 50, component: FaceRoomOverview }),
            slots().register('flybot.session.dock', { id: 'social-approval', order: 50, component: ChatApprovalDock }),
          ]
          // For other plugins (the tree's per-node "Copy invite link"): ctx.flybot.social.canInvite(botId)
          // is synchronous; flybot.call('social.createInvite', { botId }) returns { link, text, ... }.
          const social = { canInvite, onChange: onStatusChange, createInvite: botId => call('social.createInvite', { botId }), openFaceToFace, openAddFriend }
          globalThis.__flybot__.social = social
          if (globalThis.__flybot__.api) globalThis.__flybot__.api.social = social
          offs.push(() => {
            if (globalThis.__flybot__?.social === social) delete globalThis.__flybot__.social
            if (globalThis.__flybot__?.api?.social === social) delete globalThis.__flybot__.api.social
          })
          void loadStatus().catch(() => {})
          // Keep canInvite current (and onChange firing) without callers polling.
          if (typeof setInterval === 'function') {
            const statusTimer = setInterval(() => { void loadStatus().catch(() => {}) }, 30_000)
            statusTimer?.unref?.() // node tests: never keeps the process alive
            offs.push(() => clearInterval(statusTimer))
          }
        }
        let timer
        attach()
        const dispose = () => {
          clearTimeout(timer)
          for (const off of offs.splice(0)) off()
        }
        ctx?.effect?.(() => dispose, 'flybot-social: slots')
        return dispose
      },
    }
  },
})
