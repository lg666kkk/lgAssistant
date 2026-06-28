# Desktop App

This project runs as a desktop app by letting Electron start the existing Next.js app locally.

## Commands

- `npm run desktop:dev` starts the Electron desktop app in development mode.
- `npm run desktop:build` builds a macOS desktop package in `dist/`.

## Environment

The packaged app reads `.env.local` from:

1. the directory where the app executable lives,
2. the Electron user data directory,
3. the current working directory during development.

Keep real API keys out of the installer. Put `.env.local` beside the app locally when you run it.
