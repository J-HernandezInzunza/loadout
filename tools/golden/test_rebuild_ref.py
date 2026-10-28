"""Hand-written expectations for the rebuild's splice rules (behaviors.md §0.1 D1-D4).

These pin rebuild_ref.py, which in turn generates the `rebuild` expectation of every golden case
that deviates from library.py. Run: python3 -m unittest discover -s tools/golden
"""

import unittest

import rebuild_ref as R

E = R.Entry


def entry(name, etype="skill", description="D", source=None, requires=()):
    return E(etype, name, description, source or f"./{name}", list(requires))


class D1CreateMissingSection(unittest.TestCase):
    def test_after_the_preceding_section_before_the_blank_separator(self):
        text = "library:\n  skills:\n    - name: a\n      description: A\n      source: ./a\n\n  prompts: []\n"
        self.assertEqual(
            R.splice_entry(text, entry("x", "agent")),
            "library:\n  skills:\n    - name: a\n      description: A\n      source: ./a\n"
            "  agents:\n    - name: x\n      description: D\n      source: ./x\n\n  prompts: []\n",
        )

    def test_directly_after_library_when_no_section_precedes(self):
        self.assertEqual(
            R.splice_entry("library:\n  agents: []\n", entry("x")),
            "library:\n  skills:\n    - name: x\n      description: D\n      source: ./x\n  agents: []\n",
        )

    def test_into_an_empty_library_block_at_eof(self):
        self.assertEqual(
            R.splice_entry("library:\n", entry("x", "prompt")),
            "library:\n  prompts:\n    - name: x\n      description: D\n      source: ./x\n",
        )

    def test_refuses_when_the_section_it_would_follow_has_an_unsupported_layout(self):
        with self.assertRaises(R.SpliceError) as ctx:
            R.splice_entry("library:\n  skills:\n  - name: alpha\n    source: y\n", entry("x", "agent"))
        self.assertEqual((ctx.exception.code, ctx.exception.line), ("SPLICE_UNSUPPORTED", 3))

    def test_missing_library_key_is_still_an_error(self):
        with self.assertRaises(R.SpliceError) as ctx:
            R.splice_entry("library:  # c\n  skills: []\n", entry("x"))
        self.assertEqual(ctx.exception.message, "no 'library:' key in catalog")


class D2UnsupportedLayouts(unittest.TestCase):
    def assertUnsupported(self, text, line, op=lambda t: R.splice_entry(t, entry("beta"))):
        with self.assertRaises(R.SpliceError) as ctx:
            op(text)
        self.assertEqual((ctx.exception.code, ctx.exception.line), ("SPLICE_UNSUPPORTED", line))

    def test_inline_brackets_with_a_space(self):
        self.assertUnsupported("library:\n  skills: [ ]\n", 2)

    def test_non_empty_flow_sequence(self):
        self.assertUnsupported("library:\n  skills: [{name: a}]\n", 2)

    def test_two_space_items(self):
        self.assertUnsupported("library:\n  skills:\n  - name: alpha\n    description: x\n    source: y\n", 3)

    def test_item_not_starting_with_name(self):
        self.assertUnsupported("library:\n  skills:\n    - description: x\n      name: a\n", 3)

    def test_four_space_key_outside_an_item(self):
        self.assertUnsupported("library:\n  skills:\n    stray: 1\n", 3)

    def test_also_refused_on_remove(self):
        self.assertUnsupported(
            "library:\n  skills:\n  - name: alpha\n    source: y\n", 3, lambda t: R.remove_entry(t, "skill", "alpha")
        )

    def test_header_comment_is_fine(self):
        self.assertEqual(
            R.splice_entry("library:\n  skills: # mine\n    - name: a\n      description: A\n      source: ./a\n", entry("b")),
            "library:\n  skills: # mine\n    - name: a\n      description: A\n      source: ./a\n"
            "    - name: b\n      description: D\n      source: ./b\n",
        )


THREE_SPACED = """\
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
"""


class D3Remove(unittest.TestCase):
    def test_head_keeps_the_comment_above_the_next_item(self):
        self.assertEqual(
            R.remove_entry(THREE_SPACED, "skill", "alpha"),
            """\
library:
  skills:
    # beta is the odd one
    - name: beta
      description: B
      source: ./beta
      tags: [x]

    - name: gamma
      description: C
      source: ./gamma

  agents: []
""",
        )

    def test_middle_takes_its_own_lines_and_the_blank_below(self):
        self.assertEqual(
            R.remove_entry(THREE_SPACED, "skill", "beta"),
            """\
library:
  skills:
    - name: alpha
      description: A
      source: ./alpha

    # beta is the odd one
    - name: gamma
      description: C
      source: ./gamma

  agents: []
""",
        )

    def test_last_takes_the_blank_above_and_keeps_the_section_separator(self):
        self.assertEqual(
            R.remove_entry(THREE_SPACED, "skill", "gamma"),
            """\
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

  agents: []
""",
        )

    def test_a_deeper_comment_inside_the_item_goes_with_it(self):
        text = "library:\n  skills:\n    - name: a\n      # pinned\n      source: ./a\n    - name: b\n      source: ./b\n"
        self.assertEqual(
            R.remove_entry(text, "skill", "a"),
            "library:\n  skills:\n    - name: b\n      source: ./b\n",
        )

    def test_emptied_section_keeps_comments_separator_and_trailing_newline(self):
        text = "library:\n  skills:\n    # none yet\n    - name: a\n      source: ./a\n\n  prompts:\n    - name: p\n      source: ./p\n"
        once = R.remove_entry(text, "skill", "a")
        self.assertEqual(once, "library:\n  skills: []\n    # none yet\n\n  prompts:\n    - name: p\n      source: ./p\n")
        self.assertEqual(
            R.remove_entry(once, "prompt", "p"),
            "library:\n  skills: []\n    # none yet\n\n  prompts: []\n",
        )

    def test_unknown_name_is_still_an_error(self):
        with self.assertRaises(R.SpliceError) as ctx:
            R.remove_entry(THREE_SPACED, "skill", "nope")
        self.assertEqual(ctx.exception.message, "'nope' not found in skills")


class D4Replace(unittest.TestCase):
    def test_edits_values_in_place_keeping_unknown_keys_comments_and_blanks(self):
        text = """\
library:
  skills:
    - name: alpha
      # the canonical one
      description: A
      source: ./alpha
      tags: [x]
      requires:
        - skill:beta

    - name: beta
      description: B
      source: ./beta
"""
        self.assertEqual(
            R.replace_entry(text, "skill", "alpha", entry("alpha", description="A: two", source="./a2", requires=["skill:gamma"])),
            """\
library:
  skills:
    - name: alpha
      # the canonical one
      description: 'A: two'
      source: ./a2
      tags: [x]
      requires: ["skill:gamma"]

    - name: beta
      description: B
      source: ./beta
""",
        )

    def test_adds_requires_after_source_and_removes_it_when_empty(self):
        text = "library:\n  skills:\n    - name: a\n      description: A\n      source: ./a\n      tags: [x]\n"
        added = R.replace_entry(text, "skill", "a", entry("a", description="A", source="./a", requires=["skill:b"]))
        self.assertEqual(
            added, "library:\n  skills:\n    - name: a\n      description: A\n      source: ./a\n      requires: [\"skill:b\"]\n      tags: [x]\n"
        )
        self.assertEqual(R.replace_entry(added, "skill", "a", entry("a", description="A", source="./a")), text)

    def test_same_indent_block_sequence_counts_as_the_value(self):
        text = "library:\n  skills:\n    - name: a\n      source: ./a\n      requires:\n      - skill:b\n      tags: [x]\n"
        self.assertEqual(
            R.replace_entry(text, "skill", "a", entry("a", description="A", source="./a")),
            "library:\n  skills:\n    - name: a\n      description: A\n      source: ./a\n      tags: [x]\n",
        )

    def test_multiline_value_collapses_to_one_line(self):
        text = "library:\n  skills:\n    - name: a\n      description: >\n        long\n        text\n      source: ./a\n"
        self.assertEqual(
            R.replace_entry(text, "skill", "a", entry("a", description="short", source="./a")),
            "library:\n  skills:\n    - name: a\n      description: short\n      source: ./a\n",
        )


class A11Refs(unittest.TestCase):
    def test_quote_backslash_and_control_characters_are_refused(self):
        for ref in ['skill:a"b', "skill:a\\b", "skill:a\tb"]:
            with self.subTest(ref=ref), self.assertRaises(R.SpliceError) as ctx:
                R.render_entry(entry("x", requires=[ref]))
            self.assertEqual(ctx.exception.code, "INVALID_REF")


if __name__ == "__main__":
    unittest.main()
