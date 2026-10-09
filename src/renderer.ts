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
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

const PAUSE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-pause"><circle cx="12" cy="12" r="10"/><line x1="10" x2="10" y1="15" y2="9"/><line x1="14" x2="14" y1="15" y2="9"/></svg>`;
const PLAY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-play"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>`;

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
    player = new YT.Player("player", {
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
        onReady: () => {
          showStatus("");
          player?.playVideo();
        },
        onStateChange: async (event) => {
          const playPauseButton = document.getElementById("playpause");
          if (event.data === YT.PlayerState.ENDED) {
            await playNext();
          } else if (event.data === YT.PlayerState.PAUSED) {
            if (playPauseButton) playPauseButton.innerHTML = PLAY_ICON;
          } else if (event.data === YT.PlayerState.PLAYING) {
            if (playPauseButton) playPauseButton.innerHTML = PAUSE_ICON;
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
    showStatus(err instanceof Error ? err.message : String(err));
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
  volumeSlider.addEventListener("input", (e) => {
    if (!player) return;
    const newVolume = (e.target as HTMLInputElement).valueAsNumber;
    if (player.isMuted() && newVolume > 0) player.unMute();
    if (!player.isMuted() && newVolume === 0) player.mute();
    player.setVolume(newVolume);
  });

  const volumeButton = document.getElementById("volume-button");
  volumeButton?.addEventListener("click", () => {
    if (!player) return;
    volumeSlider.valueAsNumber = !player.isMuted() ? 0 : player.getVolume();
    if (player.isMuted()) {
      player.unMute();
    } else {
      player.mute();
    }
  });
});

function updateSongTitle(video: Video) {
  const currentSong = document.getElementById(
    "currentsong",
  ) as HTMLAnchorElement;
  currentSong.href = `https://youtube.com/watch?v=${video.id}`;
  currentSong.textContent = video.title;
}
