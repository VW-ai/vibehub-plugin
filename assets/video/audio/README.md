# Audio

Stems are DVC-tracked in R2; `./fetch.sh` pulls them. Both clips are **music only** — narration was tried (local Kokoro TTS, female voices) and rejected: flat delivery, and reading the on-screen text aloud felt wrong. The story is carried by picture, captions and music changes.

| file | work | performer | license | used in |
|------|------|-----------|---------|---------|
| `bach-goldberg-aria.ogg` | J.S. Bach, Goldberg Variations BWV 988 — Aria | Kimiko Ishizaka (Open Goldberg Variations) | CC0 1.0 | taskstory |
| `schubert-impromptu-gflat.ogg` | F. Schubert, Impromptu Op. 90 No. 3 in G♭, D.899 | Chiara Bertoglio | CC BY 3.0 — credit performer when publishing | glance |

Source: Wikimedia Commons. Rachmaninoff Prelude Op. 32 No. 10 (CC BY) was auditioned and set aside — too heavy for 30-second clips.

Mixing is plain ffmpeg, after the silent HyperFrames render:

```bash
audio/mix-taskstory.sh renders/taskstory-silent.mp4 renders/taskstory-v7.mp4
audio/mix-glance.sh    renders/glance-silent.mp4    renders/glance-v4.mp4
```

taskstory's arc is in the music: clean Aria (起) → the same recording low-passed, vibrato'd and tremolo'd, getting louder while the camera shakes (承/转) → clean Aria fades back in at 19 s as the light closes in (合). Nothing is cut; the warped and clean stems cross over 1.2 s.
