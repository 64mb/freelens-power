# Freelens Power tasks

New requirements are recorded here as they arrive. After each completed task: build, test, pack, reinstall locally, restart Freelens, verify loading, then mark it complete. Review accumulated changes periodically, not after every small task.

Keep this file in English. Never record secrets, tokens, Secret contents, private URLs, logs, user-configured values, or non-secret details specific to the user's infrastructure. Exclude endpoints, cluster and environment names, local paths, internal domains, identifiers, and service topology. Use neutral examples only.

## Installed

- [x] Clean extension without template examples, CRDs or unused Sass tooling
- [x] Apache 2.0 with the original MIT attribution preserved
- [x] Secure Node Shell with a configurable command and IPv6 preference
- [x] Secret certificate information
- [x] Appearance presets: Default, Purple #7868f4 and Blue #027bfe, with color indicators
- [x] Native switches and consistent settings cards
- [x] Display name: 🔋 Freelens Power, with stable settings storage and route identifiers
- [x] Secure Node Shell displayed before the built-in Shell
- [x] Accent colors for switches and the welcome logo

## Completed and locally reinstalled

- [x] Restrict accent link coloring so sidebar navigation keeps its original text colors
- [x] Match the macOS Dock icon to the selected accent and restore it on Default or disable
- [x] Automatic colima ssh with a settings switch
- [x] Welcome text with a feature list and a link to https://github.com/64mb/freelens-power

## Delivered

- [x] Add configurable AI prompt shortcuts with a label, short command and prompt text, plus one-click starter buttons in an empty chat and manual short-command expansion, following Zozzle

- [x] Visually separate prompt inputs with a themed surface, border, rounded corners, padding and accent focus state

- [x] Replace the free-text AI model field with a native model-and-effort dropdown using local Codex model metadata, similar to Orca

- [x] Apply the chosen accent to selected and focused dropdown options, including menus rendered in portals

- [x] Add aligned native icons to the bold headings of all major settings cards

- [x] Polish the chat interface using Zozzle as a reference: aligned header/composer/messages, borders, clear highlights and native action/close icons
  - Render command blocks with Copy and Insert into terminal actions
  - Terminal insertion must never press Enter or execute commands automatically; reject control characters and multiline insertion

- [x] Add a compact Autorefresh control in the editor; default on for new cards while preserving existing values, refresh that cached website every ten minutes only while the dashboard is hidden

- [x] Preserve embedded website state when switching away from Power Dashboard and add an explicit native reload icon beside Settings
  - Hide cached views on navigation; dispose them only when removed, the owner closes or Power is disabled

- [x] Replace the Ask about cluster star with a native icon and prefer Freelens icons consistently for interface actions

- [x] Use the native chat icon for the main AI launcher instead of a decorative star

- [x] Use consistent smooth color and subtle background transitions for every extension button and action, respecting reduced-motion preferences

- [x] Scale the dashboard column count to available width so large screens fit more cards, targeting a comfortable minimum S-cell width around 240px

- [x] Reduce dashboard card headers to roughly 38px with balanced icon and title sizes, especially for S cards

- [x] Polish AI launcher edge spacing and hover/focus states, then audit all interfaces in the running application
  - Keep Read-only mode enabled throughout the audit
  - Connect only to the single user-authorized cluster; never record its identity or infrastructure details here
  - Live AI chat and read-only tool calls are authorized for this audit

- [x] Use modular dashboard sizes in both dimensions: S is 1x1, M is 2x2 and L is 4x4, with exact gap-aware proportions and responsive column limits

- [x] Float Ask about cluster slightly over the top-right of the metrics area, without stretching or adding a toolbar row

- [x] Remove every hover/link affordance from welcome feature list items while keeping the GitHub link interactive

- [x] Add clear hover and keyboard-focus feedback to the dashboard Settings button

- [x] Use muted gray styling for the Open in browser icon, with a subtle hover state

- [x] Add drag handles to dashboard settings for persistent card reordering, with a keyboard-accessible alternative

- [x] Render the card-size dropdown above the editor modal and backdrop

- [x] Use the website-provided favicon in dashboard headers, including icons discovered at nonstandard paths

- [x] Replace the card browser link text and arrow with the native open_in_new icon and an Open in browser tooltip

- [x] Keep the dashboard Settings action subdued but comfortably sized at about 32px high, with a settings icon

- [x] Remove the redundant Your dashboard subtitle and keep the Power Dashboard heading

- [x] Keep the AI floating launcher on cluster work screens, omit global pages, and use a compact rounded outlined design that avoids resource controls

- [x] Describe accent themes on the welcome page without mentioning macOS or the Dock icon

- [x] Keep a clearly visible Power Dashboard page heading and render welcome features as plain emoji bullets without button-like backgrounds or hover affordances

- [x] Fix live dashboard layout: preserve card headers, align embedded views with the responsive grid, visibly clip rounded borders and hide embedded page scrollbars

- [x] Give the dashboard card editor an opaque rounded surface, border, shadow and dimmed backdrop so it is clearly separated from the settings page

- [x] Add a master Enable Freelens Power switch that stops every extension feature and restores native appearance without disabling the extension; preserve settings and histories for re-enabling

- [x] Add a UI-only Read-only mode toggle to hide create/edit/delete actions for resources, nodes and clusters; cover common menus and shortcuts where practical, with a concise note that Kubernetes permissions are unchanged

- [x] Compact dashboard settings into a concise icon/title/size list with add/edit dialogs and accessible actions, avoiding a long expanded form per card

- [x] Separate bookmark dashboard through globalPages
  - Configure title, URL and S/M/L size per card
  - Add, edit and remove cards in extension settings
  - Responsive isolated website grid and an Open in browser action
  - Use isolated native views with website scripts enabled and Node access disabled
- [x] Rounded cards with a small website icon at the top left
- [x] Register Power Dashboard in the General catalog so it can be opened and pinned like built-in pages
- [x] Replace the top-right dashboard shortcut with a battery icon opening extension settings
- [x] Add five additional well-chosen Material accent presets
- [x] Fix dashboard rendering and isolate embedded websites from Electron and Node APIs
  - Live testing found Node access inside an ordinary iframe despite its HTML sandbox attribute
  - Use an Electron-isolated embedded view rather than exposing host privileges to configured websites
- [x] Rewrite README in concise English with a bulleted feature list
- [x] Record project agreements and the delivery workflow in English in AGENTS.md

## AI and welcome

- [x] Improve the welcome block with a short introduction and a visibly separated emoji feature list
- [x] Add a floating AI button on cluster work screens and a right-hand slide-out chat panel
  - Allow the entire AI UI to be disabled in extension settings
  - Provide a CLI selector with Codex as the initial and only supported option
  - Include the current screen, cluster and resource as conversation context
  - Add an Ask about cluster action on the cluster overview page that opens AI chat with the current cluster context, following the Zozzle interaction
  - Preserve conversations across panel close/reopen and application restarts, with one history per cluster
  - Use the native Codex CLI and its existing local authentication without extension credentials
  - Add model selection and fast/default response speed settings
  - Add editable prompts to extension settings, following Zozzle; shipped defaults must not prescribe Russian or any user-specific language
  - Keep any personal language preference only in the local installed extension settings
  - Provide callable tools for reading pods, logs, nodes and other Kubernetes resources, following the reference design
  - AI tools must remain read-only independently of the UI Read-only toggle; do not expose create, edit, delete or container exec operations
  - Never include environment variable values in AI context or tool results; include environment variable names only and sanitize nested resource data
  - Inspect the public reference implementation at https://github.com/64mb/zozzle
  - The right-hand slide-out interaction applies to AI chat, not the bookmark dashboard

## Research

- [x] Investigate opt-in CPU and memory charts backed by Kubernetes metrics-server when Prometheus is unavailable
  - metrics-server provides current measurements, not stored time-series history
  - Consider collecting samples while Freelens is running and clearly show the available time range
  - Check host chart integration; do not imply support for network or disk metrics from metrics-server
- [x] Investigate a Read-only mode switch that disables create, edit and delete UI actions for resources, nodes and clusters
  - Include context menus and keyboard shortcuts, not only visible toolbar buttons
  - Distinguish UI restrictions from Kubernetes authorization
- [x] Investigate an optional CSS selector per card to show a chosen DOM element from a website
  - The ordinary iframe API cannot access a different origin
  - Check whether a controlled Electron integration can support this reliably

## Decisions

- Keep new settings in the existing visual style
- Keep the npm package name freelens-power and the UI name 🔋 Freelens Power
- Never hardcode the user's custom SSH command
- Changing the Dock icon must not modify Freelens.app, Finder or Launchpad icons
- The built-in welcome page has no public full-replacement API; custom text is a reversible DOM adaptation
- Keep a browser-opening action for sites that cannot run embedded

## Research findings

- metrics-server: the existing host graphs query Prometheus and expect time-series results. An extension can add its own CPU/memory panel and collect samples from the resource metrics API while running; replacing every native graph has no public extension hook. A future opt-in panel must label its locally collected time range and cannot supply historical, network or disk measurements from metrics-server alone. Reference: https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/
- Read-only UI: the public extension registrations add actions but provide no central veto over built-in mutations. Hiding buttons with DOM selectors cannot reliably block context menus, keyboard commands, dialogs and cluster catalog changes. The shipped opt-in switch is explicitly a UI convenience, as requested; Kubernetes read-only RBAC remains the enforceable boundary.
- Website selectors: isolated Electron views can execute a narrowly scoped selector adapter in their own page to highlight or show a subtree, without exposing Node APIs. This is technically feasible, but login pages, dynamic rendering and layout changes make it site-dependent. It should be an optional card setting with a reset action, not a promise that arbitrary pages can always be cropped reliably.

- AI log tools return locally computed numeric issue counters from at most 100 lines and 64 KiB; raw lines are never sent to the model

## Delivery verification

- Unit coverage includes isolated website lifecycle, hidden-only refresh scheduling, favicon limits, card ordering, AI resource projection, log counters, prompt shortcuts, model metadata, and chat interactions
- Live audit checks the dashboard, settings, welcome text and authorized read-only cluster interface without recording infrastructure details
- Fixed detached chat icons requiring host dependency injection, isolated feature startup, and started Read-only before optional interface features
- Fixed IPC serialization of observable saved conversations and UTF-8 decoding across CLI output chunks, with regression coverage
- Independent final review completed; actionable findings were addressed and rechecked
- Show bounded tool activity from actual backend reads and keep the latest chat message visible on open and completion
- Final automated checks: 186 unit tests passed, TypeScript build and formatting checks passed; package contents verified
- Live dashboard checks confirmed loaded site favicons, native dropdown accent, compact headers, responsive columns and view reuse after navigation
- Use private, request-scoped pod references so log summaries remain callable when environment redaction withholds resource identities
- Live explicit dashboard reload completed without an extension load error; site icons remained available
- Live authorized resource-screen audit confirmed a compact 34px launcher with consistent edge spacing and no overview-only action on resource pages
- Covered the native host log-factory proxy compatibility path with an IPC integration regression test
- Final live AI audit confirmed successful native pod reads and log-summary reads; Read-only remained enabled and raw log text was not returned to the model

## Follow-up settings controls

- [x] Add a separate switch for app icon recoloring while retaining the selected interface accent
- [x] Make the AI master switch explicit: hide every AI entry point and chat, stop active requests and preserve preferences/history

## Dashboard settings favicons

- [x] Reuse bounded website favicon data discovered by isolated dashboard views in settings without fetching arbitrary URLs

- [x] Use a native Autorefresh checkbox aligned with other editor fields and enable it by default only for new cards
- [x] Use the bright theme text color for System prompt, Cluster prompt and Prompt shortcuts headings while keeping hints muted

- [x] Persist bounded discovered website image data locally across restarts and discard stale card identities without loading website pages from settings

- [x] Use compact gray icon actions with hover labels for dashboard card editing and removal
- [x] Align the accent Add shortcut action to the right and edit shortcut drafts in the same modal component as dashboard cards

- [x] Start a configured cluster review exactly once when Ask about cluster opens an empty conversation, preserve existing history and improve starter spacing and native icons

- [x] Show animated AI thinking feedback and live, privacy-safe read activity for the originating chat request

- [x] Animate pending AI replies and show validated live read-tool progress for the active request only
- [x] Send chat messages with Enter and preserve Shift+Enter newlines and IME composition

- [x] Highlight the enabled AI Send action with the accent color and a distinct hover state while retaining muted disabled styling

- [x] Render AI answers with CommonMark headings, nested lists, tables, links and quotes while preserving safe code copying and explicit terminal insertion

- [x] Apply the accent color only to the AI header icon and AI letters while preserving the native assistant text color

- [x] Widen the AI chat panel to 560px while keeping full-width layout on narrower windows

- [x] Improve chat readability with brighter theme text, larger type, clearer message spacing and structured Markdown hierarchy based on the local reference

- [x] Isolate AI close and Escape interactions from host dropdowns and fade the launcher near the bottom of resource lists
- [x] Use subtle selected backgrounds in the namespace multi-select, with accent selection icons and distinct focus/hover feedback

- [x] Show AI code insertion only for the active visible connected terminal, trim surrounding CR/LF, reject embedded controls and never create a tab or send Enter
- [x] Render the chat close control as a compact icon with hover/focus feedback and no permanent button surface

- [x] Add native author icons and unify the chat composer into a rounded input surface with a compact Send icon and keyboard hint
- [x] Add a persisted chat font size setting matching native font preferences, with immediate message/composer updates
- [x] Refine Purple and Blue to slightly darker shades and replace Yellow with a slightly darker shade of #fdd72a, migrating existing selections
- [x] Keep Pink and add Red #e52626 as a separate accent preset
- [x] Remove the redundant Teal preset and retain Default for the native theme

- [x] Align all AI setting selectors to one consistent width
- [x] Refresh welcome feature bullets with the dashboard, read-only controls and AI capabilities
- [x] Add safe convenience improvements: copying full assistant replies and keyboard focus on the message composer

## Public extension inspiration

- Reviewed the public Lens extension catalog and official Freelens resource-map/FluxCD repositories for ideas; no third-party cluster actions or mutation tools were imported
- Sources: https://github.com/lensapp/lens-extensions and https://github.com/freelensapp/freelens-resource-map-extension and https://github.com/freelensapp/freelens-fluxcd-extension

- [x] Complete configured slash commands with keyboard and pointer selection, keep autocomplete Escape local, and preserve reading position while following new chat replies

- [x] Add read-only API discovery, custom resource reads, structural spec summaries and Secret key names while withholding all payload and environment values
- [x] Compact dashboard settings rows and render a separated Size badge beside their icon actions
- [x] Refresh settings favicons when isolated views discover icons after the settings snapshot was loaded
- [x] Increase the gap below the Secure Node Shell connection command input
- [x] Show each prompt shortcut command as a separate muted subtitle beneath its label
- [x] Ship generic SRE/DevOps system and cluster prompts adapted from Zozzle principles without language or environment-specific directives; preserve the local language override

- [x] Keep the AI launcher 16px from workspace edges and dynamically position it above the visible native Dock

- [x] Use the native stars glyph for assistant authors and align message, activity and composer gutters consistently

- [x] Keep the three existing AI shortcuts and enrich their defaults with SRE evidence, impact, restart and dependency investigation guidance, preserving customized entries
- [x] Close unpinned AI chat on outside clicks without blocking navigation; provide a native Pin control beside close and retain explicit Escape/close actions
- [x] Render the dashboard Refresh control as a compact icon with a tooltip and smooth hover feedback

- [x] Align the connection command input to the same 220px control width as Appearance and AI selectors

- [x] Use the native monospace font for dashboard settings Size badges

- [x] Live follow-up audit confirmed cached settings favicons after restart, three shortcuts, enabled new-card Autorefresh, 560px chat, equal 16px launcher gaps, slash suggestions and Pin/outside dismissal with Read-only retained
- [x] Live AI read-only API discovery completed successfully on the authorized test cluster without an extension error
- [ ] Create the requested private GitHub repository and CI for pull-request checks and release packages, following the reference workflow organization

- [x] Describe the welcome feature as AI chat so it remains accurate when more CLI providers are added

- [x] Replace native prompt resize handles with bounded automatic textarea sizing and scrolling
