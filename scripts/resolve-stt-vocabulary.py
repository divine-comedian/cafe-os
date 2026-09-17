#!/usr/bin/env python3
"""Attach conservative, unverified vocabulary suggestions to an ASR transcript."""

from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any


WORD_RE = re.compile(r"[^\W_]+(?:['’-][^\W_]+)*", re.UNICODE)
MAX_SUGGESTIONS = 8


def normalized(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value.casefold())
    without_marks = "".join(char for char in decomposed if not unicodedata.combining(char))
    return " ".join(WORD_RE.findall(without_marks))


def phonetic_key(value: str) -> str:
    """Return a coarse bilingual ASR key while retaining consonant structure."""
    keys: list[str] = []
    for word in normalized(value).split():
        if len(word) < 4:
            return ""
        encoded = word
        for source, target in (
            ("sch", "X"), ("sh", "X"), ("ch", "X"),
            ("ll", "Y"), ("qu", "k"), ("ck", "k"), ("ph", "f"),
        ):
            encoded = encoded.replace(source, target)
        encoded = encoded.replace("w", "u").replace("y", "i")
        encoded = encoded.replace("v", "b").replace("z", "s")
        encoded = encoded.replace("h", "")
        encoded = re.sub(r"c(?=[ei])", "s", encoded)
        encoded = encoded.replace("c", "k").replace("q", "k")
        encoded = encoded.replace("j", "H").replace("g", "H")
        encoded = re.sub(r"[aeiou]+", "A", encoded)
        encoded = re.sub(r"(.)\1+", r"\1", encoded)
        if not re.search(r"[^A]", encoded):
            return ""
        keys.append(encoded.upper())
    return "/".join(keys)


def load_entries(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("version") != 1 or not isinstance(payload.get("entries"), list):
        raise ValueError("known-vocabulary file has an unsupported schema")
    entries: list[dict[str, Any]] = []
    for item in payload["entries"]:
        if not isinstance(item, dict) or not isinstance(item.get("term"), str):
            raise ValueError("known-vocabulary entry is invalid")
        aliases = item.get("aliases", [])
        if not isinstance(aliases, list) or not all(isinstance(alias, str) for alias in aliases):
            raise ValueError("known-vocabulary aliases are invalid")
        entries.append({"term": item["term"], "aliases": aliases})
    return entries


def _is_close(observed: str, term: str) -> tuple[bool, float]:
    if observed == term or not observed or not term or observed[0] != term[0]:
        return False, 0.0
    longest = max(len(observed), len(term))
    if longest < 4 or abs(len(observed) - len(term)) > (1 if longest < 8 else 2):
        return False, 0.0
    ratio = difflib.SequenceMatcher(None, observed, term).ratio()
    threshold = 0.75 if longest <= 4 else 0.82
    return ratio >= threshold, ratio


def suggestions(transcript: str, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    words = [(match.group(0), match.start(), match.end()) for match in WORD_RE.finditer(transcript)]
    found: list[dict[str, Any]] = []
    claimed: set[tuple[int, int]] = set()

    candidates: list[tuple[int, str, str, str]] = []
    phonetic_owners: dict[str, set[str]] = {}
    for entry in entries:
        key = phonetic_key(entry["term"])
        if key:
            phonetic_owners.setdefault(key, set()).add(normalized(entry["term"]))
    for entry in entries:
        term = entry["term"].strip()
        canonical = normalized(term)
        if not canonical:
            continue
        for alias in entry["aliases"]:
            alias_value = normalized(alias)
            if alias_value and alias_value != canonical:
                candidates.append((len(alias_value.split()), alias_value, term, "alias"))
        candidates.append((len(canonical.split()), canonical, term, "fuzzy"))
        key = phonetic_key(term)
        if key and len(phonetic_owners[key]) == 1:
            candidates.append((len(canonical.split()), key, term, "phonetic"))

    # Long phrases and explicit aliases win over short/fuzzy candidates.
    match_priority = {"alias": 0, "fuzzy": 1, "phonetic": 2}
    candidates.sort(key=lambda item: (-item[0], match_priority[item[3]], item[2].casefold()))
    for width, expected, term, match_type in candidates:
        if len(found) >= MAX_SUGGESTIONS or width > len(words):
            break
        for start in range(0, len(words) - width + 1):
            span = (start, start + width)
            if any(span[0] < occupied[1] and occupied[0] < span[1] for occupied in claimed):
                continue
            observed = transcript[words[start][1]:words[start + width - 1][2]]
            observed_normalized = normalized(observed)
            if observed_normalized == normalized(term):
                continue
            if match_type == "alias":
                matched, score = observed_normalized == expected, 1.0
            elif match_type == "fuzzy":
                matched, score = _is_close(observed_normalized, expected)
            else:
                score = difflib.SequenceMatcher(None, observed_normalized, normalized(term)).ratio()
                matched = score >= 0.45 and phonetic_key(observed) == expected
            if not matched:
                continue
            found.append({
                "observed": observed,
                "term": term,
                "match": match_type,
                "score": round(score, 2),
            })
            claimed.add(span)
            if len(found) >= MAX_SUGGESTIONS:
                break
    return found


def render(transcript: str, matches: list[dict[str, Any]]) -> str:
    raw = transcript.rstrip("\r\n")
    if not matches:
        return raw + "\n"
    lines = [
        raw,
        "",
        "[[HERMES_STT_VOCABULARY_SUGGESTIONS_V1]]",
        "The raw transcription above is unchanged. These matches are unverified; confirm the intended term before using it in an operational record.",
    ]
    lines.extend(f'- "{item["observed"]}" may refer to "{item["term"]}".' for item in matches)
    lines.append("[[/HERMES_STT_VOCABULARY_SUGGESTIONS_V1]]")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vocabulary", required=True, type=Path)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    try:
        raw = args.input.read_text(encoding="utf-8")
        entries = load_entries(args.vocabulary)
        matches = suggestions(raw, entries)
        args.output.write_text(render(raw, matches), encoding="utf-8")
        if args.report:
            args.report.write_text(json.dumps({
                "entry_count": len(entries),
                "suggestion_count": len(matches),
                "alias_matches": sum(item["match"] == "alias" for item in matches),
                "fuzzy_matches": sum(item["match"] == "fuzzy" for item in matches),
                "phonetic_matches": sum(item["match"] == "phonetic" for item in matches),
            }, separators=(",", ":")) + "\n", encoding="utf-8")
        return 0
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        print(f"Vocabulary resolution failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
