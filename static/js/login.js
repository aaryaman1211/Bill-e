import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { api, recentMemberships, saveMembership, toast } from "./common.js";
import { auth, authReady } from "./firebase.js";

const form = document.getElementById("auth-form");
const submitButton = document.getElementById("submit-button");
let mode = "signin";

// Only allow redirects back into Bill-e, never to another site.
const nextParam = new URLSearchParams(location.search).get("next") || "/";
const next = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/";

const MESSAGES = {
  "auth/invalid-credential": "Wrong email or password.",
  "auth/invalid-email": "That email address doesn't look right.",
  "auth/missing-password": "Enter your password.",
  "auth/user-disabled": "This account has been disabled.",
  "auth/email-already-in-use": "There's already an account with this email. Sign in instead.",
  "auth/weak-password": "Use a password with at least 6 characters.",
  "auth/too-many-requests": "Too many attempts. Wait a minute and try again.",
  "auth/network-request-failed": "You seem to be offline. Check your connection.",
  "auth/operation-not-allowed": "This sign-in method isn't switched on yet.",
  "auth/unauthorized-domain": "Google sign-in isn't enabled for this web address yet.",
  "auth/popup-blocked": "Your browser blocked the sign-in window. Allow pop-ups and try again.",
};
const friendly = (error) => MESSAGES[error.code] || "Couldn't sign you in. Try again.";

function setMode(newMode) {
  mode = newMode;
  const signup = mode === "signup";
  for (const tab of document.querySelectorAll("[data-mode]")) {
    tab.setAttribute("aria-selected", String(tab.dataset.mode === mode));
  }
  document.getElementById("name-field").hidden = !signup;
  form.name.required = signup;
  form.password.autocomplete = signup ? "new-password" : "current-password";
  submitButton.textContent = signup ? "Create account" : "Sign in";
  document.getElementById("forgot-button").hidden = signup;
}

/** After signing in: register the profile, attach bills joined as a guest, then go back. */
async function finish() {
  await api("/api/me").catch(() => {});
  const uid = auth.currentUser.uid;
  for (const m of recentMemberships(20)) {
    if (!m.token || m.uid) continue;
    try {
      await api(`/api/sessions/${m.code}/link`, { method: "POST", auth: m });
      saveMembership(m.code, { uid });
    } catch { /* bill expired, or already linked elsewhere - skip */ }
  }
  location.replace(next);
}

async function attempt(action) {
  const buttons = document.querySelectorAll("button");
  buttons.forEach((b) => { b.disabled = true; });
  try {
    await action();
    await finish();
  } catch (error) {
    if (error.code !== "auth/popup-closed-by-user" && error.code !== "auth/cancelled-popup-request") {
      toast(error.code ? friendly(error) : error.message, "error");
    }
    buttons.forEach((b) => { b.disabled = false; });
  }
}

document.querySelector(".tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-mode]");
  if (tab) setMode(tab.dataset.mode);
});

document.getElementById("google-button").addEventListener("click", () => {
  attempt(() => signInWithPopup(auth, new GoogleAuthProvider()));
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = form.name.value.trim();
  const email = form.email.value.trim();
  const password = form.password.value;
  if (mode === "signup" && !name) {
    toast("Enter your name.", "error");
    return;
  }
  attempt(async () => {
    if (mode === "signin") {
      await signInWithEmailAndPassword(auth, email, password);
      return;
    }
    const { user } = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(user, { displayName: name });
    await user.getIdToken(true); // refresh so the server sees the new name
  });
});

document.getElementById("forgot-button").addEventListener("click", async () => {
  const email = form.email.value.trim();
  if (!email) {
    toast("Type your email above first.", "error");
    form.email.focus();
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    toast("If that email has an account, a reset link is on its way.");
  } catch (error) {
    toast(friendly(error), "error");
  }
});

// Already signed in? Nothing to do here.
authReady.then((user) => {
  if (user) location.replace(next);
});
