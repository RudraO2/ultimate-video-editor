"""Word times of a video's speech, for compare.mjs (--a-words, --b-words).

    py -3 -P docs/benchmarks/transcribe.py <video> <out.json> [model] [language]

model defaults to small.en; for Hindi or Tamil give a multilingual one and the language (base hi).

Needs ffmpeg and faster-whisper (`py -3 -m pip install --user faster-whisper==1.1.1`; the model,
small.en, downloads once). Writes segments as [{start, end, text, words: [[word, start, end]]}].
"""
import json
import subprocess
import sys

import numpy as np
from faster_whisper import WhisperModel

video, out = sys.argv[1], sys.argv[2]
model = sys.argv[3] if len(sys.argv) > 3 else 'small.en'
language = sys.argv[4] if len(sys.argv) > 4 else None
pcm = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', video, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], capture_output=True, check=True).stdout
audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768
segments, _ = WhisperModel(model, device='cpu', compute_type='int8').transcribe(audio, word_timestamps=True, language=language)
result = [
    {'start': round(s.start, 2), 'end': round(s.end, 2), 'text': s.text.strip(),
     'words': [[w.word.strip(), round(w.start, 2), round(w.end, 2)] for w in s.words]}
    for s in segments
]
json.dump(result, open(out, 'w', encoding='utf-8'), indent=0)
print(f'{len(result)} segments, {sum(len(s["words"]) for s in result)} words')
