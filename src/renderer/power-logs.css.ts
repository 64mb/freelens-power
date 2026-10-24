export const powerLogsStyles = `
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
.power-logs-snapshot-option { display:flex; align-items:center; justify-content:space-between; gap:12px; min-width:0; }
.power-logs-option-text { display:flex; flex-direction:column; gap:3px; min-width:0; white-space:normal; overflow-wrap:anywhere; }
.power-logs-option-text strong { font-weight:500; }
.power-logs-option-text small { opacity:.85; font-size:11px; }
.power-logs-snapshot-option > button { display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; min-width:28px; min-height:28px; padding:0; border:0; border-radius:4px; background:transparent; color:inherit; cursor:pointer; }
.power-logs-snapshot-option > button:not(:disabled):hover { color:var(--colorError); background:color-mix(in srgb,var(--colorError) 12%,transparent); }
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
.power-log-row { min-height:0!important; position:absolute; left:0; right:0; width:100%; display:grid!important; grid-template-columns:95px 48px minmax(100px,180px) minmax(0,1fr); align-items:center; gap:10px!important; padding:0 12px!important; border:0!important; border-left:3px solid var(--textColorSecondary)!important; border-bottom:1px solid var(--borderFaintColor)!important; border-radius:0!important; text-align:left; background:transparent!important; font-family:var(--font-monospace,monospace)!important; font-size:12px!important; }
.power-logs[data-compact=true] .power-log-row { padding-inline:8px!important; gap:6px!important; }
.power-logs[data-compact=true] td,.power-logs[data-compact=true] th { padding:3px 8px; }
.power-log-row > span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.power-log-row .power-log-level { font-size:10px; font-weight:600; text-transform:uppercase; }
.power-log-row[data-level=warn] { border-left-color:var(--colorWarning,#d9a441)!important; }
.power-log-row[data-level=error],.power-log-row[data-level=fatal] { border-left-color:var(--colorError,#d26860)!important; }
.power-log-row[data-level=info] { border-left-color:var(--primary)!important; }
.power-logs-detail { position:absolute; z-index:5; top:0; bottom:0; right:0; box-sizing:border-box; box-shadow:-4px 0 18px #0004; display:flex; flex-direction:column; align-items:stretch; gap:12px; width:460px; max-width:95%; padding:16px; background:var(--contentColor); border:1px solid var(--borderColor); border-radius:6px; overflow:auto; }
.power-logs-detail header { justify-content:flex-end; }
.power-logs-detail header > strong { margin-right:auto; }
.power-logs .power-logs-detail-close { flex-shrink:0; width:28px; padding:0; border-color:transparent; background:transparent; }
.power-logs .power-logs-detail-close:not(:disabled):hover { border-color:transparent; background:color-mix(in srgb,var(--primary) 10%,transparent); }
.power-log-json { --json-key:#9cdcfe; --json-string:#ce9178; --json-number:#b5cea8; --json-literal:#c586c0; }
.theme-light .power-log-json { --json-key:#005a9e; --json-string:#9e2b1a; --json-number:#17642d; --json-literal:#7a288c; }
.power-log-json [data-token=key] { color:var(--json-key); }
.power-log-json [data-token=string] { color:var(--json-string); }
.power-log-json [data-token=number] { color:var(--json-number); }
.power-log-json [data-token=literal] { color:var(--json-literal); }
.power-logs pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; line-height:1.6; }
.power-logs textarea { box-sizing:border-box; width:100%; height:56px; min-height:48px; max-height:120px; flex-shrink:0; resize:vertical; font-family:var(--font-monospace,monospace); }
.power-logs-results { flex:1; min-height:0; overflow:auto; border:1px solid var(--borderColor); border-radius:6px; }
.power-logs table { border-collapse:collapse; table-layout:fixed; font-size:12px; width:100%; min-width:0; }

.power-logs th,.power-logs td { padding:6px 10px; text-align:left; border-bottom:1px solid var(--borderColor); max-width:400px; white-space:nowrap; vertical-align:top; }
.power-logs .power-logs-cell { display:block; overflow:hidden; text-overflow:ellipsis; max-height:4.8em; }
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

.power-logs-capture { display:flex; }
.power-logs-capture > button { color:var(--primary); }
.power-logs-options { position:relative; }
.power-logs-options > summary { list-style:none; }
.power-logs-options > summary::-webkit-details-marker { display:none; }
.power-logs .power-logs-options[open] > summary { color:var(--primary); border-color:var(--primary); background:color-mix(in srgb,var(--primary) 12%,var(--contentColor)); }
.power-logs-options > div { position:absolute; z-index:10; top:100%; right:0; box-sizing:border-box; width:280px; max-width:calc(100vw - 32px); border-radius:6px; padding:12px; display:flex; flex-direction:column; gap:12px; background:var(--mainBackground); border:1px solid var(--borderColor); box-shadow:0 4px 18px #0005; }
.power-logs-options label { white-space:nowrap; justify-content:space-between; gap:12px; }
.power-logs-options .power-logs-select { min-width:130px; }
.power-logs-select .Select__single-value { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.power-logs-sql-tools button { min-height:24px; font-size:12px; }
.power-logs-pagination { justify-content:flex-end; gap:8px; }
.power-logs-pagination button { width:28px; padding:3px; }
.power-logs-footer { display:flex; align-items:center; justify-content:space-between; gap:12px; min-width:0; }
.power-logs-caption { flex:1; min-width:0; font-size:11px!important; }
.power-logs .power-logs-collection-note { display:flex; align-items:center; gap:5px; min-width:0; max-width:55%; padding:1px 6px; font-size:10px; }
.power-logs-collection-note > :first-child { color:var(--colorWarning,#d9a441); flex-shrink:0; }
.power-logs-collection-note > :last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.power-logs-status { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.power-logs .power-logs-error { white-space:normal; overflow:visible; overflow-wrap:anywhere; }
.power-logs-snapshot-notes { max-height:100px; overflow:auto; }
@container(max-width:760px) { .power-logs-detail { width:min(420px,86%); padding:12px; gap:10px; } .power-logs-filters .power-logs-select { flex:1 1 130px; } .power-logs-filters > input { flex-basis:100%; } .power-log-row { grid-template-columns:80px 42px minmax(0,1fr); } .power-log-row .power-log-origin { display:none; } .power-logs header .power-logs-actions { gap:4px; } }
`;
