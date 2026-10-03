// One Firebase app shared by every page, plus Firebase Authentication helpers.
// Signing in is optional: guests can still use Bill-e with just a name.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);

// Firebase keeps the user signed in across visits (stored in this browser).
export const auth = getAuth(app);

/** Resolves once Firebase knows whether someone is signed in (user or null). */
export const authReady = new Promise((resolve) => {
  const stop = onAuthStateChanged(auth, (user) => {
    stop();
    resolve(user);
  });
});

export const onUser = (callback) => onAuthStateChanged(auth, callback);

/** A fresh ID token for the API, or null when signed out. */
export async function idToken() {
  await authReady;
  return auth.currentUser ? auth.currentUser.getIdToken() : null;
}

export function displayName(user) {
  return user?.displayName || user?.email?.split("@")[0] || "";
}
