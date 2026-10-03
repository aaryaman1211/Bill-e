"""Reads a photo of a bill and returns its line items.

This is the only file that talks to Azure AI Document Intelligence. To switch
to a different OCR provider later, replace read_receipt() and keep the shape
of the dict it returns - nothing else in the app needs to change.
"""
import base64
import os
import re
import time

import requests

API_VERSION = "2024-11-30"
MODEL = "prebuilt-receipt"
TIMEOUT_SECONDS = 45

# Lines that are charges on the whole bill rather than food, e.g. "CGST @2.5%".
EXTRA_LINE = re.compile(
    r"\b(c?gst|sgst|igst|vat|tax|cess|service\s*(charge|chg)|s\.?\s?c\.?|discount|round\s*off|tip)\b",
    re.IGNORECASE,
)
TAX_LINE = re.compile(r"\b(c?gst|sgst|igst|vat|tax|cess)\b", re.IGNORECASE)
DISCOUNT_LINE = re.compile(r"\bdiscount\b", re.IGNORECASE)
SERVICE_LINE = re.compile(r"\bservice\s*(charge|chg)\b", re.IGNORECASE)


class OCRError(Exception):
    pass


def read_receipt(image_bytes):
    """Send a bill image to Azure and return what it found.

    Returns {"merchant": str|None, "total": float|None,
             "items":  [{"name": str, "qty": int, "price": float}],   # price = line total
             "extras": [{"label": str, "amount": float}]}             # tax, service, discount
    Amounts are in rupees.
    """
    endpoint = os.environ["AZURE_DOCINTEL_ENDPOINT"].rstrip("/")
    headers = {"Ocp-Apim-Subscription-Key": os.environ["AZURE_DOCINTEL_KEY"]}

    try:
        response = requests.post(
            f"{endpoint}/documentintelligence/documentModels/{MODEL}:analyze",
            params={"api-version": API_VERSION},
            headers=headers,
            json={"base64Source": base64.b64encode(image_bytes).decode()},
            timeout=30,
        )
    except requests.RequestException as exc:
        raise OCRError("Couldn't reach the bill scanner. Try again.") from exc
    if response.status_code == 429:
        raise OCRError("The bill scanner is busy. Wait a few seconds and try again.")
    if response.status_code != 202:
        raise OCRError(f"The bill scanner rejected the image ({response.status_code}).")

    # Azure works asynchronously: poll the operation until it finishes.
    operation_url = response.headers["Operation-Location"]
    deadline = time.monotonic() + TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        time.sleep(1)
        result = requests.get(operation_url, headers=headers, timeout=15).json()
        if result["status"] == "succeeded":
            return _parse(result["analyzeResult"])
        if result["status"] == "failed":
            raise OCRError("Couldn't read this bill. Try a clearer, straighter photo.")
    raise OCRError("Reading the bill took too long. Try again.")


def _amount(field):
    if not field:
        return None
    if "valueCurrency" in field:
        return field["valueCurrency"].get("amount")
    return field.get("valueNumber")


def _text(field):
    if not field:
        return None
    return (field.get("valueString") or field.get("content") or "").strip() or None


def _parse(result):
    documents = result.get("documents") or []
    if not documents:
        return {"merchant": None, "total": None, "items": [], "extras": []}
    fields = documents[0].get("fields", {})

    items, extras = [], []
    for entry in fields.get("Items", {}).get("valueArray", []):
        line = entry.get("valueObject", {})
        name = _text(line.get("Description")) or "Item"
        qty = line.get("Quantity", {}).get("valueNumber") or 1
        price = _amount(line.get("TotalPrice"))
        if price is None and _amount(line.get("Price")) is not None:
            price = _amount(line.get("Price")) * qty
        if price is None:
            continue

        # Indian bills often list GST / service charge as rows; treat them as bill charges.
        if EXTRA_LINE.search(name):
            amount = -abs(price) if DISCOUNT_LINE.search(name) else price
            extras.append({"label": name, "amount": amount})
        else:
            items.append({"name": name, "qty": max(1, round(qty)), "price": price})

    # Charges Azure reports as summary fields - only if we didn't already get them as rows.
    if not any(TAX_LINE.search(extra["label"]) for extra in extras):
        tax_rows = fields.get("TaxDetails", {}).get("valueArray", [])
        for row in tax_rows:
            detail = row.get("valueObject", {})
            amount = _amount(detail.get("Amount"))
            if amount:
                extras.append({"label": _text(detail.get("Description")) or "Tax", "amount": amount})
        if not tax_rows and _amount(fields.get("TotalTax")):
            extras.append({"label": "Tax", "amount": _amount(fields.get("TotalTax"))})

    # Azure files a service charge under "Tip"; name it after what the bill actually says.
    tip = _amount(fields.get("Tip"))
    if tip and not any(SERVICE_LINE.search(extra["label"]) or extra["label"].lower().startswith("tip")
                       for extra in extras):
        label = "Service charge" if SERVICE_LINE.search(result.get("content", "")) else "Tip"
        extras.append({"label": label, "amount": tip})

    return {
        "merchant": _text(fields.get("MerchantName")),
        "total": _amount(fields.get("Total")),
        "items": items,
        "extras": extras,
    }
