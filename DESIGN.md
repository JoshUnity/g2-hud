# Phosphor: the design language for the G2 apps

The G2 draws green light on a clear lens. Black is not a colour, it is the
world behind the glass. Phosphor treats light as the only material.

## The medium

| Fact | Consequence |
|---|---|
| 576 x 288 per eye, monochrome green | Shapes and light, never colour |
| Text containers: one proportional font, 5 brightness levels (0-4), left/top aligned | Hierarchy comes from light, position and case, not size |
| Image containers: up to 4, each from 20 x 20 to 288 x 144, 16 grey levels | Rich graphics are tiled rasters drawn in code |
| Images are sent one at a time, at least 100 ms apart; a full screen takes about 800 ms | Motion is a budget: small, local, and only when it means something |
| The display lifts dark greys | Make quiet things quiet with **coverage** (stipple, dither), not only with dark greys |

## Principles

1. **Quiet by default.** Most pixels stay off. A still screen costs nothing.
2. **Light is depth.** Brighter is nearer and more important. Maps put major roads in front; a new answer is bright and then steps back.
3. **Motion means state.** Nothing moves for decoration. The header icon changes when the state changes; a ring pulses only on a critical incident. Each app has one opening that plays once.
4. **Glanceable in one second.** One status line, one main thing, the rest on demand.
5. **Text belongs to the font, pictures belong to the raster.** Text in images uses
   the 5 x 7 pixel font only for labels and numbers (distances, altitudes, the timer).
6. **Pixel-perfect.** Every pixel is on or off. No anti-aliasing and no soft edges. A dim thing uses a flat grey level or coverage (stipple, dither).
7. **An outline means "you can act on this".** Reading text has no frame. A view has at most one outlined element.
8. **Edge to edge.** Content sits at the lens edges. One header row: a 24 x 24 icon and the status on the left, the clock on the right.
9. **Mixed case.** Status lines read "Listening", not "LISTENING". Capitals are for the 5 x 7 labels in images.

## The board is the reference

The approved board is the reference for every screen. The build must match it 1 to 1.

- The lens is one 576 x 288 raster. It is sent as four 288 x 144 image tiles (`LENS_TILES` in `src/core/board.ts`). The glasses-font text sits in text containers on top.
- The board's drawing engine is `test/board/hud.cjs`. It is a verbatim copy. Never edit it.
- `Canvas` draws like the engine: use `lensCanvas()`. The last write wins, black included, and `lv(a)` turns a board alpha into the 0-255 value of its level.
- A screen is done when two tests pass. The pixel test draws the screen and compares every pixel with the board frame. The text test compares each glasses-text line (words, x, y, light) with the board's text.
- `test/board/reference.ts` makes the board frame and its text. `test/board/compare.ts` compares them and writes a diff picture.
- Each test is `test/board-<app>.test.ts` (answers, code, hackos, around, sky).
- Not compared: the letter shapes of the glasses font (the board uses another font, so text is compared as data), and frame rates on the glasses.

## Demos supply input only

A demo (`?demo=<scene>`) gives an app the same data the server or Loops would give. It never draws, and it never chooses a state. The screen comes from the one live code path. A demo cannot show something that the live path cannot.

Each app has a live-path test: the real `main.ts`, with no demo, fed with real protocol messages.

| App | Test |
|---|---|
| Answers | `test/answers-live.test.ts` (and `test/answers.test.ts`) |
| Around | `test/around-live.test.ts` |
| Code, HackOS | `test/ptt.test.ts`; HackOS also in `test/hackos.test.ts` |
| Sky | `test/skyemergency.test.ts` feeds a real `osint` message; `test/sky.test.ts` boots the page on a demo feed and checks the frame rate on a live feed |

## Layout

The lens is one 576 x 288 raster, cut into four 288 x 144 image tiles (ids 1 to 4, `LENS_TILES` in `src/core/board.ts`). The glasses font sits in text containers on top, at the places where the board puts its text. Everything else is in the raster: the icon, the clock (pixel digits, scale 2, ending at x 576), the hairline at y 30, the meter, the tab squares and every picture. Measured in the simulator.

| Text | x | y | Notes |
|---|---|---|---|
| Status | 32 | 0 | Sky: x 332 |
| Question or prompt | 0 | 36 | Two lines, or one |
| Body | 0 | 72 | 8 lines of 27 px. It takes the input |
| Hint | 0 | 255 | One line |

| Rule | Why |
|---|---|
| Line height is 27 px (`LINE`). Every text box is a whole number of lines | The firmware draws a scroll bar when text does not fit the box. One line too many shows a 4 px bar at the right edge |
| Padding is 0 on every box | Edge to edge |
| Every container sets `zOrderIndex`: the tiles 1 to 4, the text 10 and up | Text must sit in front of the pictures |
| The body takes the input | One event capture per page |
| One outlined element at most, and only for something you can act on | The approval card in Code, drawn in the raster |
| One page for each app. A state changes the text and the raster, never the page | A page rebuild flickers |

## Icons

Each app has one 12 x 12 cell bitmap, `ICON` in `src/<app>/icon.ts`. It is used three ways.

| Use | Cell | Size |
|---|---|---|
| Store icon | 2 x 2 px | 24 x 24 |
| Header icon, animated by state (`IconMark`) | 2 x 2 px | 24 x 24 |
| Launch intro | A 6 x 6 square on an 8 px pitch | 96 x 96 |

A grid is 12 rows of 12 characters: `#` lit, `+` dim (header and intro only), `.` off. `ORDER(row, col)` in the same file says when, from 0 to 1, a cell lights up in the intro.

`npm run icons` builds `apps/<app>/icon.png` from the grids and checks the portal rules. Commit the PNGs.

| Portal rule | Why |
|---|---|
| The PNG is 24 x 24 and at most 1 MB | Portal limits |
| Every pixel is fully transparent or opaque `#F4F4F4` | Portal limits |
| Lit pixels form raster-aligned 2 x 2 blocks | Portal limits |

## The intro

Every app opens with the same 1.6 second intro: the app's icon as a dot-matrix logo, with its name under it in real glasses text. It is the one planned motion in the system, so it shows state (the app is starting) and then it leaves.

| Beat | Time | What happens |
|---|---|---|
| Draw | 0 to 900 ms | The cells light up in the order of `ORDER` (ease-out cubic). A new cell is at full light for a moment, then settles to 184 |
| Name | 500 to 1000 ms | The name types in under the mark, one letter at a time, at light 4 |
| Pulse | 900 to 1250 ms | Every cell goes to full light and back |
| Out | 1300 to 1600 ms | Cells go dark one by one in a scattered order. The name steps back: light 3, 2, 1 |

| Rule | Why |
|---|---|
| Once per launch. A reload of the WebView never replays it | The host refuses a second start-up page, and a reload is not a launch |
| One image container, 96 x 96 at (240, 70), at 8 frames per second, and one text container for the name at y 184 | The mark is on the lens centre line. One send at a time |
| The name is mixed case, left-aligned at x = (576 - its pixel width) / 2 | The letters type in at their final places, so the name stays centred |
| The name is kept current with `textContainerUpgrade`: one at a time, only when the text or the light changed, the last one is the empty string | The glasses text is the one place the firmware draws a real font |
| Time-based. A slow link shows fewer frames, never a longer intro | Nothing waits for the animation |
| The mark goes dark by hiding whole cells, not by grey levels | Pixel-perfect, and the display lifts dark greys |
| The app builds its page after the last frame; the intro never holds input or data for more than its own length (and at most 3.1 s if the link hangs) | Quiet by default: the app must not wait on a flourish |
| An exit event during the intro ends it at once | No work after the app closes |
| `?intro=0` skips it. `?intro=<ms>` freezes it at that time | For development and screenshots |

An app passes `{ name, icon: ICON, order: ORDER }` to `playSplash` (see `src/sky/main.ts`). `npm run frames -- <app> <out.png>` draws a contact sheet of the intro with the name text at each time (`scripts/frames.ts`).

## Text

Text is measured in pixels with Even's own library, `@evenrealities/pretext`. It follows the firmware's font and kerning. Never count characters.

| Tool (`src/core/text.ts`) | Use |
|---|---|
| `LINE` = 27 | The line height in px |
| `textWidth(text)` | The width of one line |
| `fitPx(text, maxPx)` | One line, cut with "…" |
| `wrapPx(text, maxPx)` | Word wrap. Every line fits, so the firmware never wraps it again. Bullets hang; a word wider than the line is split |
| `clipPx(text, maxPx, lines)` | At most that many lines, "…" when cut |
| `paginatePx(text, lines, maxPx)` | Pages that also stay below the 960 byte cap |

Measured in the simulator: the line pitch is exactly 27 px, and the ink of a line is its predicted width minus 3 px (the right side bearing), for every string tried.

## Light scale (text brightness)

One scale for all five apps (`LIGHT` in `src/core/hud.ts`). If a level changes, change this table only.

| Text | Level |
|---|---|
| Body: the answer, the incident list, aircraft names, the approval call | 4 |
| Status line; notices and errors | 3 |
| Clock; the prompt or question; the recall cue and facts | 2 |
| Hints | 1 |

An Answers answer steps back in light after it is shown: 3 after 20 s, 2 after 30 s.

## Glyphs

Render on the G2 (in the simulator): `• · › » ● ○ ─ │ ▶ ■ … ♪ ← →` and curly quotes.
Do not use: `◦ ▸ ⏸ ✓ ✗ ⋯`. Severity uses `■ ● ○ ·` (critical to information).

## Pixel techniques

| Technique | Where | Why |
|---|---|---|
| Crisp lines, circles and discs (`Canvas`) | Everything drawn | Bresenham and midpoint shapes at one flat value, no in-between greys. `Canvas` has no anti-aliased path |
| Flat grey levels | Depth, state | One value per shape; hot is 255, settled is 184 |
| Stipple `[on, off]` | Street classes | Reads dimmer through coverage, robust on real optics. The pattern counts whole pixels along the line |
| Ordered dither, hatch, dot grid | Fades, water, parks | Material textures in light |
| Knockout halo | Markers, you, aircraft | Clears the map under a symbol so it stands out |
| Cleared bands | Around | The header and the two incident rows are cleared, so the glasses' own font sits on black |
| Tiling | Around (2 x 2), Sky (1 x 2 for the airspace) | One raster, sliced; only changed tiles are sent |
| Pixel font 5 x 7 | Labels in images | The glasses font cannot be drawn inside images |

## Type

Three voices. Each has one job.

| Voice | What it is | Use |
|---|---|---|
| Glasses font | Text containers, unchanged | Language: sentences, titles, questions, answers |
| Dot-matrix | The 5 x 7 font in an image, each pixel a dot (`Canvas.text(..., scale, true)`) | One hero number or name per screen |
| Micro caps | The 5 x 7 font at scale 1 | Labels and units: `ALT FT`, `ELAPSED`, `VAULT 214 NOTES` |

| Size | How | Use |
|---|---|---|
| Micro | Scale 1 (`Canvas.text`, `Canvas.label`) | Labels, units, captions. Dim (about 128) |
| Value | Scale 2, solid | Supporting numbers next to a label |
| Hero | Dots at scale 3, 4 or 6 (2 x 2, 3 x 3 or 5 x 5 dots) | The one number or name the screen is about |

`textRight` and `textCenter` align to an edge or a centre. `label` clears a box 2 px around itself, so it stays clear over a drawing. A label has no frame.

## Depth

3D is drawn crisp (`src/core/three.ts`, on a `Canvas`).

| Depth cue | How |
|---|---|
| Near, middle, far | Three flat light levels. A graph link is 115, 77 or 56; a node is 204, 140 or 115 |
| Far edges | Dotted `[1, 2]`, never a dim soft line |
| Far points | Smaller marks: 3 x 3, then 2 x 2, then one pixel |
| Focus | Bright (255), with a cleared halo, so it stands out |

Never use soft edges, blur or fog. Use 3D where it carries meaning: the vault, the files of a task, altitude, the city. Do not use it as decoration.

## Motion budget

One 288 x 144 image is about 5 frames a second on the glasses.

| Scene | Rule |
|---|---|
| A moving 3D scene | Fits one image container and turns slowly |
| A scene over two or more containers | 1 to 2 frames a second, or only when the data changes |
| A page | At most 4 image containers, each at most 288 x 144 and at least 20 x 20 |

## Outline

Only an element that a tap acts on is outlined. Reading text, labels and graphs have no frame. Today one element is outlined: the approval card in Code (drawn in the raster).

## Openings

Each app has one opening that fits it. The launch intro (see "The intro") comes first. The opening starts when the live picture shows for the first time.

| Rule | Why |
|---|---|
| An opening plays once, when the live picture first shows. It is not a loop | Motion means state: the app is loading its data |
| It is time-based. A slow link shows fewer frames, never a longer opening | Nothing waits for the animation |
| State wins. If the state leaves the one the opening is for, it ends at once | An answer, a cue, an approval or a speech must never wait |
| It uses only the image containers the app already has, at 2 to 5 frames a second | No page rebuild. One image send at a time |
| `?load=<0..1>` freezes it at that progress. `?load=off` skips it | For development and screenshots |
| A frozen opening sends one frame and no more | A still picture costs nothing |

| App | Name | Length | Where it plays | When it plays |
|---|---|---|---|---|
| Answers | The vault comes online | 3000 ms | Graph and card images, and the ribbon | After the page opens, while the state stays plain listening |
| Code | The project mounts | 2400 ms | The file map | When the tree of the shown tab first arrives, and again when the tab or project changes. An approval ends it |
| HackOS | The core boots | 2000 ms | The core image | When the first view arrives and the app is at rest |
| Around | The map loads in depth | 2400 ms | The four map tiles | Each time a map first appears (no picture, then a picture) |
| Sky | The radar acquires | 3000 ms | The airspace, the panel and the numbers | Each time the feed first goes live, and again when it returns to live |

## Demo scenes and parameters

Every app takes the same parameters in its page URL. A demo needs no server and no pairing key.

| Parameter | Effect |
|---|---|
| `demo=<scene>` | Shows a fixed scene. Names per app are below |
| `intro=0` | Skips the launch intro |
| `intro=<ms>` | Freezes the launch intro at that time |
| `load=<0..1>` | Freezes the opening at that progress |
| `load=off` | Skips the opening |

| App | Scenes |
|---|---|
| Answers | `idle`, `speaking`, `thinking`, `answer`, `long`, `sources`, `paused`, `saved`, `error`, `recall`, `cue` |
| Code | `idle`, `recording`, `transcribing`, `working`, `approval`, `approval-long`, `done`, `long`, `error`, `setup` |
| HackOS | `idle`, `recording`, `transcribing`, `waking`, `thinking`, `answering`, `done`, `long`, `error`, `setup` |
| Around | `1` (live), `quiet`, `nolink`, `stale`, `nofix` |
| Sky | `1` (live), `empty`, `nolink`, `stale`, `loops`, `nodata`, `nopos`, `nokey` |

## Answers

A voice ribbon and a 3D graph of your vault. The header icon is a ring round a bright core. The demo scenes use a vault of 40 sample nodes.

| Id | Name | Kind | x | y | Width | Height |
|---|---|---|---|---|---|---|
| 1 to 4 | t00, t10, t01, t11 | image tiles | 0 / 288 | 0 / 144 | 288 | 144 |
| 5 | status | text | 32 | 0 | 478 | 27 |
| 6 | question | text | 0 | 36 | 576 | 54 |
| 7 | body | text, takes input | 0 | 72 | 576 | 216 |
| 8 | hint | text | 0 | 255 | 576 | 27 |
| 9 to 12 | card1 to card4 | text | 304 | 82, 109, 154, 198 | 272 | 27 |

One fixed page serves every state (12 containers). Tiles have `zOrderIndex` 1 to 4 and text 10 and up. The raster holds the header (icon, 5-bar level meter at x 34, pixel clock, hairline), the voice ribbon (y 206 to 246), the vault graph (left, y 60 to 204) and the card (right). The meter shows while listening, thinking or showing an answer. Silent bars are 3 px dots. The four card lines are the recall card's text.

| Icon state | Form | Frames per second |
|---|---|---|
| Connecting | All dim | 0 |
| Listening | The core breathes every 0.8 s. A louder voice lights it from the middle out | 4, or 8 with a voice |
| Thinking | An arc of 8 ring cells runs round the ring | 8 |
| Answer | All lit; still | 0 |
| Paused | The core is off, the ring stays | 0 |
| Saved | Dark for 0.12 s, then fully lit until 0.5 s, then it breathes | 8, then 4 |
| Error | All dim, every third ring cell off | 0 |

| Screen | What shows |
|---|---|
| Listening | Status "Listening". The hint "Tap pause  ·  Double tap clear  ·  Hold save" on the last body line. The ribbon is live: a dotted baseline whose columns rise with your voice, newest sample in the middle |
| Recall (with a vault graph) | The vault turns in the graph. The person is ringed. Up to 3 linked notes are lit and labelled in micro caps. A dashed leader runs to the card. The card holds PERSON, the name in dots, the note and person counts. The card's text lines show beside it. The ribbon is off. It lasts 10 s |
| Recall (without a graph) | The cue takes the question: two lines, "NAME  ·  fact 1", then the next facts |
| Thinking | Status "Thinking". The question is quoted in the prompt. The body is empty |
| Answer | Status "Answer", with "  ·  2/3" on more than one page. 7 lines a page. The answer steps back in light: 3 after 20 s, 2 after 30 s |
| Answer with sources | The body is 440 px wide. The card shows the source orb: the vault, small, with the quoted notes lit, then "FROM N NOTES" and up to 3 titles |
| Paused | Status "Paused". The body says "Not listening." and "Tap to listen again." The ribbon is dim |
| Saved | A toast in the status: "Saved  ·  <title>" |
| Error | Status "Check setup". The error is in the body at light 3 |

The recall cue waits for room. It shows while listening, or under an answer that has dimmed (after 30 s). Tests and `src/answers/view.ts` hold the exact rules.

**Opening: the vault comes online (3000 ms).** Only in plain listening, with no answer, cue or error.

| Phase | Time | What happens |
|---|---|---|
| Ribbon | 0 to 750 ms | The baseline grows from the middle to both ends |
| Assemble | 240 to 2040 ms | The vault builds from the back to the front while it turns. The card shows "VAULT ONLINE", the note count running up in dots, "NOTES", and the people count at the right |
| Hold | 2040 to 2460 ms | The whole vault turns. Nothing is lit or labelled |
| Thin out | 2460 to 3000 ms | Nodes go dark one by one. The card goes blank |

The graph and the card draw at 5 frames a second. Without a vault graph only the ribbon plays.

## Code

A step rail, a dot-matrix timer and a 3D map of the project files. Code has one fixed page for every state, so an approval never rebuilds it. The tab menu is part of the page.

| Id | Name | Kind | x | y | Width | Height |
|---|---|---|---|---|---|---|
| 1 to 4 | t00, t10, t01, t11 | image tiles | 0 / 288 | 0 / 144 | 288 | 144 |
| 5 | status | text | 32 | 0 | 544 | 27 |
| 6 | prompt | text | 0 | 36 | 336 | 54 |
| 7 | body | text, takes input | 0 | 72 | 576 | 216 |
| 8 | steps | text | 18 | 100 | 270 | 108 |
| 9 | step | text | 18 | 100 | 270 | 108 |
| 10 | call | text | 20 | 96 | 536 | 54 |
| 11 | folder | text | 20 | 123 | 536 | 27 |
| 12 | hint | text | 0 | 255 | 576 | 27 |

Every container is on the page at all times (12 in all). One with nothing to show holds an empty string. The raster holds the header (icon, pixel clock, hairline, one square per tab), the step rail, the timer, the file map, and the approval card. The prompt wraps at 330 px.

The approval card is the one outlined element, and it is drawn in the raster, with a countdown bar and the tool tag. The call text sits in it: 2 lines of 27 px a page, 536 px wide, wrapped by pixels, so no line is cut and no character is lost. The folder line ("in <folder>") shows only when the call has one line. A call that needs the network says so on the card.

| Icon state | Used in | Form | Frames per second |
|---|---|---|---|
| Idle | Idle, done | The chevron and the full cursor block; still | 0 |
| Recording | Recording | The block is a low bar that rises with your voice | 8 |
| Busy | Transcribing, working | A one-column bar slides across the block, the rest dim | 6 |
| Approval | Approval | The block is hollow and blinks dim twice a second | 4 |
| Dim | Error, setup, connecting | All dim | 0 |

| Screen | What shows |
|---|---|
| Idle | Status "Code  ·  <project>". The file map at rest: still and dim, nothing touched. The hint "Hold talk  ·  Tap + hold tabs  ·  Double tap new" |
| Recording | Status "Listening  ·  release to send". The map at rest |
| Transcribing | Status "Transcribing". The map at rest |
| Working | Status "Working". The rail has one node per step row. Earlier steps are small solid nodes. The current step is a hollow node that blinks. The steps box shows the last 5 log lines: the current one at light 4, the earlier ones at light 2. The timer shows ELAPSED, the time in dots, the step and file counts, and the lines added and removed when the server sends them. The map turns, with touched files lit (read or edit). The current file is labelled |
| Approval | Status "Allow?", with "  ·  2/3" on more than one page. The call in the card, 2 lines a page. The call shows every field, not only the command. A countdown bar of 120 s (it keeps its time across a reconnect): solid for the time left, dotted for the time gone, with the time at the right end. The hint is "Swipe more  ·  Double tap deny" until the last page, then "Tap allow  ·  Double tap deny" |
| Done | Status "Done  ·  <stats>". The result in the body, paginated. No images |
| Error | Status "Check". The error in the body at light 3 |
| Setup | Status "Code  ·  Setup". The reason in the body |

The server sends the tree of the project (up to 12 top-level folders, with file counts) and the files the task touched (at most 24, newest first). It sends only paths and states, never file content.

**Opening: the project mounts (2400 ms).**

| Phase | Time | What happens |
|---|---|---|
| Root | 0 to 190 ms | Only the project node shows. The label "MAPPING PROJECT" is under the map |
| Folders | 190 to 1010 ms | Links grow from the root to the folders. Each folder node appears when its link completes |
| Files | 1010 to 1870 ms | Links grow to the file dots |
| Marks | From 2060 ms | The touched files get bright links and labels. The label under the map goes |

The map turns a little while it mounts, and ends at its resting angle. It draws at 5 frames a second.

## HackOS

A wireframe core that stands for the machine.

| Id | Name | Kind | x | y | Width | Height |
|---|---|---|---|---|---|---|
| 1 to 4 | t00, t10, t01, t11 | image tiles | 0 / 288 | 0 / 144 | 288 | 144 |
| 5 | status | text | 32 | 0 | 340 | 27 |
| 6 | prompt | text | 0 | 36 | 576 | 27 |
| 7 | body | text, takes input | 0 | 72 | 576 | 189 |
| 8 | sentence | text | 222 | 176 | 354 | 27 |
| 9 | hint | text | 0 | 255 | 576 | 27 |

One fixed page serves every state (9 containers). The raster holds the header, the core, the counter, the speed bars (with "TOK/S") and the footer. There are two layouts. While the GPU wakes, the core is on the left and the counter on the right, with the sentence beside it. In every other state the answer is on the left and the core on the right.

The header icon is two posts with a pair of eyes. A signal bar in rows 5 and 6 carries the state.

| State | Icon | Core | Core fps |
|---|---|---|---|
| Off (connecting, setup, error) | All dim, no bar | Dim, every third edge missing | 0 |
| Idle | Still | Quiet, still | 0 |
| Recording | The dashes grow outward with your voice (3 steps) | Three flat light steps with your voice | 5 |
| Working (transcribing, thinking) | The dashes march along the bar | Bright, turns fast, with an orbit ring and a moving dot | 5 |
| Waking | The bar fills from left to right, then starts again | The 30 edges light one by one over 60 s, with the orbit ring | 5 |
| Answering | Still | Bright, turns slowly | 2 |

| Screen | What shows |
|---|---|
| Idle | Status "HackOS  ·  <model>". The hint "Hold talk  ·  Double tap new chat" |
| Recording | Status "Listening  ·  release to send". The body says "Speak…" |
| Transcribing | Status "Transcribing" |
| Waking | Status "Waking the GPU". The counter shows GPU COLD START, the seconds in dots, "SEC", and a row of 30 squares that fills over 60 s. The body says "The GPU was asleep. The first answer takes about a minute." |
| Thinking | Status "Thinking  ·  Ns" |
| Answering | Status "Answer". The text streams in with a caret |
| Done | Status "HackOS  ·  <stats>". The answer, paginated |
| Error | Status "Check". The error in the body at light 3 |
| Setup | Status "HackOS  ·  setup" |

**Opening: the core boots (2000 ms).** Only when the first view arrives and the app is at rest.

| Phase | Time | Label | What happens |
|---|---|---|---|
| Points | 0 to 600 ms | CORE | The 12 vertices appear one by one |
| Links | 600 to 1700 ms | LINKING | The 30 edges draw in |
| Online | 1700 to 2000 ms | CORE ONLINE | The whole core, then it rests |

The core draws at 5 frames a second.

## Around

The city in 3D perspective, seen from where you stand. One 576 x 288 picture, cut into four tiles. The camera is 220 m behind you and 167 m up, and looks north. The ground runs to a horizon at y 44.

| Id | Name | Kind | x | y | Width | Height |
|---|---|---|---|---|---|---|
| 1 to 4 | t00, t10, t01, t11 | image tiles | 0 / 288 | 0 / 144 | 288 | 144 |
| 5 | status | text | 32 | 0 | 480 | 27 |
| 6 | row1 | text, takes input | 22 | 232 | 440 | 27 |
| 8 | row2 | text | 22 | 259 | 440 | 27 |

One fixed page (7 containers). The header (icon, pixel clock, hairline at y 30, the heading tape NW, N and NE) and the bottom band from y 226 are drawn in the picture. Both bands are cleared, so the glasses' own text sits on black. The icon has one form: no states.

| Screen | What shows |
|---|---|
| Live | Roads by class (major roads in front, minor ones stippled), water hatched, parks as dot lattices, range rings at 250 and 500 m, a dotted wedge where you face, vehicles as 2 px dots, aircraft. Incidents stand as beacons (see below). Two incident rows a page, each with a severity mark, a distance and an arrow. The list holds only incidents of severity 2 and 3, the most severe first, then the nearest; the others show on the map only |
| Blocks | When the feed sends buildings (the server drops one with a point more than 1,200 m from the map centre or a ring wider than 400 m), up to 40 wireframe blocks within 900 m: the footprint, the roof at the real height and a few corner posts. Near blocks (300 m) are bright. Without buildings Around draws no blocks |
| Quiet | No incidents: the rows say so |
| Notice | No pairing key, no link, a stale feed or no fix: the notice takes row 1 and the moving layers stop. With no fix the picture says "WAITING FOR A POSITION" |

A beacon is a stalk from the ground point up to a badge. The stalk is 30, 46 or 70 m high for severity 1, 2 or 3. The badge is a circle, a hollow diamond or a filled diamond. A critical incident (severity 3) also has a ring on the ground that grows from 30 to 74 m every 4 s. That ring is the one moving thing, at 1 frame a second.

**Opening: the map loads in depth (2400 ms).** The scan front is eased (smoothstep).

| Phase | What happens |
|---|---|
| Front | A bright dotted row moves from your feet (y 226) to the horizon (y 44). Two dimmer rows trail it. Labels show "MAPPING" and the distance of the front, from "0M" to "1.6KM" |
| Rise | Ground above the front is not there yet. A road, a beacon or a block appears when the front passes its foot, and rises over 26 rows |

The picture draws at 2 frames a second during the opening.

## Sky

The airspace in 3D, with each aircraft on a stalk at its real altitude, and an instrument panel for the aircraft you pick.

| Id | Name | Kind | x | y | Width | Height |
|---|---|---|---|---|---|---|
| 1 to 4 | t00, t10, t01, t11 | image tiles | 0 / 288 | 0 / 144 | 288 | 144 |
| 5 | status | text | 332 | 0 | 182 | 27 |
| 6 | list | text, takes input | 300 | 134 | 276 | 81 |

One fixed page (6 containers). The airspace, the panel, the numbers and the clock are in the raster. The icon (an aircraft from above) is drawn at x 300, y 2. It has one form.

| Part | What shows |
|---|---|
| Airspace | A tilted disc of 60 km with a square-root range scale, so near aircraft get room. Rings at 2, 10 and 30 km. N, E, S and W. A mast with an altitude ladder (10K to 40K). A sweep that turns at 1 frame a second while aircraft are in range |
| Aircraft | A stalk from the ground point up to the glyph at its altitude. The glyph points along its track. Far ones are drawn first. A label (callsign, altitude) shows beside each one except the selected one. An emergency has a ring |
| Selected aircraft | Four corner brackets round the glyph |
| Panel and numbers | "N IN RANGE", then NEAREST, SELECTED or EMERGENCY, the callsign in dots, a bearing arrow with the compass point and degrees, TRK, and the tiles ALT FT, DIST KM and SPD KT |
| List | The next 3 aircraft by distance, wrapping round to the nearest, with altitude and distance in the numbers image. A notice replaces the rows when the feed fails |

**Opening: the radar acquires (3000 ms).** With nothing in range it ends at 1320 ms, after the ladder.

| Phase | Time | What happens |
|---|---|---|
| Rings | 0 to 900 ms | A bright dotted ring grows out. Its range shows under it. The rings stay behind it |
| Ladder | 900 to 1320 ms | The mast and the ladder rise |
| Sweep | 1320 to 3000 ms | One clockwise turn from north. An aircraft is found when the sweep passes its bearing, and it rises from the disc to its altitude over the next 45 degrees. The panel shows ACQUIRING until then |

All four images draw at 2 frames a second during the opening. If an aircraft has an emergency, Sky skips the opening.

## Apps

| App | Screen |
|---|---|
| **Answers** | Icon and level meter top left, status beside them. The prompt holds the quoted question. The body holds the answer, 7 lines a page. The vault graph and the voice ribbon sit under it. A known person named for the first time shows in the graph with a card for 10 s |
| **Around** | Full-screen map in perspective (4 tiles); status and two incidents on a cleared band |
| **Sky** | The airspace in 3D (2 tiles) on the left; the instrument panel and the list on the right |
| **Code** | Icon and state top left. The step rail, steps, timer and file map while it works. A separate page for an approval |
| **HackOS** | Icon top left, the wireframe core on the right. Your message, then the answer, beside the core |

## Input

| Rule | Why |
|---|---|
| A hold (Code, HackOS) ends by itself after 60 s (`MAX_HOLD_MS`). The audio is dropped and the lens says "Recording stopped after 60 seconds. Nothing was sent. Hold and speak again." | A lost release must not record for ever |
| A hold also ends without sending when the system menu opens or closes, the app exits, the socket drops or the page is hidden | Only a real release sends speech |
| The server has its own limit of 90 s per recording (`MAX_RECORDING_MS`). It must stay above the page limit | The page stops first; the server is the backstop |
| A second press during an open hold starts the recording over | After a lost release, only the new words go out |
| `code_ptt` and `hack_ptt` take an optional `discard: true` on release. The server drops the audio and runs nothing. A closed connection drops its hold | Client and server must be deployed together |
| Code approvals: the whole call, in pages of 2 lines, wrapped by pixels to 536 px (`approvalPages`, `CALL_WIDTH`). A tap allows only on the last page, after 0.7 s (`MIN_SEEN_MS`), and is sent 0.4 s later (`ALLOW_DELAY_MS`). The server ignores an Allow less than 0.7 s after the request is shown. A double tap denies at once. The page is not rebuilt: the card is in the raster | A tap that opens the system menu must never allow |
| Sky: a swipe down selects the next aircraft out, a swipe up the next one in. The ends stay put. A tap returns to the nearest. An aircraft that leaves range drops the selection | The list follows the selection, so no paging is needed |
| A hold during TRANSCRIBING is refused (Code, HackOS), on the page and on the server. A double tap or Stop from any connection cancels the instruction in transcription | One instruction in flight per tab |
| Every page listens for the exit event from the moment the bridge exists (`onExit` in `src/core/events.ts`). On system exit all five pages stop their loops and close the socket without reconnect. FOREGROUND events only drop a hold and cancel a pending allow | No work after the app closes |
| Double tap starts a new session or chat only 1.5 s after a run ended | A double tap that ends a stop must not start over |

## Check before shipping

Measured in the simulator (it says it matches the firmware, but may not in every case):

| What | Result |
|---|---|
| Font pitch and width | A line is 27 px. The ink of a line is its predicted width minus 3 px |
| Hairline, scroll bar, glyph set | 28 "─" fit; one line too many shows a bar; the glyph list above |
| Containers and layout | Every page of the five apps opens with its container table above |
| Intros, openings and demo scenes | Each draws, ends, and `load` and `intro` freeze them |
| Image sending | One image at a time; unchanged tiles are not sent again |

Still to check on the real glasses:

| What | Why |
|---|---|
| Frame rates (2 to 8 a second for the images) | The link speed and the firmware set the real rate |
| The stacking order of image and text containers (`zOrderIndex`) | Text must sit in front of every image it overlaps: the ribbon, the graph, the steps over the rail, the list over the numbers |
| Brightness levels (text 1 to 4, image greys, the "dim" values 77 to 128) | The display lifts dark greys. The light scale needs a real look |
| The openings over a real link | They are time-based, but a slow link may show only a few frames |
| The approval taps (tap, double tap, "tap, then hold") | The firmware may send a tap before a double tap. Not checked on glasses |
| The card change on a Code approval (the card appears in the raster; there is no rebuild any more) | Check that the change does not flicker on a real link |
| A blank image container without `zOrderIndex` | Does a blank image hide the text under it on hardware? The pages set `zOrderIndex` on every container, so this is untested |
| The Code page when the tab menu is open | The menu is part of both pages |

Tune the numbers where they live: the answer lines and widths in `src/answers/view.ts`, the approval card in `src/code/layout.ts`, the HackOS body width in `src/hackos/view.ts`, and each opening's length next to its drawing code.
