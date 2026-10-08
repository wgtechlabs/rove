# Rove brand assets

**Little Forager** is Rove's approved mushroom character: cyan cap, ivory stem,
and two friendly black eyes. The wordmark is lowercase **rove**, set in Fredoka
SemiBold 600 and outlined in the downloadable SVGs. The full usage rules are in
the [brand guidelines](../../docs/brand-guidelines.md).

## Asset index

| Use | Files |
| --- | --- |
| Transparent full-color symbol, for dark backgrounds | [icon.svg](icon.svg), [512 px PNG](symbol-512.png) |
| Symbol below 32 px | [icon-small.svg](icon-small.svg) |
| One-color symbols | [Black](icon-black.svg), [white](icon-white.svg), [cyan](icon-cyan.svg) |
| Horizontal lockup | [Dark background](logo-horizontal.svg), [light background](logo-horizontal-light.svg), [1200 px PNG](logo-horizontal-1200.png) |
| One-color horizontal lockup | [Black](logo-horizontal-black.svg), [white](logo-horizontal-white.svg) |
| Stacked lockup | [Dark background](logo-stacked.svg), [light background](logo-stacked-light.svg) |
| One-color stacked lockup | [Black](logo-stacked-black.svg), [white](logo-stacked-white.svg) |
| Outlined wordmark | [Ivory](wordmark.svg), [midnight](wordmark-light.svg) |
| One-color wordmark | [Black](wordmark-black.svg), [white](wordmark-white.svg) |
| Browser tab | [favicon.svg](favicon.svg), [favicon.ico](favicon.ico), [16 px PNG](favicon-16.png), [32 px PNG](favicon-32.png), [48 px PNG](favicon-48.png) |
| App and touch icons | [app-icon.svg](app-icon.svg), [Apple touch icon](apple-touch-icon.png), [192 px PNG](icon-192.png), [512 px PNG](icon-512.png), [512 px maskable PNG](maskable-512.png) |
| Web icon metadata | [site.webmanifest](site.webmanifest) |
| Identity in context | [Brand overview](brand-overview.png), [presentation](presentation.html) |

Full-color SVGs are transparent; the app icons provide a midnight background for
platforms that crop the artwork. Use black one-color artwork on white or cyan;
use full color, white or cyan on a dark background. Do not place the ivory stem
directly on white. Keep the supplied proportions and clear space.

## Construction

The standard symbol has a `256 × 256` viewBox. Two filled paths draw the stem
and cap; two black ellipses form the eyes. In the source geometry, the eyes are
centered at `(109, 179)` and `(147, 179)`, each with radii `10 × 12`. The group is
optically raised by 3 units. The small cut keeps the eye centers and enlarges the
radii to `12 × 14` for favicon use.
There is no mouth, texture, background rectangle or external dependency in the
transparent master.

`icon.svg` is the static source for the full-size character. `../index.html`
contains the same geometry inline with eye groups for local CSS animation. Keep
these versions synchronized when changing the character; regenerate the small
cut and exports deliberately rather than resizing an unrelated variant.

## Live avatar

The expressions use Rove's own CSS rules:

- Idle: centered, open eyes.
- Thinking: both eyes look upward and sweep gently left to right while waiting
  for a reply, taking 1400ms per sweep.
- Unsure: one eye narrows after a failed reply, alongside the error message.

Success, leaving the error context and disposal restore idle. Model settings and
conversation loading do not animate the avatar. Reduced-motion preferences keep
thinking eyes looking upward without movement. The header avatar is decorative;
text status and error messages remain the accessible source of information.

The live avatar requires no generator, animation library or external request.
Static exports remain still. These assets and styles are maintained as part of
Rove under the [repository license](../../LICENSE). Font files keep their separate
[OFL notices](../fonts/README.md).
