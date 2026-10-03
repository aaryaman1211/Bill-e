import random

from splitter import compute_summary, distribute

A, B, C = ({"id": pid, "name": pid} for pid in ("A", "B", "C"))


def totals(summary):
    return {p["personId"]: p["total"] for p in summary["people"]}


def test_distribute_always_sums_exactly():
    assert distribute(10000, {"A": 1, "B": 1, "C": 1}) == {"A": 3334, "B": 3333, "C": 3333}
    assert distribute(-500, {"A": 1, "B": 1}) == {"A": -250, "B": -250}
    assert distribute(100, {"A": 0}) == {"A": 0}


def test_units_weight_the_split():
    # 3 naan for ₹150: A had 2, B had 1.
    items = [{"id": "naan", "name": "Naan", "qty": 3, "price": 15000}]
    summary = compute_summary([A, B], items, [], {"naan": {"A": 2, "B": 1}})
    assert totals(summary) == {"A": 10000, "B": 5000}


def test_unclaimed_items_and_their_tax_are_tracked():
    items = [
        {"id": "dal", "name": "Dal", "qty": 1, "price": 20000},
        {"id": "rice", "name": "Rice", "qty": 1, "price": 20000},
    ]
    extras = [{"id": "gst", "label": "GST", "amount": 2000}]
    summary = compute_summary([A], items, extras, {"dal": {"A": 1}})

    # Charges are shared by the people who ate, so A covers the GST for now.
    assert totals(summary) == {"A": 22000}
    assert summary["unclaimedItems"] == ["rice"]
    assert summary["unclaimedTotal"] == 20000


def test_discount_reduces_shares():
    items = [{"id": "thali", "name": "Thali", "qty": 1, "price": 30000}]
    extras = [{"id": "d", "label": "Discount", "amount": -3000}]
    summary = compute_summary([A, B], items, extras, {"thali": {"A": 1, "B": 1}})
    assert totals(summary) == {"A": 13500, "B": 13500}


def test_removed_person_claims_are_ignored():
    items = [{"id": "tea", "name": "Tea", "qty": 1, "price": 3000}]
    summary = compute_summary([A], items, [], {"tea": {"A": 1, "ghost": 1}})
    assert totals(summary) == {"A": 3000}


def test_everyone_plus_unclaimed_always_equals_bill_total():
    rng = random.Random(7)
    for _ in range(300):
        people = [{"id": f"p{i}", "name": f"p{i}"} for i in range(rng.randint(1, 8))]
        items = [
            {"id": f"i{i}", "name": f"i{i}", "qty": 1, "price": rng.randint(0, 99999)}
            for i in range(rng.randint(0, 12))
        ]
        extras = [
            {"id": f"x{i}", "label": "x", "amount": rng.randint(-5000, 20000)}
            for i in range(rng.randint(0, 3))
        ]
        claims = {
            item["id"]: {
                p["id"]: rng.randint(1, 3) for p in people if rng.random() < 0.4
            }
            for item in items
        }
        summary = compute_summary(people, items, extras, claims)
        assert sum(totals(summary).values()) + summary["unclaimedTotal"] == summary["billTotal"]


def test_charges_split_equally():
    # Same dinner as above, but the ₹100 of charges is shared equally.
    items = [
        {"id": "pizza", "name": "Pizza", "qty": 1, "price": 60000},
        {"id": "coke", "name": "Coke", "qty": 1, "price": 10000},
        {"id": "pasta", "name": "Pasta", "qty": 1, "price": 30000},
    ]
    extras = [{"id": "x", "label": "Tax + service", "amount": 10000}]
    claims = {"pizza": {"A": 1, "B": 1, "C": 1}, "coke": {"A": 1}, "pasta": {"C": 1}}

    summary = compute_summary([A, B, C], items, extras, claims)

    assert totals(summary) == {"A": 33334, "B": 23333, "C": 53333}


def test_even_split_skips_people_who_ate_nothing():
    items = [{"id": "chai", "name": "Chai", "qty": 1, "price": 4000}]
    extras = [{"id": "gst", "label": "GST", "amount": 200}]
    summary = compute_summary([A, B], items, extras, {"chai": {"A": 1}})
    assert totals(summary) == {"A": 4200, "B": 0}


def test_even_split_before_anyone_ticks_anything():
    items = [{"id": "chai", "name": "Chai", "qty": 1, "price": 4000}]
    extras = [{"id": "gst", "label": "GST", "amount": 200}]
    summary = compute_summary([A, B], items, extras, {})
    assert totals(summary) == {"A": 0, "B": 0}
    assert summary["unclaimedTotal"] == 4200
