#!/bin/bash
set -e
INK=0x0A0B10
BONE=0xF2EEE3
ORANGE=0xFF4D00
SLATE=0x98A1B8

# Title card: wordmark + pitch
ffmpeg -y -f lavfi -i "color=c=$INK:s=1280x720:d=1" -vf "\
drawtext=fontfile=plexmono.ttf:text='A N T Í P O D A . F M':fontcolor=$ORANGE:fontsize=30:x=(w-text_w)/2:y=232,\
drawtext=fontfile=fraunces-it.ttf:text='the broadcast from underneath you':fontcolor=$BONE:fontsize=52:x=(w-text_w)/2:y=310,\
drawtext=fontfile=plexmono.ttf:text='point the antenna straight down':fontcolor=$SLATE:fontsize=20:x=(w-text_w)/2:y=428" \
-frames:v 1 title.png

# End card: URL
ffmpeg -y -f lavfi -i "color=c=$INK:s=1280x720:d=1" -vf "\
drawtext=fontfile=fraunces.ttf:text='antipoda-fm.vercel.app':fontcolor=$BONE:fontsize=56:x=(w-text_w)/2:y=300,\
drawtext=fontfile=plexmono.ttf:text='tune the other side':fontcolor=$ORANGE:fontsize=22:x=(w-text_w)/2:y=400" \
-frames:v 1 end.png
echo done
