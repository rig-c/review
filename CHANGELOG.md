# Changelog

## [0.7.0](https://github.com/rig-c/review/compare/v0.6.0...v0.7.0) (2026-10-20)


### Features

* **animate:** declare requirements and check them with `rig-parts check --requirements` ([#141](https://github.com/rig-c/review/issues/141)) ([2112cae](https://github.com/rig-c/review/commit/2112cae3b130d63c1ac7742b32ce9c80c6a657a2)), closes [#113](https://github.com/rig-c/review/issues/113)
* **animate:** idle tracks — amp, period, phase, base, chain handles, blink — with a labelled preview and Apply ([#126](https://github.com/rig-c/review/issues/126)) ([db3be7f](https://github.com/rig-c/review/commit/db3be7fcfa0b2f3dbdebab22ada666b492f46ff3))
* **animate:** physics tuning panel — edit declared constraints as config patches and Apply ([#122](https://github.com/rig-c/review/issues/122)) ([d7ebb46](https://github.com/rig-c/review/commit/d7ebb46ad4eeffb79fcba04a6fed698fdd1a670b)), closes [#103](https://github.com/rig-c/review/issues/103)
* **animate:** readings as watch instruments — rigc render readings as timeline ticks ([#123](https://github.com/rig-c/review/issues/123)) ([e0553db](https://github.com/rig-c/review/commit/e0553dbcf4e762e71b194230766cac083c3c8c8c)), closes [#108](https://github.com/rig-c/review/issues/108)
* **animate:** retarget tuning — map editor and flags, rebuilt by `rig-pose` in scratch ([#144](https://github.com/rig-c/review/issues/144)) ([2f6ec2d](https://github.com/rig-c/review/commit/2f6ec2de60371cd76a1d29f8039e9bb2f53981fb)), closes [#114](https://github.com/rig-c/review/issues/114)
* **open:** producer handoff — declare the authoring inputs and hold the baseline ([#119](https://github.com/rig-c/review/issues/119)) ([ea3a1ef](https://github.com/rig-c/review/commit/ea3a1ef4440bfcb063a24f96489e114d147060b3)), closes [#101](https://github.com/rig-c/review/issues/101)
* **rebuild:** config patch and the generic Apply runner ([#120](https://github.com/rig-c/review/issues/120)) ([a00e35c](https://github.com/rig-c/review/commit/a00e35cebf35201d18943c423b7a5af26d29fada)), closes [#102](https://github.com/rig-c/review/issues/102)
* **rebuild:** patches inside retune's scope go through `rig-parts retune` on repaired builds ([#138](https://github.com/rig-c/review/issues/138)) ([52332fb](https://github.com/rig-c/review/commit/52332fb2b291a084700a9e76dff0ae207d3af2e2)), closes [#136](https://github.com/rig-c/review/issues/136)
* **setup:** Apply · Rebuild runs the installed producer and reloads the result ([#116](https://github.com/rig-c/review/issues/116)) ([1e6c25a](https://github.com/rig-c/review/commit/1e6c25aaa80191ea74bbda162b4cc05faf542f4b)), closes [#99](https://github.com/rig-c/review/issues/99)
* **setup:** bone anchors — drag origins, chain points and tips as config patches, checked and applied ([#133](https://github.com/rig-c/review/issues/133)) ([d9eea45](https://github.com/rig-c/review/commit/d9eea451cee01e26c72161d9a7f1b44a4163ad1a)), closes [#109](https://github.com/rig-c/review/issues/109)
* **setup:** chest by landmarks — three points derive the producer's bust circles; export accepts 1–8 regions ([#127](https://github.com/rig-c/review/issues/127)) ([d7f5132](https://github.com/rig-c/review/commit/d7f513251316d67b618604ac4349626139341a74)), closes [#105](https://github.com/rig-c/review/issues/105) [#118](https://github.com/rig-c/review/issues/118)
* **setup:** cuts, patches and limbs — edited on stage, rebuilt by `rig-parts build` in scratch ([#146](https://github.com/rig-c/review/issues/146)) ([070f67d](https://github.com/rig-c/review/commit/070f67d2afb107594fcbed3f55e3e2d65f2ca578))
* **setup:** Edit Mesh Apply runs `rig-parts remesh --delta` and loads the revision ([#140](https://github.com/rig-c/review/issues/140)) ([eefc7ca](https://github.com/rig-c/review/commit/eefc7ca3d49fe69e323e8fd52e7c9e31e8dc5fe8)), closes [#135](https://github.com/rig-c/review/issues/135)
* **setup:** Edit Mesh works in setup space from the model document ([#137](https://github.com/rig-c/review/issues/137)) ([78ca0b7](https://github.com/rig-c/review/commit/78ca0b738dc920bc3a55ea77b3b3293fb3b148fc)), closes [#100](https://github.com/rig-c/review/issues/100)
* **setup:** mesh panel — contour and grid parameters, regions and segments as a remesh entry with Apply ([#128](https://github.com/rig-c/review/issues/128)) ([86caada](https://github.com/rig-c/review/commit/86caada5df44088c7d3257a710e285793f346d81)), closes [#106](https://github.com/rig-c/review/issues/106)
* **setup:** rig fields — rigid part bone, blink still row, stops, inherit, turn depth and pivot ([#134](https://github.com/rig-c/review/issues/134)) ([68868eb](https://github.com/rig-c/review/commit/68868eb7095604f0003705b779b69ff7a720edff)), closes [#110](https://github.com/rig-c/review/issues/110)
* **setup:** weights view — a bone's setup-pose weights over the selected mesh ([#132](https://github.com/rig-c/review/issues/132)) ([9267022](https://github.com/rig-c/review/commit/9267022e8bd14bb5fc9a059805de7d670abcff9c)), closes [#107](https://github.com/rig-c/review/issues/107)
* **workspace:** sticky block row in each inspector section ([#130](https://github.com/rig-c/review/issues/130)) ([8c08513](https://github.com/rig-c/review/commit/8c0851358c51ef65c7b44414af9244c35c5fa88b)), closes [#124](https://github.com/rig-c/review/issues/124)


### Bug Fixes

* **docs:** the producer writes motion in scratch; review never authors keys ([#143](https://github.com/rig-c/review/issues/143)) ([2da25ed](https://github.com/rig-c/review/commit/2da25ed607ef9e69816896c9b57d115be6baf4fa))
* **rebuild:** diff every document the producer writes, per file ([#129](https://github.com/rig-c/review/issues/129)) ([2903251](https://github.com/rig-c/review/commit/2903251ed9bcec3b04e08ffe63fe1c7e6d54d7d1)), closes [#125](https://github.com/rig-c/review/issues/125)
* **requirements:** refuse a self-targeted contact or aim before Add; default the target to another bone ([#145](https://github.com/rig-c/review/issues/145)) ([076dbcf](https://github.com/rig-c/review/commit/076dbcf5c5c9a692d8c025fc87e38b1dcc4caa34)), closes [#142](https://github.com/rig-c/review/issues/142)

## [0.6.0](https://github.com/rig-c/review/compare/v0.5.0...v0.6.0) (2026-10-19)


### Features

* **animate:** environment block — wind, gravity, jolt, drag-to-trail, physics reset, read-only constraints ([#97](https://github.com/rig-c/review/issues/97)) ([aa1eea4](https://github.com/rig-c/review/commit/aa1eea4606be455460a0c139331e6afa55486479)), closes [#94](https://github.com/rig-c/review/issues/94)
* **parts:** one-row header, collapsible settings, toggle selection, minimum thumbnails, on-screen view-region popover ([#93](https://github.com/rig-c/review/issues/93)) ([480d27c](https://github.com/rig-c/review/commit/480d27cf831c48ce1d1ef0e8bd85dc6a34ebdbd9)), closes [#91](https://github.com/rig-c/review/issues/91)
* **setup:** chest-region editor like the family example ([#96](https://github.com/rig-c/review/issues/96)) ([178cce2](https://github.com/rig-c/review/commit/178cce2c089d2307b903bbe9fc336231393f0dd2)), closes [#92](https://github.com/rig-c/review/issues/92)
* **setup:** edit-mesh designation the way Spine's Edit Mesh works ([#98](https://github.com/rig-c/review/issues/98)) ([d12efee](https://github.com/rig-c/review/commit/d12efee6ad28ee35818ee1c8ac1a67d9b52138f6)), closes [#80](https://github.com/rig-c/review/issues/80)

## [0.5.0](https://github.com/rig-c/review/compare/v0.4.0...v0.5.0) (2026-10-19)


### Features

* **setup:** chest-region designation and export ([#89](https://github.com/rig-c/review/issues/89)) ([da03f37](https://github.com/rig-c/review/commit/da03f373459ab1f29aa2d352e3e4849f5e6cb1af)), closes [#78](https://github.com/rig-c/review/issues/78)
* **workspace:** fixed left header, thinner distinct separators, Setup without animation controls, feedback as a modal ([#90](https://github.com/rig-c/review/issues/90)) ([9604e2f](https://github.com/rig-c/review/commit/9604e2f0671529f9768fae4bb2f5b85c14d382d2)), closes [#88](https://github.com/rig-c/review/issues/88)
* **workspace:** thin scrollbars, sticky panel headers, mode switch in the top bar, one-row view bar ([#85](https://github.com/rig-c/review/issues/85)) ([c322868](https://github.com/rig-c/review/commit/c3228685e60c2ac68bed9d923b4bfc4e4b4bcc56)), closes [#84](https://github.com/rig-c/review/issues/84)


### Bug Fixes

* **view:** stop the stage bottom from shaking during playback ([#87](https://github.com/rig-c/review/issues/87)) ([892e137](https://github.com/rig-c/review/commit/892e1373af46433603da50b871dce70224997cf5)), closes [#74](https://github.com/rig-c/review/issues/74)

## [0.4.0](https://github.com/rig-c/review/compare/v0.3.0...v0.4.0) (2026-10-19)


### Features

* **theme:** take the colour tokens from rig-c.org ([#83](https://github.com/rig-c/review/issues/83)) ([8b59b2b](https://github.com/rig-c/review/commit/8b59b2b1cd5239952caca900af71e9b6c1ec8b6c)), closes [#73](https://github.com/rig-c/review/issues/73)
* **workspace:** rework the layout around parts, Setup/Animate/Feedback and a status footer ([#81](https://github.com/rig-c/review/issues/81)) ([d1eb71d](https://github.com/rig-c/review/commit/d1eb71d82b96cd4d651fa386ebcb439c7420d4de)), closes [#75](https://github.com/rig-c/review/issues/75) [#76](https://github.com/rig-c/review/issues/76) [#77](https://github.com/rig-c/review/issues/77) [#79](https://github.com/rig-c/review/issues/79)

## [0.3.0](https://github.com/rig-c/review/compare/v0.2.1...v0.3.0) (2026-10-19)


### Features

* **open:** fix the launcher contract with named refusals ([#72](https://github.com/rig-c/review/issues/72)) ([e027f28](https://github.com/rig-c/review/commit/e027f28521c71d50c070119cac54ec8aa710da6f)), closes [#71](https://github.com/rig-c/review/issues/71)


### Bug Fixes

* redact the write capability from the install smoke's output ([#69](https://github.com/rig-c/review/issues/69)) ([6cbf30d](https://github.com/rig-c/review/commit/6cbf30d23e30f0a353f4d2a16e3d73b84a52c11c)), closes [#67](https://github.com/rig-c/review/issues/67)

## [0.2.1](https://github.com/rig-c/review/compare/v0.2.0...v0.2.1) (2026-10-18)


### Bug Fixes

* **smoke:** read npm 12's pack --json result instead of assuming an array ([#64](https://github.com/rig-c/review/issues/64)) ([e6cb77c](https://github.com/rig-c/review/commit/e6cb77c385c9d80e34b752131998785089290843)), closes [#63](https://github.com/rig-c/review/issues/63)

## [0.2.0](https://github.com/rig-c/review/compare/v0.1.0...v0.2.0) (2026-10-18)


### Features

* inspect actual parts with coherent held-slot identities ([#43](https://github.com/rig-c/review/issues/43)) ([a6f247e](https://github.com/rig-c/review/commit/a6f247e401a239a119a35323d668fe72f8c1cb37))
* offer comparison only when its actual inputs loaded ([#58](https://github.com/rig-c/review/issues/58)) ([7a22cfa](https://github.com/rig-c/review/commit/7a22cfa98b3059669b9630f49eafcc2ab46f8441)), closes [#53](https://github.com/rig-c/review/issues/53)
* resizable remembered panels, workspace Settings and per-tab scroll ([#56](https://github.com/rig-c/review/issues/56)) ([6986fd0](https://github.com/rig-c/review/commit/6986fd09e4d811d3af864ab6c5eff1e5bf80c85e)), closes [#42](https://github.com/rig-c/review/issues/42)
* stable loopback origin for managed inspections with per-instance capabilities ([#57](https://github.com/rig-c/review/issues/57)) ([d2a982b](https://github.com/rig-c/review/commit/d2a982b5472986b58828188a39f9d015dd51f654))


### Bug Fixes

* **parts:** keep the rig drawn when parts inspection is unavailable ([#59](https://github.com/rig-c/review/issues/59)) ([75f9442](https://github.com/rig-c/review/commit/75f944240c9d9efe0633533fe4528c282eaad7e9)), closes [#51](https://github.com/rig-c/review/issues/51)
* **strip:** decode reference frames with -fps_mode passthrough ([#55](https://github.com/rig-c/review/issues/55)) ([f979e71](https://github.com/rig-c/review/commit/f979e7132e4976c023f0ac321387c78ed7806c3e)), closes [#50](https://github.com/rig-c/review/issues/50)
