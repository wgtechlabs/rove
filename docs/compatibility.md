# Agent Plugin imports

Rove can import a supported declarative subset from an approved GitHub repository's published release. Select the original format when installing. A repository does not need to adopt Rove's native package format to use these imports.

| Format | Entry point | Imported content |
| --- | --- | --- |
| Claude Code | `.claude-plugin/plugin.json` | Standalone `SKILL.md` content and remote HTTP MCP definitions |
| Cursor | `.cursor-plugin/plugin.json` | Standalone skills, unconditional rules, and remote HTTP MCP definitions |
| Codex skill | Root `SKILL.md` or `.agents/skills/<name>/SKILL.md` | Standalone skill Markdown |

Rove imports content into its own agent runtime. It does not run Claude Code, Cursor, or Codex, reproduce their invocation policies, or execute their plugin code. Imported skills join Rove's enabled instructions; host-specific progressive loading, slash commands and permission controls are not implemented. Rove's administrator approval requirement still governs tool calls.

A source import resolves the published release tag to a commit, reads its complete bounded Git tree, and verifies each consumed Git blob. Rove stores the normalized package with a separate SHA-256 digest, original format, release ID, commit, consumed-file digests and aggregate source digest. The record has no native release-asset ID. Publisher metadata and available root license/notice text are retained. Neither normalization nor source pinning proves publisher trust or a successful release workflow; the administrator must approve the source and activation.

Native `rove-plugin.json` assets use a separate source-matching loader. AIP activation additionally requires final human review and the configured successful release workflow. Importing another format does not replace that AIP gate.

## Supported subset

- Plugin and skill identifiers use lowercase kebab-case. Versions use `X.Y.Z`; when a source manifest omits its version, the release tag must be `X.Y.Z` or `vX.Y.Z`.
- Skills require `name` and `description` frontmatter. Optional scalar `license` and `compatibility` are retained. Plain, quoted and simple folded/block string values are accepted. Nested YAML, aliases, host permissions, invocation policies, shell substitution and host variable expansion fail explicitly.
- Claude skills use `skills/` plus any declared relative skill directories. Cursor uses its declared directories or default discovery; a root skill is supported when no skill directory is declared or present. Each imported skill must be self-contained.
- Cursor rules become shared Rove instructions only when `alwaysApply: true` and no conditional or glob selector is present. Supported rule files are `.md`, `.mdc` and `.markdown`.
- Remote MCP uses Streamable HTTP over HTTPS. Claude reads `.mcp.json` and declared MCP configuration; Cursor reads `mcp.json` unless overridden. Inline server maps and a relative JSON configuration path are supported. The importer does not contact MCP endpoints.
- A bearer-token placeholder becomes an encrypted, required Rove secret setting. Claude supports `${VARIABLE}` or a declared `${user_config.key}`. Cursor requires `${VARIABLE}` to be declared in its `variables` schema. Values are supplied in Rove; the server process environment is never expanded. Literal credentials, other headers, endpoint interpolation and unused configuration declarations are rejected.

These adapters reject unsupported executable hooks, local MCP commands, SSE-only transport, dependencies, agents, commands, scripts and external skill resources. Codex `agents/openai.yaml` metadata is rejected because invocation policy and tool dependencies need an explicit mapping. Unknown behavioral manifest fields are rejected instead of producing a partly working plugin.

An import is limited to 500 tree entries, 24 consumed files, 32 KB per consumed file and 128 KB total source bytes. Symlinks, submodules, executable file modes, incomplete trees and paths outside the repository are rejected. Rove's native limits also apply: at most eight skills, eight remote servers, and 24,000 combined instruction characters. Packages with additional resources or behavior need a supported declarative release or a future executable extension.

## Verification record

The following checks were performed on October 2, 2026. They establish import behavior, not general cross-host compatibility.

| Host | Version inspected | Evidence | Remaining gap |
| --- | --- | --- | --- |
| Claude Code | `2.1.211` | Real `claude plugin validate --strict` passed a local manifest/skill/remote-HTTP-MCP fixture. Rove importer tests passed the matching content shape. | No plugin installation, model session, or host MCP call was run. |
| Codex CLI | `0.159.2` | Installed CLI version confirmed. Rove tests import released standalone skill fixtures and validate source integrity. | No Codex skill-loading or host MCP session was run. |
| Cursor | Unavailable locally | Rove tests cover the documented Cursor manifest, skills, unconditional rules, variables and remote MCP shapes. | Cursor installation and runtime behavior remain unverified. |

Run the repository's build and `node --test dist/test/agent-import.test.js` to reproduce the importer checks. Those tests use controlled GitHub responses. Real private repositories, publisher releases, client discovery and authenticated cross-host MCP execution require separate integration evidence.

The format references are the [Claude Code manifest documentation](https://code.claude.com/docs/en/plugins-reference), [Cursor plugin reference](https://cursor.com/docs/reference/plugins), and [Codex skill documentation](https://learn.chatgpt.com/docs/build-skills). New fields or formats require an adapter update and fresh checks; the existence of a package manifest alone is not a compatibility claim.
