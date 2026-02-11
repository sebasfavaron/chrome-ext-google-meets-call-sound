
https://github.com/user-attachments/assets/8fc40124-bba0-4a8d-8938-0827bdae93d6


# Meeting Sound Alert — Chrome Extension

Plays an alarm sound 1 minute before your Google Calendar meetings. Opens a new tab with a synthesized chime so it bypasses browser autoplay restrictions.

## Install

1. Download or clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select this folder
5. Click the extension icon → **Sign in with Google**

That's it. The extension checks your calendar every minute and opens an alert tab with sound when a meeting is about to start.

## How it works

- Polls Google Calendar API every 60 seconds via a background service worker
- 1 minute before a meeting → opens a new tab that plays an urgent chime on loop
- Click **Dismiss** to close the alert
- All-day events are ignored
- No duplicate alerts — each event only triggers once

## Permissions

- **Google Calendar** (read-only) — to check your upcoming events
- **Alarms** — to poll on a schedule
- **Storage** — to track which events have been notified
