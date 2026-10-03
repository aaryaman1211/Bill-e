"""Bill-e: split a restaurant bill by who ate what.

Flask serves the pages and a small JSON API. Data lives in Firebase Firestore,
accounts in Firebase Authentication, and bill photos are read by Azure AI
Document Intelligence (see ocr.py).
"""
import logging
import os
from pathlib import Path

import firebase_admin
from firebase_admin import auth as firebase_auth
from dotenv import load_dotenv
from flask import Flask, g, jsonify, render_template, request, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")
# The service account path in .env is relative to this folder.
credentials_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
if credentials_path and not os.path.isabs(credentials_path):
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(BASE_DIR / credentials_path)

import ocr  # noqa: E402
import sessions  # noqa: E402
from sessions import ApiError, Caller  # noqa: E402

firebase_admin.initialize_app()

MAX_IMAGE_BYTES = 4 * 1024 * 1024  # Azure free tier limit per image

# Pages are served through Firebase Hosting (bill-e.web.app), but the browser
# sends API calls straight to Cloud Run: going via Hosting added ~300 ms to every
# tap. These are the sites allowed to call the API from another address.
API_ORIGINS = {
    "https://bill-e.web.app",
    "https://bill-e.firebaseapp.com",
    "http://localhost:8080",
}

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_IMAGE_BYTES + 64 * 1024
log = logging.getLogger("bill-e")


@app.before_request
def answer_preflight():
    # Browsers ask permission (an OPTIONS "preflight") before a cross-site API call.
    if request.method == "OPTIONS" and request.path.startswith("/api/"):
        return app.make_default_options_response()


@app.after_request
def add_headers(response):
    origin = request.headers.get("Origin")
    if request.path.startswith("/api/") and origin in API_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE"
        response.headers["Access-Control-Allow-Headers"] = (
            "Content-Type, Authorization, X-Person-Id, X-Person-Token")
        response.headers["Access-Control-Max-Age"] = "86400"
        response.headers["Vary"] = "Origin"
    elif request.path.startswith("/static/"):
        # Let Firebase Hosting's CDN keep CSS/JS/icons for a few minutes.
        response.headers["Cache-Control"] = "public, max-age=300, s-maxage=300"
    return response


# ---------------------------------------------------------------- pages


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/login")
def login_page():
    return render_template("login.html")


@app.get("/s/<code>")
def session_page(code):
    return render_template("session.html", code=code.upper())


@app.get("/favicon.ico")
def favicon():
    return send_from_directory(app.static_folder, "icons/favicon-64.png", mimetype="image/png")


@app.get("/health")
def healthz():
    return "ok"


# ---------------------------------------------------------------- API helpers


def body():
    return request.get_json(silent=True) or {}


def signed_in_user():
    """The Firebase Authentication user behind this request, or None for guests.

    The browser sends its Firebase ID token; verifying it proves the account
    without the server ever seeing a password.
    """
    if "user" in g:
        return g.user
    header = request.headers.get("Authorization", "")
    g.user = None
    if header.startswith("Bearer "):
        try:
            g.user = firebase_auth.verify_id_token(header.removeprefix("Bearer "))
        except (ValueError, firebase_auth.InvalidIdTokenError, firebase_auth.CertificateFetchError):
            raise ApiError("Your sign-in has expired. Please sign in again.", 401)
    return g.user


def require_user():
    user = signed_in_user()
    if user is None:
        raise ApiError("Please sign in first", 401)
    return user


def profile_name(user):
    return user.get("name") or (user.get("email") or "").split("@")[0] or None


def caller():
    """Who is calling: the bill person they act as, their guest token, and account if signed in."""
    user = signed_in_user()
    return Caller(
        person_id=request.headers.get("X-Person-Id", ""),
        token=request.headers.get("X-Person-Token", ""),
        uid=user["uid"] if user else None,
    )


@app.errorhandler(ApiError)
def handle_api_error(error):
    return jsonify(error=error.message), error.status


@app.errorhandler(ocr.OCRError)
def handle_ocr_error(error):
    return jsonify(error=str(error)), 502


@app.errorhandler(413)
def handle_too_large(_error):
    return jsonify(error="That photo is too big. Try a smaller one."), 413


# ---------------------------------------------------------------- API


@app.delete("/api/me/bills/<code>")
def forget_bill(code):
    """Remove a bill from the signed-in user's list (it stays for everyone else)."""
    sessions.forget_bill(require_user()["uid"], code)
    return jsonify(ok=True)


@app.get("/api/me")
def me():
    """Record the signed-in user's profile and list their bills."""
    user = require_user()
    sessions.save_profile(user["uid"], profile_name(user), user.get("email"))
    return jsonify(bills=sessions.my_bills(user["uid"]))


@app.post("/api/sessions")
def create_session():
    data = body()
    user = signed_in_user()
    name = data.get("name") or (user and profile_name(user))
    result = sessions.create_session(name, data.get("title"), uid=user and user["uid"])
    return jsonify(result), 201


@app.post("/api/sessions/<code>/join")
def join_session(code):
    user = signed_in_user()
    name = body().get("name") or (user and profile_name(user))
    return jsonify(sessions.join(code, name, uid=user and user["uid"])), 201


@app.post("/api/sessions/<code>/link")
def link_account(code):
    return jsonify(sessions.link_account(code, caller()))


@app.post("/api/sessions/<code>/people")
def add_person(code):
    return jsonify(sessions.add_person(code, caller(), body().get("name"))), 201


@app.delete("/api/sessions/<code>/people/<target_id>")
def remove_person(code, target_id):
    return jsonify(sessions.remove_person(code, caller(), target_id))


@app.put("/api/sessions/<code>/claims")
def set_claim(code):
    data = body()
    return jsonify(sessions.set_claim(
        code, caller(), data.get("itemId"), data.get("personId"), data.get("units", 0)))


@app.post("/api/sessions/<code>/items")
def add_item(code):
    data = body()
    result = sessions.add_item(code, caller(), data.get("name"), data.get("qty", 1), data.get("price"))
    return jsonify(result), 201


@app.patch("/api/sessions/<code>/items/<item_id>")
def update_item(code, item_id):
    fields = {key: value for key, value in body().items() if key in ("name", "qty", "price")}
    return jsonify(sessions.update_item(code, caller(), item_id, fields))


@app.delete("/api/sessions/<code>/items/<item_id>")
def delete_item(code, item_id):
    return jsonify(sessions.delete_item(code, caller(), item_id))


@app.put("/api/sessions/<code>/extras")
def set_extras(code):
    return jsonify(sessions.set_extras(code, caller(), body().get("extras")))


@app.patch("/api/sessions/<code>")
def update_session(code):
    data = body()
    result = {}
    if "title" in data:
        result = sessions.set_title(code, caller(), data["title"])
    if "final" in data:
        result = sessions.set_final(code, caller(), bool(data["final"]))
    return jsonify(result)


@app.delete("/api/sessions/<code>")
def delete_session(code):
    sessions.delete_session(code, caller())
    return jsonify(ok=True)


@app.post("/api/sessions/<code>/scan")
def scan_bill(code):
    image = request.files.get("image")
    if image is None or not (image.mimetype or "").startswith("image/"):
        raise ApiError("Upload a photo of the bill")
    image_bytes = image.read()
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise ApiError("That photo is too big. Try a smaller one.", 413)

    sessions.check_can_scan(code, caller())
    scanned = ocr.read_receipt(image_bytes)
    log.info("Scanned bill %s: %d items, %d charges", code, len(scanned["items"]), len(scanned["extras"]))
    if not scanned["items"]:
        raise ApiError("Couldn't find any items on that bill. Try a clearer photo or add items by hand.", 422)
    return jsonify(sessions.apply_scan(code, caller(), scanned))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)), debug=True)
