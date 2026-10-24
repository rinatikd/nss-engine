"""Preservation checks for local block definitions used by a modelspace layer.

The existing modelspace entity fingerprints remain a separate check. This
snapshot follows INSERT references, including nested blocks on any layer; it
does not inspect the contents of external reference files or table resources.
"""

import hashlib
import json

from ezdxf.lldxf.tagwriter import TagCollector


def tkk_block_fingerprints(doc, layer):
    """Return {block name: SHA256} for definitions reachable from layer INSERTs.

    Include BLOCK/BLOCK_RECORD/ENDBLK headers and complete exported entity tags.
    Visit each definition once so shared references and cycles terminate.
    Missing definitions fail explicitly rather than silently weakening the check.
    """
    pending = [e.dxf.name for e in doc.modelspace()
               if e.dxftype() == "INSERT" and e.dxf.layer == layer]
    result = {}

    def tags(entity):
        return [(t.code, str(t.value))
                for t in TagCollector.dxftags(entity, doc.dxfversion)]

    while pending:
        name = pending.pop()
        try:
            block = doc.blocks[name]
        except KeyError as exc:
            raise ValueError(f"TKK references missing block definition: {name}") from exc
        # Use the stored spelling: DXF block lookup is case insensitive.
        name = block.name
        if name in result:
            continue
        entities = list(block)
        payload = [tags(block.block_record), tags(block.block),
                   [tags(e) for e in entities], tags(block.endblk)]
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        result[name] = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
        pending.extend(e.dxf.name for e in entities if e.dxftype() == "INSERT")
    return result


def verify_tkk_blocks(doc, layer, expected):
    """Raise RuntimeError if reachable block definitions differ from a snapshot."""
    actual = tkk_block_fingerprints(doc, layer)
    if actual != expected:
        missing = sorted(expected.keys() - actual.keys())
        added = sorted(actual.keys() - expected.keys())
        changed = sorted(name for name in expected.keys() & actual.keys()
                         if expected[name] != actual[name])
        raise RuntimeError(
            f"TKK block definitions changed: missing={missing}, "
            f"added={added}, changed={changed}")
