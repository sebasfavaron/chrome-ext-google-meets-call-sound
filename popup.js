const signedOutEl = document.getElementById('signed-out');
const signedInEl = document.getElementById('signed-in');
const nextEventEl = document.getElementById('next-event');
const noEventsEl = document.getElementById('no-events');

async function checkAuth() {
  try {
    const token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: false }, (token) => {
        if (chrome.runtime.lastError || !token) reject();
        else resolve(token);
      });
    });
    showSignedIn();
  } catch {
    showSignedOut();
  }
}

function showSignedOut() {
  signedOutEl.style.display = 'block';
  signedInEl.style.display = 'none';
}

async function showSignedIn() {
  signedOutEl.style.display = 'none';
  signedInEl.style.display = 'block';

  const stored = await chrome.storage.local.get('nextEvent');
  if (stored.nextEvent) {
    const d = new Date(stored.nextEvent.startTime);
    nextEventEl.textContent = '';

    const eventDiv = document.createElement('div');
    eventDiv.className = 'event';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'event-title';
    titleDiv.textContent = stored.nextEvent.summary;

    const timeDiv = document.createElement('div');
    timeDiv.className = 'event-time';
    timeDiv.textContent = `${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`;

    eventDiv.appendChild(titleDiv);
    eventDiv.appendChild(timeDiv);
    nextEventEl.appendChild(eventDiv);
    noEventsEl.style.display = 'none';
  } else {
    nextEventEl.textContent = '';
    noEventsEl.style.display = 'block';
  }
}

document.getElementById('signin-btn').addEventListener('click', () => {
  chrome.identity.getAuthToken({ interactive: true }, (token) => {
    if (token) showSignedIn();
  });
});

document.getElementById('signout-btn').addEventListener('click', () => {
  chrome.identity.getAuthToken({ interactive: false }, (token) => {
    if (token) {
      fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
      chrome.identity.removeCachedAuthToken({ token }, () => {
        chrome.storage.local.clear();
        showSignedOut();
      });
    }
  });
});

checkAuth();
