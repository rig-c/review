# Retained Create example

Create commit `e5b6da07298eb282f1139bd1e158a26720f8496f` supplied the project
and all 142 accompanying files. Its GitHub source archive SHA-256 was
`8969c7c90f5334976f23ed6d68e29bc1ee28f4bb2906aef4f9911b9a7f195cd6`.

From that source, call `materializeFixture(destination, undefined,
'example-reopened/project.json')` from Create's `tests/fixtures.ts` in a Bun
test. The resulting project matches the retained template byte for byte.
The archive contains the 143 unchanged materialized files (314,077 bytes)
as regular files with relative paths. Its compressed size is 46,557 bytes.
`files.sha256` records the member hashes. The Review test pins the archive
digest before extracting it into a disposable directory. The test uses v2
through the regular loaders and runs offline without a producer.
