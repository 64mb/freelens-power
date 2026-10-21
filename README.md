# 🔋 Freelens Power

Power tools and personal dashboards for Freelens. Built for Freelens 1.x and tested with 1.10.3.

## Features

- **Secure Node Shell:** your connection command, optional IPv6 preference, and automatic `colima ssh`
- **Secret certificates:** CN, SAN, issuer, serial number, validity dates, and expiration details for PEM chains
- **Accent themes:** Default, Purple, Blue, Green, Yellow, Orange, Red, and Pink for controls, text links, and the welcome logo
- **macOS Dock icon:** optionally follows your accent, with a separate toggle to restore the original
- **Power Dashboard:** reorderable S/M/L website cards, responsive layout, cached pages, manual reload, and optional background refresh
- **AI assistant:** native Codex CLI, per-cluster conversations, read-only API discovery and resource summaries, model/effort/speed selection, editable prompts, quick-start commands, Markdown, pinned chat, and a switch to disable all AI features
- **Read-only UI:** hides common mutation actions without changing Kubernetes permissions
- **Master switch:** restores the native interface while preserving all settings
- **Settings:** native switches, compact dashboard editors, and a consistent card layout

AI tool results exclude environment values and Secret payloads; logs are reduced locally to numeric issue counters. Websites run in isolated Electron views. Every dashboard card also opens in your browser.

## Install

Download the `.tgz` package from [GitHub Releases](https://github.com/64mb/freelens-power/releases), open **Extensions** in Freelens (`Cmd+Shift+E` on macOS), and install it by its absolute path. Private repository access is required to download releases. You can also build and pack the extension locally.

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

Pull requests and pushes to `main` run lint, type checking, unit tests, and a build. Run **Make Release** from GitHub Actions to bump the version and open a release pull request. Merging it into `main` repeats all checks and publishes a GitHub Release with the installable `.tgz` package from the merge commit. **Package Release** also accepts a merged release pull request number for retrying a failed release.

Enable **Allow GitHub Actions to create and approve pull requests** in repository Actions settings. The workflows use the built-in `GITHUB_TOKEN`; no package registry credentials are needed. For pull requests opened by this token, GitHub may require a repository member to select **Approve workflows to run** before the **Checks** jobs start. **Make Release** also validates the source before opening its pull request. Packages are distributed through private GitHub Releases; npm publishing is not configured.

## License

Apache-2.0. Original Freelens template code retains its MIT license and attribution in `THIRD_PARTY_LICENSES`.

[GitHub](https://github.com/64mb/freelens-power)
