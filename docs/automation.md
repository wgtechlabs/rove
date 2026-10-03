# Build and release automation

[Back to Rove](../README.md)

[Build Flow](../.github/workflows/build-flow.yml) uses WG Tech Labs'
[Build Flow Action](https://github.com/wgtechlabs/build-flow-action) to run CI,
Release Build Flow Action and Container Build Flow Action together.

- Pushes and PRs targeting `dev` or `main` run Biome,
  type checking, integration tests, a production build, Gitleaks, and the Docker
  smoke test. CI starts PostgreSQL 18 with pgvector and authenticated Redis 8.2
  from `compose.yaml` before integration tests. The isolated container smoke test
  reuses those service definitions under a separate Compose project with random
  host ports and disposable credentials. It verifies pgvector availability,
  Redis authentication and append-only persistence, saved login and chat after
  storage restarts, and graceful shutdown.
- Only pushes to `main` can publish. Clean Commit history determines the release
  version. The flow updates `package.json` and `CHANGELOG.md` and creates the tag,
  builds and publishes `wgtechlabs/rove` to Docker Hub and GHCR for Linux AMD64 and ARM64,
  then publishes the GitHub Release after the image succeeds. A failed image
  build or push can leave the version commit and tag without a GitHub Release.
- PR, `dev` and manual runs validate without publishing. npm publishing
  is disabled. Use `dev` for integration and promote reviewed changes to `main`
  through the repository's Clean Flow.

Releases use the built-in **`GITHUB_TOKEN`**, including Git checkout credentials;
no `GH_PAT` is used. Make `DOCKER_HUB_USERNAME`, `DOCKER_HUB_ACCESS_TOKEN`
and `GITLEAKS_LICENSE` available to the repository through GitHub Actions secrets.
Organization secrets must have an access policy that includes this repository;
private repositories on GitHub Free need repository-level secrets instead. See
[GitHub’s secret access rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets#creating-secrets-for-an-organization).
Gitleaks needs its license for CI; Docker Hub credentials are needed for
publishing. Fork PRs do not receive these secrets. Branch rules must permit
the release automation's version commit and tag on `main`.

Container source, Dockerfile and image scans use Trivy's default reporting mode;
vulnerability findings do not block publication. CodeQL security scanning and
SARIF uploads are currently disabled in the workflow. Review these settings
when enabling GitHub security scanning. GitHub's separate Code Quality workflow
remains unchanged.

The top-level reusable workflow is pinned to v0.2.1's commit. Its upstream nested
CI workflow still follows the mutable `v0` tag. Enabling this workflow does not
publish an image or create a release until a qualifying `main` push occurs.

The pinned release detector needs an explicit `release-major-keywords` pattern
for Clean Commit's `update! (scope):` syntax. The workflow preserves the default
breaking-change keywords and adds that pattern for both planning and finalization.
Keep it until the pinned detector supports this syntax directly. Release detection
excludes merge commits, so changing a release PR's title cannot supply a missing
breaking-change signal.
