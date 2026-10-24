"""ElevenLabs layer: spoken narration of an already-computed explanation.

Same hard rule as explain.py: this module explains results that have
already been computed. It never touches the numerical path, and it is given
nothing but a finished sentence of English text. Degrades without an API
key: the narrate button simply doesn't appear, same as the Gemini pill.

Cached per text string so repeated plays (or the same drug/dose revisited)
don't re-spend API quota.
"""
import os

VOICE_ID = os.environ.get('ELEVENLABS_VOICE_ID', 'NOpBlnGInO9m6vDvFkFC')
MODEL_ID = os.environ.get('ELEVENLABS_MODEL_ID', 'eleven_v4')

_cache = {}
_client = None


def available():
    return bool(os.environ.get('ELEVENLABS_API_KEY'))


def _get_client():
    global _client
    if _client is None:
        from elevenlabs.client import ElevenLabs
        _client = ElevenLabs(api_key=os.environ['ELEVENLABS_API_KEY'])
    return _client


def speak(text):
    """Text -> mp3 bytes, or None if unavailable/failed."""
    if not available():
        return None
    if text in _cache:
        return _cache[text]

    try:
        audio = b''.join(_get_client().text_to_speech.convert(
            voice_id=VOICE_ID, text=text, model_id=MODEL_ID,
            language_code='en'))
    except Exception:                                  # noqa: BLE001
        return None

    _cache[text] = audio
    return audio
