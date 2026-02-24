const ALARM_NAME = 'check-calendar';
const POLL_INTERVAL_MINUTES = 1;
const ALERT_BEFORE_MS = 60 * 1000; // 1 minute
const LOOKAHEAD_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000; // 1 day

// Must register alarm listener at top level (MV3 requirement)
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkUpcomingEvents();
  }
});

// Start polling on install/startup
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
  checkUpcomingEvents();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
  checkUpcomingEvents();
});

async function getAuthToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(token);
      }
    });
  });
}

async function fetchUpcomingEvents(token) {
  const now = new Date();
  const soon = new Date(now.getTime() + LOOKAHEAD_MS);

  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: soon.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '10',
  });

  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    // Token expired — remove cached token and retry once
    await new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
    const newToken = await getAuthToken(false);
    const retry = await fetch(url, {
      headers: { Authorization: `Bearer ${newToken}` },
    });
    if (!retry.ok) throw new Error(`Calendar API error: ${retry.status}`);
    return retry.json();
  }

  if (!res.ok) throw new Error(`Calendar API error: ${res.status}`);
  return res.json();
}

async function checkUpcomingEvents() {
  let token;
  try {
    token = await getAuthToken(false);
  } catch {
    // Not signed in yet — nothing to do
    return;
  }

  let data;
  try {
    data = await fetchUpcomingEvents(token);
  } catch (err) {
    console.error('Failed to fetch events:', err);
    return;
  }

  const events = data.items || [];
  const now = Date.now();

  // Load notified set
  const stored = await chrome.storage.local.get('notifiedEvents');
  const notified = stored.notifiedEvents || {};

  // Cleanup old entries
  for (const [id, timestamp] of Object.entries(notified)) {
    if (now - timestamp > CLEANUP_AGE_MS) {
      delete notified[id];
    }
  }

  for (const event of events) {
    // Skip all-day events (no dateTime)
    const startStr = event.start?.dateTime;
    if (!startStr) continue;

    const startMs = new Date(startStr).getTime();
    const timeUntil = startMs - now;

    // Alert if event starts within 1 minute and hasn't been notified
    if (timeUntil <= ALERT_BEFORE_MS && timeUntil > -ALERT_BEFORE_MS && !notified[event.id]) {
      notified[event.id] = now;
      const meetLink = event.hangoutLink || '';
      const params = new URLSearchParams({
        title: event.summary || 'Untitled Meeting',
        time: startStr,
        meetLink,
      });
      chrome.tabs.create({ url: `sound.html?${params}` });
    }
  }

  await chrome.storage.local.set({ notifiedEvents: notified });

  // Store next event for popup
  const upcoming = events.find((e) => e.start?.dateTime);
  if (upcoming) {
    await chrome.storage.local.set({
      nextEvent: {
        summary: upcoming.summary || 'Untitled Meeting',
        startTime: upcoming.start.dateTime,
      },
    });
  } else {
    await chrome.storage.local.remove('nextEvent');
  }
}
