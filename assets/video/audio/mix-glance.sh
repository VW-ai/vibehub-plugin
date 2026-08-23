#!/usr/bin/env bash
# glance: Schubert Impromptu Op.90/3 throughout, two gentle lifts (Start this with VibeHub · 3/3 accepted). No narration.
set -e; cd "$(dirname "$0")/.."
ffmpeg -y -loglevel error -i audio/schubert-impromptu-gflat.ogg -i "$1" -filter_complex "
[0:a]atrim=start=2:duration=25,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,afade=t=in:d=2,
volume='if(lt(t,10),0.14, if(lt(t,12.5),0.14+0.06*((t-10)/2.5), if(lt(t,16),0.2, if(lt(t,18),0.2+0.06*((t-16)/2),0.26))))':eval=frame,afade=t=out:st=22.5:d=2.5,alimiter=limit=0.95[a]" -map 1:v -map "[a]" -c:v copy -c:a aac -b:a 192k "$2"
