// Helpers shared by every page.

import { idToken } from "./firebase.js";

const STORAGE_KEY = "bill-e:sessions";

// Pages come through Firebase Hosting, but API calls go straight to Cloud Run:
// the extra hop through Hosting added ~300 ms (and the odd timeout) to every tap.
const CLOUD_RUN = "https://bill-e-1064792089790.asia-south1.run.app";
const API_BASE = /(^|\.)(web\.app|firebaseapp\.com)$/.test(location.hostname) ? CLOUD_RUN : "";

/** Call the Bill-e API. Throws an Error with a friendly message on failure. */
export async function api(path, { method = "GET", body, auth, form } = {}) {
  const headers = {};
  if (auth) {
    headers["X-Person-Id"] = auth.personId;
    if (auth.token) headers["X-Person-Token"] = auth.token;
  }
  // Signed-in users also send their Firebase ID token, which the server verifies.
  const token = await idToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(API_BASE + path, { method, headers, body: payload });
  } catch {
    throw new Error("You seem to be offline. Check your connection.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Something went wrong. Try again.");
    error.status = response.status;
    throw error;
  }
  return data;
}

const wholeRupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const withPaise = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });

/** Format paise as rupees, e.g. 33000 -> "₹330", 3333 -> "₹33.33". */
export function money(paise) {
  return (paise % 100 === 0 ? wholeRupees : withPaise).format(paise / 100);
}

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

let toastTimer;
export function toast(message, kind = "info") {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === "error" ? 5000 : 2500);
}

// Which bills this browser has joined: { CODE: { personId, token, title, at } }.
// Storage can be unavailable (private mode), so every access is guarded.
function readAll() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function writeAll(all) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* not fatal - the user just won't be remembered */
  }
}

export function getMembership(code) {
  return readAll()[code] || null;
}

export function saveMembership(code, membership) {
  const all = readAll();
  all[code] = { ...all[code], ...membership, at: Date.now() };
  writeAll(all);
}

export function forgetMembership(code) {
  const all = readAll();
  delete all[code];
  writeAll(all);
}

/** On sign-out, drop bills tied to that account so the next person can't act as them. */
export function forgetAccountMemberships(uid) {
  const all = readAll();
  for (const [code, m] of Object.entries(all)) {
    if (m.uid === uid) delete all[code];
  }
  writeAll(all);
}

export function recentMemberships(limit = 5) {
  return Object.entries(readAll())
    .map(([code, m]) => ({ code, ...m }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}
