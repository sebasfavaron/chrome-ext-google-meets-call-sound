const params = new URLSearchParams(window.location.search);
const title = params.get('title') || 'Meeting';
const time = params.get('time');

document.getElementById('title').textContent = title;
if (time) {
  const d = new Date(time);
  document.getElementById('time').textContent = 'Starts at ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

let alertAudio = null;

function stopAudio() {
  if (alertAudio) {
    alertAudio.pause();
    alertAudio.currentTime = 0;
    alertAudio = null;
  }
}

function playAlert() {
  stopAudio();
  alertAudio = new Audio(chrome.runtime.getURL('assets/sonar-alert.mp3'));
  alertAudio.loop = true;
  alertAudio.volume = 1.0;
  alertAudio.play().catch((err) => {
    console.error('Failed to play alert audio:', err);
  });
}

playAlert();

const meetLink = params.get('meetLink');
const joinBtn = document.getElementById('join');
if (meetLink) {
  joinBtn.style.display = '';
  joinBtn.addEventListener('click', () => {
    window.open(meetLink, '_blank');
    stopAudio();
    window.close();
  });
}

document.getElementById('dismiss').addEventListener('click', () => {
  stopAudio();
  window.close();
});
