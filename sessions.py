"""Bill sessions stored in Firestore.

Each session is one document, sessions/{code}, which browsers listen to for
live updates. Only this server writes to it (see firestore.rules); every change
runs in a transaction and recomputes the split, so all phones always see the
same, consistent numbers.

Two ways to prove who you are in a bill:
  * guests get a random token when they join; only its SHA-256 hash is stored,
    in sessions/{code}/private/auth, which browsers cannot read
  * signed-in users (Firebase Authentication) are matched by their account uid,
    so they are recognised on any device without a token

users/{uid}/bills/{code} indexes the bills each account is part of.
"""
import copy
import hashlib
import random
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

from firebase_admin import firestore
from google.api_core.exceptions import Aborted, AlreadyExists

from splitter import compute_summary

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O or 1/I confusion
CODE_LENGTH = 6
SESSION_LIFETIME = timedelta(days=7)
MAX_PEOPLE = 30
MAX_ITEMS = 150
MAX_EXTRAS = 10
MAX_SCANS = 5
MAX_UNITS = 99
MAX_TX_ATTEMPTS = 6


@dataclass(frozen=True)
class Caller:
    """Who is making a request: a person in the bill plus their guest token and/or account uid."""
    person_id: str = ""
    token: str = ""
    uid: str | None = None


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def _db():
    return firestore.client()


def _refs(code):
    session_ref = _db().collection("sessions").document(code.upper())
    return session_ref, session_ref.collection("private").document("auth")


def _hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def _new_id(prefix):
    return f"{prefix}{secrets.token_hex(4)}"


def _clean_text(value, field, max_length=60):
    text = " ".join(str(value or "").split())
    if not text:
        raise ApiError(f"{field} can't be empty")
    return text[:max_length]


def to_paise(value, field="Price", allow_negative=False):
    try:
        paise = int((Decimal(str(value)) * 100).quantize(Decimal("1")))
    except (InvalidOperation, ValueError):
        raise ApiError(f"{field} must be a number")
    if paise < 0 and not allow_negative:
        raise ApiError(f"{field} can't be negative")
    if abs(paise) > 100_000_00 * 100:
        raise ApiError(f"{field} is too large")
    return paise


def _to_units(value, field="Quantity"):
    try:
        units = int(value)
    except (TypeError, ValueError):
        raise ApiError(f"{field} must be a whole number")
    if not 0 <= units <= MAX_UNITS:
        raise ApiError(f"{field} must be between 0 and {MAX_UNITS}")
    return units


def _person(name, *, is_host=False, has_device=True, added_by=None, uid=None):
    return {
        "id": _new_id("p_"),
        "name": _clean_text(name, "Name", 30),
        "isHost": is_host,
        "hasDevice": has_device,
        "addedBy": added_by,
        "uid": uid,
    }


def _find(collection, item_id, what):
    for entry in collection:
        if entry["id"] == item_id:
            return entry
    raise ApiError(f"{what} not found", 404)


def _recompute(session):
    session["summary"] = compute_summary(
        session["people"], session["items"], session["extras"], session["claims"]
    )


def client_view(session):
    """The bill as browsers see it in Firestore (minus server-only timestamps)."""
    return {k: v for k, v in session.items() if k not in ("createdAt", "expiresAt", "updatedAt")}


# ---------------------------------------------------------------- creating


def create_session(host_name, title, uid=None):
    host = _person(host_name, is_host=True, uid=uid)
    token = secrets.token_urlsafe(24)
    now = datetime.now(timezone.utc)
    session = {
        "title": _clean_text(title or f"{host['name']}'s bill", "Title"),
        "status": "open",
        "hostId": host["id"],
        "people": [host],
        "items": [],
        "extras": [],
        "claims": {},
        "scan": None,
        "version": 1,
        "scanCount": 0,
        "createdAt": now,
        "expiresAt": now + SESSION_LIFETIME,
        "updatedAt": firestore.SERVER_TIMESTAMP,
    }
    _recompute(session)

    for _ in range(10):
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
        session_ref, auth_ref = _refs(code)
        batch = _db().batch()
        batch.create(session_ref, {**session, "code": code})
        batch.set(auth_ref, {"tokens": {host["id"]: _hash(token)}})
        try:
            batch.commit()
        except AlreadyExists:
            continue
        _remember_bill(uid, code, host["id"])
        return {"code": code, "personId": host["id"], "token": token}
    raise ApiError("Couldn't create a session, try again", 500)


# ---------------------------------------------------------------- changing


def _authenticate(session, auth, caller):
    """Return the person `caller` is acting as, or raise if they can't prove it."""
    person = next((p for p in session["people"] if p["id"] == caller.person_id), None)
    if person is not None:
        stored = auth["tokens"].get(person["id"])
        if caller.token and stored and secrets.compare_digest(stored, _hash(caller.token)):
            return person
        if caller.uid and person.get("uid") == caller.uid:
            return person
    raise ApiError("You're not part of this bill. Join it first.", 401)


def _mutate(code, change, *, caller=None, host_only=False, allow_final=False, write=True):
    """Run `change(session, actor, auth)` inside a transaction and save the result.

    `actor` is the authenticated person making the change (None when `caller` is
    None, i.e. joining). `change` edits `session`/`auth` in place and may return
    a dict to send back to the browser. The saved bill is returned too (as
    "session"), so the phone can show the change without waiting for Firestore's
    live update.
    """
    session_ref, auth_ref = _refs(code)
    db = _db()

    @firestore.transactional
    def run(transaction):
        snapshot = session_ref.get(transaction=transaction)
        if not snapshot.exists:
            raise ApiError("This bill doesn't exist or has expired", 404)
        session = snapshot.to_dict()
        auth = auth_ref.get(transaction=transaction).to_dict() or {"tokens": {}}

        actor = _authenticate(session, auth, caller) if caller else None
        if host_only and not (actor and actor["isHost"]):
            raise ApiError("Only the host can do that", 403)
        if session["status"] == "final" and not allow_final:
            raise ApiError("This bill has been finalised. Ask the host to reopen it.", 409)

        auth_before = copy.deepcopy(auth)
        result = change(session, actor, auth)
        if not write:
            return result
        _recompute(session)
        # A counter lets browsers ignore a live update older than a reply they already have.
        session["version"] = session.get("version", 0) + 1
        session["updatedAt"] = firestore.SERVER_TIMESTAMP
        transaction.set(session_ref, session)
        if auth != auth_before:
            transaction.set(auth_ref, auth)
        return {**(result or {}), "session": client_view(session)}

    # When several phones tick at the same moment, Firestore aborts all but one
    # transaction. The library retries commit clashes a few times (then raises
    # ValueError) but not read clashes (Aborted), so retry both here with a
    # random back-off that spreads the phones out.
    for attempt in range(MAX_TX_ATTEMPTS):
        try:
            return run(db.transaction())
        except Aborted:
            pass
        except ValueError as exc:
            if "Failed to commit transaction" not in str(exc):
                raise
        time.sleep(random.uniform(0.05, 0.15) * 2 ** attempt)
    raise ApiError("Lots of people are changing the bill at once. Please try again.", 409)


def join(code, name, uid=None):
    token = secrets.token_urlsafe(24)

    def change(session, _actor, auth):
        if uid:
            existing = next((p for p in session["people"] if p.get("uid") == uid), None)
            if existing:
                # Already in this bill on another device - no new person needed.
                return {"code": session["code"], "personId": existing["id"]}
        if len(session["people"]) >= MAX_PEOPLE:
            raise ApiError("This bill already has the maximum number of people")
        person = _person(name, uid=uid)
        session["people"].append(person)
        auth["tokens"][person["id"]] = _hash(token)
        return {"code": session["code"], "personId": person["id"], "token": token}

    # Joining a finalised bill is fine - you just can't change anything.
    result = _mutate(code, change, allow_final=True)
    _remember_bill(uid, result["code"], result["personId"])
    return result


def link_account(code, caller):
    """Attach a signed-in account to the guest person this browser joined as."""
    if not caller.uid:
        raise ApiError("Sign in first", 401)

    def change(session, actor, _auth):
        if actor.get("uid") == caller.uid:
            return {"linked": False}
        if actor.get("uid"):
            raise ApiError("This person is linked to a different account", 409)
        if any(p.get("uid") == caller.uid for p in session["people"]):
            raise ApiError("Your account is already in this bill as someone else", 409)
        actor["uid"] = caller.uid
        return {"linked": True}

    # Only the guest token proves who they were, so don't accept the uid on its own here.
    result = _mutate(code, change, caller=Caller(caller.person_id, caller.token), allow_final=True)
    _remember_bill(caller.uid, code.upper(), caller.person_id)
    return result


def add_person(code, caller, name):
    """Add someone who isn't using the app; anyone in the session can pick for them."""
    def change(session, actor, _auth):
        if len(session["people"]) >= MAX_PEOPLE:
            raise ApiError("This bill already has the maximum number of people")
        person = _person(name, has_device=False, added_by=actor["id"])
        session["people"].append(person)
        return {"personId": person["id"]}

    return _mutate(code, change, caller=caller)


def remove_person(code, caller, target_id):
    def change(session, actor, auth):
        target = _find(session["people"], target_id, "Person")
        if target["isHost"]:
            raise ApiError("The host can't be removed")
        if not (actor["isHost"] or target["addedBy"] == actor["id"]):
            raise ApiError("Only the host or whoever added them can remove this person", 403)
        session["people"].remove(target)
        auth["tokens"].pop(target_id, None)
        for item_claims in session["claims"].values():
            item_claims.pop(target_id, None)

    return _mutate(code, change, caller=caller)


def set_claim(code, caller, item_id, target_id, units):
    """Set how many units of an item a person had (0 = didn't have it)."""
    units = _to_units(units)

    def change(session, actor, _auth):
        _find(session["items"], item_id, "Item")
        target = _find(session["people"], target_id, "Person")
        can_pick = target["id"] == actor["id"] or actor["isHost"] or not target["hasDevice"]
        if not can_pick:
            raise ApiError(f"{target['name']} picks their own items", 403)
        item_claims = session["claims"].setdefault(item_id, {})
        if units:
            item_claims[target_id] = units
        else:
            item_claims.pop(target_id, None)

    return _mutate(code, change, caller=caller)


def add_item(code, caller, name, qty, price):
    item = {
        "id": _new_id("i_"),
        "name": _clean_text(name, "Item name"),
        "qty": max(1, _to_units(qty)),
        "price": to_paise(price),
    }

    def change(session, _actor, _auth):
        if len(session["items"]) >= MAX_ITEMS:
            raise ApiError("Too many items on this bill")
        session["items"].append(item)
        return {"itemId": item["id"]}

    return _mutate(code, change, caller=caller, host_only=True)


def update_item(code, caller, item_id, fields):
    def change(session, _actor, _auth):
        item = _find(session["items"], item_id, "Item")
        if "name" in fields:
            item["name"] = _clean_text(fields["name"], "Item name")
        if "qty" in fields:
            item["qty"] = max(1, _to_units(fields["qty"]))
        if "price" in fields:
            item["price"] = to_paise(fields["price"])

    return _mutate(code, change, caller=caller, host_only=True)


def delete_item(code, caller, item_id):
    def change(session, _actor, _auth):
        session["items"].remove(_find(session["items"], item_id, "Item"))
        session["claims"].pop(item_id, None)

    return _mutate(code, change, caller=caller, host_only=True)


def set_extras(code, caller, extras):
    if not isinstance(extras, list) or len(extras) > MAX_EXTRAS:
        raise ApiError(f"Send up to {MAX_EXTRAS} charges")
    cleaned = [
        {
            "id": _new_id("x_"),
            "label": _clean_text(extra.get("label"), "Charge name", 40),
            "amount": to_paise(extra.get("amount"), "Charge amount", allow_negative=True),
            # "scan" = printed on the bill; "manual" = added on top (e.g. an extra tip)
            "source": "scan" if extra.get("source") == "scan" else "manual",
        }
        for extra in extras
    ]

    def change(session, _actor, _auth):
        session["extras"] = cleaned

    return _mutate(code, change, caller=caller, host_only=True)


def set_title(code, caller, title):
    title = _clean_text(title, "Title")

    def change(session, _actor, _auth):
        session["title"] = title

    return _mutate(code, change, caller=caller, host_only=True)


def set_final(code, caller, final):
    def change(session, _actor, _auth):
        session["status"] = "final" if final else "open"

    return _mutate(code, change, caller=caller, host_only=True, allow_final=True)


# ---------------------------------------------------------------- scanning


def check_can_scan(code, caller):
    """Cheap checks before spending an Azure call (free tier = 500 pages/month)."""
    def change(session, _actor, _auth):
        if session["scanCount"] >= MAX_SCANS:
            raise ApiError(f"This bill has been scanned {MAX_SCANS} times already. Add items by hand.", 429)

    _mutate(code, change, caller=caller, host_only=True, write=False)


def apply_scan(code, caller, scanned):
    """Replace the bill's items and charges with what the scanner found."""
    items = [
        {
            "id": _new_id("i_"),
            "name": _clean_text(line["name"], "Item name"),
            "qty": min(MAX_UNITS, max(1, int(line["qty"]))),
            "price": abs(to_paise(line["price"], allow_negative=True)),
        }
        for line in scanned["items"][:MAX_ITEMS]
    ]
    extras = [
        {
            "id": _new_id("x_"),
            "label": _clean_text(extra["label"], "Charge name", 40),
            "amount": to_paise(extra["amount"], allow_negative=True),
            "source": "scan",
        }
        for extra in scanned["extras"][:MAX_EXTRAS]
    ]
    total = scanned.get("total")

    def change(session, _actor, _auth):
        session["items"] = items
        session["extras"] = extras
        session["claims"] = {}
        session["scanCount"] += 1
        session["scan"] = {
            "merchant": scanned.get("merchant"),
            "total": to_paise(total, allow_negative=True) if total is not None else None,
        }
        if scanned.get("merchant") and session["title"].endswith("'s bill"):
            session["title"] = _clean_text(scanned["merchant"], "Title")
        return {"items": len(items), "extras": len(extras)}

    return _mutate(code, change, caller=caller, host_only=True)


# ---------------------------------------------------------------- deleting


def delete_session(code, caller):
    """Host only: delete the bill for everyone."""
    session_ref, auth_ref = _refs(code)
    db = _db()

    @firestore.transactional
    def run(transaction):
        snapshot = session_ref.get(transaction=transaction)
        if not snapshot.exists:
            raise ApiError("This bill doesn't exist or has already been deleted", 404)
        session = snapshot.to_dict()
        auth = auth_ref.get(transaction=transaction).to_dict() or {"tokens": {}}
        actor = _authenticate(session, auth, caller)
        if not actor["isHost"]:
            raise ApiError("Only the host can delete this bill", 403)
        transaction.delete(auth_ref)
        transaction.delete(session_ref)
        return [p["uid"] for p in session["people"] if p.get("uid")]

    for uid in run(db.transaction()):
        forget_bill(uid, code.upper())


def forget_bill(uid, code):
    """Remove a bill from one account's "My bills" list (the bill itself stays)."""
    _db().collection("users").document(uid).collection("bills").document(code.upper()).delete()


# ---------------------------------------------------------------- accounts


def _remember_bill(uid, code, person_id):
    """Add a bill to an account's "My bills" list."""
    if not uid:
        return
    _db().collection("users").document(uid).collection("bills").document(code).set(
        {"code": code, "personId": person_id, "at": firestore.SERVER_TIMESTAMP}
    )


def save_profile(uid, name, email):
    _db().collection("users").document(uid).set(
        {"name": name, "email": email, "lastSeen": firestore.SERVER_TIMESTAMP}, merge=True
    )


def my_bills(uid, limit=30):
    """The bills an account is part of, newest first, with what they owe in each."""
    db = _db()
    entries = [
        doc.to_dict()
        for doc in db.collection("users").document(uid).collection("bills")
        .order_by("at", direction=firestore.Query.DESCENDING).limit(limit).stream()
    ]
    refs = [db.collection("sessions").document(entry["code"]) for entry in entries]
    snapshots = {snap.id: snap for snap in db.get_all(refs)} if refs else {}

    bills = []
    for entry in entries:
        snapshot = snapshots.get(entry["code"])
        if snapshot is None or not snapshot.exists:
            continue
        session = snapshot.to_dict()
        person = next((p for p in session["people"] if p.get("uid") == uid), None)
        if person is None:
            continue  # removed from the bill since
        mine = next(p for p in session["summary"]["people"] if p["personId"] == person["id"])
        bills.append({
            "code": session["code"],
            "personId": person["id"],
            "title": session["title"],
            "status": session["status"],
            "isHost": person["isHost"],
            "people": len(session["people"]),
            "billTotal": session["summary"]["billTotal"],
            "myTotal": mine["total"],
            "createdAt": session["createdAt"].isoformat(),
        })
    return bills
