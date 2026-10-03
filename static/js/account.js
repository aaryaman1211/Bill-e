// The "Sign in" button / account menu in the top bar of every page.

import { signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { esc, forgetAccountMemberships } from "./common.js";
import { auth, displayName, onUser } from "./firebase.js";

const slot = document.getElementById("account");

function initials(name) {
  // Letters and digits only, so "Riya (guest)" gives "RG", not "R(".
  const parts = name.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts.at(-1)[0] : "")).toUpperCase();
}

onUser((user) => {
  if (!slot) return;
  if (!user) {
    const next = encodeURIComponent(location.pathname);
    slot.innerHTML = `<a class="btn btn-small" href="/login?next=${next}">Sign in</a>`;
    return;
  }
  const name = displayName(user);
  slot.innerHTML = `
    <details class="account-menu">
      <summary aria-label="Account menu for ${esc(name)}">
        ${user.photoURL
          ? `<img src="${esc(user.photoURL)}" alt="" referrerpolicy="no-referrer">`
          : `<span>${esc(initials(name))}</span>`}
      </summary>
      <div class="menu">
        <p class="menu-who"><strong>${esc(name)}</strong><span>${esc(user.email || "")}</span></p>
        <a href="/#my-bills">My bills</a>
        <button type="button" data-sign-out>Sign out</button>
      </div>
    </details>`;
});

slot?.addEventListener("click", async (event) => {
  if (!event.target.closest("[data-sign-out]")) return;
  const uid = auth.currentUser?.uid;
  await signOut(auth);
  if (uid) forgetAccountMemberships(uid);
  location.href = "/";
});

// Close the menu when tapping elsewhere.
document.addEventListener("click", (event) => {
  const menu = slot?.querySelector(".account-menu[open]");
  if (menu && !menu.contains(event.target)) menu.open = false;
});
