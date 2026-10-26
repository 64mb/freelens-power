# 🔋 Freelens Power

Power tools and personal dashboards for Freelens. Built for Freelens 1.x and tested with 1.10.3.

## Features

- **Secure Node Shell:** your connection command, optional IPv6 preference, and automatic `colima ssh`
- **Secret certificates:** CN, SAN, issuer, serial number, validity dates, and expiration details for PEM chains
- **Accent themes:** Default, Purple, Blue, Green, Yellow, Orange, Red, and Pink for controls, text links, and the welcome logo
- **Cluster icons:** a searchable cluster grid, matching SVG icons, editable labels and colors, live previews, and saved editor settings
- **macOS Dock icon:** optionally follows your accent, with a separate toggle to restore the original
- **Power Dashboard:** reorderable XS/S/M/L/XL website cards in a responsive grid, cached pages, loading skeletons, interactive element selection, expansion, pinned floating windows, shared website sessions, per-card 10-second refresh including pinned windows, and optional background refresh
- **Monitoring:** optional CPU and memory trends, allocation rings, pinned tooltips, and node/pod charts using metrics-server and Kubernetes APIs
- **Resource diagnostics:** CPU/memory consumers, grouped warning timelines, Pending and Not ready triage, Service/HPA checks, operational resource and namespace summaries, scoped AI handoff, and incident-summary copying
- **Power Logs:** opt-in colored workload logs with structured fields, source and level filters, bounded live collection, temporary or pinned SQLite snapshots, cancellable read-only SQL, compact density, configurable limits, NDJSON export and reviewable AI context with SQL drafts; native Pod logs remain available. JSON details support syntax coloring, value copying and AND field filters in Live view and SQL; SQL presets retain original JSON field names, and five preset selectors control log limits
- **Resource relationships:** a focused Service graph connects Ingress and installed Gateway API routes/listeners to selected Pods, published endpoints, owners and node references, with acceptance and cross-namespace reference evidence, resource links, explicit expansion of all available graph resources and saved upstream visibility
- **Fast resource search:** double Shift searches all discoverable resource types, including Secrets, ConfigMaps and custom resources, through a persistent local metadata index with gentle background refresh, type and namespace filters, name-part and typo matching, resource links and explicit AI attachment; search and background indexing can be disabled together in Monitoring settings
- **Local metric history:** opt-in SQLite storage, up to seven days within a 100 MiB budget, with aggregated ranges and explicit collection gaps
- **AI assistant:** native Codex or Claude CLI, per-cluster conversations, read-only API discovery and resource summaries, model/effort/speed selection, editable prompts, quick-start commands, Markdown, cancellable replies, context preview, optional terminal attachments, automatic visible Relationships/Consumers/Timeline snapshots when no attachment exists, resource links, resizable pinned chat, and a switch to disable all AI features
- **Read-only UI:** hides common mutation actions without changing Kubernetes permissions
- **Master switch:** restores the native interface while preserving all settings
- **Settings:** native switches, compact dashboard editors, and JSON backup and restore of cards and prompt shortcuts

AI tool results exclude environment values and Secret payloads; automatic log summaries contain numeric issue counters. Power Logs lines and SQL results attach to a reviewable context block when the AI action is clicked. Drafted SQL is inserted into the editor without execution. Terminal output is sent only when explicitly attached; review its masked preview before sending. Websites run in isolated Electron views. Every dashboard card also opens in your browser.

Power Logs captures stay on the local disk for one hour by default, with configurable retention, and are removed when the feature stops unless pinned. Pinned snapshots survive restarts and remain until manually deleted; unpinning starts a new retention period. Snapshot deletion and pinning require confirmation. Temporary and pinned snapshot pools each use the configured capture count limit, with the same combined limit per cluster context. Collection follows current Kubernetes permissions and retained container logs. Large workloads use rotating bounded tails, so busy sources can have gaps; coverage and partial captures are reported in the interface.

Monitoring history is collected while Freelens is running and the cluster view is active. Cluster and node series are retained automatically when enabled. History cannot backfill periods without collection. Timelines combine retained Kubernetes events with changes observed while the diagnostics page is open. Local Pending checks explain available evidence and do not reproduce the full scheduler.

## Screenshots

Real extension components with synthetic website content, prompts, and conversations.

| Dashboard | AI assistant |
| --- | --- |
| <a href="https://raw.githubusercontent.com/64mb/freelens-power/main/docs/screenshots/dashboard.png"><img src="https://raw.githubusercontent.com/64mb/freelens-power/main/docs/screenshots/dashboard.png" width="288" height="224" alt="Dashboard with demonstration websites"></a> | <a href="https://raw.githubusercontent.com/64mb/freelens-power/main/docs/screenshots/ai-chat.png"><img src="https://raw.githubusercontent.com/64mb/freelens-power/main/docs/screenshots/ai-chat.png" width="288" height="224" alt="AI assistant with example read-only diagnostics and code copying"></a> |

| AI preferences and shortcuts | Focused website cards |
| --- | --- |
| <a href="https://raw.githubusercontent.com/64mb/freelens-power/main/docs/screenshots/ai-settings.png"><img src="https://raw.githubusercontent.com/64mb/freelens-power/main/docs/screenshots/ai-settings.png" width="288" height="224" alt="AI preferences with neutral prompts and shortcuts"></a> | <a href="https://raw.githubusercontent.com/64mb/freelens-power/main/docs/screenshots/card-editor.png"><img src="https://raw.githubusercontent.com/64mb/freelens-power/main/docs/screenshots/card-editor.png" width="288" height="224" alt="Dashboard card editor with an example URL and CSS selector"></a> |

## Install

Install `@64mb/freelens-power` from the npm registry in Freelens Extensions, or download the `.tgz` package from [GitHub Releases](https://github.com/64mb/freelens-power/releases), open **Extensions** in Freelens (`Cmd+Shift+E` on macOS), and install it by its absolute path. You can also build and pack the extension locally.

## Develop

Requires Node.js 24.15.0 and pnpm 10.34.4.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm lint:check
pnpm pack
```

Use `pnpm dev` to rebuild on changes, then reinstall the package.

## CI and releases

Pull requests and pushes to `main` run independent lint, type checking, unit tests, build and real Freelens UI checks against a disposable kind cluster. Scheduled checks add a light/narrow profile, restart and index refresh scenarios. See [UI testing](e2e/README.md) for fixtures, screenshots and coverage limits.

Run **Make Release** in GitHub Actions to create a version bump pull request. Merging it publishes the package to npm and the installable `.tgz` archive in [GitHub Releases](https://github.com/64mb/freelens-power/releases). Use **Package Release** with the merged pull request number to retry a failed release.

PR titles follow Conventional Commits, for example `feat(ai): add Claude CLI`.

## License

Apache-2.0. Original Freelens template code retains its MIT license and attribution in `THIRD_PARTY_LICENSES`.

[GitHub](https://github.com/64mb/freelens-power)
