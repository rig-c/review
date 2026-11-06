The model, atlas page and direction document are byte copies from
`rig-c/create@b793e0c6198ceaf775cba53e0a16abf5f23e775e`,
under `templates/example-direction`. Their relative paths match that template.
The atlas page is also byte-identical to Create's declared rectangle source image.
`review.json` is Review's wrapper for this inspection fixture. It carries no
producer handoff or approval.

| File | SHA-256 |
| --- | --- |
| skeleton.model.json | 63190ec6746bafbc73847fa6c6905b5811cc0adb41897dfed923fe802e4dc261 |
| rectangle.png | 6030af0b8c57d0f6f3a25cf417b7d4fb3b442c1e0a4f441e4918623db571e511 |
| v2.json | 9bec50f753d4790ee0d9dde824a612126ed37e7b0e63d393505ac836118c50a4 |

For the described correction round-trip, Create is pinned to
`76a96dc528e07804a4df5e6c6e99ec5fc66b751c` (PR #161 in rig-c/create).
The three retained files above match the bytes at that pin. The pinned
Create CLI runs separately on a scratch copy of its complete
`templates/example-direction` project.
