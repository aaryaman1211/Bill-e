import { api, esc, forgetMembership, getMembership, money, recentMemberships, saveMembership, toast } from "./common.js";
import { auth, displayName, onUser } from "./firebase.js";

const createForm = document.getElementById("create-form");
const joinForm = document.getElementById("join-form");

async function submit(form, action) {
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await action(Object.fromEntries(new FormData(form)));
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
  }
}

function remember(code, result, title) {
  saveMembership(code, {
    personId: result.personId,
    ...(result.token && { token: result.token }),
    ...(title && { title }),
    ...(auth.currentUser && { uid: auth.currentUser.uid }),
  });
}

createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submit(createForm, async ({ name, title }) => {
    const result = await api("/api/sessions", { method: "POST", body: { name, title } });
    remember(result.code, result, title || `${name}'s bill`);
    location.href = `/s/${result.code}`;
  });
});

joinForm.code.addEventListener("input", () => {
  joinForm.code.value = joinForm.code.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submit(joinForm, async ({ code, name }) => {
    code = code.toUpperCase();
    const result = await api(`/api/sessions/${code}/join`, { method: "POST", body: { name } });
    remember(code, result);
    location.href = `/s/${code}`;
  });
});

const TRASH = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>`;

function billRow(code, inner, label) {
  return `<li data-code="${esc(code)}">
    <a href="/s/${esc(code)}">${inner}</a>
    <button type="button" class="icon-button row-delete" data-delete="${esc(code)}" aria-label="${esc(label)}">${TRASH}</button>
  </li>`;
}

function renderRecent() {
  const recent = recentMemberships();
  document.getElementById("recent").hidden = !recent.length;
  document.getElementById("recent-list").innerHTML = recent.map((m) => billRow(
    m.code,
    `<span>${esc(m.title || "Bill")}</span><code>${esc(m.code)}</code>`,
    m.isHost ? `Delete ${m.title || "bill"}` : `Remove ${m.title || "bill"} from this device`,
  )).join("");
}

const dateFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });
let myBills = [];

async function renderMyBills() {
  const list = document.getElementById("my-bills-list");
  list.innerHTML = `<li class="muted small">Loading…</li>`;
  try {
    ({ bills: myBills } = await api("/api/me"));
    document.getElementById("my-bills-empty").hidden = myBills.length > 0;
    list.innerHTML = myBills.map((b) => billRow(b.code, `
          <span class="bill-main">
            <strong>${esc(b.title)}</strong>
            <span class="muted small">${dateFormat.format(new Date(b.createdAt))} · ${b.people} people${b.isHost ? " · you hosted" : ""}</span>
          </span>
          <span class="bill-side">
            <strong>${money(b.myTotal)}</strong>
            <span class="badge${b.status === "final" ? " done" : ""}">${b.status === "final" ? "Final" : "Open"}</span>
          </span>`,
      b.isHost ? `Delete ${b.title}` : `Remove ${b.title} from my bills`,
    )).join("");
  } catch (error) {
    list.innerHTML = `<li class="muted small">${esc(error.message)}</li>`;
  }
}

/**
 * Hosts delete the bill for everyone; anyone else just removes it from their own list.
 */
async function deleteBill(code) {
  const mine = myBills.find((b) => b.code === code);
  const saved = getMembership(code);
  const isHost = mine ? mine.isHost : saved?.isHost;
  const title = mine?.title || saved?.title || "this bill";

  if (isHost) {
    if (!confirm(`Delete "${title}" for everyone? This can't be undone.`)) return;
    const host = { personId: mine?.personId || saved?.personId, token: saved?.token };
    await api(`/api/sessions/${code}`, { method: "DELETE", auth: host });
    toast("Bill deleted");
  } else {
    if (!confirm(`Remove "${title}" from your list? The bill stays for everyone else.`)) return;
    if (auth.currentUser) await api(`/api/me/bills/${code}`, { method: "DELETE" });
    toast("Removed from your list");
  }
  forgetMembership(code);
}

for (const listId of ["my-bills-list", "recent-list"]) {
  document.getElementById(listId).addEventListener("click", async (event) => {
    const button = event.target.closest("[data-delete]");
    if (!button) return;
    const row = button.closest("li");
    button.disabled = true;
    try {
      await deleteBill(button.dataset.delete);
      if (auth.currentUser) renderMyBills(); else renderRecent();
    } catch (error) {
      if (error.status === 404) {  // already gone: just tidy up the list
        forgetMembership(button.dataset.delete);
        row.remove();
      } else {
        toast(error.message, "error");
      }
    } finally {
      button.disabled = false;
    }
  });
}

// Signed in: skip the name boxes and show bills from every device.
onUser((user) => {
  const name = displayName(user);
  for (const field of document.querySelectorAll("[data-name-field]")) {
    field.hidden = Boolean(user);
    field.querySelector("input").required = !user;
    field.querySelector("input").value = user ? name : "";
  }
  const greeting = document.getElementById("greeting");
  greeting.hidden = !user;
  greeting.textContent = user ? `Hi ${name.split(" ")[0]} 👋` : "";

  document.getElementById("my-bills").hidden = !user;
  if (user) {
    document.getElementById("recent").hidden = true;
    renderMyBills();
  } else {
    renderRecent();
  }
});
