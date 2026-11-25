`hud.cjs` is the approved board's drawing engine, copied verbatim on 2026-11-25. Never edit it.
Tests compare the build with it, pixel for pixel (`reference.ts`, `compare.ts`).
To see a frame, call `writeDiffPng` from `compare.ts`; the glasses font is not the board's font, so text is compared as data.
