# Project guidelines

- Keep repository documentation and task tracking in English
- Record new requirements in local, Git-ignored `TASKS.md` and keep completion status accurate
- Keep the README concise, with a concrete feature list
- Preserve the established settings layout and use native controls where available
- Prefer the native Freelens icon set for interface actions
- Keep source code, documentation and fixtures free of secrets and user-specific infrastructure details, including endpoints, cluster names and local paths
- Use neutral examples in documentation and tests
- Keep reference projects and experiments in `.research`, outside the shipped package
- Run checks appropriate to each change and review accumulated changes periodically, rather than starting an expensive review for every small task
- Build, pack, reinstall locally, restart Freelens and verify loading after each completed task
- Preserve user settings during updates and restore host behavior when the extension is disabled

## Pull request descriptions

- Write all pull request descriptions in English, including release pull requests
- Use concise bullets describing concrete changes and important verification results
- Read the current description before updating it and preserve manual edits
- Translate existing descriptions when requested without dropping details or links

## Pull request titles

- Use Conventional Commits for pull request titles: `type(scope): description`
- The scope is optional; use `!` before the colon for breaking changes
- Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore and revert
- Write a concise English description starting with a lowercase letter, for example `feat(ai): add Claude CLI`
- Put ticket references in the description or body rather than before the commit type

## GitHub Actions

- Use the latest stable release of every GitHub Action and pin it to its full commit SHA
- Keep the release version in a comment next to each pinned action
- Write setup steps directly in each workflow rather than introducing shared composite actions
