# Bill-e

Split a restaurant bill by what each person actually ate. Snap the bill, everyone
ticks their dishes on their own phone (or someone ticks for them), and Bill-e
works out exactly what each person owes, with GST and service charge split in
proportion to what they ordered.

## Cloud services

Live at **https://bill-e.web.app**

| Service | Role |
|---|---|
| Google Cloud Run | Hosts the Flask app (pages + JSON API) |
| Firebase Hosting | Serves the app at bill-e.web.app, forwarding every request to Cloud Run |
| Firebase Firestore | Stores bills; pushes live updates to every phone |
| Firebase Authentication | Optional accounts (email/password, Google) so bills follow you across devices |
| Azure AI Document Intelligence | Reads items and prices from a photo of the bill (`prebuilt-receipt` model) |
| Secret Manager + IAM | Holds the Azure key; Cloud Run's service account may only use Firestore and that secret |

## Project layout

```
app.py          Flask routes (pages + API)
sessions.py     Bill sessions in Firestore: auth, permissions, transactions
splitter.py     The split maths (integer paise, always adds up exactly)
ocr.py          Azure bill reading - the only Azure-specific file
templates/      HTML pages
static/         CSS + JavaScript (Firestore live listener, UI)
firestore.rules Browsers may only read bills; all writes go through the server
tests/          Unit tests for the split maths
```

## Run locally

Needs `.env` (Azure endpoint + key, path to the Firebase service account JSON).

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
.venv/bin/pytest
.venv/bin/python app.py      # http://localhost:8080
```
