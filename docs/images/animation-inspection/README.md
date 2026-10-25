# Animation inspection captures

Actual browser captures of the public getting-started rig, all from compiled model SHA-256 `746b27b042e1812afc6d077766cc38588c794b231d8a4e678de9991fa3bcc98d`. [Receipt and installed-package provenance](receipt.json).

- [Timeline](timeline.png): the original `hello` animation, 18 tracks and 2,070 exact key marks.
- [Curves](curve.png): the same build’s original `idle`, with its stored Bézier handles and separately labeled runtime cursor. `hello` has only linear keys; no keys were added to make this capture. Neither animation has stepped keys; synthetic controls cover stepped evaluation.
- [Bone tree](bone-tree.png): `hello`, with `chest` selected, its visible stage marker and directly attached Parts rows highlighted. Initial load and paused `hello → idle → hello` changes retain picking immediately, without seek/repose or changing player time.

The public `hello` readout passed 22,820 comparisons against installed published Play at zero tolerance. Synthetic browser controls cover all ten recognized kinds × linear/stepped/Bézier, including split axes and shear. These are inspection/identity receipts, not an upstream visual-quality or performance certificate.

## Artwork attribution

The inputs are from [rig-c/exam at 01436ee3f02c189fe1a1e9656fe62068889837f5](https://github.com/rig-c/exam/tree/01436ee3f02c189fe1a1e9656fe62068889837f5/tasks/01-build/inputs), used through [the pinned getting-started guide](https://github.com/rig-c/getting-started/tree/ce926769373977558da470973afb52fe7c32d7fc).

These captures contain input artwork licensed [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/), as recorded in the input repository’s [LICENSE](https://github.com/rig-c/exam/blob/01436ee3f02c189fe1a1e9656fe62068889837f5/LICENSE) and [NOTICE](https://github.com/rig-c/exam/blob/01436ee3f02c189fe1a1e9656fe62068889837f5/NOTICE.md). The repository’s MIT code license does not replace that artwork license.

Painted with Nova Anime XL IL v8.0 by Crody (https://civitai.com/models/376130).
