// Loads background.js in a vm with a stubbed `chrome`, `fetch` and clock. No deps, no network.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('./background.js', import.meta.url), 'utf8');
const MIN = 60 * 1000;
const TUESDAY_10AM = new Date(2026, 9, 20, 10, 0).getTime(); // local time, inside sound hours
const flush = () => new Promise((r) => setTimeout(r, 0));

function load({ now = TUESDAY_10AM } = {}) {
  const clock = { now };
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(clock.now);
    }
    static now() {
      return clock.now;
    }
  }

  const state = {
    alarms: new Map(),
    storage: {},
    tabs: [],
    windows: [],
    badge: '',
    items: [],
    fetchUrls: [],
    fetchError: null,
    fetchDelayMs: 0,
    authError: null,
    tabsFail: false,
    windowsFail: false,
  };
  const listeners = { alarm: [], installed: [], startup: [], message: [] };
  const pick = (keys) => {
    if (keys == null) return structuredClone(state.storage);
    const out = {};
    for (const k of [].concat(keys)) if (k in state.storage) out[k] = structuredClone(state.storage[k]);
    return out;
  };

  const chrome = {
    alarms: {
      onAlarm: { addListener: (f) => listeners.alarm.push(f) },
      create: async (name, info) => {
        state.alarms.set(name, {
          name,
          scheduledTime: info.when ?? clock.now + info.periodInMinutes * MIN,
          periodInMinutes: info.periodInMinutes,
        });
      },
      get: async (name) => state.alarms.get(name),
      getAll: async () => [...state.alarms.values()],
      clear: async (name) => state.alarms.delete(name),
    },
    storage: {
      local: {
        get: async (keys) => pick(keys),
        set: async (obj) => Object.assign(state.storage, structuredClone(obj)),
        remove: async (keys) => [].concat(keys).forEach((k) => delete state.storage[k]),
        clear: async () => (state.storage = {}),
      },
    },
    identity: {
      getAuthToken: (_opts, cb) => {
        if (state.authError) {
          chrome.runtime.lastError = { message: state.authError };
          cb(undefined);
          chrome.runtime.lastError = undefined;
        } else cb('token');
      },
      removeCachedAuthToken: (_opts, cb) => cb(),
    },
    runtime: {
      lastError: undefined,
      getURL: (p) => `chrome-extension://test/${p}`,
      onInstalled: { addListener: (f) => listeners.installed.push(f) },
      onStartup: { addListener: (f) => listeners.startup.push(f) },
      onMessage: { addListener: (f) => listeners.message.push(f) },
    },
    tabs: {
      create: async ({ url }) => {
        await flush();
        if (state.tabsFail) throw new Error('No current window');
        state.tabs.push(url);
        return { id: state.tabs.length };
      },
    },
    windows: {
      create: async ({ url }) => {
        if (state.windowsFail) throw new Error('window failed');
        state.windows.push(url);
        return { id: 100 + state.windows.length };
      },
    },
    action: {
      setBadgeText: async ({ text }) => (state.badge = text),
      setBadgeBackgroundColor: async () => {},
    },
  };

  const fetch = async (url) => {
    state.fetchUrls.push(url);
    if (state.fetchDelayMs) await new Promise((r) => setTimeout(r, state.fetchDelayMs));
    if (state.fetchError) throw new Error(state.fetchError);
    return { ok: true, status: 200, json: async () => ({ items: structuredClone(state.items) }) };
  };

  const ctx = vm.createContext({
    chrome,
    fetch,
    Date: FakeDate,
    URLSearchParams,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
  });
  vm.runInContext(SOURCE, ctx);

  return {
    ctx,
    state,
    clock,
    poll: () => ctx.checkUpcomingEvents(),
    fireAlarm: (name) => Promise.all(listeners.alarm.map((f) => f({ name }))),
    evtAlarms: () =>
      [...state.alarms.values()].filter((a) => a.name.startsWith('evt:')).map((a) => [a.name, a.scheduledTime]),
  };
}

function event(id, startMs, extra = {}) {
  return {
    id,
    summary: `Meeting ${id}`,
    start: { dateTime: new Date(startMs).toISOString() },
    hangoutLink: 'https://meet.google.com/abc',
    ...extra,
  };
}

test('worker load recreates a missing poll alarm', async () => {
  const t = load();
  await flush();
  assert.equal(t.state.alarms.get('check-calendar')?.periodInMinutes, 1);
});

test('a poll schedules one alarm per event, and the alarm rings without network', async () => {
  const t = load();
  const regular = event('a', TUESDAY_10AM + 30 * MIN);
  const daily = event('b', TUESDAY_10AM + 60 * MIN, { summary: 'Team Daily' });
  t.state.items = [regular, daily];
  await t.poll();

  assert.match(t.state.fetchUrls[0], /maxResults=50/);
  assert.deepEqual(t.evtAlarms(), [
    [`evt:a|${regular.start.dateTime}`, TUESDAY_10AM + 29 * MIN],
    [`evt:b|${daily.start.dateTime}`, TUESDAY_10AM + 49 * MIN],
  ]);
  assert.equal(t.state.tabs.length, 0);

  // Network goes down; the event alarm still rings from stored data
  t.state.fetchError = 'Failed to fetch';
  t.clock.now = TUESDAY_10AM + 29 * MIN;
  await t.fireAlarm(`evt:a|${regular.start.dateTime}`);
  assert.equal(t.state.tabs.length, 1);
  const url = new URL(t.state.tabs[0]);
  assert.equal(url.pathname, '/sound.html');
  assert.equal(url.searchParams.get('title'), 'Meeting a');
  assert.equal(url.searchParams.get('silent'), '');

  // Firing again (or a poll in the same minute) does not ring twice
  await t.fireAlarm(`evt:a|${regular.start.dateTime}`);
  await t.poll();
  assert.equal(t.state.tabs.length, 1);
});

test('a moved event clears its old alarm and alerts again at the new time', async () => {
  const t = load();
  const first = event('m', TUESDAY_10AM + 1 * MIN);
  t.state.items = [first];
  await t.poll(); // already within the 1-minute lead
  assert.equal(t.state.tabs.length, 1);

  const moved = event('m', TUESDAY_10AM + 30 * MIN);
  t.state.items = [moved];
  t.clock.now += 1 * MIN;
  await t.poll();
  assert.deepEqual(t.evtAlarms(), [[`evt:m|${moved.start.dateTime}`, TUESDAY_10AM + 29 * MIN]]);

  t.clock.now = TUESDAY_10AM + 29 * MIN;
  await t.fireAlarm(`evt:m|${moved.start.dateTime}`);
  assert.equal(t.state.tabs.length, 2);
});

test('a deleted event drops its alarm before it fires', async () => {
  const t = load();
  const original = event('r', TUESDAY_10AM + 20 * MIN);
  t.state.items = [original];
  await t.poll();
  t.state.items = []; // deleted
  await t.poll();
  assert.deepEqual(t.evtAlarms(), []);
  t.clock.now = TUESDAY_10AM + 19 * MIN;
  await t.fireAlarm(`evt:r|${original.start.dateTime}`);
  assert.equal(t.state.tabs.length, 0);
});

test('declined, focus time, out of office, working location and all-day events never ring', async () => {
  const t = load();
  const soon = TUESDAY_10AM + 30 * MIN;
  t.state.items = [
    event('declined', soon, { attendees: [{ email: 'me', self: true, responseStatus: 'declined' }] }),
    event('focus', soon, { eventType: 'focusTime' }),
    event('ooo', soon, { eventType: 'outOfOffice' }),
    event('wl', soon, { eventType: 'workingLocation' }),
    { id: 'allday', summary: 'Holiday', start: { date: '2026-10-20' } },
    event('ok', soon, {
      eventType: 'default',
      attendees: [
        { email: 'me', self: true, responseStatus: 'accepted' },
        { email: 'other', responseStatus: 'declined' },
      ],
    }),
  ];
  await t.poll();
  assert.deepEqual(t.evtAlarms().map(([n]) => n.split('|')[0]), ['evt:ok']);
});

test('late alerts ring up to 5 minutes after start, not after', async () => {
  const t = load();
  t.state.items = [event('late', TUESDAY_10AM - 3 * MIN), event('too-late', TUESDAY_10AM - 6 * MIN)];
  await t.poll();
  assert.equal(t.state.tabs.length, 1);
  assert.equal(new URL(t.state.tabs[0]).searchParams.get('title'), 'Meeting late');
});

test('two failed polls during working hours set a red badge; success clears it', async () => {
  const t = load();
  t.state.authError = 'OAuth2 not granted or revoked.';
  await t.poll();
  assert.equal(t.state.badge, '');
  await t.poll();
  assert.equal(t.state.badge, '!');
  assert.equal(t.state.storage.pollStatus.consecutiveFailures, 2);
  assert.match(t.state.storage.pollStatus.lastError, /OAuth2 not granted/);

  t.state.authError = null;
  await t.poll();
  assert.equal(t.state.badge, '');
  assert.equal(t.state.storage.pollStatus.lastError, null);
  assert.equal(t.state.storage.pollStatus.lastOkAt, TUESDAY_10AM);
});

test('failures outside working hours do not set the badge', async () => {
  const t = load({ now: new Date(2026, 9, 20, 22, 0).getTime() });
  t.state.fetchError = 'Failed to fetch';
  await t.poll();
  await t.poll();
  assert.equal(t.state.badge, '');
  assert.equal(t.state.storage.pollStatus.consecutiveFailures, 2);
});

test('concurrent checks do not open duplicate tabs', async () => {
  const t = load();
  t.state.items = [event('dup', TUESDAY_10AM + 30 * 1000)];
  t.state.fetchDelayMs = 5;
  const key = `evt:dup|${t.state.items[0].start.dateTime}`;
  await Promise.all([t.poll(), t.poll(), t.fireAlarm('check-calendar'), t.fireAlarm(key)]);
  assert.equal(t.state.tabs.length, 1);
});

test('falls back to a new window when no tab can be created', async () => {
  const t = load();
  t.state.items = [event('w', TUESDAY_10AM + 30 * 1000)];
  t.state.tabsFail = true;
  await t.poll();
  assert.equal(t.state.windows.length, 1);
  assert.equal(Object.keys(t.state.storage.notifiedEvents).length, 1);
});

test('when neither tab nor window opens, the event stays un-notified and retries', async () => {
  const t = load();
  t.state.items = [event('x', TUESDAY_10AM + 30 * 1000)];
  t.state.tabsFail = true;
  t.state.windowsFail = true;
  await t.poll();
  assert.deepEqual(t.state.storage.notifiedEvents ?? {}, {});

  t.state.tabsFail = false;
  t.clock.now += MIN;
  await t.poll();
  assert.equal(t.state.tabs.length, 1);
});
