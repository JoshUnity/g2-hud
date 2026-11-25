# Phosphor: the design language for the G2 apps

The G2 draws green light on a clear lens. Black is not a colour, it is the
world behind the glass. Phosphor treats light as the only material.

## The medium

| Fact | Consequence |
|---|---|
| 576 x 288 per eye, monochrome green | Shapes and light, never colour |
| Text containers: one proportional font, 5 brightness levels (0-4), left/top aligned | Hierarchy comes from light, position and case, not size |
| Image containers: up to 4, each at most 288 x 144, 16 grey levels | Rich graphics are tiled rasters drawn in code |
| Images are sent one at a time, at least 100 ms apart; a full screen takes about 800 ms | Motion is a budget: small, local, and only when it means something |
| The display lifts dark greys | Make quiet things quiet with **coverage** (stipple, dither), not only with dark greys |

## Principles

1. **Quiet by default.** Most pixels stay off. A still screen costs nothing.
2. **Light is depth.** Brighter is nearer and more important. The Sigil shades its
   back edges dim and its front edges bright; maps put major roads in front.
3. **Motion means state.** Nothing moves for decoration. The Sigil turns when it
   listens and spins when it thinks; a ring pulses only on a critical incident.
4. **Glanceable in one second.** One status line, one main thing, the rest on demand.
5. **Text belongs to the font, pictures belong to the raster.** Text in images uses
   the 5 x 7 pixel font only for labels (callsigns, distances).

## Light scale (text brightness)

| Level | Name | Use |
|---|---|---|
| 4 | primary | The answer, the incident list, aircraft names |
| 3 | near | Errors; an answer stepping back after 20 s |
| 2 | secondary | Status lines, the question, the recall cue, an answer after 30 s |
| 1 | ambient | Clock, hints |

## Glyphs

Render on the G2 (in the simulator): `• · › » ● ○ ─ │ ▶ ■ … ♪ ← →` and curly quotes.
Do not use: `◦ ▸ ⏸ ✓ ✗ ⋯`. Severity uses `■ ● ○ ·` (critical to information).

## Pixel techniques

| Technique | Where | Why |
|---|---|---|
| Anti-aliased lines (Wu) | Everything drawn | Uses the in-between grey levels for smooth edges |
| Stipple `[on, off]` | Street classes | Reads dimmer through coverage, robust on real optics |
| Ordered dither, hatch, dot grid | Fades, water, parks | Material textures in light |
| Knockout halo | Markers, you, aircraft | Clears the map under a symbol so it stands out |
| Dithered fade band | Around | A clean floor for the glasses' own font over a raster |
| Tiling | Around (2 x 2), Sky (1 x 2) | One raster, sliced; only changed tiles are sent |
| Pixel font 5 x 7 | Labels in images | The glasses font cannot be drawn inside images |

## The Sigil (Answers)

A wireframe icosahedron, rendered in software with perspective and depth shading.

| State | Form | Frames per second |
|---|---|---|
| Listening, quiet | Slow turn, gentle breath | 3 |
| Hearing speech | Swells and ripples with your voice level | 8 |
| Thinking | Fast spin with an orbit ring and trail | 8 |
| Answer | Lands with a shockwave, then a bright core | 8, then 2 |
| Paused | Folded flat into a ring; still | 0 |
| Saved | Two rings pulse outward | 8 |
| Error | Broken edges, dim | 2 |

## Apps

| App | Screen |
|---|---|
| **Answers** | Sigil top left, status and question beside it, the answer in a rounded card. A known person named for the first time raises a two-line recall cue in the question's place for 10 s |
| **Around** | Full-screen map from Loops (4 tiles); status and two incidents on a faded band |
| **Sky** | Full-height radar (2 tiles) with sweep and trails; aircraft list on the right |
| **Code** | The Code mark top left, tab dots and state beside it, the prompt, then steps or the result in the card |
| **HackOS** | Sigil top left (still at rest, spins while the GPU wakes or thinks), status beside it, your message, then the answer in the card |

## Input

| Rule | Why |
|---|---|
| A hold (Code, HackOS) ends by itself after 60 s (`MAX_HOLD_MS`). The audio is dropped and the lens says "Recording stopped after 60 seconds. Nothing was sent." | A lost release must not record for ever |
| A hold also ends without sending when the system menu opens or closes, the app exits, the socket drops or the page is hidden | Only a real release sends speech |
| The server has its own limit of 90 s per recording (`MAX_RECORDING_MS`). It must stay above the page limit | The page stops first; the server is the backstop |
| A second press during an open hold starts the recording over | After a lost release, only the new words go out |
| `code_ptt` and `hack_ptt` take an optional `discard: true` on release. The server drops the audio and runs nothing. A closed connection drops its hold | Client and server must be deployed together |
| Code approvals: pages of 5 lines of 31 characters (`APPROVAL_CHARS`; 31 x 18 px = the card width). A tap allows only on the last page, after 0.7 s, and is sent 0.4 s later. The server ignores an Allow less than 0.7 s after the request is shown. A double tap denies at once | A tap that opens the system menu must never allow |
| A hold during TRANSCRIBING is refused (Code, HackOS), on the page and on the server. A double tap or Stop from any connection cancels the instruction in transcription | One instruction in flight per tab |
| On system exit all five pages stop their loops and close the socket without reconnect. FOREGROUND events only drop a hold and cancel a pending allow | No work after the app closes |
| Double tap starts a new session or chat only 1.5 s after a run ended | A double tap that ends a stop must not start over |

## The Code mark (Code)

A terminal prompt, a chevron and a cursor block, drawn in code at 64 x 64 with anti-aliased lines. The cursor carries the state.

| State | Form | Frames per second |
|---|---|---|
| Idle | Chevron and full cursor block; still | 0 |
| Recording | The cursor is a low underscore that rises toward a full block with your voice | 4 to 8 |
| Working | A narrow bar slides to and fro across the cursor cell, with a fading trail | 8 |
| Waiting for approval | The cursor turns hollow, and the whole mark pulses once a second | 4 |
| Done | The cursor rises into place as the prompt steps in, then rests | 8, then 0 |
| Error | Dim, with the chevron broken and the cursor split into three slices out of line | 0 |
| Off (connecting, setup) | The idle form, dim | 0 |

Light is depth in the mark: the cursor is at full light (255) and the chevron is a step back (210). Error and off are at 120. About 13% of the 64 x 64 pixels are lit.

Tabs show as dots before the status: `●` this tab, `!` a tab waiting for you, `○` the others.

## Check before shipping

Fonts, glyphs, grey levels and timing are measured in the simulator, which says it
matches the firmware but may not in every case. Check every screen on the real
glasses, and tune `CARD_CHARS`, `CARD_LINES` and frame rates there.
