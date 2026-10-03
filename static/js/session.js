// The bill page. Reads the bill live from Firestore and sends changes to the
// Flask API, which validates them and recomputes the split for everyone.

import { doc, getFirestore, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { api, esc, forgetMembership, getMembership, money, saveMembership, toast } from "./common.js";
import { app, displayName, onUser } from "./firebase.js";

const code = document.body.dataset.code;
const $ = (id) => document.getElementById(id);

let session = null;   // latest bill from Firestore
let user;             // signed-in Firebase user, null for guests, undefined until known
let me = null;        // { personId, token? } - who this browser is in the bill
let pickingFor = null;
let editing = false;
let linkTried = false;
const openBreakdowns = new Set();

// ------------------------------------------------------------ live data

onUser((current) => {
  user = current;
  if (session) render();
});

const db = getFirestore(app);
onSnapshot(
  doc(db, "sessions", code),
  (snapshot) => {
    if (!snapshot.exists()) {
      if (session) $("missing-text").textContent = "This bill has been deleted.";
      show("missing");
      return;
    }
    applySession(snapshot.data());
  },
  (error) => {
    console.error(error);
    $("loading").hidden = true;
    toast("Lost connection to the bill. Refresh to try again.", "error");
  },
);

// ------------------------------------------------------------ helpers

const personById = (id) => session.people.find((p) => p.id === id);
const summaryFor = (id) => session.summary.people.find((p) => p.personId === id);
const isHost = () => session.hostId === me?.personId;
const isOpen = () => session.status === "open";
const isAdded = (extra) => extra.source === "manual";
const canPickFor = (person) => person.id === me.personId || isHost() || !person.hasDevice;
const firstName = (name) => name.split(" ")[0];
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const rupees = (paise) => (paise / 100).toFixed(2).replace(/\.00$/, "");
const cleanAmount = (value) => value.replace(/[₹,\s]/g, "");

function initials(name) {
  // Letters and digits only, so "Riya (guest)" gives "RG", not "R(".
  const parts = name.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts.at(-1)[0] : "")).toUpperCase();
}

function hue(id) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return hash;
}

function avatar(person, units = 1) {
  const label = units > 1 ? `${person.name} ×${units}` : person.name;
  return `<span class="avatar" style="--hue:${hue(person.id)}" title="${esc(label)}">${esc(initials(person.name))}</span>`;
}

function show(view) {
  $("loading").hidden = true;
  for (const id of ["missing", "join-view", "bill-view"]) $(id).hidden = id !== view;
}

function busy(message) {
  $("busy").hidden = !message;
  $("busy-text").textContent = message || "";
}

/** Show a newer copy of the bill; ignore anything older than what's on screen. */
function applySession(next) {
  if (session && (next.version ?? 0) <= (session.version ?? 0)) return;
  session = next;
  render();
}

async function call(path, options = {}) {
  try {
    const result = await api(`/api/sessions/${code}${path}`, { ...options, auth: me });
    // The server replies with the updated bill, so show it now instead of
    // waiting for Firestore's live update to arrive.
    if (result.session) applySession(result.session);
    return result;
  } catch (error) {
    toast(error.message, "error");
    throw error;
  }
}

// ------------------------------------------------------------ rendering

/** Who this browser is in the bill: a saved guest token, or a signed-in account on any device. */
function resolveMe() {
  const saved = getMembership(code);
  if (saved?.personId && personById(saved.personId)) return saved;
  if (saved) forgetMembership(code); // removed from the bill since
  const mine = user && session.people.find((p) => p.uid === user.uid);
  return mine ? { personId: mine.id } : null;
}

/** Joined as a guest, then signed in? Attach this bill to the account (once). */
function linkAccount() {
  if (linkTried || !user || !me?.token || personById(me.personId)?.uid) return;
  linkTried = true;
  api(`/api/sessions/${code}/link`, { method: "POST", auth: me })
    .then(() => saveMembership(code, { uid: user.uid }))
    .catch(() => {});
}

function render() {
  if (user === undefined) return; // wait until we know who's signed in
  me = resolveMe();
  if (!me) {
    renderJoin();
    show("join-view");
    return;
  }
  linkAccount();
  pickingFor ??= me.personId;

  const target = personById(pickingFor);
  if (!target || !canPickFor(target)) pickingFor = me.personId;
  if (!isOpen()) editing = false;
  const linked = user && personById(me.personId).uid === user.uid;
  saveMembership(code, {
    personId: me.personId, title: session.title, isHost: isHost(), ...(linked && { uid: user.uid }),
  });

  show("bill-view");
  renderHead();
  renderMe();
  renderTools();
  renderPeople();
  renderPicker();
  renderItems();
  renderCharges();
  renderSummary();
}

function renderJoin() {
  $("join-title").textContent = session.title;
  const names = session.people.map((p) => firstName(p.name));
  $("join-people").textContent = names.length > 3
    ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more are splitting this bill.`
    : `${names.join(" and ")} ${names.length === 1 ? "is" : "are"} splitting this bill.`;
  document.title = `Join ${session.title} · Bill-e`;

  const form = $("join-form");
  const nameField = form.name.closest(".field");
  nameField.hidden = Boolean(user);
  form.name.required = !user;
  if (user) form.name.value = displayName(user);
  form.querySelector("button").textContent = user ? `Join as ${displayName(user)}` : "Join bill";
}

function renderHead() {
  const s = session.summary;
  $("bill-title").textContent = session.title;
  $("bill-subtitle").textContent = [
    plural(session.people.length, "person").replace("persons", "people"),
    plural(session.items.length, "item"),
    session.items.length ? `${money(s.billTotal)} total` : null,
  ].filter(Boolean).join(" · ");
  document.title = `${session.title} · Bill-e`;

  const banner = $("final-banner");
  banner.hidden = isOpen();
  banner.textContent = "The host has finalised this bill. Amounts are locked.";
}

function renderMe() {
  const mine = summaryFor(me.personId);
  const card = $("me-card");
  if (!session.items.length) {
    card.innerHTML = `<p class="me-label">You pay</p><p class="me-amount is-zero">—</p>
      <p class="me-note">Your share shows up here once the bill is added.</p>`;
    return;
  }
  const count = mine.lines.length;
  const stamp = isOpen() ? "" : `<span class="stamp" aria-label="Finalised">Final</span>`;
  card.innerHTML = count
    ? `<p class="me-label">You pay</p>
       <p class="me-amount">${money(mine.total)}</p>
       <p class="me-note">${plural(count, "item")}${mine.extrasTotal ? ` · incl. ${money(mine.extrasTotal)} tax &amp; charges` : ""}</p>${stamp}`
    : `<p class="me-label">You pay</p>
       <p class="me-amount is-zero">${money(0)}</p>
       <p class="me-note">Tick the dishes you had below.</p>${stamp}`;
}

function renderTools() {
  $("host-tools").hidden = !isHost();
  if (!isHost()) return;
  $("scan-label").hidden = !isOpen();
  $("edit-toggle").hidden = !isOpen();
  $("edit-toggle").textContent = editing ? "Done editing" : "Edit items";
  $("edit-toggle").setAttribute("aria-pressed", String(editing));
  $("final-toggle").textContent = isOpen() ? "Finalise" : "Reopen";
}

function renderPeople() {
  $("people-list").innerHTML = session.people.map((p) => {
    const tags = [
      p.id === me.personId && "you",
      p.isHost && "host",
      !p.hasDevice && "no phone",
    ].filter(Boolean);
    const removable = isOpen() && !p.isHost && (isHost() || p.addedBy === me.personId);
    return `<li class="person">
      ${avatar(p)}
      <span class="person-name">${esc(p.name)}</span>
      ${tags.map((t) => `<span class="tag">${t}</span>`).join("")}
      ${removable ? `<button type="button" class="icon-button" data-remove="${p.id}" aria-label="Remove ${esc(p.name)}">×</button>` : ""}
    </li>`;
  }).join("");
  $("add-person-toggle").hidden = !isOpen();
  if (!isOpen()) {
    $("add-person-form").hidden = true;
    $("add-person-hint").hidden = true;
  }
}

function renderPicker() {
  const options = session.people.filter(canPickFor);
  const picker = $("picker");
  picker.hidden = editing || !isOpen() || options.length < 2 || !session.items.length;
  picker.innerHTML = `<span class="picker-label">Ticking for</span>` + options.map((p) => {
    const active = p.id === pickingFor;
    const label = p.id === me.personId ? "You" : esc(firstName(p.name));
    return `<button type="button" class="pill${active ? " active" : ""}" data-pick="${p.id}" aria-pressed="${active}">${label}</button>`;
  }).join("");
}

function renderItems() {
  const s = session.summary;
  $("items-count").textContent = session.items.length ? `${money(s.itemsTotal)}` : "";

  const empty = $("items-empty");
  empty.hidden = editing || session.items.length > 0;
  if (!empty.hidden) {
    const host = personById(session.hostId);
    empty.innerHTML = isHost()
      ? `<p><strong>No items yet.</strong></p>
         <p>Tap <strong>Scan bill</strong> to read it from a photo, or
         <button type="button" class="link-button" data-action="edit">add items by hand</button>.</p>`
      : `<p><strong>Waiting for the bill…</strong></p>
         <p>${esc(firstName(host.name))} is adding it. Dishes will appear here automatically.</p>`;
  }

  $("item-list").hidden = editing;
  $("editor").hidden = !editing;
  if (editing) {
    syncEditor();
    return;
  }

  const target = personById(pickingFor);
  const who = target.id === me.personId ? "You" : esc(firstName(target.name));
  const targetLines = summaryFor(pickingFor)?.lines ?? [];

  $("item-list").innerHTML = session.items.map((item) => {
    const claims = session.claims[item.id] || {};
    const claimants = session.people.filter((p) => claims[p.id] > 0);
    const units = claims[pickingFor] || 0;
    const line = targetLines.find((l) => l.itemId === item.id);

    let note;
    if (!claimants.length) note = `<span class="warn-text">Nobody yet</span>`;
    else if (claimants.length === 1) note = esc(firstName(claimants[0].name));
    else note = `Split ${claimants.length} ways`;

    const stepper = units && item.qty > 1 && isOpen()
      ? `<span class="stepper">
           <button type="button" data-step="-1" data-item="${item.id}" aria-label="One less ${esc(item.name)}">−</button>
           <output>${units}</output>
           <button type="button" data-step="1" data-item="${item.id}" aria-label="One more ${esc(item.name)}">+</button>
         </span>`
      : "";

    return `<li class="item${units ? " picked" : ""}${claimants.length ? "" : " unclaimed"}">
      <button type="button" class="item-main" data-toggle="${item.id}" aria-pressed="${units > 0}" ${isOpen() ? "" : "disabled"}>
        <span class="check" aria-hidden="true"></span>
        <span class="item-name">${esc(item.name)}${item.qty > 1 ? ` <span class="qty">×${item.qty}</span>` : ""}</span>
        <span class="item-price">${money(item.price)}</span>
      </button>
      <div class="item-meta">
        <span class="avatars">${claimants.map((p) => avatar(p, claims[p.id])).join("")}</span>
        <span class="item-note">${note}</span>
        ${line ? `<span class="item-share">${who}: ${money(line.share)}</span>` : ""}
        ${stepper}
      </div>
    </li>`;
  }).join("");
}

function renderCharges() {
  const section = $("charges-section");
  section.hidden = editing || !session.extras.length;
  $("charge-list").innerHTML = session.extras.map((x) => `
    <li><span>${esc(x.label)}${isAdded(x) && session.scan ? ` <span class="tag">added</span>` : ""}</span>
      <span class="${x.amount < 0 ? "discount" : ""}">${money(x.amount)}</span></li>
  `).join("");

}

function renderSummary() {
  const s = session.summary;
  const warnings = [];

  if (s.unclaimedItems.length) {
    const names = s.unclaimedItems.map((id) => session.items.find((i) => i.id === id)?.name).filter(Boolean);
    warnings.push(`<div class="banner warn">
      <strong>${plural(names.length, "item")} not ticked by anyone</strong> (${money(s.unclaimedTotal)}):
      ${esc(names.join(", "))}. Someone needs to claim ${names.length === 1 ? "it" : "them"} before you pay.
    </div>`);
  }
  // Charges added on top of the bill (e.g. an extra tip) aren't on the printed total,
  // so it's fine if the bill matches either with or without them.
  const scanned = session.scan?.total;
  const addedOnTop = session.extras.filter(isAdded).reduce((sum, x) => sum + x.amount, 0);
  const matches = (total) => Math.abs(scanned - total) < 100;
  const mismatch = scanned != null && !matches(s.billTotal) && !matches(s.billTotal - addedOnTop);
  if (mismatch) {
    warnings.push(`<div class="banner warn">
      <strong>Totals don't match.</strong> The bill says ${money(scanned)} but items + charges add up to
      ${money(s.billTotal - addedOnTop)}${addedOnTop ? ` (not counting the ${money(addedOnTop)} you added)` : ""}. ${isHost()
        ? "Tap <em>Edit items</em> to fix a misread price or remove a charge that isn't on the bill."
        : "The host may need to fix a misread line."}
    </div>`);
  }
  if (session.items.length && !s.unclaimedItems.length) {
    warnings.push(mismatch
      ? `<div class="banner">Everything's claimed. Fix the total above before anyone pays.</div>`
      : `<div class="banner ok">Everything's claimed. Shares add up to the full ${money(s.billTotal)}.</div>`);
  }
  $("warnings").innerHTML = warnings.join("");

  $("summary-list").innerHTML = s.people.map((row) => {
    const person = personById(row.personId);
    if (!person) return "";
    const lines = row.lines.map((l) => {
      const detail = [l.units > 1 && `×${l.units}`, l.sharedWith && `shared with ${l.sharedWith}`].filter(Boolean).join(", ");
      return `<li><span>${esc(l.name)}${detail ? ` <small>(${detail})</small>` : ""}</span><span>${money(l.share)}</span></li>`;
    });
    const extras = row.extras.filter((x) => x.share).map((x) =>
      `<li class="extra"><span>${esc(x.label)}</span><span>${money(x.share)}</span></li>`);
    const open = openBreakdowns.has(row.personId) ? " open" : "";
    return `<li class="summary-row${row.personId === me.personId ? " is-me" : ""}">
      <details data-person="${row.personId}"${open}>
        <summary>
          ${avatar(person)}
          <span class="person-name">${row.personId === me.personId ? "You" : esc(person.name)}</span>
          <span class="amount">${money(row.total)}</span>
        </summary>
        ${lines.length ? `<ul class="breakdown">${lines.join("")}${extras.join("")}</ul>` : `<p class="muted small">Hasn't ticked anything yet.</p>`}
      </details>
    </li>`;
  }).join("");

  const claimed = s.people.reduce((sum, p) => sum + p.total, 0);
  $("totals").innerHTML = session.items.length ? `
    <div><dt>Bill total</dt><dd>${money(s.billTotal)}</dd></div>
    <div><dt>Claimed</dt><dd>${money(claimed)}</dd></div>
    ${s.unclaimedTotal ? `<div class="warn-text"><dt>Not claimed</dt><dd>${money(s.unclaimedTotal)}</dd></div>` : ""}
  ` : "";
}

// ------------------------------------------------------------ item editor (host)

function buildEditor() {
  $("editor").innerHTML = `
    <p class="hint">Changes save automatically. Fix anything the scanner misread.</p>
    <div class="edit-grid edit-labels" aria-hidden="true"><span>Item</span><span>Qty</span><span>Price ₹</span><span></span></div>
    <div id="edit-items"></div>
    <form id="add-item-form" class="edit-grid add-row">
      <input name="name" placeholder="Add an item" maxlength="60" required aria-label="New item name">
      <input name="qty" type="number" min="1" max="99" value="1" inputmode="numeric" aria-label="Quantity">
      <input name="price" placeholder="0" inputmode="decimal" required aria-label="Price in rupees">
      <button class="icon-button add" type="submit" aria-label="Add item">+</button>
    </form>
    <h3>Tax &amp; charges</h3>
    <p class="hint">Use a minus amount for a discount. Charges you add here don't need to be on the printed bill.</p>
    <div id="edit-extras"></div>
    <div class="quick-add">
      <button type="button" class="pill" data-quick="GST 5%">+ GST 5%</button>
      <button type="button" class="pill" data-quick="Service charge 10%">+ Service 10%</button>
      <button type="button" class="pill" data-quick="">+ Other</button>
    </div>
    <button type="button" class="btn btn-primary btn-block" data-action="done">Done editing</button>`;
}

function itemRow(item) {
  const row = document.createElement("div");
  row.className = "edit-grid";
  row.dataset.item = item.id;
  row.innerHTML = `
    <input name="name" maxlength="60" aria-label="Item name">
    <input name="qty" type="number" min="1" max="99" inputmode="numeric" aria-label="Quantity">
    <input name="price" inputmode="decimal" aria-label="Price in rupees">
    <button type="button" class="icon-button" data-delete-item="${item.id}" aria-label="Delete item">×</button>`;
  return row;
}

function extraRow(label = "", amount = "", source = "manual") {
  const row = document.createElement("div");
  row.className = "edit-grid extra-row";
  row.dataset.source = source;
  row.innerHTML = `
    <input name="label" maxlength="40" placeholder="e.g. CGST 2.5%" aria-label="Charge name">
    <input name="amount" inputmode="decimal" placeholder="0" aria-label="Amount in rupees">
    <button type="button" class="icon-button" data-delete-extra aria-label="Remove charge">×</button>`;
  row.querySelector("[name=label]").value = label;
  row.querySelector("[name=amount]").value = amount;
  return row;
}

/** Update the editor in place so live updates never wipe out what the host is typing. */
function syncEditor() {
  const box = $("edit-items");
  const rows = new Map([...box.children].map((row) => [row.dataset.item, row]));
  session.items.forEach((item, index) => {
    const row = rows.get(item.id) || itemRow(item);
    rows.delete(item.id);
    const values = { name: item.name, qty: item.qty, price: rupees(item.price) };
    for (const [name, value] of Object.entries(values)) {
      const input = row.querySelector(`[name=${name}]`);
      if (document.activeElement !== input) input.value = value;
    }
    if (box.children[index] !== row) box.insertBefore(row, box.children[index] || null);
  });
  rows.forEach((row) => row.remove());

  const extrasBox = $("edit-extras");
  if (!extrasBox.contains(document.activeElement)) {
    extrasBox.replaceChildren(...session.extras.map((x) => extraRow(x.label, rupees(x.amount), x.source)));
  }
}

function setEditing(on) {
  editing = on;
  if (on) buildEditor();
  render();
}

function saveExtras() {
  const extras = [...$("edit-extras").children]
    .map((row) => ({
      label: row.querySelector("[name=label]").value.trim(),
      amount: cleanAmount(row.querySelector("[name=amount]").value),
      source: row.dataset.source,
    }))
    .filter((x) => x.label && x.amount !== "");
  return call("/extras", { method: "PUT", body: { extras } }).catch(() => {});
}

// ------------------------------------------------------------ actions

let claimQueue = Promise.resolve();

function setClaim(itemId, units) {
  // Show the tick instantly; the totals follow when the server's update arrives.
  const before = structuredClone(session.claims);
  const claims = (session.claims[itemId] ||= {});
  if (units) claims[pickingFor] = units;
  else delete claims[pickingFor];
  render();

  const body = { itemId, personId: pickingFor, units };
  // Queue requests so quick taps reach the server in order.
  claimQueue = claimQueue.then(() => call("/claims", { method: "PUT", body })).catch(() => {
    session.claims = before;
    render();
  });
}

$("bill-view").addEventListener("click", async (event) => {
  const el = event.target.closest("button");
  if (!el) return;
  const { dataset } = el;

  if (dataset.toggle) {
    setClaim(dataset.toggle, session.claims[dataset.toggle]?.[pickingFor] ? 0 : 1);
  } else if (dataset.step) {
    const current = session.claims[dataset.item]?.[pickingFor] || 0;
    setClaim(dataset.item, Math.max(0, Math.min(99, current + Number(dataset.step))));
  } else if (dataset.pick) {
    pickingFor = dataset.pick;
    render();
    toast(pickingFor === me.personId ? "Ticking your own dishes" : `Now ticking for ${firstName(personById(pickingFor).name)}`);
  } else if (dataset.remove) {
    const person = personById(dataset.remove);
    if (confirm(`Remove ${person.name} from this bill? Their ticks will be cleared.`)) {
      await call(`/people/${dataset.remove}`, { method: "DELETE" }).catch(() => {});
    }
  } else if (dataset.action === "edit") {
    setEditing(true);
  } else if (dataset.action === "done") {
    setEditing(false);
  } else if (dataset.deleteItem) {
    el.closest(".edit-grid").style.opacity = 0.4;
    await call(`/items/${dataset.deleteItem}`, { method: "DELETE" }).catch(() => render());
  } else if (dataset.deleteExtra !== undefined) {
    el.closest(".extra-row").remove();
    saveExtras();
  } else if (dataset.quick !== undefined) {
    const percent = Number(dataset.quick.match(/([\d.]+)%/)?.[1] || 0);
    const amount = percent ? rupees(Math.round(session.summary.itemsTotal * percent / 100)) : "";
    const row = extraRow(dataset.quick, amount);
    $("edit-extras").append(row);
    if (percent) saveExtras();
    else row.querySelector("[name=label]").focus();
  }
});

// Item and charge edits save when a field is changed.
$("editor").addEventListener("change", (event) => {
  const input = event.target;
  const itemRowEl = input.closest("[data-item]");
  if (itemRowEl) {
    const value = input.name === "price" ? cleanAmount(input.value) : input.value;
    call(`/items/${itemRowEl.dataset.item}`, { method: "PATCH", body: { [input.name]: value } })
      .catch(() => syncEditor());
  } else if (input.closest("#edit-extras")) {
    saveExtras();
  }
});

$("editor").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  try {
    await call("/items", { method: "POST", body: { ...data, price: cleanAmount(data.price) } });
    form.reset();
    form.name.focus();
  } catch { /* toast already shown */ }
});

// Remember which breakdowns are expanded across live re-renders.
document.addEventListener("toggle", (event) => {
  const id = event.target.dataset?.person;
  if (!id) return;
  if (event.target.open) openBreakdowns.add(id);
  else openBreakdowns.delete(id);
}, true);

$("edit-toggle").addEventListener("click", () => setEditing(!editing));

$("delete-bill").addEventListener("click", async () => {
  if (!confirm(`Delete "${session.title}" for everyone? This can't be undone.`)) return;
  try {
    await call("", { method: "DELETE" });
    forgetMembership(code);
    location.href = "/";
  } catch { /* toast already shown */ }
});

$("final-toggle").addEventListener("click", async () => {
  const finalise = isOpen();
  if (finalise && session.summary.unclaimedItems.length
      && !confirm("Some items haven't been claimed yet. Finalise anyway?")) return;
  await call("", { method: "PATCH", body: { final: finalise } }).catch(() => {});
});

$("add-person-toggle").addEventListener("click", () => {
  const form = $("add-person-form");
  form.hidden = !form.hidden;
  $("add-person-hint").hidden = form.hidden;
  if (!form.hidden) form.name.focus();
});

$("add-person-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    const { personId } = await call("/people", { method: "POST", body: { name: form.name.value } });
    form.reset();
    form.hidden = true;
    $("add-person-hint").hidden = true;
    pickingFor = personId;
    toast("Added. You're now ticking their dishes.");
  } catch { /* toast already shown */ }
});

$("join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  button.disabled = true;
  try {
    const result = await api(`/api/sessions/${code}/join`, { method: "POST", body: { name: event.target.name.value } });
    saveMembership(code, {
      personId: result.personId,
      ...(result.token && { token: result.token }),
      ...(user && { uid: user.uid }),
    });
    pickingFor = result.personId;
    if (session) render();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

// ------------------------------------------------------------ scanning

/** Shrink phone photos before upload: faster, and under Azure's 4 MB free-tier limit. */
async function shrinkImage(file, maxSide = 2200) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  } catch {
    return file; // e.g. a format the browser can't decode - let the server try
  }
}

$("scan-input").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (session.items.length
      && !confirm("Replace the current items with this bill? Everyone's ticks will be cleared.")) return;

  busy("Reading your bill with Azure AI…");
  try {
    const form = new FormData();
    form.append("image", await shrinkImage(file), "bill.jpg");
    const result = await call("/scan", { method: "POST", form });
    toast(`Found ${plural(result.items, "item")}${result.extras ? ` and ${plural(result.extras, "charge")}` : ""}. Check they look right.`);
    setEditing(true);
  } catch { /* toast already shown */ } finally {
    busy(null);
  }
});

// ------------------------------------------------------------ sharing

const shareUrl = `${location.origin}/s/${code}`;
let qrDrawn = false;

$("share-button").addEventListener("click", () => {
  if (!qrDrawn && window.QRCode) {
    new window.QRCode($("qr"), { text: shareUrl, width: 200, height: 200, correctLevel: window.QRCode.CorrectLevel.M });
    qrDrawn = true;
  }
  $("native-share").hidden = !navigator.share;
  $("share-dialog").showModal();
});

$("copy-link").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(shareUrl);
    toast("Link copied");
  } catch {
    toast(shareUrl);
  }
});

$("native-share").addEventListener("click", () => {
  navigator.share({ title: session?.title || "Bill-e", text: `Join our bill on Bill-e (code ${code})`, url: shareUrl })
    .catch(() => {});
});
