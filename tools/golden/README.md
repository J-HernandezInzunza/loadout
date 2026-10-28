# Golden fixtures

Dev-only. Generates the JSON fixtures in `packages/core/test/golden/` by running the old CLI's
`library.py` (the-library-skill @ `a29e816`, PyYAML 6.0.3) on fixed inputs. The core's Vitest suite
replays them; CI never needs Python (architecture.md §3.2).

| Command | What it does |
|---|---|
| `npm run golden` | regenerate every fixture |
| `npm run golden:check` | regenerate into a temp dir and diff against the committed fixtures (no diff = exit 0) |
| `npm run golden:test` | run the hand-written tests that pin `rebuild_ref.py` |

They use the old repo's venv at `$LIBRARY_SKILL_DIR/.venv` (default
`~/Projects/my-tools/the-library-skill`). The generator refuses to run unless that repo is at
`a29e816` with `library.py` unmodified; `--allow-any-commit` lifts that for diffing against a newer
`library.py`. It imports `library.py` without writing bytecode and never writes to the old repo.

## Corpora

| File | From | Contents |
|---|---|---|
| `splice.json` | `splice_entry`, `remove_entry`, `replace_entry`, `render_entry` | 29 catalog texts × every insert/remove/replace/batch/round-trip operation; output text (and whether it parses) or the error |
| `scalar.json` | `_yaml_inline` | ~280 hand-picked strings plus seeded random ones; the quoted form or `multiline` |
| `source.json` | `parse_source`, `Source.clone_urls`, `_remote_web` | every URL shape in behaviors.md §1.5 and the failure forms (`~` expands to `/home/golden`) |
| `hash.json` | `content_hash` | small trees (nesting, empty files, unicode names, symlinks, `.git`, sort order) and their digests |
| `registry.json` | `Config.problems`, `_normalize_catalogs`, `_catalog_from_raw` | valid and invalid `config.local.yaml` texts; the problems, or the normalized catalogs |

## Python vs rebuild expectations

Some splice behavior deliberately changes in the rebuild (behaviors.md §0.1 D1–D4: missing sections
are created, unsupported layouts are refused, remove and update keep blank lines, comments and
unknown keys). Every splice case records what `library.py` does under `python`. When the rebuild's
result differs, the case also carries `rebuild`, computed by `rebuild_ref.py`, and the core is tested
against `rebuild ?? python`.

`rebuild_ref.py` is the executable form of D1–D4. Its own tests (`test_rebuild_ref.py`) use
hand-written expected outputs. Change the rules there first, then regenerate.

Never edit a fixture by hand to make a test pass.
