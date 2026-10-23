// Narrow multi-pane windows (#705): the Details panel is fixed to the right edge with its width
// reserved as a margin on the conversation column, so a long value that cannot wrap (the About
// text, "4.1M tok · Cache hit …") widens the panel's content past that reservation and the row
// overflows — the panel ends up clipped and a dead strip is left between the panes. Every flexing
// pane gets min-width:0 so it can shrink, and the long values wrap. Installed after the shell
// styles, so these declarations win at equal specificity.
export const PANE_MIN_WIDTH_CSS = `
.bt-panel{min-width:0}
.bt-panel-view{min-width:0}
.bt-drawer-body{min-width:0;overflow-wrap:anywhere}
.bt-drawer-body :is(.bt-muted,.bt-note,.bt-section-title,.bt-drawer-role,.bt-drawer-permission){min-width:0;overflow-wrap:anywhere}
.bt-panel :is(.bt-member,.bt-members,.bt-bcard-row,.bt-drawer-model,.bt-usage-row){min-width:0}
.bt-panel :is(.bt-muted,.bt-note){white-space:normal}
[class*="_centerCol"]{min-width:0}
`
