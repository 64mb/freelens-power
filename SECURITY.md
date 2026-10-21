# AI data boundaries

Extension-supplied screen context contains only bounded resource metadata. Resource tool results omit environment values and Secret payloads; log tools return numeric counters. Navigation references are derived from successful, redacted reads.

The installed AI CLI and its provider are trusted components. Built-in tools, third-party MCP servers and user/project customizations are disabled for extension requests. Claude uses its native sign-in; known unsafe managed policies are rejected before launch. Organization-managed policy can be refreshed by the CLI after this check and remains under the organization administrator's control.

Dashboard websites run in isolated Electron views without Node access. Website selectors execute only inside that isolated page. Exported settings contain dashboard cards and prompt shortcuts, excluding chat history and authentication settings; recognized credentials embedded in card URLs are removed.
