const ALARM_NAME = 'check-calendar';
const EVENT_ALARM_PREFIX = 'evt:'; // one alarm per upcoming event: `evt:<id>|<start>`
const POLL_INTERVAL_MINUTES = 1;
const ALERT_BEFORE_MS = 60 * 1000; // 1 minute
const DAILY_EXTRA_LEAD_MS = 10 * 60 * 1000; // dailies ring 10 minutes earlier, to leave time to prepare
const LATE_WINDOW_MS = 5 * 60 * 1000; // still alert up to 5 minutes after start (sleep/wake, slow worker)
const LOOKAHEAD_MS = 6 * 60 * 60 * 1000; // alarms are set this far ahead, so a network outage this long still rings
const MAX_RESULTS = 50;
const DAILY_TITLE = /\bdaily\b/i;
const SOUND_DAYS = [1, 2, 3, 4, 5];
const SOUND_START_HOUR = 8;
const SOUND_END_HOUR = 19;
const FAILURES_BEFORE_BADGE = 2;
const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000; // 1 day

// Must register listeners at top level (MV3 requirement)
chrome.alarms.onAlarm.addListener(handleAlarm);

// Start polling on install/startup
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
  checkUpcomingEvents();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
  checkUpcomingEvents();
});

// The popup asks for a check right after sign-in, so the status and badge update at once
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'check-now') return false;
  checkUpcomingEvents().finally(() => sendResponse({ done: true }));
  return true;
});

// Self-heal: if the poll alarm got lost (extension reload, Chrome restore), recreate it whenever the worker wakes
chrome.alarms.get(ALARM_NAME).then((alarm) => {
  if (!alarm) chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
});

function handleAlarm(alarm) {
  if (alarm.name === ALARM_NAME) return checkUpcomingEvents();
  if (alarm.name.startsWith(EVENT_ALARM_PREFIX)) {
    return alertFromAlarm(alarm.name.slice(EVENT_ALARM_PREFIX.length));
  }
  return Promise.resolve();
}

// Runs one task at a time, so a poll and an event alarm can't both open a tab for the same event
let queue = Promise.resolve();
function serialized(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

function isWithinSoundHours(date) {
  const hour = date.getHours();
  return SOUND_DAYS.includes(date.getDay()) && hour >= SOUND_START_HOUR && hour < SOUND_END_HOUR;
}

async function getAuthToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(`Not signed in: ${chrome.runtime.lastError.message}`));
      } else if (!token) {
        reject(new Error('Not signed in'));
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
    maxResults: String(MAX_RESULTS),
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

// Calendar event -> what an alert needs, or null when the event should never ring
function toAlertEvent(event) {
  const start = event.start?.dateTime;
  if (!start) return null; // all-day event
  if (event.eventType && event.eventType !== 'default') return null; // focusTime, outOfOffice, workingLocation...
  const self = (event.attendees || []).find((a) => a.self);
  if (self?.responseStatus === 'declined') return null;

  const startMs = new Date(start).getTime();
  const isDaily = DAILY_TITLE.test(event.summary || '');
  const leadMs = isDaily ? ALERT_BEFORE_MS + DAILY_EXTRA_LEAD_MS : ALERT_BEFORE_MS;
  return {
    // Keyed on the start too, so a moved event alerts again at its new time
    key: `${event.id}|${start}`,
    summary: event.summary || 'Untitled Meeting',
    start,
    startMs,
    fireAt: startMs - leadMs,
    isDaily,
    meetLink: event.hangoutLink || '',
  };
}

function checkUpcomingEvents() {
  return serialized(runCheck);
}

function alertFromAlarm(key) {
  return serialized(async () => {
    const { upcomingEvents = {} } = await chrome.storage.local.get('upcomingEvents');
    const event = upcomingEvents[key];
    if (event) await alertIfDue(event);
  });
}

async function runCheck() {
  let events;
  try {
    const token = await getAuthToken(false);
    const data = await fetchUpcomingEvents(token);
    events = (data.items || []).map(toAlertEvent).filter(Boolean);
  } catch (err) {
    console.error('Calendar check failed:', err);
    await recordFailure(err);
    // Event alarms from the last good poll still fire; this catches any that are already due
    await alertDueEvents();
    return;
  }

  await recordSuccess();
  await storeAndSchedule(events);
  await alertDueEvents();
}

async function storeAndSchedule(events) {
  const now = Date.now();
  const { notifiedEvents = {} } = await chrome.storage.local.get('notifiedEvents');

  const wanted = new Map();
  for (const event of events) {
    if (event.fireAt > now && !notifiedEvents[event.key]) {
      wanted.set(EVENT_ALARM_PREFIX + event.key, event.fireAt);
    }
  }

  // Drop alarms for events that moved, were deleted or declined; keep the ones already right
  for (const alarm of await chrome.alarms.getAll()) {
    if (!alarm.name.startsWith(EVENT_ALARM_PREFIX)) continue;
    if (wanted.get(alarm.name) === alarm.scheduledTime) wanted.delete(alarm.name);
    else await chrome.alarms.clear(alarm.name);
  }
  for (const [name, when] of wanted) {
    await chrome.alarms.create(name, { when });
  }

  await chrome.storage.local.set({
    upcomingEvents: Object.fromEntries(events.map((e) => [e.key, e])),
  });

  // Store next event for popup
  const upcoming = events.find((e) => e.startMs > now - LATE_WINDOW_MS);
  if (upcoming) {
    await chrome.storage.local.set({
      nextEvent: { summary: upcoming.summary, startTime: upcoming.start },
    });
  } else {
    await chrome.storage.local.remove('nextEvent');
  }
}

async function alertDueEvents() {
  const { upcomingEvents = {} } = await chrome.storage.local.get('upcomingEvents');
  for (const event of Object.values(upcomingEvents)) {
    await alertIfDue(event);
  }
}

async function alertIfDue(event) {
  const now = Date.now();
  if (now < event.fireAt || now - event.startMs > LATE_WINDOW_MS) return;

  const { notifiedEvents = {} } = await chrome.storage.local.get('notifiedEvents');
  if (notifiedEvents[event.key]) return;

  const params = new URLSearchParams({
    title: event.summary,
    time: event.start,
    meetLink: event.meetLink,
    daily: event.isDaily ? '1' : '',
    silent: isWithinSoundHours(new Date(event.startMs)) ? '' : '1',
  });

  try {
    await openAlertTab(`${chrome.runtime.getURL('sound.html')}?${params}`);
  } catch (err) {
    // Not marked notified, so the next poll tries again while the event is still in the window
    console.error('Could not open the alert tab:', err);
    return;
  }

  for (const [key, timestamp] of Object.entries(notifiedEvents)) {
    if (now - timestamp > CLEANUP_AGE_MS) delete notifiedEvents[key];
  }
  notifiedEvents[event.key] = now;
  await chrome.storage.local.set({ notifiedEvents });
}

async function openAlertTab(url) {
  try {
    return await chrome.tabs.create({ url });
  } catch (err) {
    // No normal window to put a tab in (all closed, only a popup/devtools window) — open one
    console.warn('tabs.create failed, opening a window instead:', err);
    return await chrome.windows.create({ url, focused: true });
  }
}

async function recordSuccess() {
  await chrome.storage.local.set({
    pollStatus: { lastOkAt: Date.now(), lastError: null, consecutiveFailures: 0 },
  });
  await chrome.action.setBadgeText({ text: '' });
}

async function recordFailure(err) {
  const { pollStatus = {} } = await chrome.storage.local.get('pollStatus');
  const consecutiveFailures = (pollStatus.consecutiveFailures || 0) + 1;
  await chrome.storage.local.set({
    pollStatus: {
      ...pollStatus,
      lastError: String(err?.message || err),
      lastErrorAt: Date.now(),
      consecutiveFailures,
    },
  });
  if (consecutiveFailures >= FAILURES_BEFORE_BADGE && isWithinSoundHours(new Date())) {
    await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    await chrome.action.setBadgeText({ text: '!' });
  }
}
