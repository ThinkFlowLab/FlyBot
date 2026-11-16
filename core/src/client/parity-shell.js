// Chat-shell details measured from the visual-reference screenshots
// at 1920×1072 (see ui-reference.md). Values are calibrated CSS, not copied
// brand assets. The product name and mark stay FlyBot.
export const ICON_RAIL_WIDTH = 72
export const CHAT_LIST_WIDTH = 360
export const SHELL_LEFT_WIDTH = ICON_RAIL_WIDTH + CHAT_LIST_WIDTH
export const COMPOSER_HEIGHT = 86
export const HEADER_HEIGHT = 56

export const PARITY_SHELL_CSS = `
.bt-side.bt-side-split{display:flex;flex-direction:row;align-items:stretch;min-height:100%;background:var(--bt-sidebar);min-width:0}
.bt-icon-rail{flex:none;width:72px;display:flex;flex-direction:column;align-items:center;gap:6px;padding:16px 8px 12px;box-sizing:border-box;border-right:1px solid var(--bt-line);background:color-mix(in srgb,var(--bt-sidebar) 92%,#000 8%)}
.bt-brand-rail{display:flex;align-items:center;justify-content:center;width:40px;height:40px;flex:none}
.bt-brand-rail .bt-mark,.bt-brand-rail .bt-mark svg{width:28px;height:28px}
.bt-rail-btn{width:40px;height:40px;border:0;border-radius:12px;padding:0;background:transparent;color:var(--bt-ink-2);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background-color .12s ease,color .12s ease,opacity .12s ease}
.bt-rail-btn svg{width:20px;height:20px}
.bt-rail-btn:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-rail-btn[aria-current=page],.bt-icon-rail .bt-row[aria-current=page]{background:var(--bt-selected,color-mix(in srgb,var(--bt-accent) 28%,transparent));color:var(--bt-ink)}
.bt-rail-btn:disabled{opacity:.4;cursor:not-allowed}
.bt-rail-btn:focus-visible,.bt-brand-rail:focus-visible,.bt-icon-rail .bt-row:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-chat-col{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;background:var(--bt-sidebar)}
.bt-side.bt-side-split .bt-side-top{display:flex;align-items:center;padding:10px 12px 8px;gap:8px}
.bt-side.bt-side-split .bt-brand{align-items:center}
.bt-side.bt-side-split .bt-row{min-height:48px;padding:8px 10px;border-radius:12px;align-items:center}
.bt-side.bt-side-split .bt-row:hover{background:var(--bt-hover)}
.bt-side.bt-side-split .bt-row[aria-current=page]{background:var(--bt-selected,color-mix(in srgb,var(--bt-accent) 22%,transparent))}
.bt-side.bt-side-split .bt-row-name{font-size:14px;line-height:20px;font-weight:500;color:var(--bt-ink)}
.bt-side.bt-side-split .bt-row[aria-current=page] .bt-row-name{font-weight:600}
.bt-side.bt-side-split .bt-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.bt-side.bt-side-split .bt-row-preview{font-size:12px;line-height:16px;font-weight:400;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-side.bt-side-split .bt-list{flex:1 1 auto;min-height:0;overflow-x:hidden;overflow-y:auto;scrollbar-width:thin;padding:4px 8px 12px}
.bt-side.bt-side-split .bt-hint{margin:24px 12px;padding:0;text-align:center;color:var(--bt-ink-3);font-size:13px;line-height:18px}
.bt-plus-menu{border-radius:16px;border:1px solid var(--bt-line-2);background:var(--bt-card);padding:8px}

@media (min-width:1025px){
[class*="_sidebar"]:has(.bt-side-split),[class*="Sidebar"]:has(.bt-side-split){width:432px;min-width:432px;max-width:432px;flex:none}
.bt-chat-col{width:360px;max-width:360px}
}

@media (min-width:641px){
[class*="_header"]:has(.bt-head){min-height:56px;margin:8px 12px 0;padding:0 12px;border-radius:16px;background:var(--bt-card);border:1px solid var(--bt-line);box-sizing:border-box;display:flex;align-items:center}
[data-composer-card]{min-height:86px!important;border-radius:20px!important;padding:10px 14px!important;background:var(--bt-bubble)!important;border:1px solid color-mix(in srgb,var(--bt-ink) 22%,transparent)!important;box-shadow:none!important;align-items:center!important}
[data-composer-card]:has(> [data-slot="conversation.input.attachments"] *),[data-composer-card]:has([data-composer-input] br + *),[data-composer-card]:has([data-composer-input] > :nth-child(2)){border-radius:16px!important;align-items:flex-end!important}
[class*="_root"]:has(> [data-composer-card]){padding:8px 16px 12px!important}
[data-composer-card] [class*="_tools"]{order:1;flex:none;align-self:center;margin:0;gap:6px!important}
[data-composer-card]>[data-input-scroll]{order:2;flex:1 1 0;min-width:0;min-height:44px;padding:6px 12px!important;margin:0!important}
[data-composer-card] [class*="_trailing"]{order:3;flex:none;align-self:center;margin:0;gap:8px}
[data-composer-card] [data-composer-input]{min-height:44px;padding:8px 0!important;font-size:14px;line-height:20px}
[data-composer-card] [data-composer-placeholder]::after{font-size:14px;line-height:20px;color:var(--bt-ink-3)}
[data-composer-card] .bt-plus,.bt-mic,.bt-voice,[data-composer-card] button[class*="_primary"]{width:32px!important;height:32px!important}
[data-composer-card] .bt-plus svg,.bt-mic svg,.bt-voice svg,[data-composer-card] button[class*="_primary"] svg{width:18px;height:18px}
[data-composer-card] .bt-plus:disabled,.bt-mic:disabled,.bt-voice:disabled,[data-composer-card] button:disabled{opacity:.4;cursor:not-allowed}
[data-composer-card] .bt-plus:focus-visible,.bt-mic:focus-visible,.bt-voice:focus-visible,[data-composer-card] button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
}
`;
