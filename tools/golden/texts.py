"""Catalog texts the splice corpus runs every operation against.

Copied verbatim from the old repo (the-library-skill @ a29e816) with their citations, plus the
behaviors.md Appendix D edge texts and texts aimed at the rebuild rules (§0.1 D1-D4).
library.example.yaml is read from the old repo by gen.py, not copied here.
"""

TEXTS: dict[str, tuple[str, str]] = {}  # id -> (citation, text)


def text(id_: str, citation: str, body: str) -> None:
    assert id_ not in TEXTS, id_
    TEXTS[id_] = (citation, body)


# --- tests/test_library.py ------------------------------------------------------------------

text("py-catalog", "tests/test_library.py:558", """\
# Team catalog — hand-authored. The CLI splices text so this comment survives writes.
default_dirs:
  skills:
    - project: .claude/skills/
    - global: ~/.claude/skills/

library:
  skills:
    # keep alphabetical
    - name: alpha
      description: First skill
      source: ./alpha

    - name: gamma
      description: Third skill
      source: ./gamma
      requires: ["skill:alpha"]
  agents: []
  prompts:
    - name: solo
      description: Only prompt
      source: ./solo
""")

text("py-three", "tests/test_library.py:582", """\
library:
  skills:
    - name: alpha
      description: A
      source: ./alpha
    - name: beta
      description: B
      source: ./beta
    - name: gamma
      description: C
      source: ./gamma
  agents: []
  prompts: []
""")

text("py-single", "tests/test_library.py:597", """\
library:
  skills:
    - name: alpha
      description: A
      source: ./alpha
  agents: []
  prompts: []
""")

text("py-trailing-blank", "tests/test_library.py:606", """\
library:
  skills:
    - name: alpha
      description: A
      source: ./alpha

  agents: []
""")

text("py-quoted", "tests/test_library.py:615", """\
library:
  skills:
    - name: "yaml-lint"
      description: Quoted name
      source: ./yaml-lint
  agents: []
  prompts: []
""")

text("py-commented-section", "tests/test_library.py:916", """\
library:
  skills:
    # nothing here yet is fine
    - name: alpha
      description: A
      source: ./alpha
  agents: []
""")

text("py-commented-item", "tests/test_library.py:1017", """\
library:
  skills:
    - name: alpha
      description: A
      # pinned to a fork on purpose
      source: ./alpha
  agents: []
""")

text("py-golden-catalog", "tests/test_library.py:273", """\
# Fixture catalog for the single-catalog golden tests.
default_dirs:
  skills:
    - project: .claude/skills/
    - global: ~/.claude/skills/
  agents:
    - project: .claude/agents/
    - global: ~/.claude/agents/
  prompts:
    - project: .claude/commands/
    - global: ~/.claude/commands/

library:
  skills:
    - name: backend-code-practices
      description: Backend conventions for Spring Boot services
      source: https://github.com/acme/agentics/blob/main/skills/backend-code-practices/SKILL.md
    - name: session-retro
      description: Distill a finished session into durable style learnings
      source: https://github.com/acme/agentics/blob/main/skills/session-retro/SKILL.md
      requires: ["skill:backend-code-practices"]
  agents:
    - name: sql-review
      description: Reviews SQL migrations and stored procedures
      source: https://github.com/acme/agentics/blob/main/agents/sql-review.md
  prompts:
    - name: grill-me
      description: Interrogate a plan for its load-bearing decisions
      source: https://github.com/acme/agentics/blob/main/prompts/grill-me.md
""")

text("py-personal-catalog", "tests/test_library.py:306", """\
library:
  skills:
    - name: scratch-thing
      description: Personal scratch skill
      source: /srv/personal/scratch/SKILL.md
    - name: session-retro
      description: My iterated copy of session-retro
      source: /srv/personal/session-retro/SKILL.md
  agents: []
  prompts: []
""")

text("py-broken-catalog", "tests/test_library.py:372", """\
library:
  skills:
    - name: session-retro
      description: Distill a finished session into durable style learnings
      source: https://github.com/acme/agentics/blob/main/skills/session-retro/SKILL.md
      requires: ["skill:missing-dep"]
    - name: backend-code-practices
      description: Backend conventions for Spring Boot services
      source: https://github.com/acme/agentics/blob/main/skills/backend-code-practices/SKILL.md
    - name: session-retro
      description: A second entry with the same name
      source: https://github.com/acme/agentics/blob/main/skills/retro/SKILL.md
  agents: []
  prompts: []
""")

text("py-empty-catalog", "tests/test_library.py:9277", "library:\n  skills: []\n  agents: []\n  prompts: []\n")

# library.py:5943 (EDIT-15), with the {cid} placeholder filled.
text("scaffold", "library.py:5943", """\
# Personal library catalog. Registered in the tool's config.local.yaml.
# Add entries with: library add --catalog personal --name … --description … --source …
#
# No default_dirs here: install locations belong to the tool, not the catalog.
library:
  skills: []
  agents: []
  prompts: []
""")

# --- research/tools/exp_splice.py (behaviors.md §2.7 probes) ---------------------------------

text("probe-mixed", "research/tools/exp_splice.py", """\
# header comment
library:
  skills:
    - name: alpha
      description: A.
      source: https://github.com/o/r/blob/main/skills/alpha/SKILL.md
    # comment inside alpha block
    - name: gamma
      description: G.
      source: https://github.com/o/r/blob/main/skills/gamma/SKILL.md
      tags: [x]

  agents: []
  prompts:
    - name: p1
      description: P.
      source: /tmp/p1.md
""")

# --- behaviors.md Appendix D.1 edge texts ----------------------------------------------------

text("d1-library-comment", "behaviors.md D.1", "library:  # c\n  skills: []\n")
text("d1-missing-section", "behaviors.md D.1", "library:\n  agents: []\n")
text("d1-inline-space", "behaviors.md D.1", "library:\n  skills: [ ]\n")
text("d1-two-space-items", "behaviors.md D.1",
     "library:\n  skills:\n  - name: alpha\n    description: x\n    source: y\n")
text("d1-case-order", "behaviors.md D.1",
     "library:\n  skills:\n    - name: alpha\n      description: x\n      source: y\n"
     "    - name: Charlie\n      description: x\n      source: y\n")
text("d1-crlf", "behaviors.md D.1",
     "library:\r\n  skills:\r\n    - name: alpha\r\n      description: x\r\n      source: y\r\n")
text("d1-no-trailing-newline", "behaviors.md D.1",
     "library:\n  skills:\n    - name: alpha\n      description: x\n      source: y")
text("d1-top-level-after", "behaviors.md D.1",
     "library:\n  skills:\n    - name: alpha\n      description: x\n      source: y\n\ndefault_dirs:\n  skills: []\n")

# --- aimed at the rebuild rules (behaviors.md §0.1) -------------------------------------------

text("r-spaced-commented", "behaviors.md §0.1 D3/D4", """\
library:
  skills:
    - name: alpha
      description: A
      source: ./alpha

    # beta is the odd one
    - name: beta
      description: B
      source: ./beta
      tags: [x]

    - name: gamma
      description: C
      source: ./gamma

  agents: []
  prompts:
    - name: solo
      description: Only prompt
      source: ./solo
""")

text("r-block-values", "behaviors.md §0.1 D4", """\
library:
  skills:
    - name: alpha
      description: >
        A folded
        description
      source: ./alpha
      requires:
        - skill:beta
      owner: platform
    - name: beta
      source: ./beta
      requires:
      - skill:alpha
  agents: []
  prompts: []
""")

text("r-only-prompts", "behaviors.md §0.1 D1", "# just prompts so far\nlibrary:\n  prompts:\n    - name: p\n      description: P\n      source: ./p\n")
text("r-library-empty", "behaviors.md §0.1 D1", "library:\n")
text("r-header-comment", "behaviors.md §0.1 D2", "library:\n  skills: # mine\n    - name: a\n      description: A\n      source: ./a\n  agents: []\n  prompts: []\n")
text("r-flow-items", "behaviors.md §0.1 D2", "library:\n  skills: [{name: a, description: A, source: ./a}]\n  agents: []\n  prompts: []\n")
text("r-brackets-comment", "behaviors.md §0.1 D2", "library:\n  skills: []  # none\n  agents: []\n  prompts: []\n")
