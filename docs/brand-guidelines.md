# Rove brand guidelines

The Rove identity is **Little Forager**: a soft cyan mushroom with an ivory stem
and two friendly black eyes. The character makes a company agent approachable;
mycelium provides a metaphor for connections between tools, skills and company
knowledge. The mark stays simple while those connections inform the wider story.

Write **Rove** in prose and **rove** in the wordmark. The character has no mouth,
spots, gills or network nodes. Keep its approved proportions and eye placement.
Use the [asset index](../public/brand/README.md) for the supplied files.

## Choose the right logo

Use the horizontal lockup for introductions and headers, the stacked lockup for
taller spaces, and the symbol alone for avatars and icons. Use the outlined SVG
wordmark when the character is already present nearby. SVG is the master format;
PNG exports are provided for applications that cannot display SVG.

| Background | Artwork |
| --- | --- |
| Midnight or another plain, dark surface | Full-color symbol with ivory wordmark |
| White or ivory | Black one-color symbol; use the supplied light-background lockup |
| Cyan | Black one-color artwork |
| Dark surface, one-color reproduction | White or cyan one-color artwork |

The ivory stem nearly disappears against white. Do not place the full-color
symbol directly on a light background. Use an approved light-background asset
or a midnight tile. On photography or a busy surface, use a plain midnight tile.
Use the supplied one-color artwork, which preserves the eyes and mushroom silhouette,
rather than applying one fill to the full-color SVG.

## Space and scale

Keep **one eye-height** of clear space around the visible artwork on every side:
24 units in the 256-unit symbol master, scaled with the logo. Clear space is
measured from the artwork, not the edge of a file or its transparent padding.
Keep the symbol, wordmark and their spacing together when resizing a lockup.

| Asset | Minimum screen size |
| --- | --- |
| Standard symbol | 32 px square |
| Small symbol / favicon | 16 px square; use below 32 px |
| Horizontal lockup | 160 px wide |
| Stacked lockup | 120 px wide |

The small cut enlarges the eyes for legibility. Use the supplied app-icon files
for platform crops; the maskable version has extra space around the character.
Print size depends on material and process: proof the actual reproduction before
approving embroidery, engraving or very small print.

## Palette

| Name | HEX | RGB | Approximate CMYK | Role |
| --- | --- | --- | --- | --- |
| Cyan | `#22d3ee` | 34, 211, 238 | 86, 11, 0, 7 | Mushroom cap and brand accent |
| Midnight | `#0b1220` | 11, 18, 32 | 66, 44, 0, 87 | Brand backgrounds and dark wordmark |
| Ivory | `#fff4df` | 255, 244, 223 | 0, 4, 13, 0 | Stem and wordmark on dark backgrounds |
| Black | `#000000` | 0, 0, 0 | 0, 0, 0, 100 | Eyes and one-color artwork |

HEX/RGB values are the digital reference. CMYK values are mathematical starting
points, not a press profile; approve a printer's proof for the chosen stock.
No Pantone match is specified.

Cyan on midnight has approximately **10.4:1** contrast; ivory on midnight has
**17.2:1**. Cyan on white is only **1.8:1**, so do not use it for ordinary text on
white. Product controls retain their semantic focus, error and disabled-state
colors in [DESIGN.md](../DESIGN.md). Never communicate status through color or
the character alone.

## Typography and motion

The wordmark uses **Fredoka SemiBold 600**, always lowercase. Final logo SVGs
contain outlined letterforms and do not need a font to render. Use the supplied
lockups rather than retyping or respacing the logo. In the live masthead, use the
local Fredoka font at weight 600 beside the inline symbol.

Product text uses **Inter** with system sans-serif fallbacks. Keep Fredoka for the
wordmark; avoid a third brand typeface. Local font files and their SIL Open Font
License notices are documented in [public/fonts](../public/fonts/README.md).
Retain those notices when distributing the fonts.

The mascot's motion reflects reply status only: idle eyes are open; thinking eyes
look upward and move gently side to side; an unsure pose narrows one eye after a
failed reply. Reduced motion keeps the thinking pose still. Success, leaving the
error context and disposal restore idle. Visible text remains the source of
status and error information. See the [avatar guide](../public/brand/README.md#live-avatar).

## Keep it consistent

- Use the approved files at their original aspect ratio, upright and unobstructed.
- Keep the cap cyan, stem ivory and eyes black in the full-color mark.
- Keep any mycelium-inspired illustrations outside the logo and away from controls.
- Preserve the supplied spacing and letterforms in the wordmark and lockups.
- Avoid added mouths, spots, roots, accessories, gradients, shadows or outlines.
- Keep the friendly character separate from claims about an integration's availability.

Masters and exports live in [public/brand](../public/brand/README.md). Follow
[DESIGN.md](../DESIGN.md) for interface patterns and [LICENSE](../LICENSE) for the
repository's license; the font files retain their separate OFL notices.
