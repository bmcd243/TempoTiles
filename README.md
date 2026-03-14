# TempoTiles

TempoTiles is a mobile interval training builder that turns natural language into draggable workout blocks. It supports grouped sets, edit-in-place, voice input (when using cloud parsing), and a runner screen with a countdown, big timer, and audio cues.

## Features
- Natural language to intervals with AI parsing (cloud or local)
- Grouped sets with drill‑down editing
- Drag-and-drop interval reordering
- Preset workout templates
- Save and load sessions
- Runner screen with countdown and spoken cues

## Running locally
```bash
npm install
npx expo start
```

## iOS native build (prebuild)
```bash
npx expo prebuild -p ios
cd ios
pod install
```

## Notes
- On-device model integration is in progress.
- Voice input requires OpenAI API credentials.
