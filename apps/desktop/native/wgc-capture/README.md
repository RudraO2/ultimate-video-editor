# Windows capture helpers (from OpenScreen)

The two programs the screen recorder runs on Windows, vendored from
[OpenScreen](https://github.com/getopenscreen/openscreen) (MIT, see `LICENSE`,
copyright Siddharth Vaddem and the OpenScreen contributors), folder
`electron/native/wgc-capture` at commit `f7894518960b03f50cba414c78030db07112724e`
(2026-10-31). The sources are unchanged; the test programs are left out, and
`src/sdk_compat.h` plus two lines in `CMakeLists.txt` are ours (they let the code
build with Visual Studio 2019 and Windows SDK 10.0.19041).

- `wgc-capture.exe`: records a display or a window through Windows Graphics
  Capture, with system sound (WASAPI loopback), the microphone and an optional
  webcam picture-in-picture, into an H.264/AAC MP4 (Media Foundation; the
  hardware encoder when there is one, else Microsoft's software encoder). It
  takes one JSON argument and reads `stop` on stdin; it prints JSON events, one
  per line (`ready`, `recording-started`, `recording-stopped` with
  `screenPath`). The editor asks it to draw the real cursor into the video
  (`captureCursor: true`), so every cursor shape and animation is exactly what
  was on screen.
- `cursor-sampler.exe <intervalMs> [windowHandle]`: prints a JSON line per
  sample: position in physical pixels, visibility, cursor type and image (once
  per cursor), left-button presses and releases, and the window's bounds when a
  window handle is given. The editor turns these into the cursor sidecar
  (`<video>.cursor.json`, OpenScreen's layout) for auto-zoom.

Prebuilt copies live in `../bin/win32-x64/` and are what the app runs. To build
them again (Visual Studio 2019 or newer Build Tools with the C++ workload and a
Windows 10 SDK):

```
node apps/desktop/scripts/build-wgc.mjs
```
