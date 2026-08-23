#!/usr/bin/env bash
# taskstory: Bach Goldberg Aria in three states — clean (起) → warped, growing (承/转) → clean returns at 19s (合). No narration.
set -e; cd "$(dirname "$0")/.."
ffmpeg -y -loglevel error -i audio/bach-goldberg-aria.ogg -i "$1" -filter_complex "
[0:a]atrim=duration=34,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,asplit=2[c0][w0];
[c0]volume='if(lt(t,5.5),0.16, if(lt(t,8.5),0.16*(1-(t-5.5)/3), if(lt(t,19),0, if(lt(t,21.5),0.2*((t-19)/2.5), min(0.26,0.2+0.01*(t-21.5))))))':eval=frame,afade=t=out:st=31.5:d=2.5[clean];
[w0]vibrato=f=5.5:d=0.45,tremolo=f=7:d=0.6,lowpass=f=900,volume='if(lt(t,5.5),0, if(lt(t,8.5),0.2*((t-5.5)/3), if(lt(t,19),0.2+0.012*(t-8.5), if(lt(t,20.2),0.33*(1-(t-19)/1.2),0))))':eval=frame[warp];
[clean][warp]amix=inputs=2:normalize=0,alimiter=limit=0.95[a]" -map 1:v -map "[a]" -c:v copy -c:a aac -b:a 192k "$2"
