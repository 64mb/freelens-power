export const powerLogsStyles = `
.ConfirmDialog:has(.power-logs-confirmation) > .box { background:var(--contentColor); color:var(--textColorPrimary); min-width:min(360px,calc(100vw - 32px)); max-width:min(640px,calc(100vw - 32px)); }
.ConfirmDialog:has(.power-logs-confirmation) .confirm-content { gap:12px; }
.ConfirmDialog:has(.power-logs-confirmation) .confirm-content > .Icon { flex-shrink:0; margin:0; }
.ConfirmDialog .power-logs-confirmation { display:block; min-width:0; overflow-wrap:anywhere; }
.ConfirmDialog:has(.power-logs-confirmation) .confirm-buttons { background:var(--mainBackground); color:var(--textColorPrimary); }
.ConfirmDialog .power-logs-confirm-label { display:inline-flex; align-items:center; gap:6px; }
.ConfirmDialog:has(.power-logs-confirmation) .Button.power-logs-confirm-delete { background:var(--colorError); color:#fff !important; }
body:has(.power-logs[data-testid="power-logs-page"]) .power-ai-launcher { display:none; }
.power-logs { display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; box-sizing:border-box; overflow:hidden; padding:12px; gap:6px; color:var(--textColorPrimary); container-type:inline-size; }
.power-logs header, .power-logs-toolbar, .power-logs-filters, .power-logs-source { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.power-logs header h1 { margin:0; font-size:16px; display:flex; align-items:center; gap:10px; }
.power-logs header .power-logs-actions { margin-left:auto; display:flex; gap:8px; flex-wrap:wrap; }
.power-logs :is(button,input,select,textarea), .power-logs .power-logs-options > summary { font:inherit; color:inherit; }
.power-logs :is(.power-logs-filters > input,textarea) { background:var(--contentColor); border:1px solid var(--borderColor); border-radius:5px; padding:4px 8px; min-width:0; }
.power-logs-filters > input { flex:1; min-width:180px; }
.power-logs label { display:flex; align-items:center; gap:8px; }
.power-logs button, .power-logs .power-logs-options > summary { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:28px; padding:3px 8px; border:1px solid var(--borderColor); border-radius:5px; background:var(--contentColor); cursor:pointer; box-shadow:none; }
.power-logs button::before { content:none; }
.power-logs :is(button:not(:disabled),.power-logs-options > summary):hover { color:var(--primary); border-color:var(--primary); }
.power-logs button[aria-pressed=true], .power-logs button[aria-selected=true] { color:var(--primary); background:color-mix(in srgb,var(--primary) 12%,var(--contentColor)); border-color:var(--primary); }
.power-logs button:disabled { opacity:.45; cursor:default; }
.power-logs :is(button,input,select,textarea):focus-visible, .power-logs .power-logs-options > summary:focus-visible { outline:2px solid var(--primary); outline-offset:2px; }
.power-logs .power-logs-filters > input:focus-visible, .power-logs textarea:focus-visible { outline:none; border-color:var(--primary); box-shadow:inset 0 0 0 1px var(--primary); }
.power-logs .power-logs-muted { color:var(--textColorSecondary); font-size:12px; line-height:1.5; }
.power-logs .power-logs-notice { padding:3px 8px; border:1px solid var(--borderColor); border-radius:4px; line-height:1.5; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex-shrink:0; }
.power-logs .power-logs-error { color:var(--colorError,#e68b80); }
.power-logs-tabs { display:flex; gap:4px; flex-shrink:0; }
.power-logs header .power-logs-page-title { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
.power-logs-snapshot-option { display:flex; align-items:center; justify-content:flex-start; gap:12px; min-width:0; }
.power-logs-snapshot-option > .power-logs-option-text { flex:1; }
.power-logs-option-text { display:flex; flex-direction:column; gap:3px; min-width:0; white-space:normal; overflow-wrap:anywhere; }
.power-logs-option-text strong { font-weight:500; }
.power-logs-option-text small { opacity:.85; font-size:11px; }
.power-logs-source-option { display:flex; align-items:center; gap:10px; width:100%; min-width:0; white-space:normal; line-height:1.4; }
.power-logs-source-option > :first-child { flex-shrink:0; opacity:.75; }
.power-logs-source-option .power-logs-option-text { flex:1; }
.power-logs-source-option strong, .power-logs-source-option small { white-space:normal; overflow:visible; overflow-wrap:anywhere; }
.power-logs-source-check { display:inline-flex; width:16px; flex-shrink:0; }
.power-logs-snapshot-option > button { display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; min-width:28px; min-height:28px; padding:0; border:0; border-radius:4px; background:transparent; color:inherit; cursor:pointer; }
.power-logs-snapshot-option > button[data-capture-delete]:not(:disabled):hover { color:var(--colorError); background:color-mix(in srgb,var(--colorError) 12%,transparent); }
.power-logs-snapshot-option > button[data-capture-persistent]:not(:disabled):hover, .power-logs-snapshot-option > button[aria-pressed=true] { color:var(--primary); background:color-mix(in srgb,var(--primary) 12%,transparent); }
.power-logs-snapshot-option > button:focus-visible { outline:2px solid var(--primary); outline-offset:-2px; }
.power-logs-snapshot-option > button:disabled { opacity:.45; cursor:default; }
.power-logs-level-label { color:var(--textColorSecondary); }
.power-logs-level-label[data-level=debug] { color:var(--colorInfo); }
.power-logs-level-label[data-level=info] { color:var(--primary); }
.power-logs-level-label[data-level=warn] { color:var(--colorWarning); }
.power-logs-level-label[data-level=error],.power-logs-level-label[data-level=fatal] { color:var(--colorError); }
.Select__option--is-selected .power-logs-level-label { color:inherit; }
.power-logs-workspace { position:relative; display:flex; flex:1; min-height:0; }
.power-logs-viewer { display:flex; flex-direction:column; flex:1; min-width:0; min-height:0; gap:4px; }
.power-logs-stream { position:relative; flex:1; min-height:0; min-width:0; overflow:auto; border:1px solid var(--borderColor); border-radius:6px; background:var(--contentColor); }
.power-log-row { min-height:0!important; position:absolute; left:0; right:0; width:100%; display:grid!important; grid-template-columns:var(--log-time-width,calc(8ch + 4px)) var(--log-level-width,calc(var(--power-log-level-ch,7) * .833333ch + 4px)) minmax(100px,180px) minmax(0,1fr); align-items:center; gap:8px!important; padding:0 12px!important; border:0!important; border-left:3px solid var(--textColorSecondary)!important; border-bottom:1px solid var(--borderFaintColor)!important; border-radius:0!important; text-align:left; background:transparent!important; font-family:var(--font-monospace,monospace)!important; font-size:12px!important; }
.power-logs[data-compact=true] .power-log-row { --log-time-width:calc(8ch + 1px); --log-level-width:calc(var(--power-log-level-ch,7) * .909091ch + 1px); padding-inline:6px!important; gap:4px!important; font-size:11px!important; line-height:16px; }
.power-logs[data-compact=true] table :is(td,th) { padding:1px 6px; font-size:11px; line-height:16px; }
.power-logs[data-compact=true] .power-logs-cell { white-space:nowrap; }
.power-log-row > span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.power-log-row > span:last-child { white-space:pre; height:16px; line-height:16px; }
.power-log-message { color:var(--textColorPrimary); }
.power-log-message [data-log-token=http-method] { color:var(--primary); }
.power-log-message [data-log-token=uuid] { color:#9cdcfe; }
.theme-light .power-log-message [data-log-token=uuid] { color:#005a9e; }
.power-log-row .power-log-level { font-size:10px; font-weight:600; text-transform:uppercase; }
.power-log-row[data-level=warn] { border-left-color:var(--colorWarning,#d9a441)!important; }
.power-log-row[data-level=error],.power-log-row[data-level=fatal] { border-left-color:var(--colorError,#d26860)!important; }
.power-log-row[data-level=info] { border-left-color:var(--primary)!important; }
.power-logs-detail { position:absolute; z-index:5; top:0; bottom:0; right:0; box-sizing:border-box; box-shadow:-4px 0 18px #0004; display:flex; flex-direction:column; align-items:stretch; gap:12px; width:460px; max-width:95%; padding:16px; background:var(--contentColor); border:1px solid var(--borderColor); border-radius:6px; overflow:auto; }
.power-logs-detail header { justify-content:flex-end; }
.power-logs-detail header > strong { margin-right:auto; }
.power-logs-structured-heading { display:flex; align-items:center; gap:6px; }
.power-logs .power-logs-detail-copy, .power-logs .power-logs-detail-close { flex-shrink:0; width:28px; padding:0; border-color:transparent; background:transparent; }
.power-logs .power-logs-detail-copy:not(:disabled):hover, .power-logs .power-logs-detail-close:not(:disabled):hover { border-color:transparent; background:color-mix(in srgb,var(--primary) 10%,transparent); }
.power-log-json { --json-key:#9cdcfe; --json-string:#ce9178; --json-number:#b5cea8; --json-literal:#c586c0; }
.theme-light .power-log-json { --json-key:#005a9e; --json-string:#9e2b1a; --json-number:#17642d; --json-literal:#7a288c; }
.power-log-json [data-token=key] { color:var(--json-key); }
.power-log-json [data-token=string] { color:var(--json-string); }
.power-log-json [data-token=number] { color:var(--json-number); }
.power-log-json [data-token=literal] { color:var(--json-literal); }
.power-logs pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; line-height:1.6; }
.power-logs textarea { user-select:text; box-sizing:border-box; width:100%; height:56px; min-height:48px; max-height:120px; flex-shrink:0; resize:vertical; font-family:var(--font-monospace,monospace); }
.power-logs-results { flex:1; min-height:0; overflow:auto; border:1px solid var(--borderColor); border-radius:6px; }
.power-logs table { border-collapse:collapse; table-layout:fixed; font-size:12px; width:100%; min-width:0; }

.power-logs th,.power-logs td { padding:6px 10px; text-align:left; border-bottom:1px solid var(--borderColor); max-width:400px; white-space:nowrap; vertical-align:top; }
.power-logs .power-logs-cell { display:block; overflow:hidden; text-overflow:ellipsis; max-height:4.8em; }
.power-logs .power-logs-json-cell { position:relative; display:flex; align-items:center; gap:4px; min-width:0; height:20px; max-height:20px; }
.power-logs .power-logs-json-cell .power-log-json { flex:1; min-width:0; margin:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; line-height:20px; }
.power-logs .power-logs-json-copy { display:inline-flex; align-items:center; justify-content:center; flex:0 0 20px; width:20px; height:20px; min-height:0; padding:0; border-color:transparent; background:transparent; opacity:.6; }
.power-logs .power-logs-json-copy:hover, .power-logs .power-logs-json-copy:focus-visible { opacity:1; background:color-mix(in srgb,var(--primary) 10%,transparent); }
.power-logs .power-logs-json-copy-feedback { position:absolute; left:0; top:0; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }

.power-logs tbody tr { cursor:pointer; }
.power-logs tbody tr:hover, .power-logs tbody tr:focus-visible { background:color-mix(in srgb,var(--primary) 10%,var(--contentColor)); outline:none; }
.power-logs td[data-column=message] { font-family:var(--font-monospace,monospace); font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; }
.power-logs td[data-level=error], .power-logs td[data-level=fatal] { color:var(--colorError,#d26860); }
.power-logs td[data-level=warn] { color:var(--colorWarning,#d9a441); }
.power-logs th { position:sticky; top:0; background:var(--contentColor); }
.power-logs dialog { position:fixed; inset:0; margin:auto; background:var(--mainBackground); color:var(--textColorPrimary); border:1px solid var(--borderColor); border-radius:8px; padding:24px; width:min(640px,85vw); max-height:80vh; overflow:auto; }
.power-logs dialog::backdrop { background:#0007; }
.power-logs-empty { padding:32px; text-align:center; color:var(--textColorSecondary); }

.power-logs > :not(.power-logs-workspace):not(.power-logs-results) { flex-shrink:0; }
.power-logs-target, .power-logs-caption { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.power-logs-select { display:inline-block; min-width:0; max-width:360px; flex:1; }
.power-logs-source .power-logs-select { flex:1; max-width:none; }
.power-logs-select > div { width:100%; min-width:0; }
.power-logs-filters .power-logs-select { flex:0 1 180px; }
.power-logs-filters .power-logs-select[data-source-select] { flex:1 1 260px; max-width:420px; }

.power-logs-capture { display:flex; }
.power-logs-capture > button { color:var(--primary); }
.power-logs-options { position:relative; }
.power-logs-options > summary { list-style:none; }
.power-logs-options > summary::-webkit-details-marker { display:none; }
.power-logs .power-logs-options[open] > summary { color:var(--primary); border-color:var(--primary); background:color-mix(in srgb,var(--primary) 12%,var(--contentColor)); }
.power-logs-options > div { position:absolute; z-index:10; top:calc(100% + 6px); right:0; box-sizing:border-box; width:280px; max-width:calc(100vw - 32px); border-radius:6px; padding:12px; display:flex; flex-direction:column; gap:12px; background:var(--mainBackground); border:1px solid var(--borderColor); box-shadow:0 4px 18px #0005; }
.power-logs-options label { white-space:nowrap; justify-content:space-between; gap:12px; }
.power-logs-options .power-logs-select { min-width:130px; }
.power-logs-select .Select__single-value { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.power-logs-sql-tools button { min-height:24px; font-size:12px; }
.power-logs-pagination { justify-content:flex-end; gap:8px; }
.power-logs-pagination button { width:28px; padding:3px; }
.power-logs-footer { display:flex; align-items:center; justify-content:space-between; gap:12px; min-width:0; }
.power-logs-caption { flex:1; min-width:0; font-size:11px!important; }
.power-logs .power-logs-collection-note { display:flex; align-items:center; gap:5px; min-width:0; max-width:55%; padding:1px 6px; font-size:11px; }
.power-logs-collection-note > :first-child { color:var(--colorWarning,#d9a441); flex-shrink:0; }
.power-logs-collection-note > :last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.power-logs-status { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.power-logs .power-logs-error { white-space:normal; overflow:visible; overflow-wrap:anywhere; }
.power-logs-snapshot-notes { max-height:100px; overflow:auto; }
@container(max-width:760px) { .power-logs-detail { width:min(420px,86%); padding:12px; gap:10px; } .power-logs-filters .power-logs-select { flex:1 1 130px; } .power-logs-filters > input { flex-basis:100%; } .power-log-row { grid-template-columns:var(--log-time-width,calc(8ch + 4px)) var(--log-level-width,calc(var(--power-log-level-ch,7) * .833333ch + 4px)) minmax(0,1fr); } .power-log-row .power-log-origin { display:none; } .power-logs header .power-logs-actions { gap:4px; } }
.Select__option--is-selected .power-logs-snapshot-option > button { color:var(--freelens-power-accent-foreground,#fff); background:#0002; border:1px solid currentColor; }
.Select__option--is-selected .power-logs-snapshot-option > button[data-capture-persistent]:not(:disabled):hover { color:var(--primary); background:var(--freelens-power-accent-foreground,#fff); border-color:var(--freelens-power-accent-foreground,#fff); }
.Select__option--is-selected .power-logs-snapshot-option > button[data-capture-delete]:not(:disabled):hover { color:#a61b1b; background:#fff; border-color:#fff; }
.power-logs-field-filters { display:flex; align-items:center; flex-wrap:wrap; gap:4px; }
.power-logs .power-logs-field-filters button { max-width:360px; min-height:24px; padding:2px 6px; font-size:11px; }
.power-logs-field-filters button > span:first-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.power-logs-field-filters button > :last-child { flex-shrink:0; }
@keyframes power-log-json-actions-in { from { opacity:0; } to { opacity:1; } }
.power-log-json-actions button { color:inherit; }
.power-logs .power-log-json-actions button:hover, .power-logs .power-log-json-actions button:focus-visible { color:var(--primary); }
.power-log-json-actions { animation:power-log-json-actions-in 120ms ease-out; }
@media (prefers-reduced-motion:reduce) { .power-log-json-actions { animation:none; } }
.power-logs .power-logs-json-cell .power-log-json-fields { flex:1; min-width:0; overflow:hidden; }
.power-logs .power-logs-json-cell .power-log-json { white-space:pre; }
.power-log-message [data-log-token=url], .power-log-message [data-log-token=trace-id], .power-log-message [data-log-token=address] { color:#9cdcfe; }
.theme-light .power-log-message [data-log-token=url], .theme-light .power-log-message [data-log-token=trace-id], .theme-light .power-log-message [data-log-token=address] { color:#005a9e; }
.power-log-message [data-log-token=duration], .power-log-message [data-status-class="2"] { color:#b5cea8; }
.theme-light .power-log-message [data-log-token=duration], .theme-light .power-log-message [data-status-class="2"] { color:#17642d; }
.power-log-message [data-status-class="1"], .power-log-message [data-status-class="3"] { color:#9cdcfe; }
.theme-light .power-log-message [data-status-class="1"], .theme-light .power-log-message [data-status-class="3"] { color:#005a9e; }
.power-log-message [data-status-class="4"] { color:#e3b56b; }
.theme-light .power-log-message [data-status-class="4"] { color:#8a4b00; }
.power-log-message [data-status-class="5"] { color:#f19b8d; }
.theme-light .power-log-message [data-status-class="5"] { color:#9e2b1a; }
.power-logs[data-hide-resource-name=true] .power-log-row { grid-template-columns:var(--log-time-width,calc(8ch + 4px)) var(--log-level-width,calc(var(--power-log-level-ch,7) * .833333ch + 4px)) minmax(0,1fr); }
.power-logs[data-hide-resource-name=true] .power-log-origin { display:none; }
.power-logs .power-logs-control-label { display:block; flex:0 0 76px; width:76px; margin:0; }
.power-logs .power-logs-query-error { font-size:12px; color:var(--colorError); }
`;
