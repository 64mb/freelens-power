# Real Freelens extension UI tests

This suite installs the exact freshly packed archive and its runtime dependencies with pnpm into an isolated application profile before launching official Freelens, seeds the isolated native extension registry as enabled, verifies the actual Power settings entry point and isolated Electron user-data directory, and interacts with its features using Playwright keyboard and pointer events. It does not replace the host with a component mock or test unrelated Freelens features. Host extension-manager navigation and installer watcher timing are outside this extension suite. Search, Diagnostics, Relationships and Settings are independent tests, each with a fresh application profile.

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

Screenshots capture the extension search, drawer, Diagnostics, Relationships and settings. Hover, pressed and focus settings states are captured. Press geometry, viewport containment and absence of overlapping section buttons are asserted directly. Light/dark text contrast is checked to avoid mislabeled theme captures. These captures are review artifacts, not approved pixel-comparison baselines. Baselines must be recorded and reviewed on the fixed Linux runner before adding pixel-diff gates; Linux captures do not validate macOS rendering.

## Coverage limits

The current executable lane covers double Shift and keyboard search, a result beyond 500 objects, Secret/ConfigMap/CRD/custom objects, a trusted drawer click, Diagnostics tabs, Relationships toggle persistence, official Gateway API CRDs with explicitly synthetic route statuses and a real graph-to-drawer click, and settings focus, press geometry and independent resource-search enablement. The extended lane exercises restart, persisted search disablement, ConfigMap creation with explicit inventory refresh, and metadata database inspection including the synthetic Secret value in raw and base64 form. Fault injection, RBAC changes, deletion/recreation, quota/corruption, Gateway-controller reconciliation, Dashboard website loading, AI provider processes, package upgrades and uninstall are not claimed by this suite. Add those as explicit cases with isolated fixtures rather than treating setup screenshots or skipped tests as evidence.
