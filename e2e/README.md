# Real Freelens extension UI tests

This suite extracts the exact freshly packed archive into an isolated extension discovery directory and installs a pnpm `link:` to it in the application profile, matching the native host layout before launching official Freelens. It does not install the archive's transitive dependencies separately, so required runtime modules must ship in the package. It seeds the isolated native extension registry as enabled, verifies the actual Power settings entry point and isolated Electron user-data directory, and interacts with its features using Playwright keyboard and pointer events. It does not replace the host with a component mock or test unrelated Freelens features. Host extension-manager navigation and installer watcher timing are outside this extension suite. Search, Diagnostics, Relationships, Settings, Power Logs and Helm are independent tests, each with a fresh application profile.

`Checks` retains independent lint, type, build and unit jobs and also calls the fast Linux UI lane. The scheduled and manual `Extension UI` workflow adds a second Kubernetes version, a light/narrow profile, 1,200 ConfigMaps, a real application restart and index/churn checks. The release publisher runs the smoke suite on the exact archive it subsequently publishes, at the resolved merge revision. An unavailable app, cluster, index or interaction fails the lane rather than becoming a skipped success.

## Linux CI and local execution

Requirements: Linux x64, Node 24, pnpm, Docker, Xvfb and the desktop libraries listed in the workflow. The provisioning script downloads the official Freelens AppImage, kind and kubectl with the versions and SHA-256 digests recorded in `runtime-lock.json`. Kubernetes node images are pinned by digest. Update the lock intentionally after reviewing upstream releases.

```sh
pnpm install --frozen-lockfile
pnpm build
mkdir -p .e2e-runtime/package
pnpm pack --pack-destination .e2e-runtime/package
pnpm test:e2e:provision
export KUBECONFIG="$PWD/.e2e-runtime/kubeconfig"
export FREELENS_EXECUTABLE="$PWD/.e2e-runtime/squashfs-root/freelens"
export E2E_KUBECTL="$PWD/.e2e-runtime/bin/kubectl"
export EXTENSION_ARCHIVE="$(find "$PWD/.e2e-runtime/package" -name '*.tgz' -print -quit)"
xvfb-run --auto-servernum pnpm test:e2e
node e2e/provision.mjs --cleanup
```

Use a directory containing only the archive to test. Set `E2E_LANE=extended` for the extended project matrix. `pnpm type:check:e2e` checks harness types without launching the app. `pnpm test:e2e --list` verifies test discovery only and is not UI validation.

For a macOS developer probe, use an installed official Freelens binary and create the dedicated `power-e2e` kind cluster with `--kubeconfig .e2e-runtime/kubeconfig` and the appropriate digest from the lock. Set the same environment variables, pointing `FREELENS_EXECUTABLE` at the app executable, and run without Xvfb. This does not establish Linux CI or macOS visual baseline coverage.

## Isolation and artifacts

Every project starts with a new `FREELENS_INTEGRATION_TESTING_DIR` under the OS temporary directory, with its own home, kubeconfig, extension directory and user settings. Native kubeconfig sync entries are explicitly restricted to the copied test kubeconfig, and a plain shell avoids importing a developer shell configuration. Catalog bootstrap asserts exactly one cluster before connecting. The extended restart reuses only this test profile. Fixtures refuse any current context other than `kind-power-e2e`. Never pass a real cluster kubeconfig. The suite never invokes an AI provider or sends an AI message.

Only synthetic, neutral fixture data is used, including a recognizable synthetic sensitive value. The suite checks that value is absent from search database files. It does not upload the profile, kubeconfig, database, full API bodies or application stdout. Failure traces retain screenshots and input actions with DOM/network snapshots disabled. PNG captures and the HTML report are retained for seven days in CI.

Screenshots capture the extension search, drawer, Diagnostics, Relationships, settings and Power Logs. Power Logs captures include filtered line details, reviewed and attached AI context, SQL results, DaemonSet sources, Pod container selection and native fallback. Hover, pressed and focus settings states are captured. Press geometry, viewport containment and absence of overlapping section buttons are asserted directly. Light/dark text contrast is checked to avoid mislabeled theme captures. These captures are review artifacts, not approved pixel-comparison baselines. Baselines must be recorded and reviewed on the fixed Linux runner before adding pixel-diff gates; Linux captures do not validate macOS rendering.

## Power Logs

The Power Logs test creates a three-replica Deployment with two containers per Pod and a DaemonSet in a dedicated fixture namespace. BusyBox is pinned by digest and emits synthetic structured info/error records, warning lines and a nested credential sentinel. Fixture setup checks both the isolated context and local HTTPS API endpoint before applying resources and waits for both rollouts.

The test opens Logs through native workload and Pod drawers, checks six Deployment sources and live polling, filters by message/level/container, expands structured fields and checks viewport geometry and bounded rendered rows. It creates a real temporary capture, runs native SQLite count and JSON extraction queries, cancels an expensive query and verifies reuse, exports NDJSON and checks its row count and Pod/container coverage, then deletes the capture. Export uses the real UI, IPC, SQLite worker and file writing; only the native save dialog response is replaced with an isolated profile path and restored afterward. It reviews redacted evidence, attaches it to AI context without sending a message, checks DaemonSet and Pod container selection, opens a native Pod log tab, and verifies the native Logs action returns when Power Logs is disabled. The extended lane also checks persisted Power Logs disablement and AI enablement after restarting the application. Run this case alone with `pnpm test:e2e --grep 'Power Logs'` after the normal provisioning and packing steps.

These assertions are automated coverage, not a claim that every platform/project has passed. The real UI case does not exercise native operating-system save dialog interaction, historical container restarts, workload ownership changes, fair-poll delivery from every source, capture expiry or storage limits, query result pagination, or every supported workload kind. Those require separate explicit cases; unit tests cover additional collector, backend and renderer behavior. Screenshots remain review artifacts rather than pixel baselines.

## Helm

The Helm smoke test creates two synthetic Helm release Secrets in its own namespace, with a latest Failed revision and an older Deployed revision. Fixture writes and cleanup require explicit test environment variables, the isolated kind context and a local HTTPS API endpoint. The test verifies default-off behavior, native sidebar fallback, opt-in release listing, background App Version, historical read-only YAML, Latest and Last deployed comparison baselines, cancellation of native rollback confirmation, and Read only hiding edit actions. It checks that cancellation leaves exactly the two fixture revisions. Run it alone with `pnpm test:e2e --grep 'Helm native fallback'` after provisioning and packing.

The CI smoke test does not execute Helm upgrade or rollback mutations. Mutation guards, stale identities, cancellation and concurrency have focused unit coverage; real mutation checks require a separate explicitly isolated chart fixture. Visual screenshots are review evidence, not pixel baselines.

## Coverage limits

The current executable lane covers double Shift and keyboard search, a result beyond 500 objects, Secret/ConfigMap/CRD/custom objects, a trusted drawer click, Diagnostics tabs, Relationships toggle persistence, official Gateway API CRDs with explicitly synthetic route statuses and a real graph-to-drawer click, and settings focus, press geometry and independent resource-search enablement. The extended lane exercises restart, persisted search disablement, ConfigMap creation with explicit inventory refresh, and metadata database inspection including the synthetic Secret value in raw and base64 form. Fault injection, RBAC changes, deletion/recreation, quota/corruption, Gateway-controller reconciliation, Dashboard website loading, AI provider processes, package upgrades and uninstall are not claimed by this suite. Add those as explicit cases with isolated fixtures rather than treating setup screenshots or skipped tests as evidence.

### Desktop-safe UI testing

Run routine UI checks on Linux with a virtual display, including when driving them from macOS through a local container:

```sh
xvfb-run --auto-servernum --server-args='-screen 0 1600x1100x24' pnpm test:e2e
```

The CI UI workflow already uses Xvfb. Local macOS UI runs are blocked by default because Electron opens real windows and can interrupt other desktop activity. Set `E2E_ALLOW_VISIBLE_UI=1` only when visible testing is explicitly intended. Unit tests, type checks, builds and packaging do not open windows.

On Linux, closing the isolated app also terminates native Kubernetes proxies only when both the executable name and the exact temporary test-profile environment match. This prevents inherited proxy pipes from delaying Playwright shutdown and leaves other app instances untouched.
