"""Gemini layer: plain-English explanation and natural-language queries.

Hard rule, stated in the pitch: Gemini never touches the numerical path. The
physics is ODEs. This module explains results that have already been computed
and parses questions into a structured query. It computes nothing.

Everything degrades without an API key: the explanation falls back to a
template built from the same per-channel numbers, and the query parser falls
back to a regex. A rate limit or flaky conference wifi cannot break the
headline feature.
"""
import os
import re

MODEL = os.environ.get('GEMINI_MODEL', 'gemini-3.8-flash')
FALLBACK_MODEL = 'gemini-3.5-flash-lite'

PROMPT = """You are a cardiac safety pharmacologist. Explain in exactly two sentences
why this compound received its risk classification. Reference the specific channels.
Do not hedge, do not add caveats, do not mention being an AI.

Compound: {drug} at {dose}x therapeutic Cmax ({conc:.1f} nM)
Channel block at this concentration: {block}
hERG channels drug-bound at peak: {bound:.0%}
qNet: {qnet:.4f} uC/uF (drug-free control: 0.0781)
APD90 change: {dapd}
Classification: {risk}"""

QUERY_SCHEMA = {
    'type': 'object',
    'properties': {
        'drug': {'type': 'string',
                 'description': 'one of the 12 CiPA training compounds'},
        'dose_mult': {'type': 'number',
                      'description': 'multiple of therapeutic Cmax, 0 to 4'},
    },
    'required': ['drug', 'dose_mult'],
}

_cache = {}
_client = None


def available():
    return bool(os.environ.get('GEMINI_API_KEY'))


def _get_client():
    global _client
    if _client is None:
        from google import genai
        _client = genai.Client(api_key=os.environ['GEMINI_API_KEY'])
    return _client


def _generate(contents, config=None):
    """Call the current model, falling back to the lite model on failure."""
    client = _get_client()
    for model in (MODEL, FALLBACK_MODEL):
        try:
            return client.models.generate_content(
                model=model, contents=contents, config=config)
        except Exception:                            # noqa: BLE001
            continue
    return None


def _template(ctx):
    """Offline explanation, from the same numbers Gemini would be given."""
    blocks = sorted(ctx['block'].items(), key=lambda kv: -kv[1])
    top = [f'{ch} {frac:.0%}' for ch, frac in blocks[:3] if frac >= 0.01]
    bound = ctx['bound']
    lead = (f"{ctx['drug'].capitalize()} at {ctx['dose']}x Cmax "
            f"({ctx['conc']:.1f} nM) leaves {bound:.0%} of hERG channels "
            f"drug-bound at peak")
    lead += (f", with additional block of {', '.join(top)}." if top
             else ', with no appreciable block of the other channels.')
    if ctx['repol_failure']:
        second = ('Repolarising reserve is exhausted: the cell fails to '
                  f"repolarise within the cycle and qNet falls to "
                  f"{ctx['qnet']:.4f} uC/uF against a control of 0.0781, "
                  f"which places it in {ctx['risk']}.")
    else:
        second = (f"Net charge carried over the beat falls to "
                  f"{ctx['qnet']:.4f} uC/uF against a drug-free control of "
                  f"0.0781, with APD90 {ctx['dapd']}, placing it in "
                  f"{ctx['risk']}.")
    return f'{lead} {second}'


def explain(drug, dose_mult, conc_nM, block, bound, qnet, dapd90, risk,
            repol_failure=False):
    """Two sentences on why this compound scored as it did.

    Cached per (drug, dose) so the slider never triggers an API call.
    """
    key = (drug, round(float(dose_mult), 2))
    if key in _cache:
        return _cache[key]

    ctx = {
        'drug': drug, 'dose': dose_mult, 'conc': conc_nM,
        'block': ', '.join(f'{k} {v:.0%}' for k, v in block.items()),
        'bound': bound, 'qnet': qnet, 'risk': risk,
        'dapd': ('repolarisation failure (no APD90)' if repol_failure
                 else f'{dapd90:+.1f} ms'),
    }
    out, source = None, 'template'
    if available():
        resp = _generate(PROMPT.format(**ctx))
        if resp is not None and getattr(resp, 'text', None):
            out, source = resp.text.strip(), MODEL

    if out is None:
        ctx['block'] = block
        ctx['repol_failure'] = repol_failure
        out = _template(ctx)

    result = {'text': out, 'source': source}
    _cache[key] = result
    return result


# Ordered: an explicit multiplier wins over the baseline words, because
# "twice the normal dose" contains both and means 2x.
_DOSE_WORDS = [('quadruple', 4), ('four', 4), ('triple', 3), ('three', 3),
               ('double', 2), ('twice', 2), ('two', 2),
               ('normal', 1), ('therapeutic', 1), ('standard', 1)]


def _regex_parse(question, drugs):
    """Fallback parser. Keeps the NL feature alive without a network."""
    q = question.lower()
    drug = next((d for d in drugs if d in q), None)
    dose = None
    m = re.search(r'(\d+(?:\.\d+)?)\s*(?:x|times|×|-?fold)', q)
    if m:
        dose = float(m.group(1))
    else:
        for word, mult in _DOSE_WORDS:
            if re.search(rf'\b{word}\b', q):
                dose = mult
                break
    return {'drug': drug, 'dose_mult': dose if dose is not None else 1.0,
            'source': 'regex'}


def parse_query(question, drugs):
    """Natural language -> {drug, dose_mult}. Structured output, not free text."""
    if available():
        try:
            from google.genai import types
            resp = _generate(
                f'Parse this question into a drug and a dose multiple of '
                f'therapeutic Cmax. Valid drugs: {", ".join(drugs)}.\n\n'
                f'Question: {question}',
                config=types.GenerateContentConfig(
                    response_mime_type='application/json',
                    response_schema=QUERY_SCHEMA))
            if resp is not None and getattr(resp, 'text', None):
                import json
                parsed = json.loads(resp.text)
                if parsed.get('drug') in drugs:
                    return {'drug': parsed['drug'],
                            'dose_mult': max(0.0, min(4.0, float(
                                parsed.get('dose_mult', 1)))),
                            'source': MODEL}
        except Exception:                            # noqa: BLE001
            pass
    return _regex_parse(question, drugs)
