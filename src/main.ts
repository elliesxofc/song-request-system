/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { config as loadEnv } from "dotenv";

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from "electron";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "path";
import { Masterchat, stringify } from "masterchat";
import ms from "ms";
import squirrelStartup from "electron-squirrel-startup";
import exampleSongs from "../songs.example.json";

// the Windows installer runs the app briefly while installing to make shortcuts
if (squirrelStartup) {
  app.quit();
}

// Everything the app saves (playlist, settings, .env) lives in one fixed folder, so it works
// the same whether it's started with `npm start` or installed, wherever it's launched from.
// Windows: %APPDATA%\custom-sr-system
const DATA_DIR = app.getPath("userData");
mkdirSync(DATA_DIR, { recursive: true });
const SONGS_FILE = path.join(DATA_DIR, "songs.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

// .env next to the project (npm start) wins, then the one in the data folder (installed app)
loadEnv({ path: [path.resolve(".env"), path.join(DATA_DIR, ".env")] });

const REQUIRED_ENV = ["YOUTUBE_API_KEY", "YOUTUBE_BOT_CREDENTIALS", "YOUTUBE_STREAM_ID"];
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missingEnv.length) {
  const message = `Missing settings: ${missingEnv.join(", ")}.\n\nPut them in a .env file in:\n${DATA_DIR}`;
  console.error(message);
  // an installed app has no console, so say it in a window and open the folder
  dialog.showErrorBox("Song Requests can't start", message);
  shell.openPath(DATA_DIR);
  process.exit(1);
}

// First run: bring over the playlist from the project folder if there is one,
// otherwise start from the example playlist built into the app.
if (!existsSync(SONGS_FILE)) {
  const oldSongs = path.resolve("songs.json");
  writeFileSync(
    SONGS_FILE,
    existsSync(oldSongs) ? readFileSync(oldSongs, "utf-8") : JSON.stringify(exampleSongs)
  );
}

const songIds = JSON.parse(readFileSync(SONGS_FILE, "utf-8"));

function saveSongs() {
  writeFileSync(SONGS_FILE, JSON.stringify(songIds));
}

type Settings = { nowPlayingPath?: string };
function readSettings(): Settings {
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
  } catch {
    return {};
  }
}
function writeSettings(patch: Settings) {
  writeFileSync(SETTINGS_FILE, JSON.stringify({ ...readSettings(), ...patch }, null, 2));
}

// The song title for OBS (Text source → "Read from file"). Saved in Documents until
// you pick another place in the app; the choice is remembered.
function nowPlayingPath() {
  return readSettings().nowPlayingPath || path.join(app.getPath("documents"), "current-song.txt");
}
async function writeNowPlaying() {
  if (!currentSong) return;
  try {
    await writeFile(nowPlayingPath(), parseSongTitle(currentSong.title) + " ", "utf8");
  } catch (err) {
    // a missing drive or read-only folder shouldn't stop the music
    console.error("Couldn't write the now playing file:", err);
  }
}

let currentSong: {
  id: string;
  title: string;
} | null = null;
let previousSongId: string | null = null;
const queue = new Map<
  string,
  {
    title: string;
  }
>();
const cooldowns = new Map<string, number>();
const trustedChannels = [
  "UC_aEa8K-EOJ3D6gOs7HcyNg", // NoCopyrightSounds
  "UCiJnBO_XuDsi1SSRAmt4n5g", // NCS Arcade
  "UCJ6td3C9QlPO9O_J5dF4ZzA", // Monstercat Uncaged
  "UCp8OOssjSjGZRVYK6zWbNLg", // Monstercat Instinct
  "UCa_UMppcMsHIzb5LDx1u9zQ", // TheFatRat
  "UCMg7TTDtUXq2yTu3uqqoprQ", // Epidemic Electronic
  "UCCeNgETxEJf__ZAAOvU5ZaQ", // Elektronomia
  "UCAA6pKrh72sARBb7JCfp8AA", // Tobu
];

function getRandomSong(): string {
  const videoId = songIds[Math.floor(Math.random() * songIds.length)];
  if (videoId === previousSongId) return getRandomSong();
  return videoId;
}

async function getSongTitle(videoId: string): Promise<string | null> {
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${process.env.YOUTUBE_API_KEY}`
  );
  const data = await res.json();
  if (!data.items[0]) return null;
  return data.items[0].snippet.title;
}

function parseSongTitle(title: string) {
  return title
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

// The YouTube player refuses to run on pages opened from file:// (it can't tell which site
// it's embedded in: "Error 153 / video player configuration error"), which is how a packaged
// app loads its page. So in production the page is served from a small local web server,
// the same way `npm start` serves it from Vite's dev server.
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

function serveRenderer(root: string): Promise<string> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      const file = path.normalize(path.join(root, relative));
      if (!file.startsWith(root + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[path.extname(file)] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    // 127.0.0.1 only: nothing outside this PC can reach it; port 0 picks a free port
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}/index.html`);
    });
  });
}

const createWindow = async () => {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    maximizable: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadURL(
      await serveRenderer(
        path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`)
      )
    );
  }

  ipcMain.handle("yt:get-video", async () => {
    return await getNextSong();
  });

  ipcMain.handle("now-playing:get", () => nowPlayingPath());
  ipcMain.handle("now-playing:choose", async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Where should the song name for OBS be saved?",
      defaultPath: nowPlayingPath(),
      filters: [{ name: "Text file", extensions: ["txt"] }],
    });
    if (result.canceled || !result.filePath) return nowPlayingPath();
    writeSettings({ nowPlayingPath: result.filePath });
    await writeNowPlaying();
    return result.filePath;
  });
  ipcMain.on("now-playing:show", () => shell.showItemInFolder(nowPlayingPath()));

  ipcMain.on("show-context-menu", (_event, videoId) => {
    const menu = Menu.buildFromTemplate([
      {
        label: "Remove from queue",
        click: () => {
          queue.delete(videoId);
          mainWindow.webContents.send(
            "queue-updated",
            [...queue.entries()].map(([k, v]) => ({ id: k, title: v.title }))
          );
        },
      },
      {
        label: "Skip to this song",
        click: () => {
          const video = queue.get(videoId);
          const videoObj = { id: videoId, title: video.title };
          updateSong(videoObj);
          mainWindow.webContents.send("song-skipped", videoObj);
          queue.delete(videoId);
          mainWindow.webContents.send(
            "queue-updated",
            [...queue.entries()].map(([k, v]) => ({ id: k, title: v.title }))
          );
        },
      },
      {
        label: "Copy video link",
        click: () => {
          clipboard.writeText(`https://youtube.com/watch?v=${videoId}`);
        },
      },
    ]);
    menu.popup();
  });

  const mc = await Masterchat.init(process.env.YOUTUBE_STREAM_ID!, {
    credentials: process.env.YOUTUBE_BOT_CREDENTIALS!,
  });

  function sendMessage(content: string) {
    if (content.length === 0) return;
    if (content.length > 200) {
      const messages = [];
      while (content.length > 200) {
        messages.push(content.substring(0, 200));
        content = content.substring(200);
      }
      for (const message of messages) {
        mc.sendMessage(message);
      }
    } else {
      mc.sendMessage(content);
    }
  }

  mc.on("chat", async (chat) => {
    const message = {
      content: stringify(chat.message),
      user: {
        id: chat.authorChannelId,
        name: chat.authorName,
        avatar: chat.authorPhoto,
      },
    };
    if (message.content.startsWith("!sr")) {
      const cooldown = cooldowns.get(message.user.id);
      if (cooldown) {
        if (Date.now() < cooldown + 10 * 1000) {
          return mc.sendMessage(
            `${message.user.name}, you're on cooldown. Please wait ${ms(
              cooldown + 10 * 1000 - Date.now(),
              { long: true }
            )} before requesting another song.`
          );
        }
      }

      const searchQuery = message.content.split(" ").slice(1).join(" ");

      let videoId: string;
      let title: string;

      if (searchQuery.includes("youtu.be/")) {
        videoId = searchQuery.split("youtu.be/")[1];

        const res = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${process.env.YOUTUBE_API_KEY}`
        );
        const data = await res.json();
        if (!data.items[0])
          return mc.sendMessage(
            `${message.user.name}, I couldn't find a video with that search query.`
          );
        title = parseSongTitle(data.items[0].snippet.title);

        if (!songIds.includes(videoId)) {
          if (trustedChannels.includes(data.items[0].snippet.channelId)) {
            songIds.push(videoId);
            saveSongs();
          } else
            return mc.sendMessage(
              `${message.user.name}, you can only request songs that are from the playlist.`
            );
        }
      } else if (searchQuery.includes("youtube.com/watch?v=")) {
        videoId = searchQuery.split("youtube.com/watch?v=")[1].split("&")[0];

        const res = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${process.env.YOUTUBE_API_KEY}`
        );
        const data = await res.json();
        if (!data.items[0])
          return mc.sendMessage(
            `${message.user.name}, I couldn't find a video with that search query.`
          );
        title = parseSongTitle(data.items[0].snippet.title);

        if (!songIds.includes(videoId)) {
          if (trustedChannels.includes(data.items[0].snippet.channelId)) {
            songIds.push(videoId);
            saveSongs();
          } else
            return mc.sendMessage(
              `${message.user.name}, you can only request songs that are from the playlist.`
            );
        }
      } else if (!searchQuery.includes(" ") && searchQuery.length >= 11) {
        videoId = searchQuery;

        const res = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${process.env.YOUTUBE_API_KEY}`
        );
        const data = await res.json();
        if (!data.items[0])
          return mc.sendMessage(
            `${message.user.name}, I couldn't find a video with that search query.`
          );
        title = parseSongTitle(data.items[0].snippet.title);

        if (!songIds.includes(videoId)) {
          if (trustedChannels.includes(data.items[0].snippet.channelId)) {
            songIds.push(videoId);
            saveSongs();
          } else
            return mc.sendMessage(
              `${message.user.name}, you can only request songs that are from the playlist.`
            );
        }
      } else {
        const res = await fetch(
          `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(
            searchQuery
          )}&maxResults=5&type=video&key=${process.env.YOUTUBE_API_KEY}`
        );
        const data = await res.json();
        if (!data.items?.length)
          return mc.sendMessage(
            `${message.user.name}, I couldn't find a video with that search query.`
          );

        const video = data.items[0];
        videoId = video.id.videoId;
        title = parseSongTitle(video.snippet.title);
        if (!songIds.includes(videoId)) {
          if (trustedChannels.includes(video.snippet.channelId)) {
            songIds.push(videoId);
            saveSongs();
          } else {
            let foundVideo = false;
            for (let i = 1; i < 5; i++) {
              const video = data.items[i];
              if (songIds.includes(video.id.videoId)) {
                videoId = video.id.videoId;
                title = parseSongTitle(video.snippet.title);
                foundVideo = true;
              }
            }
            if (!foundVideo)
              return mc.sendMessage(
                `${message.user.name}, you can only request songs that are from the playlist.`
              );
          }
        }
      }

      if (queue.has(videoId))
        return sendMessage(
          `${message.user.name}, ${title} is already in the queue.`
        );

      queue.set(videoId, { title });
      mainWindow.webContents.send(
        "queue-updated",
        [...queue.entries()].map(([k, v]) => ({ id: k, title: v.title }))
      );
      if (!chat.isOwner && !chat.isModerator)
        cooldowns.set(message.user.id, Date.now());

      sendMessage(
        `${message.user.name}, ${title} has been added to the queue.`
      );
    } else if (message.content === "!currentsong") {
      sendMessage(
        `Currently playing: ${currentSong?.title} (https://youtu.be/${currentSong?.id})`
      );
    } else if (message.content === "!queue") {
      if (!queue.size)
        return mc.sendMessage("There are no songs in the queue.");
      sendMessage(
        `Next 3 songs in the queue: ${[...queue.entries()]
          .slice(0, 3)
          .map(([, { title }], index) => `${index + 1}. ${title}`)
          .join(", ")}`
      );
    } else if (message.content === "!skip") {
      if (!chat.isModerator && !chat.isOwner)
        return mc.sendMessage(
          `${message.user.name}, you are not authorized to skip songs.`
        );
      sendMessage(`${message.user.name}, skipped ${currentSong?.title}.`);
      const nextSong = await getNextSong();
      mainWindow.webContents.send("song-skipped", nextSong);
    }
  });

  mc.on("error", (err) => {
    console.error(err);
    mc.listen({ ignoreFirstResponse: true });
  });

  mc.listen({ ignoreFirstResponse: true });

  async function getNextSong() {
    let videoId: string;
    let title: string;
    if (queue.size > 0) {
      const [queueEntry] = [...queue.entries()];
      videoId = queueEntry[0];
      title = queueEntry[1].title;
      queue.delete(videoId);
      mainWindow.webContents.send(
        "queue-updated",
        [...queue.entries()].map(([k, v]) => ({ id: k, title: v.title }))
      );
    } else {
      videoId = getRandomSong();
      title = await getSongTitle(videoId);
      while (title === null) {
        if (queue.has(videoId)) queue.delete(videoId);
        songIds.splice(songIds.indexOf(videoId), 1);
        saveSongs();
        videoId = getRandomSong();
        title = await getSongTitle(videoId);
      }
    }

    updateSong({ id: videoId, title });
    return { id: videoId, title };
  }

  function updateSong(video: { id: string; title: string }) {
    currentSong = video;
    previousSongId = currentSong?.id ?? video.id;
    writeNowPlaying();
    cooldowns.clear();
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith("http")) {
      shell.openExternal(details.url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
};

app.on("ready", createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
