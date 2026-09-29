---
name: Rove
description: Dark administration interface with original cyan accents
colors:
  canvas: "#0b1014"
  surface: "#141c22"
  ink: "#e6f1f5"
  quiet: "#a6bac4"
  on-cyan: "#082f3b"
  cyan: "#22d3ee"
  cyan-hover: "#67e8f9"
  cyan-pressed: "#06b6d4"
  tint: "#123640"
  line: "#30444f"
  field-line: "#637e8c"
  focus: "#67e8f9"
  danger: "#fda4af"
  danger-surface: "#381e28"
typography:
  wordmark:
    fontFamily: "Fredoka, ui-rounded, sans-serif"
    fontSize: "2rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0"
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "2.5rem"
    fontWeight: 720
    lineHeight: 1.15
    letterSpacing: "-.03em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 680
    lineHeight: 1.35
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "1rem"
    lineHeight: 1.5
  label:
    fontSize: ".875rem"
    fontWeight: 650
  recovery-key:
    fontFamily: "ui-monospace, monospace"
    fontSize: ".875rem"
rounded:
  step: "6px"
  control: "8px"
  panel: "16px"
  badge: "999px"
spacing:
  field: "11px 14px"
  button: "11px 20px"
  panel: "32px"
  panel-mobile: "24px"
components:
  button-primary:
    backgroundColor: "{colors.cyan}"
    textColor: "{colors.on-cyan}"
    rounded: "{rounded.control}"
    padding: "{spacing.button}"
    width: "100%"
  button-primary-hover:
    backgroundColor: "{colors.cyan-hover}"
  button-primary-active:
    backgroundColor: "{colors.cyan-pressed}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "{spacing.button}"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.focus}"
    rounded: "{rounded.control}"
    padding: "11px 0"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "{spacing.field}"
  form-panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
    padding: "{spacing.panel}"
  badge:
    backgroundColor: "{colors.tint}"
    textColor: "{colors.focus}"
    rounded: "{rounded.badge}"
    padding: "5px 12px"
  error:
    backgroundColor: "{colors.danger-surface}"
    textColor: "{colors.danger}"
    rounded: "{rounded.control}"
    padding: "12px 14px"
---

# Design System: Rove

## Overview

**Creative North Star: "A clear installation worksheet"**

Rove is a dark-by-default administration interface with original cyan accents for focused company setup, conversations and model administration. A cute cyan round avatar and lowercase rove wordmark establish identity on the dark masthead; light ink, a deep canvas and subtly lighter working surfaces keep forms clear. Fredoka SemiBold gives the wordmark its friendly character; Inter keeps the working interface clear. Both fonts are served locally as WOFF2 with system fallbacks. The transparent SVG mark has two black eyes; no raster assets are required.

This document records the implemented `public/style.css`, `public/index.html`, `public/app.js`, `public/chat.js`, `public/brand/icon.svg` and local fonts in `public/fonts/`.

**Key Characteristics:**
- Dark masthead with cyan branding and primary actions.
- Quiet, spacious forms with persistent labels.
- Flat conversation workspace with a persistent account and settings entry point.
- Transparent cyan round avatar mark, lowercase Fredoka wordmark and Inter interface type.

## Colors

### Primary
Cyan identifies the round avatar mark, lowercase rove wordmark, primary actions and current setup step. The round avatar has two solid black eyes and no background shape. Its lighter hover and deeper pressed variants communicate action state. Dark on-cyan text is used on primary actions, text selection, the current setup number and active secondary buttons. Bright cyan focus outlines remain visible on dark surfaces; a deep teal tint supports secondary hover and the selected conversation.

### Neutral
The deep canvas surrounds subtly lighter forms and working surfaces. Light ink carries primary text; muted blue-gray supports descriptions and fully opaque placeholder text. Soft lines divide records, while stronger field lines distinguish editable controls. Light rose text on a dark rose surface identifies errors. Native browser controls use the dark color scheme by default.

## Typography

Use Inter throughout the interface, with the system UI stack as fallback. Local `inter-latin.woff2` covers weights 400–800. Reserve Fredoka SemiBold (600) for the lowercase rove wordmark, using local `fredoka-600-latin.woff2` with rounded sans-serif fallback. Both assets are preloaded and use `font-display: swap`; their OFL license files live alongside them in `public/fonts/`. No external font service is required. Headlines use the headline role, section headings the title role, and field labels the label role. The rove wordmark is 2rem at weight 600 with line height 1 and zero tracking. Supporting text ranges from .75rem to .875rem. Paragraphs cap at 68ch. Workspace headings use a compact 1.5rem size and 1.35 line height at every breakpoint; message labels use .8125rem. Message content caps at 72ch and preserves line breaks with long text wrapping. Recovery keys use the monospace role; conversation and system-instruction textareas retain Inter.

## Layout

The masthead content caps at 1200px, with a 76px minimum height and 16px 36px padding. Authentication is a centered single column capped at 680px, with 24px minimum side gutters and 48px top margin. Introduction, horizontal setup steps and form follow a clear vertical sequence.

The authenticated workspace caps at 1200px. A 260px sidebar contains conversation navigation above account identity and model settings. A soft vertical divider separates it from the dark chat or settings surface, which uses 32px 36px padding. The message history grows naturally above the composer; a compact heading and horizontal divider establish the current conversation. Model settings replace the chat within the same working surface rather than opening an overlay.

At 700px and below, the masthead wraps with 12px 20px padding and a 68px minimum height. Authentication gutters become 16px, authentication headings become 2rem, and form padding uses panel-mobile. Setup steps become vertical. The workspace becomes one column: conversation buttons form a horizontally scrolling row, account identity sits beside the settings action, and the working surface uses 24px 20px padding. Conversation buttons cap at 220px on mobile. Settings headings stack and composer actions wrap when needed.

## Elevation & Depth

Subtly lighter working surfaces sit on the deep canvas. Only authentication panels use the restrained shadow `0 12px 36px rgb(0 0 0 / 24%)`; the conversation and settings surfaces remain flat. The sidebar and user messages use the deeper canvas to distinguish them from the working surface. Borders separate navigation, headings and the composer without enclosing every section.

## Shapes

Controls and conversation buttons have softly rounded corners; forms and user-message surfaces use the broader panel radius from the frontmatter. Setup numbers are 28px squares with the step radius. The approved Rove mark is a transparent cyan round avatar SVG with two black elliptical eyes, displayed at 40px beside the wordmark with a 10px gap. The matching static SVG supplies the favicon. The mark is authored from a circle and two ellipses; its construction is documented in `public/brand/README.md`. Inputs have a 48px minimum height, buttons 46px, and checkbox label targets 48px.

## Components

Primary buttons fill authentication forms; chat and settings actions use their natural width. Dark bordered secondary buttons serve sign-out, retry, new conversation and settings navigation. Underlined text buttons connect sign-in and recovery. Button background and border transitions last 160ms with ease-out, and disappear under reduced-motion preferences. Disabled buttons use quiet text and line-colored fill and border, with a not-allowed cursor.

Inputs retain visible labels, stronger borders and bright cyan carets. Hover and keyboard focus brighten field borders. Placeholder text uses the quiet text tone at full opacity. Keyboard focus uses a 3px bright cyan outline with 3px offset. A skip link appears on focus; newly rendered page headings receive focus without a decorative outline. Recovery keys use a read-only textarea on the deep canvas and require a native confirmation checkbox before continuing.

Inline errors use alert semantics and a tinted surface; empty errors are hidden. Pending authentication forms disable submission, display “Please wait…” and set a busy state. Workspace requests disable conversation navigation, settings and submission until they finish. Sending displays a waiting status; failed messages keep their draft and expose a retry action. Failure feedback receives focus; a password mismatch focuses confirmation. The header contains the linked Rove mark, supporting label and conditional sign-out. Numbered setup steps mark the current step semantically; administrator identity remains visible in the workspace sidebar.

Conversation navigation uses quiet, single-line titles with ellipsis. The current conversation gains a deep teal fill, stronger border and semibold weight, with a semantic current-page marker. User messages use the deeper rounded canvas surface; Rove responses remain on the subtly lighter working surface. Both retain visible speaker labels. The composer has a persistent label, keyboard shortcut hint and plain-text multiline input; Enter inserts a line break and Ctrl or Command + Enter submits.

Model settings use the same labeled fields and focus treatment as authentication. The saved API key remains hidden behind a blank password field, with a hint describing retention or replacement. Inline save status distinguishes saved configuration from a verified provider connection. Empty chat states guide administrators to settings, and a failed initial load exposes a reload action.

## Do's and Don'ts

- Do keep Rove branding, cyan primary actions and dark working surfaces.
- Do preserve visible labels, keyboard focus, alert feedback and reduced-motion behavior.
- Do identify unavailable capabilities as unavailable.
- Don't add decorative imagery beyond the approved round avatar or motion unrelated to reply status.
- Don't substitute the pinned Fredoka wordmark or Inter interface fonts; keep their local assets and required attribution.
- Don't present planned integrations as working controls.

The inline avatar holds idle, thinking and unsure expressions. Only a pending chat reply starts the 1400ms side-to-side eye sweep; errors hold a still unsure pose. Success, leaving the error context and disposal restore idle. Reduced motion keeps the thinking pose but removes animation and transitions. Text status remains the accessible source of feedback.
