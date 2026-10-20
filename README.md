
https://github.com/user-attachments/assets/ee0081c0-7e70-4483-96bc-32688224b23f


# Meeting Sound Alert — Chrome Extension

Plays an alarm sound 1 minute before your Google Calendar meetings, and 11 minutes before any meeting with "daily" in the title. Opens a new tab with a sonar sound so it bypasses browser autoplay restrictions.

## Install

1. Download or clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select this folder
5. Click the extension icon → **Sign in with Google**

That's it. The extension checks your calendar every minute and opens an alert tab with sound when a meeting is about to start.

**After pulling changes:** open `chrome://extensions` and click the reload icon on the extension card.

## How it works

- Polls Google Calendar every 60 seconds for the next 6 hours of events, and sets one Chrome alarm per event at its alert time. The alarm rings from stored data, so a network or sign-in hiccup right before a meeting doesn't swallow the alert
- 1 minute before a meeting → opens a new tab that plays an alarm on loop
- 11 minutes before a meeting whose title contains the word "daily" → same alert, plus a checklist to prepare the status report (closed / taking today / blockers). It rings once, at the early time, not again at the 1-minute mark
- If Chrome was asleep or closed at the alert time, the alert still opens up to 5 minutes after the meeting started, showing "started N min ago"
- Sound only plays for meetings starting Monday–Friday, 08:00–19:00 (local time). Outside that window the alert tab still opens, silent
- If no tab can be opened (no normal Chrome window), it opens a new window instead
- Click **Dismiss** to close the alert
- Skipped: all-day events, meetings you declined, and Focus time / Out of office / Working location blocks
- No duplicate alerts — each event triggers once; if it's moved to a new time, it alerts again at the new time

## When checks fail

If two checks in a row fail during working hours (signed out, token revoked, offline), the toolbar icon shows a red **!**. The popup says when the last successful check was and the error. It clears on the next successful check.

## Tests

```bash
node --test
```

Runs `test-background.mjs`: loads `background.js` with a stubbed `chrome`, `fetch` and clock. No dependencies, no Google calls.

## Permissions

- **Google Calendar** (read-only) — to check your upcoming events
- **Alarms** — to poll on a schedule and to ring at each meeting's alert time
- **Storage** — to track which events have been notified
