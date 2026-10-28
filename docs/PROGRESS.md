# Progress

One line per finished task, newest last: `YYYY-MM-DD <task id> <commit> <what changed>`.

2026-10-28 M1.01 50d467a rule-coverage test: checked tasks' rule ids must appear in a describe/it/test title
2026-10-28 M1.02 e065f4e model types with zod schemas, closed ErrorCode enum, Result with ok()/err()
2026-10-28 M1.03 184dede sandbox host: per-test temp home/appData, escaping fs paths and cwds fail the test; core tests get their own TS project and may use Node
2026-10-28 M1.04 0dd4642 strict zod readers for the six golden fixtures, expected(), replaySplice(), materializeTree()
2026-10-28 M1.05 412489a pyyamlInline: all 4,689 scalar.json outputs byte-equal; MULTILINE_VALUE when the emitted scalar would span lines (a double-quoted \n is accepted, per the fixture)
2026-10-28 M1.06 3cfe152 renderEntry passes all 8 render cases (rebuild for the 3 refused refs); validateRef checks A11 characters, then DEP-11's type:name
2026-10-28 M1.07 832f990 spliceEntry: all 309 insert cases where library.py and the rebuild agree pass, batches included; Python whitespace, dot and string-order semantics kept
2026-10-28 M1.08 850c298 D2 layout check (assertSpliceable) with code and 1-based line: 28 of 48 SPLICE_UNSUPPORTED cases; the other 20 are D1 refusals into missing sections, left to M1.09
2026-10-28 M1.09 5cb0c1e D1: inserts create a missing section in canonical order; 132 missing-section cases pass, incl. M1.08's 20 deferred refusals; 36 create-then-remove round trips wait for M1.10
2026-10-28 M1.10 edf838d removeEntry (D3): all 330 cases with a remove pass, incl. M1.09's 36 round trips
2026-10-28 M1.11 727a4e4 replaceEntry (D4): all 896 splice.json cases now replay as expected; test-only assertSpliceable removed
2026-10-28 M1.12 d9cf9ad parseCatalog (yaml failsafe + PyYAML's exact resolvers), catalogEntries with typed field/structure problems, verifyEdit (VERIFY_FAILED), sortedProblems; all 66 read.json cases
2026-10-28 M1.13 29e8d78 scaffoldCatalog: same YAML as the CLI's scaffold, Loadout comments; accepts an insert into each section
2026-10-28 M1.14 3074272 parseSource/cloneUrls/remoteWeb: all 47 source.json cases (sandbox home); new INVALID_SOURCE error code
2026-10-28 M1.15 0647edc config store: strict AppConfigV1, no-catalogs state, queued atomic saves, an invalid file is CONFIG_INVALID (new code) and never overwritten
2026-10-28 M1.16 5abd1af validateRegistry: all 31 registry.json problem lists, in order; parseYamlMaps keeps YAML key types
