# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Companies deploying their own general AI agent; the initial user is the company administrator setting up a self-hosted instance.

## Product Purpose

Rove is a company-neutral agent framework that companies teach their workflows through reviewed Agent Improvement Proposals (AIPs).

## Capabilities and Constraints

Web is the default setup, administration and conversation surface. Slack is the first optional external channel. No CLI for the MVP. Docker and Railway deployment must work without mandatory Vercel services. One company per deployment; one initial admin. Email/password login, deployment-secret-protected setup, no public registration, and account recovery are agreed. This implementation includes authentication, an administrator-only web chat, saved conversations, and web configuration of an OpenAI-compatible model endpoint and system instructions. The MVP includes administrator approval for each tool call, Markdown skills, declarative skill-bundle plugins, remote Streamable HTTP MCP, optional signed Slack events/interactivity, and source-conversation AIPs finalized through GitHub draft PRs. Adoption requires a separate approval and verified merged skill content. Chat uses bounded, non-streaming text requests and one active reply per deployment.

## Product Principles

- Company knowledge and business rules belong to the deployment.
- Suggestions are reviewable proposals, not permission to make changes.
- Prefer simple installation and established authentication.
- Never present planned integrations as working features.

## Brand Commitments

Name: Rove, with lowercase rove in the wordmark. The pinned identity is a cute cyan round avatar SVG with two black eyes and a transparent background, paired with Fredoka SemiBold (600) for the wordmark and Inter for interface text. Keep dark mode as the default with cyan accents and light text, documented in DESIGN.md. Serve the font assets locally and preserve their OFL licenses. AIP means Agent Improvement Proposal. Preserve required attribution for any third-party material.
