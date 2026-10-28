# Progress

One line per finished task, newest last: `YYYY-MM-DD <task id> <commit> <what changed>`.

2026-10-28 M1.01 50d467a rule-coverage test: checked tasks' rule ids must appear in a describe/it/test title
2026-10-28 M1.02 e065f4e model types with zod schemas, closed ErrorCode enum, Result with ok()/err()
2026-10-28 M1.03 184dede sandbox host: per-test temp home/appData, escaping fs paths and cwds fail the test; core tests get their own TS project and may use Node
2026-10-28 M1.04 0dd4642 strict zod readers for the six golden fixtures, expected(), replaySplice(), materializeTree()
2026-10-28 M1.05 412489a pyyamlInline: all 4,689 scalar.json outputs byte-equal; MULTILINE_VALUE when the emitted scalar would span lines (a double-quoted \n is accepted, per the fixture)
