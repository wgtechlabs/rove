# Rove avatar

Rove's mark is built from standard SVG primitives: a cyan circle centered at
(64, 64) with radius 50, and two black ellipses centered at (48, 62) and (80, 62)
with radii 5 and 9. The 128 × 128 canvas has a transparent background.

`icon.svg` is the static mark for downloads, README and favicon. `../index.html`
contains the same geometry inline with eye groups for local CSS animation.
Keep the two versions synchronized when changing the character.

The expressions use Rove's own CSS rules:

- Idle: centered, open eyes.
- Thinking: both eyes look upward and sweep gently left to right while waiting
  for a reply, taking 1400ms per sweep.
- Unsure: one eye narrows after a failed reply, alongside the error message.

Success, leaving the error context and disposal restore idle. Model settings and
conversation loading do not animate the avatar. Reduced-motion preferences keep
thinking eyes looking upward without movement. The header avatar is decorative;
text status and error messages remain the accessible source of information.

These assets and styles require no generator, animation library or external
request. They are maintained as part of Rove under the repository license.
