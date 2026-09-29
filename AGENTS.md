# Rove agent instructions

These instructions apply throughout this repository. Follow explicit user
instructions and more specific directory instructions when they apply. Read the
affected code and current repository state before making changes.

## Product boundaries

- Rove is an open-source, company-neutral AI agent framework. Companies supply
  their own knowledge, integrations, policies, and workflows.
- Build Rove's own identity and implementation. External projects may inform
  ideas; do not copy their branding, visual styles, or product-specific code.
- Reuse proven capabilities when they fit, preserve required third-party
  attribution, and document compatibility.
  Do not copy company-specific features, private content, destinations, credentials,
  organization IDs, or business rules into Rove defaults.
- The web interface is the default setup, administration, and chat experience.
  Slack is an optional channel configured afterward. CLI, Discord, and Telegram
  are outside the MVP. Web use must not require Slack credentials.
- Ship a Docker image suitable for Railway and other container hosts. Respect
  the assigned port, provide a health endpoint, handle shutdown, keep secrets
  out of images, and persist company data outside the container filesystem.
  Do not make Vercel infrastructure mandatory.
- One company per deployment, initially one administrator. Protect first-admin
  setup with a deployment secret, close setup after creation, and enforce admin
  authorization on the server. No public registration or implicit channel-based
  administrative access.
- Keep agent behavior, tools, skills, and improvement workflows shared across
  channels. Channel-specific delivery and identity belong at the channel boundary.
  Preserve conversation privacy and actor permissions across every boundary.
- A channel interface must work through the real execution path before it is
  described as supported. Do not invent Slack identities for other platforms or
  describe a mock-only interface as a working integration.
- AIPs are **Agent Improvement Proposals**: concrete, reviewable changes through
  which a company teaches Rove. Preserve the proposed change, rationale,
  validation, and adoption outcome. A suggestion is not approval to change policy,
  grant access, merge code, publish content, or deploy.
- Keep the MVP small. Add abstractions, dependencies, configuration, and workflow
  machinery only when required by an accepted capability.

## Clean Workflow

This repository adopts [WG Tech Labs Clean Workflow](https://github.com/wgtechlabs/clean-workflow).
Apply Clean Coding for implementation and Clean Code Review for reviews when
those skills are available. The rules below remain usable without any locally
installed skill or a particular agent product.

1. **Understand:** inspect instructions, branch, changes, callers, and relevant
   tests. Resolve facts yourself. Ask only about missing decisions that materially
   affect the result, and reuse answers already supplied.
2. **Plan:** state the intended behavior and observable acceptance criteria.
   Keep the plan proportional; a small, clear change does not need an interview.
3. **Implement:** choose the smallest complete solution. Prefer existing code,
   standard libraries, native platform features, and installed dependencies.
   Fix the owning cause rather than scattering special cases among callers.
4. **Verify:** run checks appropriate to the changed behavior and exercise the
   relevant runtime path where possible. Preserve necessary validation, error
   handling, privacy, security, and accessibility.
5. **Examine:** review the final diff for correctness, scope, maintainability,
   unnecessary layers, and duplicated logic. Correct relevant findings and rerun
   checks affected by those corrections.

Use design and interaction review when UI is involved; inspect the running UI and
capture useful visual evidence when available. Skip UI work for unrelated changes.
Treat oversized files and tangled logic as signals to investigate, not reasons
for a speculative rewrite.

## Git and pull requests

Use Clean Flow once the repository's base branches exist:

```text
feature branch -> squash merge -> dev -> merge commit -> main
```

- `dev` integrates reviewed changes; `main` contains stable releases.
- Start new work from current `dev` and target change PRs at `dev`. Use short,
  lowercase, descriptive names with `feature/`, `fix/`, `docs/`, `chore/`, `test/`,
  or `refactor/` prefixes.
- Avoid direct changes to `main` and `dev`. Promote `dev` to `main` through a
  release PR with a meaningful `🚀 release:` title and a regular merge commit.
- For an empty repository, use the authorized bootstrap branch until the base
  branches are established. Do not invent a merge base or claim a PR exists.
  Preserve a suitable in-progress branch rather than renaming it just to conform.
- Inspect staged, unstaged, and untracked changes; preserve unrelated user work.
  A committed diff such as `origin/dev...HEAD` does not include uncommitted work.
- Keep commits and PRs focused. Explain the concrete behavior, relevant
  validation, and material limitations; use the repository's PR template if one
  exists. Do not include local research artifacts, private source, or secrets.
- Complete delivery actions within the user's authorized scope and verify remote
  results. Do not infer permission to merge, release, deploy, change repository
  visibility, or rewrite history from permission to implement.

### Clean Commit

Use a matching emoji and lowercase type:

```text
<emoji> <type>: <description>
<emoji> <type> (<scope>): <description>
<emoji> <type>!: <description>
<emoji> <type>! (<scope>): <description>
```

| Emoji | Type | Purpose |
| --- | --- | --- |
| 📦 | `new` | New features, files, or capabilities |
| 🔧 | `update` | Changes and bug fixes |
| 🗑️ | `remove` | Removed code, features, or dependencies |
| 🔒 | `security` | Security fixes and hardening |
| ⚙️ | `setup` | Configuration, CI, and tooling |
| ☕ | `chore` | Maintenance |
| 🧪 | `test` | Tests and test fixes |
| 📖 | `docs` | Documentation |
| 🚀 | `release` | Releases and release preparation |

Use present tense, start the description in lowercase, omit a final period, and
stay under 72 characters when practical. Example:
`📖 docs: establish rove agent instructions`.

### Clean Labels and reviews

- Assign only labels that already exist. Prefer the Clean Labels categories:
  Type, Status, Community, Resolution, and Area.
- Use [GitHub Labels Template (GHLT)](https://github.com/warengonzaga/github-labels-template)
  for authorized label setup, with the target repository supplied explicitly.
  Do not recreate its template using custom scripts. Destructive label migration
  requires an explicit request; adopting this workflow is not that request.
- Validate review feedback against the current head and actual behavior before
  implementing it. Prioritize concrete correctness, security, and maintainability
  issues; do not manufacture findings or broaden scope for cosmetic preferences.
- When authorized to address review feedback, verify the fix on the remote branch,
  reply to the specific thread, and resolve it only after the concern and reply
  are verified. Leave disputed or blocked concerns visible.
- Review-only work does not authorize fixes. Honor publication limits; approval,
  formal change requests, and merging need their own applicable authorization.

## Validation and handoff

- Use the Bun version pinned in `package.json` for dependency installation and
  script commands. Commit `bun.lock` and use frozen installs in CI and Docker.
  Node 24 remains the server and integration-test runtime.
- Run `bun run check` for Biome formatting, lint and import checks. Use
  `bun run format` to format files; keep lint warnings and errors resolved.
- Discover real commands from package scripts, CI, and nearby tests. Until tooling
  exists, report that limitation rather than documenting imaginary commands.
- Use the smallest meaningful regression check for nontrivial logic. Prefer the
  existing harness; do not add a test framework for documentation or tests that
  merely mirror the implementation.
- Await and inspect each parallel check's exit status. A bare shell `wait` is not
  sufficient to propagate every background failure.
- Use dummy credentials and controlled provider boundaries for local tests.
  Never retrieve production secrets or make live provider writes just to complete
  a test without the necessary authorization.
- Separate local checks, remote CI, and live integration evidence. A build or
  mocked test does not prove Slack delivery, OAuth, persistent state, or deployment.
- Finish with what changed, the checks actually run, and any remaining limitation.
  Distinguish local work from committed, pushed, deployed, or otherwise verified
  remote results. Do not claim a feature is complete while required behavior is
  still missing.
