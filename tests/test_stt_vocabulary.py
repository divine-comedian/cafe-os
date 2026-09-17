import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "resolve-stt-vocabulary.py"
SPEC = importlib.util.spec_from_file_location("resolve_stt_vocabulary", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class VocabularyResolverTests(unittest.TestCase):
    def test_explicit_alias_is_suggested_without_rewriting_raw_text(self):
        raw = "Compramos café con Sheema ayer."
        matches = MODULE.suggestions(raw, [{"term": "Chema", "aliases": ["Sheema"]}])
        rendered = MODULE.render(raw, matches)
        self.assertTrue(rendered.startswith(raw + "\n"))
        self.assertIn('"Sheema" may refer to "Chema"', rendered)

    def test_exact_canonical_term_has_no_suggestion(self):
        matches = MODULE.suggestions("Hablé con Chema.", [{"term": "Chema", "aliases": ["Sheema"]}])
        self.assertEqual(matches, [])

    def test_near_phrase_is_suggested_conservatively(self):
        matches = MODULE.suggestions(
            "Llegó de Sierra Verdi.",
            [{"term": "Sierra Verde", "aliases": []}],
        )
        self.assertEqual(matches[0]["term"], "Sierra Verde")
        self.assertEqual(matches[0]["match"], "fuzzy")

    def test_one_canonical_name_covers_common_phonetic_renderings(self):
        entries = [{"term": "Chema", "aliases": []}]
        for rendering in ("Shema", "Sheyma", "Sheema"):
            with self.subTest(rendering=rendering):
                matches = MODULE.suggestions(f"Hablé con {rendering}.", entries)
                self.assertEqual(matches[0]["term"], "Chema")
                self.assertEqual(matches[0]["match"], "phonetic")

    def test_unrelated_word_is_ignored(self):
        matches = MODULE.suggestions("Compramos café verde.", [{"term": "Sierra Verde", "aliases": []}])
        self.assertEqual(matches, [])


if __name__ == "__main__":
    unittest.main()
