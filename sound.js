const params = new URLSearchParams(window.location.search);
const title = params.get('title') || 'Meeting';
const time = params.get('time');

document.getElementById('title').textContent = title;
if (time) {
  const d = new Date(time);
  document.getElementById('time').textContent = `Starts at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

// Synthesized bell chime via Web Audio API
const ctx = new AudioContext();
let loopInterval;

function playChime() {
  const now = ctx.currentTime;

  // Urgent alarm: rapid alternating tones, loud and buzzy
  const pattern = [880, 1100, 880, 1100, 880, 1100];
  pattern.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'square'; // harsher, more attention-grabbing
    osc.frequency.value = freq;

    const onset = i * 0.12;
    gain.gain.setValueAtTime(0.3, now + onset);
    gain.gain.setValueAtTime(0, now + onset + 0.1); // staccato cut

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now + onset);
    osc.stop(now + onset + 0.11);
  });
}

// Play immediately, then loop every 1.5 seconds (more urgent)
playChime();
loopInterval = setInterval(playChime, 1500);

const meetLink = params.get('meetLink');
const joinBtn = document.getElementById('join');
if (meetLink) {
  joinBtn.style.display = '';
  joinBtn.addEventListener('click', () => {
    window.open(meetLink, '_blank');
    clearInterval(loopInterval);
    ctx.close();
    window.close();
  });
}

document.getElementById('dismiss').addEventListener('click', () => {
  clearInterval(loopInterval);
  ctx.close();
  window.close();
});
