# Changelog

## [2.0.0](https://github.com/rig-c/review/compare/v1.18.0...v2.0.0) (2026-11-07)


### ⚠ BREAKING CHANGES

* live jobs use rig-review/job-api@2 and rig-review/act@2. Parts identity now carries enumeratorVersion and manifest-relative image paths with roles. Close incompatible active jobs using their matching older installation.

### Features

* bind C4 jobs to the versioned public Parts enumeration ([#509](https://github.com/rig-c/review/issues/509)) ([6656149](https://github.com/rig-c/review/commit/66561493c0a62888554d04326b081761ed0b348a))

## [1.18.0](https://github.com/rig-c/review/compare/v1.17.0...v1.18.0) (2026-11-07)


### Features

* expose the public managed job host ([#506](https://github.com/rig-c/review/issues/506)) ([cb74f06](https://github.com/rig-c/review/commit/cb74f06b1588f3fde5c6b908dc98d2a0ba974387))

## [1.17.0](https://github.com/rig-c/review/compare/v1.16.7...v1.17.0) (2026-11-07)


### Features

* add a persistent live job inspection window ([#505](https://github.com/rig-c/review/issues/505)) ([ca0c0cc](https://github.com/rig-c/review/commit/ca0c0cc6bf3df3309d15feae813b93aa16fa52f8))
* add semantic live review backend ([#493](https://github.com/rig-c/review/issues/493)) ([d1eda8c](https://github.com/rig-c/review/commit/d1eda8c5b8f8d64b31cddfde1b64d307489b1630))
* prepare internal scene plate rendering ([#485](https://github.com/rig-c/review/issues/485)) ([6894e44](https://github.com/rig-c/review/commit/6894e442c15ec30ad37c1ed88a217d60913fa967)), closes [#482](https://github.com/rig-c/review/issues/482)


### Bug Fixes

* gate rig modes on refused inspection stages ([#495](https://github.com/rig-c/review/issues/495)) ([0997ce8](https://github.com/rig-c/review/commit/0997ce889a7793f404bbf9c788320bf8c6382a9c))
* refuse parts camera changes after paint failure ([#500](https://github.com/rig-c/review/issues/500)) ([c0cd20d](https://github.com/rig-c/review/commit/c0cd20dc276b8ce7ab5b00ee16f0d64141966403))

## [1.16.7](https://github.com/rig-c/review/compare/v1.16.6...v1.16.7) (2026-11-07)


### Bug Fixes

* resolve directory aliases consistently across output paths ([83c29f4](https://github.com/rig-c/review/commit/83c29f42019ce3244b065548162a03f88b44aaeb))

## [1.16.6](https://github.com/rig-c/review/compare/v1.16.5...v1.16.6) (2026-11-07)


### Bug Fixes

* canonicalize Parts paths across directory aliases ([aa37f34](https://github.com/rig-c/review/commit/aa37f34a720eb138fc89ad8eae81db86f9a39c77))

## [1.16.5](https://github.com/rig-c/review/compare/v1.16.4...v1.16.5) (2026-11-07)


### Bug Fixes

* resolve Parts zoom against the selected frame before paint ([8402a68](https://github.com/rig-c/review/commit/8402a688bbec7074e9781506acdf7661aea17275))

## [1.16.4](https://github.com/rig-c/review/compare/v1.16.3...v1.16.4) (2026-11-06)


### Bug Fixes

* preserve direct handoff for embedded stages ([#456](https://github.com/rig-c/review/issues/456)) ([2020979](https://github.com/rig-c/review/commit/2020979c6ea72bd99dc1a538a28e253ceeaba18b))

## [1.16.3](https://github.com/rig-c/review/compare/v1.16.2...v1.16.3) (2026-11-06)


### Bug Fixes

* expand authored direction keys into the stage ([#454](https://github.com/rig-c/review/issues/454)) ([c747e5e](https://github.com/rig-c/review/commit/c747e5e484d0ce5ae474e3fbf60126efd6b2fc7a))

## [1.16.2](https://github.com/rig-c/review/compare/v1.16.1...v1.16.2) (2026-11-06)


### Bug Fixes

* show producer check verdicts after Apply ([#452](https://github.com/rig-c/review/issues/452)) ([204cf9a](https://github.com/rig-c/review/commit/204cf9a3e5a4ffba4674b64f058d5dcf5760c37c))

## [1.16.1](https://github.com/rig-c/review/compare/v1.16.0...v1.16.1) (2026-11-06)


### Bug Fixes

* preserve bounded correction submit refusals ([#445](https://github.com/rig-c/review/issues/445)) ([cc33832](https://github.com/rig-c/review/commit/cc33832670fc36a037b188499f92054fc3f9cdc0))

## [1.16.0](https://github.com/rig-c/review/compare/v1.15.0...v1.16.0) (2026-11-06)


### Features

* open pre-rig drafts and save joined parts verdicts ([#440](https://github.com/rig-c/review/issues/440)) ([f64fd14](https://github.com/rig-c/review/commit/f64fd14369f56da30dfe5df00fd7dccd97052ccb))

## [1.15.0](https://github.com/rig-c/review/compare/v1.14.1...v1.15.0) (2026-11-06)


### Features

* transport selected Create direction through joined review ([#438](https://github.com/rig-c/review/issues/438)) ([b10e367](https://github.com/rig-c/review/commit/b10e36764d81da4744c0258fa5f41280c8d102a9))

## [1.14.1](https://github.com/rig-c/review/compare/v1.14.0...v1.14.1) (2026-11-06)


### Bug Fixes

* localize generated inspection labels and round turn range ([#434](https://github.com/rig-c/review/issues/434)) ([e398497](https://github.com/rig-c/review/commit/e398497f66631de74ad0d528d13fc1c13b26fd57))

## [1.14.0](https://github.com/rig-c/review/compare/v1.13.0...v1.14.0) (2026-11-06)


### Features

* open the joined project interview in the standard host ([#432](https://github.com/rig-c/review/issues/432)) ([2470116](https://github.com/rig-c/review/commit/24701161695d2159e92fefbc6eb952f3b05b7b91))

## [1.13.0](https://github.com/rig-c/review/compare/v1.12.0...v1.13.0) (2026-11-06)


### Features

* bind described direction corrections to inspected sources ([#429](https://github.com/rig-c/review/issues/429)) ([8bb37b2](https://github.com/rig-c/review/commit/8bb37b24cba58fe2a72e61e7723ae64339c982fb))

## [1.12.0](https://github.com/rig-c/review/compare/v1.11.0...v1.12.0) (2026-11-06)


### Features

* inspect declared direction capabilities and camera metadata ([#426](https://github.com/rig-c/review/issues/426)) ([3b02cb1](https://github.com/rig-c/review/commit/3b02cb1d99d4d72a5e4b372e2d1be7fedc80fc44))

## [1.11.0](https://github.com/rig-c/review/compare/v1.10.2...v1.11.0) (2026-11-06)


### Features

* export explicit source-bound correction handoffs ([#422](https://github.com/rig-c/review/issues/422)) ([1ad9141](https://github.com/rig-c/review/commit/1ad914134f49ed33f78129c7fac0c6da1e9a6b7b))
* inspect create choices with bound parts and explicit picks ([#420](https://github.com/rig-c/review/issues/420)) ([328836d](https://github.com/rig-c/review/commit/328836d25d6cdf18d64d35b02aec2c7282a532ae))

## [1.10.2](https://github.com/rig-c/review/compare/v1.10.1...v1.10.2) (2026-11-06)


### Bug Fixes

* **ci:** condition verdict uploads on producer receipts ([#418](https://github.com/rig-c/review/issues/418)) ([69ae749](https://github.com/rig-c/review/commit/69ae7491388333f9540e1ec271e2d86ad1302e51))

## [1.10.1](https://github.com/rig-c/review/compare/v1.10.0...v1.10.1) (2026-11-05)


### Performance Improvements

* **ci:** reuse verified verdicts for identical trees ([#415](https://github.com/rig-c/review/issues/415)) ([001ea9f](https://github.com/rig-c/review/commit/001ea9f936ca0fabb0eb4f01805170977b9362ad))

## [1.10.0](https://github.com/rig-c/review/compare/v1.9.0...v1.10.0) (2026-11-05)


### Features

* **parts:** compare the declared rig-space painting ([#412](https://github.com/rig-c/review/issues/412)) ([01def15](https://github.com/rig-c/review/commit/01def158d6536d80910e49f011d3f33b64f607d4))
* **stage1:** connect source-bound draft mesh corrections ([#403](https://github.com/rig-c/review/issues/403)) ([60865d1](https://github.com/rig-c/review/commit/60865d128c457d707926747df9e484b7869a8677))


### Bug Fixes

* persist bounded inspection time after idle loops ([#404](https://github.com/rig-c/review/issues/404)) ([63756b3](https://github.com/rig-c/review/commit/63756b3fd463f4cd72aa556d7c383c6caca7e2a2))
* retain inspection phase in animation panels and rebuilds ([#409](https://github.com/rig-c/review/issues/409)) ([677064e](https://github.com/rig-c/review/commit/677064ec5655da92460d0f1b4f88e3eadc87b8d2))
* retain unclassified carried producer reports ([#401](https://github.com/rig-c/review/issues/401)) ([fc96810](https://github.com/rig-c/review/commit/fc96810b78484f9eab928d98434173b09c45f2f7))

## [1.9.0](https://github.com/rig-c/review/compare/v1.8.0...v1.9.0) (2026-11-05)


### Features

* **parts:** approve pending outcomes together and compact the list ([#397](https://github.com/rig-c/review/issues/397)) ([b711ff9](https://github.com/rig-c/review/commit/b711ff99e348ed0ad0dfe76cc48dfa7df927560a))
* **parts:** count explicit part findings separately from check evidence ([#394](https://github.com/rig-c/review/issues/394)) ([1210d7b](https://github.com/rig-c/review/commit/1210d7b2de7e5da4510de741dee3f14c4d4300b0))

## [1.8.0](https://github.com/rig-c/review/compare/v1.7.0...v1.8.0) (2026-11-05)


### Features

* **parts:** inspect assembled package placements and draw order ([#392](https://github.com/rig-c/review/issues/392)) ([48f2a5d](https://github.com/rig-c/review/commit/48f2a5dd23a1f38f8cbc57d356a9d02ff69f0270))

## [1.7.0](https://github.com/rig-c/review/compare/v1.6.0...v1.7.0) (2026-11-05)


### Features

* **parts:** add source-bound pointed comments and shared viewports ([#389](https://github.com/rig-c/review/issues/389)) ([07c07d2](https://github.com/rig-c/review/commit/07c07d254725c97cfc63aa7b028cb8ef8ccf9045))
* **parts:** compare original painting with visual overlays ([#391](https://github.com/rig-c/review/issues/391)) ([80e2a49](https://github.com/rig-c/review/commit/80e2a4986bc60060f68920fc9789c8d9938af7f1))
* **workspace:** add four-stage inspection navigation ([#379](https://github.com/rig-c/review/issues/379)) ([b5f03d8](https://github.com/rig-c/review/commit/b5f03d82e7cf45fe05677910e5d1874f1f8518ed))


### Bug Fixes

* **parts:** distinguish producer rows and group source counts ([#386](https://github.com/rig-c/review/issues/386)) ([c9e5d87](https://github.com/rig-c/review/commit/c9e5d8745f8380574c338779038754f48e8ad944))

## [1.6.0](https://github.com/rig-c/review/compare/v1.5.4...v1.6.0) (2026-11-05)


### Features

* **parts:** inspect and sign off per-part mesh geometry ([#377](https://github.com/rig-c/review/issues/377)) ([136746a](https://github.com/rig-c/review/commit/136746a3d1a581a8ae79c335c9bc6c0b77fcc875))


### Bug Fixes

* **parts:** protect inputs and bound verdict request bytes ([#374](https://github.com/rig-c/review/issues/374)) ([4cccdb3](https://github.com/rig-c/review/commit/4cccdb3e444f31d1fb9e742df6b670d6b952bc8a))

## [1.5.4](https://github.com/rig-c/review/compare/v1.5.3...v1.5.4) (2026-11-04)


### Bug Fixes

* **animate:** keep physics stepping while the clip is paused ([#346](https://github.com/rig-c/review/issues/346)) ([#363](https://github.com/rig-c/review/issues/363)) ([8309837](https://github.com/rig-c/review/commit/8309837aaad4d5f27af2e8ed754b3b725c756490))

## [1.5.3](https://github.com/rig-c/review/compare/v1.5.2...v1.5.3) (2026-11-04)


### Performance Improvements

* **animate:** cut review's per-frame cost on a heavy rig ([#356](https://github.com/rig-c/review/issues/356)) ([#361](https://github.com/rig-c/review/issues/361)) ([2574a7e](https://github.com/rig-c/review/commit/2574a7efa3bc50ffe0287bc3a719be995b823f2e))

## [1.5.2](https://github.com/rig-c/review/compare/v1.5.1...v1.5.2) (2026-11-04)


### Bug Fixes

* **front:** keep the front up on unreadable records; lifecycle tests wait on server events ([#354](https://github.com/rig-c/review/issues/354)) ([#358](https://github.com/rig-c/review/issues/358)) ([77eed85](https://github.com/rig-c/review/commit/77eed8577f52ccdb7f097f8d14480a15fde62ed1))

## [1.5.1](https://github.com/rig-c/review/compare/v1.5.0...v1.5.1) (2026-11-04)


### Performance Improvements

* **animate:** stop re-translating unchanged text on every played frame ([#355](https://github.com/rig-c/review/issues/355)) ([c3303c4](https://github.com/rig-c/review/commit/c3303c434a4aa0d4e3f26b19b4fcbd337a447ac7))

## [1.5.0](https://github.com/rig-c/review/compare/v1.4.4...v1.5.0) (2026-11-04)


### Features

* **chest:** compact detail block layout; draw chest markers only while toggled ([#351](https://github.com/rig-c/review/issues/351)) ([3093e59](https://github.com/rig-c/review/commit/3093e5912fbf33e9aa10dab2ff66f59af653426c))
* **parts:** parts and atlas view with per-part sign-off before rigging ([#348](https://github.com/rig-c/review/issues/348)) ([#353](https://github.com/rig-c/review/issues/353)) ([eabe05d](https://github.com/rig-c/review/commit/eabe05dcd30f3eb5794a6129b0886b48e4710f49))

## [1.4.4](https://github.com/rig-c/review/compare/v1.4.3...v1.4.4) (2026-11-04)


### Bug Fixes

* **animate:** carry physics across the loop wrap and step at a fixed rate ([#349](https://github.com/rig-c/review/issues/349)) ([8ecae37](https://github.com/rig-c/review/commit/8ecae3738f3686cfc5236b445fb3ab3bc3e557d4))

## [1.4.3](https://github.com/rig-c/review/compare/v1.4.2...v1.4.3) (2026-11-03)


### Bug Fixes

* **chest:** disable the chest tools on a rig with no contour mesh, and say why in words ([#342](https://github.com/rig-c/review/issues/342)) ([#343](https://github.com/rig-c/review/issues/343)) ([b55b022](https://github.com/rig-c/review/commit/b55b022dcc8ea64cf5a1931e9851ab6cb3f492f2))

## [1.4.2](https://github.com/rig-c/review/compare/v1.4.1...v1.4.2) (2026-11-03)


### Bug Fixes

* **deps:** pin @rig-c/play 1.22.3, meshes stay on WebGL past the drawing-buffer grant ([#340](https://github.com/rig-c/review/issues/340)) ([50bf7e1](https://github.com/rig-c/review/commit/50bf7e1b2d3c36f269c42f6a90d1bf6980d72182))

## [1.4.1](https://github.com/rig-c/review/compare/v1.4.0...v1.4.1) (2026-11-03)


### Bug Fixes

* **deps:** move the play pin to 1.22.2, which draws a zoomed stage without corruption ([#332](https://github.com/rig-c/review/issues/332)) ([#338](https://github.com/rig-c/review/issues/338)) ([a7e951b](https://github.com/rig-c/review/commit/a7e951b996dd088c0c26a1e84cdcec5603779bcc))

## [1.4.0](https://github.com/rig-c/review/compare/v1.3.0...v1.4.0) (2026-11-03)


### Features

* **stage:** a drag on the rig view pans and moves the physics, as the Family viewer does ([#331](https://github.com/rig-c/review/issues/331)) ([#337](https://github.com/rig-c/review/issues/337)) ([5e137de](https://github.com/rig-c/review/commit/5e137decd7bb07e9b242ce834ff4919011f12311))
* **stage:** preview on hover which part a click would select ([#330](https://github.com/rig-c/review/issues/330)) ([#335](https://github.com/rig-c/review/issues/335)) ([1360932](https://github.com/rig-c/review/commit/1360932e0979bec34bbbb16507d940687343effb))

## [1.3.0](https://github.com/rig-c/review/compare/v1.2.1...v1.3.0) (2026-11-03)


### Features

* **reference:** show the source painting first when the producer handoff knows it ([#329](https://github.com/rig-c/review/issues/329)) ([#333](https://github.com/rig-c/review/issues/333)) ([f150583](https://github.com/rig-c/review/commit/f150583a0652f96f4167ff62f1ac894999282748))

## [1.2.1](https://github.com/rig-c/review/compare/v1.2.0...v1.2.1) (2026-11-03)


### Bug Fixes

* **open:** open a handoff whose config states no contour mesh ([#327](https://github.com/rig-c/review/issues/327)) ([e62b226](https://github.com/rig-c/review/commit/e62b22665d649cb28d80183e646f65f2d2ce29a7))

## [1.2.0](https://github.com/rig-c/review/compare/v1.1.1...v1.2.0) (2026-11-03)


### Features

* **chest:** chest editor at parity with the Family editor ([#307](https://github.com/rig-c/review/issues/307), [#306](https://github.com/rig-c/review/issues/306)) ([#310](https://github.com/rig-c/review/issues/310)) ([5b508c4](https://github.com/rig-c/review/commit/5b508c4d102747903bc76799657faa00191429b4))
* **inspector:** make the block rows real tabs, one panel on screen at a time ([#308](https://github.com/rig-c/review/issues/308)) ([#321](https://github.com/rig-c/review/issues/321)) ([1fb6a2b](https://github.com/rig-c/review/commit/1fb6a2b1732376e7eb79863940640f2231ff3932))


### Bug Fixes

* **chest:** apply seeded bust circles beside other contour parts ([#314](https://github.com/rig-c/review/issues/314)) ([#326](https://github.com/rig-c/review/issues/326)) ([0d4ea31](https://github.com/rig-c/review/commit/0d4ea3129c9a8f00e7083e00fb8f4f55b0031b44))
* **chest:** draw the non-edit overlay when only the generator field is empty ([#323](https://github.com/rig-c/review/issues/323)) ([#325](https://github.com/rig-c/review/issues/325)) ([4e2e035](https://github.com/rig-c/review/commit/4e2e035f2c946b599b1555ca6ae2aa612c1c5933))
* **chest:** keep contour regions the editor did not seed, refuse by name what cannot go back ([#317](https://github.com/rig-c/review/issues/317)) ([#320](https://github.com/rig-c/review/issues/320)) ([a94aea1](https://github.com/rig-c/review/commit/a94aea18a9e6ba43fb7113f5d8931c39f39b29f8))
* **chest:** read an absent contour maxEdge, stray or bridges as the producer does ([#318](https://github.com/rig-c/review/issues/318)) ([#322](https://github.com/rig-c/review/issues/322)) ([e45108f](https://github.com/rig-c/review/commit/e45108fbc70f98e4d13c1f7c8664e8bf943d3289))
* **chest:** seed ellipse-polygon bust regions, refuse other polygons by name ([#315](https://github.com/rig-c/review/issues/315)) ([#316](https://github.com/rig-c/review/issues/316)) ([c9a48a2](https://github.com/rig-c/review/commit/c9a48a287e4e0e2c2119d52dec3877db2eecf759))
* **open:** refuse to start without a loadable model or a ready producer handoff; --view-only asks for the viewer ([#305](https://github.com/rig-c/review/issues/305)) ([#309](https://github.com/rig-c/review/issues/309)) ([579b34b](https://github.com/rig-c/review/commit/579b34b8805464101bd29d6c5d77554a26c4e9fb))
* **strip:** draw in named font families, refuse STRIP_FONT when none is installed ([#319](https://github.com/rig-c/review/issues/319)) ([#324](https://github.com/rig-c/review/issues/324)) ([d18629c](https://github.com/rig-c/review/commit/d18629cc0cc4c302ec4e8d241900876346e07530))

## [1.1.1](https://github.com/rig-c/review/compare/v1.1.0...v1.1.1) (2026-11-02)


### Bug Fixes

* **web:** a stale local draft no longer blocks a review ([#303](https://github.com/rig-c/review/issues/303)) ([b3cbd87](https://github.com/rig-c/review/commit/b3cbd87d3fb28b6a2f914f69ec147f974f1261e1)), closes [#301](https://github.com/rig-c/review/issues/301)

## [1.1.0](https://github.com/rig-c/review/compare/v1.0.1...v1.1.0) (2026-11-02)


### Features

* **i18n:** let a review link choose its language ([#300](https://github.com/rig-c/review/issues/300)) ([db2d6cc](https://github.com/rig-c/review/commit/db2d6cce5e2e3151bfaaaacbbae933fee2b10ac8)), closes [#299](https://github.com/rig-c/review/issues/299)

## [1.0.1](https://github.com/rig-c/review/compare/v1.0.0...v1.0.1) (2026-11-01)


### Bug Fixes

* **cli:** answer --version instead of reading it as a path ([#297](https://github.com/rig-c/review/issues/297)) ([02ca2c9](https://github.com/rig-c/review/commit/02ca2c99e4cedec76c38a75dcd42b83b9d68fa25))

## [1.0.0](https://github.com/rig-c/review/compare/v0.25.2...v1.0.0) (2026-11-01)


### Bug Fixes

* **deps:** move the play pin to 1.22.1 before 1.0 ([#292](https://github.com/rig-c/review/issues/292)) ([3e97f87](https://github.com/rig-c/review/commit/3e97f873ae04da3f38c51c33309791dadbb7242c)), closes [#288](https://github.com/rig-c/review/issues/288)
* **front:** exit when the control directory is gone ([#290](https://github.com/rig-c/review/issues/290)) ([3f74232](https://github.com/rig-c/review/commit/3f742320b7f2d35ef329d18f65b06f19c76f4cbc)), closes [#287](https://github.com/rig-c/review/issues/287)
* **i18n:** translate dynamic strings whole in Korean mode ([#295](https://github.com/rig-c/review/issues/295)) ([df449c5](https://github.com/rig-c/review/commit/df449c55d8f2446892c9c788114ba62159c1e63b))
* **turn-pad:** keep the pad's height while its values change ([7e42575](https://github.com/rig-c/review/commit/7e425758bcc60fd6c8beaf42caed6782ce9586ea)), closes [#289](https://github.com/rig-c/review/issues/289)

## [0.25.2](https://github.com/rig-c/review/compare/v0.25.1...v0.25.2) (2026-11-01)


### Bug Fixes

* **comments:** place the open list below a wrapped view bar ([#285](https://github.com/rig-c/review/issues/285)) ([062d7f9](https://github.com/rig-c/review/commit/062d7f9172ca1a87d0822c62618285a73ee4cbb2)), closes [#284](https://github.com/rig-c/review/issues/284)

## [0.25.1](https://github.com/rig-c/review/compare/v0.25.0...v0.25.1) (2026-11-01)


### Bug Fixes

* **view-bar:** wrap so every control stays reachable when narrow ([#282](https://github.com/rig-c/review/issues/282)) ([7f1a538](https://github.com/rig-c/review/commit/7f1a538b342e0d3d911b0799fa8794f66732a995)), closes [#279](https://github.com/rig-c/review/issues/279)

## [0.25.0](https://github.com/rig-c/review/compare/v0.24.1...v0.25.0) (2026-11-01)


### Features

* **comments:** one comment control for writing, listing and editing ([#277](https://github.com/rig-c/review/issues/277)) ([598d37d](https://github.com/rig-c/review/commit/598d37d651848ad328858280d09f03e516096333)), closes [#276](https://github.com/rig-c/review/issues/276)
* **i18n:** the review app in English and Korean ([#280](https://github.com/rig-c/review/issues/280)) ([de09469](https://github.com/rig-c/review/commit/de09469c2e24ec02794794180d5e200d5d5e4952))

## [0.24.1](https://github.com/rig-c/review/compare/v0.24.0...v0.24.1) (2026-11-01)


### Bug Fixes

* **readme:** title the README @rig-c/review ([#273](https://github.com/rig-c/review/issues/273)) ([d962804](https://github.com/rig-c/review/commit/d962804bf164a67fbd78952d7e96196076664429))

## [0.24.0](https://github.com/rig-c/review/compare/v0.23.0...v0.24.0) (2026-11-01)


### Features

* ship the rig-review agent skill ([#270](https://github.com/rig-c/review/issues/270)) ([e08d217](https://github.com/rig-c/review/commit/e08d217d3fade2687fe0428d388e51a3bf26d8c1)), closes [#269](https://github.com/rig-c/review/issues/269)

## [0.23.0](https://github.com/rig-c/review/compare/v0.22.0...v0.23.0) (2026-11-01)


### Features

* **apply:** state what a rebuild drops before the click ([#268](https://github.com/rig-c/review/issues/268)) ([d5447ad](https://github.com/rig-c/review/commit/d5447ad183e0d16078017b40ea1b9f45b96afd14)), closes [#250](https://github.com/rig-c/review/issues/250)


### Bug Fixes

* **readme:** show the npm badges ([#266](https://github.com/rig-c/review/issues/266)) ([cc13a13](https://github.com/rig-c/review/commit/cc13a130980a585fdf1d55714caab930363af87c)), closes [#265](https://github.com/rig-c/review/issues/265)

## [0.22.0](https://github.com/rig-c/review/compare/v0.21.0...v0.22.0) (2026-11-01)


### Features

* **animate:** edit each build separately in Compare ([#262](https://github.com/rig-c/review/issues/262)) ([05cba0c](https://github.com/rig-c/review/commit/05cba0ceab9cbf4daedd42e6c42697ed8e50186b))
* **animate:** select keys in groups and pose bones on the stage ([#260](https://github.com/rig-c/review/issues/260)) ([b13f0c0](https://github.com/rig-c/review/commit/b13f0c0ab342164d497f924ac4282b0f7016f116))


### Bug Fixes

* show the shared banner ([#264](https://github.com/rig-c/review/issues/264)) ([6bd7acd](https://github.com/rig-c/review/commit/6bd7acd7eced71d6a409a4429891d28a14462e3a)), closes [#263](https://github.com/rig-c/review/issues/263)

## [0.21.0](https://github.com/rig-c/review/compare/v0.20.0...v0.21.0) (2026-11-01)


### Features

* **animate:** a ruler, playhead and internal scroll for the timeline ([#257](https://github.com/rig-c/review/issues/257)) ([90ea3a9](https://github.com/rig-c/review/commit/90ea3a9c1816fa3158377c218a8f8ffcf023feca))
* **animate:** edit curves in the Curves view, and close five dock defects ([#259](https://github.com/rig-c/review/issues/259)) ([36091e7](https://github.com/rig-c/review/commit/36091e79dec552df6057c802f6ea5aff59439bb4))
* **animate:** edit keys in the dopesheet with a pending preview ([#255](https://github.com/rig-c/review/issues/255)) ([2572b92](https://github.com/rig-c/review/commit/2572b924546d9916d1fbf04f3792cdf70ddf95db))
* **animate:** give the timeline its own panel ([#258](https://github.com/rig-c/review/issues/258)) ([fe38d31](https://github.com/rig-c/review/commit/fe38d3180aa624a47d32240e4bfef8bdf4a2c9a4))

## [0.20.0](https://github.com/rig-c/review/compare/v0.19.0...v0.20.0) (2026-10-31)


### Features

* **animate:** Apply a keyed animation edit as a scratch rebuild ([#253](https://github.com/rig-c/review/issues/253)) ([81b4964](https://github.com/rig-c/review/commit/81b49642480c37b40e4057c975bcc162dd5371a4))

## [0.19.0](https://github.com/rig-c/review/compare/v0.18.1...v0.19.0) (2026-10-31)


### Features

* **animate:** pure source ops for editing keyed animations ([#251](https://github.com/rig-c/review/issues/251)) ([138d7de](https://github.com/rig-c/review/commit/138d7de80228f0288e9e03d520c3891930ad356c))

## [0.18.1](https://github.com/rig-c/review/compare/v0.18.0...v0.18.1) (2026-10-31)


### Bug Fixes

* **compare:** hold the picked environment out of Compare ([#248](https://github.com/rig-c/review/issues/248)) ([63a8fea](https://github.com/rig-c/review/commit/63a8fea484204f763b25c48e6480c57976d699e1)), closes [#247](https://github.com/rig-c/review/issues/247)

## [0.18.0](https://github.com/rig-c/review/compare/v0.17.0...v0.18.0) (2026-10-31)


### Features

* **compare:** make Compare a mode in the top switch ([#245](https://github.com/rig-c/review/issues/245)) ([747dcae](https://github.com/rig-c/review/commit/747dcae57ee277d6f31e8f71ab5ad57f5b1d7730))

## [0.17.0](https://github.com/rig-c/review/compare/v0.16.0...v0.17.0) (2026-10-31)


### Features

* **server:** exit when the last review window closes ([#243](https://github.com/rig-c/review/issues/243)) ([b94ba18](https://github.com/rig-c/review/commit/b94ba18275113bf7e2cf855e2f91b53a76d16ce1))

## [0.16.0](https://github.com/rig-c/review/compare/v0.15.1...v0.16.0) (2026-10-31)


### Features

* **parts:** fixed tools, thumbnails in compare, one-line rows ([#241](https://github.com/rig-c/review/issues/241)) ([8d7615b](https://github.com/rig-c/review/commit/8d7615b83d3ecfca918fb47683ee33414ab2490d)), closes [#233](https://github.com/rig-c/review/issues/233)

## [0.15.1](https://github.com/rig-c/review/compare/v0.15.0...v0.15.1) (2026-10-31)


### Bug Fixes

* **compare:** hold the pane footers still during playback ([#239](https://github.com/rig-c/review/issues/239)) ([3779641](https://github.com/rig-c/review/commit/377964103393b91c31685d4e706df763ce15f1a8)), closes [#232](https://github.com/rig-c/review/issues/232)

## [0.15.0](https://github.com/rig-c/review/compare/v0.14.0...v0.15.0) (2026-10-31)


### Features

* **review:** comment on the stage by marking a region on the current view ([#237](https://github.com/rig-c/review/issues/237)) ([6256501](https://github.com/rig-c/review/commit/6256501b2e4ac3c3ec59989db3330fbc0151951e))

## [0.14.0](https://github.com/rig-c/review/compare/v0.13.1...v0.14.0) (2026-10-31)


### Features

* **review:** add a turn pad over a rig's model dials ([#230](https://github.com/rig-c/review/issues/230)) ([94b25c4](https://github.com/rig-c/review/commit/94b25c4e21e4bf13b35e8f8c38e1df1130cb9483)), closes [#229](https://github.com/rig-c/review/issues/229)


### Bug Fixes

* **docs:** replace the README's twenty "see the reference" stubs with one task table ([#228](https://github.com/rig-c/review/issues/228)) ([a725779](https://github.com/rig-c/review/commit/a725779fd0079106f867664550e842aa3b41dc50)), closes [#227](https://github.com/rig-c/review/issues/227)
* **docs:** split the 95 KB README into orientation and shipped reference docs ([#225](https://github.com/rig-c/review/issues/225)) ([3eabbcd](https://github.com/rig-c/review/commit/3eabbcd86418b8d0f030508619a1a11e5b95639f)), closes [#224](https://github.com/rig-c/review/issues/224)

## [0.13.1](https://github.com/rig-c/review/compare/v0.13.0...v0.13.1) (2026-10-29)


### Bug Fixes

* **producer:** resolve the compiler under @rig-c/core as well as rig-c, and refresh package guidance ([#222](https://github.com/rig-c/review/issues/222)) ([42c437b](https://github.com/rig-c/review/commit/42c437b1de57f4e470706efed30af0d162830c93)), closes [#221](https://github.com/rig-c/review/issues/221)

## [0.13.0](https://github.com/rig-c/review/compare/v0.12.0...v0.13.0) (2026-10-28)


### Features

* **release:** publish the convenience alias rig-review from the same release, like rig-parts, rig-play and rig-pose ([#219](https://github.com/rig-c/review/issues/219)) ([6a0e732](https://github.com/rig-c/review/commit/6a0e732c89d7de025993b184b5bdb2b5c3f4d0bd))

## [0.12.0](https://github.com/rig-c/review/compare/v0.11.2...v0.12.0) (2026-10-25)


### Features

* inspect animation keys, curves and bone hierarchy ([#216](https://github.com/rig-c/review/issues/216)) ([86a790c](https://github.com/rig-c/review/commit/86a790c91fb8b46d450f9bde2e7b1fcc01a86ae6))

## [0.11.2](https://github.com/rig-c/review/compare/v0.11.1...v0.11.2) (2026-10-21)


### Bug Fixes

* **ci:** resolve annotated release tags through full refs ([#213](https://github.com/rig-c/review/issues/213)) ([e1e8969](https://github.com/rig-c/review/commit/e1e896942ee8625d5cff1168c96742676bf3b5e6))

## [0.11.1](https://github.com/rig-c/review/compare/v0.11.0...v0.11.1) (2026-10-21)


### Bug Fixes

* **ci:** refuse push releases with mismatched provenance SHA ([#210](https://github.com/rig-c/review/issues/210)) ([0dfab63](https://github.com/rig-c/review/commit/0dfab63522178ae92951b9554a99dd0969ac5a1a))

## [0.11.0](https://github.com/rig-c/review/compare/v0.10.5...v0.11.0) (2026-10-21)


### Features

* **preview:** consume Play context and live physics parameters ([#207](https://github.com/rig-c/review/issues/207)) ([e1ba857](https://github.com/rig-c/review/commit/e1ba85722bb06c063c05c91565dab946de397915))

## [0.10.5](https://github.com/rig-c/review/compare/v0.10.4...v0.10.5) (2026-10-21)


### Bug Fixes

* **mesh:** read setup geometry through the published Play API ([#204](https://github.com/rig-c/review/issues/204)) ([1f0a879](https://github.com/rig-c/review/commit/1f0a8798a1a0cec0f809436f3ddc72bc5665d844))

## [0.10.4](https://github.com/rig-c/review/compare/v0.10.3...v0.10.4) (2026-10-21)


### Performance Improvements

* **mesh:** share the input check across density candidates ([#201](https://github.com/rig-c/review/issues/201)) ([1f47006](https://github.com/rig-c/review/commit/1f47006c092602aaf7985ee0ade27198b73d6c88))

## [0.10.3](https://github.com/rig-c/review/compare/v0.10.2...v0.10.3) (2026-10-21)


### Bug Fixes

* **ci:** a dispatched publish refuses when the run's commit is not the tag's (provenance) ([#199](https://github.com/rig-c/review/issues/199)) ([4c9b363](https://github.com/rig-c/review/commit/4c9b3634243c37b917961f79a1382906dd52c065)), closes [#198](https://github.com/rig-c/review/issues/198)

## [0.10.2](https://github.com/rig-c/review/compare/v0.10.1...v0.10.2) (2026-10-21)


### Bug Fixes

* **ci:** a dispatched publish requires a release-please release and a tag on main ([#193](https://github.com/rig-c/review/issues/193)) ([7977d88](https://github.com/rig-c/review/commit/7977d8864ad64f14dd6fd2687d14cec87f0b18c9))
* range worst frame, nested cloth fields, part image in baseline reach, named build dirs hashed ([#196](https://github.com/rig-c/review/issues/196)) ([b6353f1](https://github.com/rig-c/review/commit/b6353f18f68a5f13bd530a1cc3a161133e7e943a)), closes [#185](https://github.com/rig-c/review/issues/185)
* **state:** one canonical containment check for the review state directory ([#192](https://github.com/rig-c/review/issues/192)) ([c0eae97](https://github.com/rig-c/review/commit/c0eae97b5892532b699dd25560fefb5bf6fe85ff))
* strip ownership race, stale strip pending, last environment frame, wind clock restart (Codex P1s) ([#191](https://github.com/rig-c/review/issues/191)) ([b8792e3](https://github.com/rig-c/review/commit/b8792e396e2ae109004086c227ab5afeeb1359d1))
* **view:** editor UI state — retarget clean flag and seek, undo restores retarget clip, stale label and readouts, off-canvas labels (Codex P2s) ([#197](https://github.com/rig-c/review/issues/197)) ([de04fd2](https://github.com/rig-c/review/commit/de04fd27226eadae7d5910f99b7d3f9d256ac3d8))

## [0.10.1](https://github.com/rig-c/review/compare/v0.10.0...v0.10.1) (2026-10-21)


### Bug Fixes

* **cuts:** adding a cut or patch keeps the config's existing regions ([#190](https://github.com/rig-c/review/issues/190)) ([b2adf48](https://github.com/rig-c/review/commit/b2adf488dfaa98b5f145c0cf47b7777c113e5a3e)), closes [#184](https://github.com/rig-c/review/issues/184)
* **rebuild:** publish "refused" or "failed" only after the job's scratch is removed ([#181](https://github.com/rig-c/review/issues/181)) ([dd71585](https://github.com/rig-c/review/commit/dd715853e1343ddcc3ca1de5e8b63bff38fdc173)), closes [#180](https://github.com/rig-c/review/issues/180)

## [0.10.0](https://github.com/rig-c/review/compare/v0.9.0...v0.10.0) (2026-10-21)


### Features

* **mesh:** a density strip — N candidates of the part's density field side by side, refine between ([#178](https://github.com/rig-c/review/issues/178)) ([c067082](https://github.com/rig-c/review/commit/c067082e001374039beee3aaeac6c45db92ec542)), closes [#173](https://github.com/rig-c/review/issues/173)


### Bug Fixes

* **view:** the Cuts and Cloth blocks mark as applied only the ops of the record on the stage ([#175](https://github.com/rig-c/review/issues/175)) ([312ba57](https://github.com/rig-c/review/commit/312ba570a6070c299c6202aebebc176287d465fc))


### Performance Improvements

* **rebuild:** a patch-remesh Apply reads remesh's own revision check instead of running check a third time ([#176](https://github.com/rig-c/review/issues/176)) ([67e2548](https://github.com/rig-c/review/commit/67e25481432134d1baf61f509f1ea5b6926ed955)), closes [#174](https://github.com/rig-c/review/issues/174)

## [0.9.0](https://github.com/rig-c/review/compare/v0.8.1...v0.9.0) (2026-10-21)


### Features

* **open:** open a rig-parts build root and take the build's own config ([#168](https://github.com/rig-c/review/issues/168)) ([84168f4](https://github.com/rig-c/review/commit/84168f41b90db7a19b4f08a7f9809ad6af8c1f6f)), closes [#149](https://github.com/rig-c/review/issues/149)
* **rebuild:** undo across Applies, N deep, from the applied records ([#171](https://github.com/rig-c/review/issues/171)) ([1161706](https://github.com/rig-c/review/commit/11617062d46cec654cf4a9d86c848efbab465fb7)), closes [#166](https://github.com/rig-c/review/issues/166)


### Bug Fixes

* **rebuild:** say what Apply can still do on a hand-repaired build; correct the retune claim ([#170](https://github.com/rig-c/review/issues/170)) ([6880381](https://github.com/rig-c/review/commit/688038195a5ef4b154b22c7ec6b5a97f81885142)), closes [#148](https://github.com/rig-c/review/issues/148)

## [0.8.1](https://github.com/rig-c/review/compare/v0.8.0...v0.8.1) (2026-10-20)


### Bug Fixes

* **overlay:** marker labels avoid each other on the stage ([#158](https://github.com/rig-c/review/issues/158)) ([784f52e](https://github.com/rig-c/review/commit/784f52ed66c44a44fb0709d3c86281504e884d39)), closes [#147](https://github.com/rig-c/review/issues/147)
* **view:** the rig pane names the frame it shows; the counter reads a retarget build's own clock; no control probe without --control ([#165](https://github.com/rig-c/review/issues/165)) ([ad3bb7a](https://github.com/rig-c/review/commit/ad3bb7a560a8cbf390f4da3011044d7de4b4689e)), closes [#164](https://github.com/rig-c/review/issues/164)

## [0.8.0](https://github.com/rig-c/review/compare/v0.7.1...v0.8.0) (2026-10-20)


### Features

* **animate:** use the watched wind for readings and check — export it as rigc-environment/1, run `check --environment` ([#155](https://github.com/rig-c/review/issues/155)) ([b11ac5c](https://github.com/rig-c/review/commit/b11ac5c0a7fe533f192a5302939546319e339fd0)), closes [#112](https://github.com/rig-c/review/issues/112)
* **setup:** cloth recipe form — edit /cloth/&lt;tag&gt;, re-drafted by `propose --cloth --write-config` and built in scratch ([#156](https://github.com/rig-c/review/issues/156)) ([e3cfca6](https://github.com/rig-c/review/commit/e3cfca67acd7896209ec5110a78dd755a8042f2c)), closes [#111](https://github.com/rig-c/review/issues/111)


### Bug Fixes

* **ci:** publish an already-cut release tag by hand when its publish did not land ([#153](https://github.com/rig-c/review/issues/153)) ([c47a0dd](https://github.com/rig-c/review/commit/c47a0dd622e25c3672161eb001c4ce2f602f7840))


### Performance Improvements

* **rebuild:** a retune Apply reads retune's own revision check instead of running check again ([#157](https://github.com/rig-c/review/issues/157)) ([03dbf92](https://github.com/rig-c/review/commit/03dbf921945553de45a5ff21a0fa33f59ee5a3b9)), closes [#139](https://github.com/rig-c/review/issues/139)

## [0.7.1](https://github.com/rig-c/review/compare/v0.7.0...v0.7.1) (2026-10-20)


### Bug Fixes

* **requirements:** picking a part without a producer handoff no longer throws ([#151](https://github.com/rig-c/review/issues/151)) ([00e8276](https://github.com/rig-c/review/commit/00e82761002a109e4888ab51195b8e6c40a01fe5)), closes [#150](https://github.com/rig-c/review/issues/150)

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
