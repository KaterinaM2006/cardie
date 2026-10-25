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
TTS_MODEL = os.environ.get('GEMINI_TTS_MODEL', 'gemini-3.8-flash-tts')
TTS_VOICE = os.environ.get('GEMINI_TTS_VOICE', 'Kore')

PROMPT = """You are a cardiac safety pharmacologist. Explain in exactly two sentences
why this compound received its risk classification. Reference the specific channels.
Do not hedge, do not add caveats, do not mention being an AI. Plain prose only --
no LaTeX, no markdown, no subscript/superscript markup; write channel and metric
names as plain text (e.g. "INaL", "qNet", "APD90").

Compound: {drug} at {dose}x therapeutic Cmax ({conc:.1f} nM)
Channel block at this concentration: {block}
hERG channels drug-bound at peak: {bound:.0%}
qNet: {qnet:.4f} uC/uF (drug-free control: 0.0781)
APD90 change: {dapd}
Classification: {risk}"""

CONTEXT_PROMPT = """You are guiding a first-time viewer through a cardiac drug-safety
simulator. Write exactly two sentences orienting them in what they are
currently looking at and what is currently selected. Plain language, no
jargon dump, no hedging, do not mention being an AI.

Current view: {view_desc}
Compound selected: {drug} at {dose}x therapeutic Cmax ({conc:.1f} nM)
FDA CiPA label for this compound: {fda_label}
Computed risk at this dose: {risk}"""

VIEW_DESC = {
    'heart': ('the whole heart, rendered as an illustrative organ-level '
              'view driven by a single simulated cell -- not a tissue '
              'simulation'),
    'cell': ('a single human ventricular myocyte (one heart muscle cell), '
             'the actual unit the ORd-CiPA v1.0 model simulates'),
}

MODE_VIEW_SUFFIX = {
    'Endocardial': ' (the innermost ventricular wall layer)',
    'Epicardial': ' (the outermost ventricular wall layer, shortest action '
                  'potential of the three)',
    'Mid-myocardial': (' (the "M cell" layer in the wall’s middle, the '
                       'longest action potential of the three and the most '
                       'arrhythmogenic)'),
}

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


_context_cache = {}


def _context_template(ctx):
    """Offline fallback for the left-column view narration."""
    return (f"You're looking at {ctx['view_desc']}. {ctx['drug'].capitalize()} "
            f"is selected at {ctx['dose']}x Cmax ({ctx['conc']:.1f} nM) -- "
            f"FDA CiPA label {ctx['fda_label']}, computed risk {ctx['risk']} "
            f"at this dose.")


def explain_context(drug, dose_mult, conc_nM, fda_label, risk, stage,
                     mode_label=None):
    """Two sentences orienting the viewer in the current view: what scale
    they're looking at (whole heart vs. single myocyte, optionally which
    transmural layer) and what's currently selected (drug, dose, risk).

    This narrates the VIEW. explain() above narrates the VERDICT. Same hard
    rule as explain(): handed only numbers and labels already computed
    elsewhere, never touches the simulation.

    Cached per (stage, mode, drug, dose) so switching views/dragging the
    dose slider never spams the API.
    """
    key = (stage, mode_label, drug, round(float(dose_mult), 2))
    if key in _context_cache:
        return _context_cache[key]

    view_desc = VIEW_DESC.get(stage, VIEW_DESC['heart'])
    if stage == 'cell' and mode_label:
        view_desc += MODE_VIEW_SUFFIX.get(mode_label, '')

    ctx = {'view_desc': view_desc, 'drug': drug, 'dose': dose_mult,
           'conc': conc_nM, 'fda_label': fda_label, 'risk': risk}

    out, source = None, 'template'
    if available():
        resp = _generate(CONTEXT_PROMPT.format(**ctx))
        if resp is not None and getattr(resp, 'text', None):
            out, source = resp.text.strip(), MODEL

    if out is None:
        out = _context_template(ctx)

    result = {'text': out, 'source': source}
    _context_cache[key] = result
    return result


_audio_cache = {}


def speak(text):
    """Gemini reads an already-generated sentence aloud. Returns WAV bytes,
    or None if unavailable/failed -- same hard rule as explain() and
    explain_context(): handed a finished sentence of English, computes
    nothing else, and the demo has to survive this call failing.

    Cached per text string so repeated plays of the same explanation don't
    re-spend API quota.
    """
    if not available():
        return None
    if text in _audio_cache:
        return _audio_cache[text]

    try:
        from google.genai import types
        client = _get_client()
        resp = client.models.generate_content(
            model=TTS_MODEL, contents=text,
            config=types.GenerateContentConfig(
                response_modalities=['AUDIO'],
                speech_config=types.SpeechConfig(
                    voice_config=types.VoiceConfig(
                        prebuilt_voice_config=types.PrebuiltVoiceConfig(
                            voice_name=TTS_VOICE)))))
        part = resp.candidates[0].content.parts[0]
        if part.inline_data is None:
            return None
        audio = part.inline_data.data
    except Exception:                                  # noqa: BLE001
        return None

    _audio_cache[text] = audio
    return audio


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
                f'therapeutic Cmax. Valid drugs: {", ".join(drugs)}. If none '
                f'of these compounds is actually named or clearly implied by '
                f'the question, set drug to exactly "unknown" rather than '
                f'guessing one.\n\n'
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
