# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Companies deploying their own general AI agent; the initial user is the company administrator setting up a self-hosted instance.

## Product Purpose

Rove is a company-neutral agent framework that companies teach their workflows through reviewed Agent Improvement Proposals (AIPs).

## Capabilities and Constraints

Web is the default setup, administration and conversation surface. Slack is the first optional external channel. No CLI for the MVP. Docker and Railway deployment must work without mandatory Vercel services. One company per deployment; one initial admin. Email/password login, deployment-secret-protected setup, no public registration, and account recovery are agreed. This implementation includes authentication, an administrator-only web chat, saved conversations, and web configuration of an OpenAI-compatible model endpoint and system instructions. The MVP includes administrator approval for each tool call, Markdown skills, local skill bundles, versioned Agent Plugin releases from approved GitHub repositories, remote Streamable HTTP MCP, optional signed Slack events/interactivity, and source-conversation AIPs finalized through GitHub draft PRs. AIP activation requires explicit review of the final PR revision, a matching merged commit and verified release workflow/artifact, followed by separate activation. Plugin settings and secret bindings are owned by the dashboard; release content is immutable. Installed releases can be deactivated, upgraded or rolled back independently of core. User Plugins provide offline tools, dashboard actions, text pages and agent workflow steps through the shared approval path. Execution uses fresh Railway sandboxes and checks containment before loading source; live Railway compatibility remains unverified. Channel Plugins support an installed signed JSON gateway. Bundled Slack remains the transitional channel implementation; external plugin repositories and the marketplace come later. Chat uses bounded, non-streaming text requests and one active reply per deployment.

PostgreSQL with pgvector is the durable store; Redis coordinates core ownership,
active turns and credential attempt limits. Both are required. Deploy one active
Rove core with persistent PostgreSQL and Redis services; the app container needs
no persistent volume. The vector extension prepares the database for later work,
without adding semantic retrieval. New installations start with a fresh
PostgreSQL database. Storage upgrades and backups are operator-managed;
automatic import from older storage formats is not included.

## Product Principles

- Company knowledge and business rules belong to the deployment.
- Suggestions are reviewable proposals, not permission to make changes.
- Prefer simple installation and established authentication.
- Never present planned integrations as working features.

## Brand Commitments

Name: Rove, with lowercase rove in the wordmark. The pinned identity is a cute cyan round avatar SVG with two black eyes and a transparent background, paired with Fredoka SemiBold (600) for the wordmark and Inter for interface text. Keep dark mode as the default with cyan accents and light text, documented in DESIGN.md. Serve the font assets locally and preserve their OFL licenses. AIP means Agent Improvement Proposal. Preserve required attribution for any third-party material.
