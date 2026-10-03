"""Bill splitting maths.

All amounts are integer paise (₹1 = 100 paise) so everyone's shares always
add up to exactly the bill total - no floating point drift, no lost paisa.
"""

# Bucket for items nobody has claimed yet, so totals still reconcile mid-session.
UNCLAIMED = "__unclaimed__"


def distribute(amount, weights):
    """Split `amount` paise across the keys of `weights` in proportion to each weight.

    Uses the largest-remainder method so the parts sum to exactly `amount`.
    Leftover paise go to the largest remainders; ties go to earlier keys.
    Works for negative amounts (e.g. a discount) too.
    """
    total_weight = sum(weights.values())
    if total_weight <= 0 or amount == 0:
        return {key: 0 for key in weights}

    sign = -1 if amount < 0 else 1
    amount = abs(amount)
    shares = {}
    remainders = []
    for index, (key, weight) in enumerate(weights.items()):
        quotient, remainder = divmod(amount * weight, total_weight)
        shares[key] = quotient
        remainders.append((-remainder, index, key))

    leftover = amount - sum(shares.values())
    for _, _, key in sorted(remainders)[:leftover]:
        shares[key] += 1
    return {key: sign * share for key, share in shares.items()}


def compute_summary(people, items, extras, claims):
    """Work out exactly what each person owes.

    people: [{"id", "name", ...}]
    items:  [{"id", "name", "qty", "price"}]      price = line total in paise
    extras: [{"id", "label", "amount"}]           tax/service/tip (+) or discount (-)
    claims: {item_id: {person_id: units}}         units = how many / what share

    Each item is split between the people who claimed it, weighted by units.
    Each extra (tax, service charge...) is split equally between everyone who
    ate something.
    """
    order = [person["id"] for person in people] + [UNCLAIMED]
    subtotals = dict.fromkeys(order, 0)
    lines = {key: [] for key in order}
    unclaimed_items = []

    for item in items:
        item_claims = claims.get(item["id"], {})
        weights = {
            pid: item_claims[pid]
            for pid in order
            if pid != UNCLAIMED and item_claims.get(pid, 0) > 0
        }
        if not weights:
            unclaimed_items.append(item["id"])
            subtotals[UNCLAIMED] += item["price"]
            continue

        for pid, share in distribute(item["price"], weights).items():
            subtotals[pid] += share
            lines[pid].append({
                "itemId": item["id"],
                "name": item["name"],
                "units": weights[pid],
                "sharedWith": len(weights) - 1,
                "share": share,
            })

    items_total = sum(item["price"] for item in items)
    eaters = {pid: 1 for pid in order if pid != UNCLAIMED and subtotals[pid] > 0}
    charge_weights = eaters or {UNCLAIMED: 1}  # nobody has ticked anything yet

    extra_lines = {key: [] for key in order}
    for extra in extras:
        parts = dict.fromkeys(order, 0)
        parts.update(distribute(extra["amount"], charge_weights))
        for key, share in parts.items():
            extra_lines[key].append({"label": extra["label"], "share": share})

    def totals_for(key):
        extras_share = sum(line["share"] for line in extra_lines[key])
        return subtotals[key], extras_share, subtotals[key] + extras_share

    summary_people = []
    for person in people:
        pid = person["id"]
        subtotal, extras_share, total = totals_for(pid)
        summary_people.append({
            "personId": pid,
            "lines": lines[pid],
            "extras": extra_lines[pid],
            "subtotal": subtotal,
            "extrasTotal": extras_share,
            "total": total,
        })

    extras_total = sum(extra["amount"] for extra in extras)
    return {
        "people": summary_people,
        "itemsTotal": items_total,
        "extrasTotal": extras_total,
        "billTotal": items_total + extras_total,
        "unclaimedItems": unclaimed_items,
        "unclaimedTotal": totals_for(UNCLAIMED)[2],
    }
