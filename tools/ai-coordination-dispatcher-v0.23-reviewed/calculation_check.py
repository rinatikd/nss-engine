"""Check the two expected physical quantities without evaluating model text as code.

Only presentation wrappers are normalized. Signs and unit case are preserved.
The last quantity of each unit family is the reported result, which permits
formula inputs such as ``4 * 2 Мбит/с = 8 Мбит/с`` before the conclusion.
This validates reported values/units, not arbitrary equations or prose claims.
"""
from decimal import Decimal
import re


_NUMBER = r"(?<![\w.,+\-])(?P<number>[+\-]?(?:\d+(?:\.\d+)?|\.\d+))"
_FLOW_UNIT = (
    r"(?:[Мм](?i:бит|байт|[Бб])\s*/\s*(?i:сек|с)"
    r"|[Mm](?i:bits?|bytes?)\s*/\s*s"
    r"|[Mm][Bb]\s*/\s*s|[Mm][Bb]ps)"
)
_ARCHIVE_UNIT = r"(?:[Gg][iI]?[Bb]|[Гг][иИ]?[Бб])"
_ARCHIVE_QUALIFIER = r"(?P<archive_qualifier>(?i:десятичных|decimal|двоичных|binary))"
_QUANTITY = re.compile(
    _NUMBER + r"(?:\s*(?P<flow>" + _FLOW_UNIT + r")|(?:\s+"
    + _ARCHIVE_QUALIFIER + r"\s+|\s*)(?P<archive>" + _ARCHIVE_UNIT
    + r"))(?![\w]|\s*[/^])"
)


def _normalize(answer):
    if not isinstance(answer, str) or not answer.strip() or len(answer) > 20000:
        raise ValueError("Calculation answer must contain 1..20000 characters")
    text = answer.translate(str.maketrans({"−": "-", "﹣": "-", "－": "-"}))
    text = re.sub(r"[\u200b\u200c\u200d\ufeff]", "", text)
    text = re.sub(r"(?<=\d)\{([.,])\}(?=\d)", r"\1", text)
    # Preserve command boundaries before unwrapping '\text{...}' into letters.
    text = re.sub(r"\\(?:qquad\b|quad\b|enspace\b|thinspace\b|[,;:!])", " ", text)
    for _ in range(4):
        updated = re.sub(r"\\(?:text|mathrm|textrm)\s*\{([^{}]*)\}", r"\1", text)
        if updated == text:
            break
        text = updated
    text = re.sub(r"\\[()\[\]]", "", text)
    text = re.sub(r"\{([+\-]?\d+(?:[.,]\d+)?)\}", r"\1", text)
    text = text.replace("**", "").replace("__", "").replace("`", "").replace("$", "")
    text = text.replace(",", ".")
    # Keep spaced mathematical signs attached; do not turn '- 8' into positive 8.
    return re.sub(r"([+\-])\s+(?=\d)", r"\1", text)


def _is_bit_rate(unit):
    compact = re.sub(r"\s+", "", unit)
    if compact in {"Mbps", "Mb/s"}:
        return True
    if compact.startswith("М"):
        return compact[1:].casefold() in {"бит/с", "бит/сек"}
    if compact.startswith("M"):
        return compact[1:].casefold() in {"bit/s", "bits/s"}
    return False


def validate_calculation(answer: str) -> None:
    """Require a positive 8 Mbit/s result and 86.4 decimal GB result.

    Accept Russian/English bit-rate notation, GB/ГБ with an optional exact
    'десятичных'/'decimal' qualifier, decimal comma, inline
    Markdown and limited LaTeX text/spacing wrappers. Byte rates, gigabits,
    binary GiB, negative values and numeric substrings do not satisfy it.
    """
    values = {}
    for match in _QUANTITY.finditer(_normalize(answer)):
        if match.group("flow") is not None:
            values["flow"] = (Decimal(match.group("number")), _is_bit_rate(match.group("flow")))
        else:
            qualifier = (match.group("archive_qualifier") or "").casefold()
            values["archive"] = (
                Decimal(match.group("number")),
                match.group("archive") in {"ГБ", "GB"}
                and qualifier in {"", "десятичных", "decimal"})
    if values.get("flow") != (Decimal("8"), True):
        raise ValueError("Expected a positive total flow of 8 Mbit/s")
    if values.get("archive") != (Decimal("86.4"), True):
        raise ValueError("Expected a positive archive of 86.4 decimal GB")
