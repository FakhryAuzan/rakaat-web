# Rakaat Counter (web)

Web version of Rakaat Counter for iPhone (works on Android browsers too).
Counts rakaat during shalat by detecting sujood with the front camera; every 2 sujood = 1 rakaat.

**Open:** https://fakhryauzan.github.io/rakaat-web/ in Safari, then Share → **Add to Home Screen**.

- Put the phone screen-up on the mat, under where your chest will be in sujood (not under your forehead).
- First time: a short tutorial pops up (replay it from Settings → Help). Then Settings → Calibrate (about 30 s, guided by beeps; turn the volume up). Ruku is optional (Settings → Track ruku).
- Keep "Light up my face" on for dark rooms: the white screen lights your face for the camera.
- Everything runs on the phone; no video leaves the device.

Face detection: [@vladmandic/face-api](https://github.com/vladmandic/face-api) (Tiny Face Detector, MIT).
