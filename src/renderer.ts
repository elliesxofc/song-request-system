/// <reference types="youtube" />

import "./index.css";

type Video = { id: string; title: string };

declare global {
  interface Window {
    electronAPI: {
      getVideo: () => Promise<Video>;
      onQueueUpdate: (callback: (queue: Video[]) => void) => void;
      onSongSkipped: (callback: (video: Video) => void) => void;
      showContextMenu: (videoId: string) => void;
      getNowPlayingPath: () => Promise<string>;
      chooseNowPlayingPath: () => Promise<string>;
      showNowPlayingFile: () => void;
      getChatStatus: () => Promise<string>;
      onChatStatus: (callback: (text: string) => void) => void;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

const PAUSE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-pause"><circle cx="12" cy="12" r="10"/><line x1="10" x2="10" y1="15" y2="9"/><line x1="14" x2="14" y1="15" y2="9"/></svg>`;
const PLAY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-play"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>`;

const VOLUME_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-volume-2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
const VOLUME_LOW_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-volume-1"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
const MUTED_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-volume-x"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/></svg>`;

// YouTube error codes that mean "this video can't be played here": skip to the next song
// instead of stalling. 2 = bad video id, 5 = HTML5 player error, 100 = removed or private,
// 101/150 = the owner doesn't allow embedding, 153 = the page didn't identify itself.
const UNPLAYABLE = new Set([2, 5, 100, 101, 150, 153]);

// The IFrame API script loads asynchronously and calls window.onYouTubeIframeAPIReady when
// YT.Player can be used. Creating the player before that fails with "YT is not defined".
function loadYouTubeApi(): Promise<typeof YT> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  return new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () =>
      reject(new Error("Couldn't load the YouTube player. Check your internet connection."));
    document.head.appendChild(script);
  });
}

// only set once YouTube says the player is ready: before that it has no volume, play or
// pause controls yet, and calling them throws
let player: YT.Player | null = null;
let skipping = false;
// if songs keep failing back to back, something bigger is wrong (no internet, YouTube
// rejecting the app): stop rather than burn through the playlist and the API quota
let failuresInARow = 0;
const MAX_FAILURES_IN_A_ROW = 3;

function showStatus(text: string) {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const status = document.getElementById("status")!;
  status.textContent = text;
  status.hidden = !text;
}

// Volume and mute are kept here instead of being read back from the player: YouTube only
// reports a change back a moment later, so reading it right after a change gets the old value.
let volume = 100;
let muted = false;
let volumeBeforeMute = 100;

function applyVolume() {
  const slider = document.getElementById("volume") as HTMLInputElement;
  slider.valueAsNumber = muted ? 0 : volume;
  const button = document.getElementById("volume-button");
  if (button) {
    button.innerHTML = muted || volume === 0 ? MUTED_ICON : volume < 50 ? VOLUME_LOW_ICON : VOLUME_ICON;
    button.title = muted ? "Unmute" : "Mute";
  }
  if (!player) return; // applied again once the player is ready
  player.setVolume(volume);
  if (muted || volume === 0) player.mute();
  else player.unMute();
}

async function playNext() {
  if (!player || skipping) return;
  skipping = true;
  try {
    const newVideo = await window.electronAPI.getVideo();
    updateSongTitle(newVideo);
    player.loadVideoById(newVideo.id);
  } finally {
    skipping = false;
  }
}

(async () => {
  try {
    const [, video] = await Promise.all([loadYouTubeApi(), window.electronAPI.getVideo()]);
    updateSongTitle(video);
    new YT.Player("player", {
      width: "800",
      height: "300",
      videoId: video.id,
      playerVars: {
        controls: 0,
        autohide: 1,
        modestbranding: 1,
        rel: 0,
        // lets the player talk back to this page (play state, errors) reliably
        origin: window.location.origin,
      },
      events: {
        onReady: (event) => {
          player = event.target;
          showStatus("");
          applyVolume();
          player.playVideo();
        },
        onStateChange: async (event) => {
          const playPauseButton = document.getElementById("playpause");
          if (event.data === YT.PlayerState.ENDED) {
            await playNext();
          } else if (event.data === YT.PlayerState.PAUSED) {
            if (playPauseButton) playPauseButton.innerHTML = PLAY_ICON;
          } else if (event.data === YT.PlayerState.PLAYING) {
            if (playPauseButton) playPauseButton.innerHTML = PAUSE_ICON;
            // a new video can start at YouTube's own volume, so keep it in line with the slider
            applyVolume();
            failuresInARow = 0;
            showStatus("");
          }
        },
        onError: async (event) => {
          const title = document.getElementById("currentsong")?.textContent || "this song";
          if (UNPLAYABLE.has(event.data)) {
            failuresInARow++;
            if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
              showStatus(`${failuresInARow} songs in a row couldn't play (YouTube error ${event.data}). Press skip to try again.`);
              failuresInARow = 0;
              return;
            }
            showStatus(`Couldn't play "${title}" (YouTube error ${event.data}), skipping…`);
            await playNext();
          } else {
            showStatus(`YouTube player error ${event.data}`);
          }
        },
      },
    });
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err))
      // Electron wraps errors from the app: "Error invoking remote method 'yt:get-video': …"
      .replace(/^Error invoking remote method '[^']+': /, "");
    showStatus(
      message.includes("fetch failed")
        ? "Couldn't reach YouTube to get a song. Check your internet connection, then restart the app."
        : message
    );
  }
})();

window.electronAPI.onQueueUpdate((queue) => {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const queueElem = document.getElementById("queue")!;
  queueElem.innerHTML = "";
  if (!queue.length) {
    queueElem.innerText = "No songs in queue.";
  } else {
    for (let i = 0; i < queue.length; i++) {
      const song = queue[i];
      const songElem = document.createElement("div");
      songElem.className = "song";
      songElem.innerText = `${i + 1}. ${song.title}`;
      songElem.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.electronAPI.showContextMenu(song.id);
      });
      queueElem.appendChild(songElem);
    }
  }
});

// whether chat requests are on, and whether the bot can reply
function showChatStatus(text: string) {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const chatStatus = document.getElementById("chat-status")!;
  chatStatus.textContent = text;
  chatStatus.hidden = !text;
}
window.electronAPI.getChatStatus().then(showChatStatus);
window.electronAPI.onChatStatus(showChatStatus);

window.electronAPI.onSongSkipped((video) => {
  updateSongTitle(video);
  player?.loadVideoById(video.id);
});

document.addEventListener("DOMContentLoaded", () => {
  // where the song name for OBS is saved
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const nowPlayingPath = document.getElementById("now-playing-path")!;
  const showNowPlayingPath = (file: string) => {
    nowPlayingPath.textContent = file;
    nowPlayingPath.title = file;
  };
  window.electronAPI.getNowPlayingPath().then(showNowPlayingPath);
  document.getElementById("now-playing-change")?.addEventListener("click", async () => {
    showNowPlayingPath(await window.electronAPI.chooseNowPlayingPath());
  });
  document
    .getElementById("now-playing-show")
    ?.addEventListener("click", () => window.electronAPI.showNowPlayingFile());

  document.getElementById("skip")?.addEventListener("click", () => playNext());

  const playPauseButton = document.getElementById("playpause");
  playPauseButton?.addEventListener("click", () => {
    if (!player) return;
    if (player.getPlayerState() === YT.PlayerState.PLAYING) {
      player.pauseVideo();
      playPauseButton.innerHTML = PLAY_ICON;
    } else {
      player.playVideo();
      playPauseButton.innerHTML = PAUSE_ICON;
    }
  });

  const volumeSlider = document.getElementById("volume") as HTMLInputElement;
  volumeSlider.addEventListener("input", () => {
    volume = volumeSlider.valueAsNumber;
    // dragging the slider is how you'd expect to unmute, and dragging it to 0 mutes
    muted = volume === 0;
    if (volume > 0) volumeBeforeMute = volume;
    applyVolume();
  });

  document.getElementById("volume-button")?.addEventListener("click", () => {
    if (muted || volume === 0) {
      muted = false;
      if (volume === 0) volume = volumeBeforeMute || 50;
    } else {
      volumeBeforeMute = volume;
      muted = true;
    }
    applyVolume();
  });
});

function updateSongTitle(video: Video) {
  const currentSong = document.getElementById(
    "currentsong",
  ) as HTMLAnchorElement;
  currentSong.href = `https://youtube.com/watch?v=${video.id}`;
  currentSong.textContent = video.title;
}
