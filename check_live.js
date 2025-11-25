import fs from "fs";
import fetch from "node-fetch";
import XLSX from "xlsx";


const EXCEL_FILE = "streamers.xlsx";
const OUTPUT_FILE = "live.json";
const CHECK_INTERVAL_MIN = 5; // not used in GitHub Actions, but fine for local runs

// Try env vars first, then config.json for local use
let CONFIG = { twitch_client_id: "", twitch_client_secret: "" };
try {
  if (process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET) {
    CONFIG.twitch_client_id = process.env.TWITCH_CLIENT_ID;
    CONFIG.twitch_client_secret = process.env.TWITCH_CLIENT_SECRET;
  } else {
    // Fallback for local dev
    CONFIG = JSON.parse(fs.readFileSync("config.json", "utf8"));
  }
} catch (err) {
  console.warn("No config.json found and env vars missing; Twitch auth may fail.");
}

let tokenCache = { token: null, expiry: 0 };

// === 1. Get or refresh OAuth token ===
async function getToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiry) return tokenCache.token;

  const url = `https://id.twitch.tv/oauth2/token?client_id=${CONFIG.twitch_client_id}&client_secret=${CONFIG.twitch_client_secret}&grant_type=client_credentials`;
  const res = await fetch(url, { method: "POST" });
  const data = await res.json();
  if (!data.access_token) throw new Error("Failed to fetch Twitch token: " + JSON.stringify(data));

  tokenCache.token = data.access_token;
  tokenCache.expiry = now + data.expires_in * 1000 - 60000;
  console.log("🔑 Refreshed Twitch token");
  return tokenCache.token;
}

// === 2. Load usernames from spreadsheet (col A, include only if col E has value) ===
function loadUsernames() {
  const wb = XLSX.readFile(EXCEL_FILE);
  const sh = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sh, { header: 1 });
  const names = [];

  for (let i = 1; i < rows.length; i++) {
    const username = (rows[i][0] || "").toString().trim();
    const recent = (rows[i][4] || "").toString().trim().toLowerCase(); // col E
    if (username && recent && recent !== "no" && recent !== "false") {
      names.push(username);
    }
  }
  return names;
}

// === 3. Check live status ===
async function checkLive(names) {
  const token = await getToken();
  const headers = {
    "Client-ID": CONFIG.twitch_client_id,
    "Authorization": `Bearer ${token}`
  };

  const liveUsers = [];
  for (let i = 0; i < names.length; i += 100) {
    const batch = names.slice(i, i + 100);
    const params = batch.map(n => `user_login=${encodeURIComponent(n)}`).join("&");
    const res = await fetch(`https://api.twitch.tv/helix/streams?${params}`, { headers });
    const data = await res.json();

    if (data.data) {
      for (const s of data.data) {
        liveUsers.push({
          username: s.user_name,
          title: s.title || "",
          game: s.game_name || "",
          started_at: s.started_at
        });
      }
    }
  }
  return liveUsers;
}

function writeJSON(liveList) {
  const out = {
    timestamp: new Date().toISOString(),
    live: liveList
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2));
  console.log(`✅ Wrote ${OUTPUT_FILE} (${liveList.length} live)`);
  return out;
}

// === Main (single run) ===
async function main() {
  try {
    const names = loadUsernames();
    if (!names.length) {
      console.warn("⚠ No valid streamers found in spreadsheet");
      return;
    }
    const liveList = await checkLive(names);
    writeJSON(liveList);
  } catch (err) {
    console.error("Error:", err.message);
    process.exitCode = 1;
  }
}

// If you still want to run this continuously on your own server, uncomment:
// console.log("▶ Starting Twitch live check (every 5 min)...");
// main();
// setInterval(main, CHECK_INTERVAL_MIN * 60 * 1000);

// For GitHub Actions, just do a single run:
if (require.main === module) {
  main();
}
