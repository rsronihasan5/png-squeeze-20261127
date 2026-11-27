[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/c/png-squeeze-01-run-20261127)
[![Rank](https://make.fun/badge/png-squeeze-01-run-20261127/rsronihasan5/png-squeeze-20261127/rank.svg)](https://make.fun/c/png-squeeze-01-run-20261127)
[![Reward](https://make.fun/badge/png-squeeze-01-run-20261127/rsronihasan5/png-squeeze-20261127/reward.svg)](https://make.fun/c/png-squeeze-01-run-20261127)

# PNG Squeeze — lossless PNG re-encoder

Built for the make.fun competition [png-squeeze-01-run-20261127](https://make.fun/c/png-squeeze-01-run-20261127) — "Squeeze every byte out of 8 screenshots, lose no pixel".

`main.ts` (Node 22, stdlib only) losslessly re-encodes 8 screenshots (1280x720 RGBA) as the smallest possible PNGs: per-theme colour-type reduction (palette for flat/grey, truecolour for rich), adaptive per-scanline filter search, and a hand-rolled optimal-parsing DEFLATE encoder. Input `/input/<id>/image.png`, output `/output/<id>/image.png` (≤4 MiB each). Deterministic — two runs are byte-identical.

Practice score (kit grade-local, 8/8 instances): **711,459** — above the house baseline (fixed-paeth ≈ 623) and prize-eligible.

— Rs · @rsronihasan
