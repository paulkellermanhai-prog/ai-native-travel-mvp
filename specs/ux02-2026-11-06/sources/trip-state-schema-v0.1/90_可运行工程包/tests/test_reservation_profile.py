"""Read-only committed receipt profile; no order or payment lifecycle."""
import unittest
from copy import deepcopy
from tripstate.engine import Actor, Store
from tripstate.fixtures import NOW, initial_state, fact, skeleton, ingest_command, create_command, request, adopt
from tripstate.rules import index, validate_state, RuleError, assess

TOOL = Actor("tool", "receipt-provider")
USER = Actor("user", "traveler")


def receipt(oid="receipt-hotel", status="confirmed"):
    parameters = [dict(name=k, value=v) for k, v in dict(
        profile="reservation-v0.1", commitment_kind="lodging", confirmation_ref="TEST-BOOKING-1",
        city_id="luxor", check_in="2030-01-12", check_out="2030-01-14",
        commitment_state=status).items()]
    return fact(oid, subject_ids=["luxor"], query=dict(date="2030-01-12", parameters=parameters),
                valid_for=dict(start="2030-01-12", end="2030-01-14"),
                value=dict(kind="condition", value=status == "confirmed", description="仅合成住宿回执"))


class ReservationProfileTests(unittest.TestCase):
    def store_with_receipt(self):
        store = Store(initial_state(), clock=lambda: NOW)
        result = store.submit(request(store, ingest_command(receipt()), key="ingest-receipt"), TOOL)
        self.assertEqual(result["outcome"], "applied", result)
        return store

    def cairo_only(self, oid="cairo-only"):
        item = skeleton(oid)
        item["stops"] = [dict(entity_id="cairo", nights=4)]
        item["connections"] = []
        return item

    def test_receipt_profile_has_no_new_business_object_and_does_not_verify_calendar(self):
        store = self.store_with_receipt()
        objects = index(store.get_state())
        result = assess(objects["skeleton-a"], objects, NOW)
        self.assertIn("reservation_dates_not_checked:receipt-hotel", result["unknowns"])
        self.assertNotIn("reservation_city_conflict:receipt-hotel", result["violations"])
        self.assertNotIn("Booking", {o["type"] for o in objects.values()})

    def test_committed_city_blocks_conflicting_adoption_and_candidate_rejection(self):
        store = self.store_with_receipt()
        original = store.get_state()
        result = store.submit(request(store, dict(op="decide_candidate", id="candidate-luxor", value="reject"), key="reject-luxor"), USER)
        self.assertEqual(result["outcome"], "rejected")
        self.assertEqual(store.get_state(), original)
        result = store.submit(request(store, create_command(self.cairo_only()), key="create-cairo"), USER)
        self.assertEqual(result["outcome"], "applied", result)
        state = store.get_state()
        result = store.submit(request(store, adopt("cairo-only"), key="adopt-cairo"), USER)
        self.assertEqual(result["outcome"], "rejected")
        self.assertEqual(result["errors"][0]["code"], "HARD_CONFLICT")
        self.assertEqual(store.get_state(), state)

    def test_expired_receipt_does_not_silently_release_commitment(self):
        store = self.store_with_receipt()
        store.clock = lambda: NOW.replace(day=3)
        objects = index(store.get_state())
        result = assess(self.cairo_only(), objects, store.clock())
        self.assertIn("reservation_city_conflict:receipt-hotel", result["violations"])
        self.assertIn("reservation_receipt_needs_recheck:receipt-hotel", result["unknowns"])

    def test_changed_trip_dates_preserve_receipt_without_forcing_old_city(self):
        store = self.store_with_receipt()
        changed = dict(op="revise", object_type="Constraint", id="constraint-dates",
                       changes=dict(value=dict(kind="date_window", start="2030-02-10", end="2030-02-14")))
        self.assertEqual(store.submit(request(store, changed, key="move-dates"), USER)["outcome"], "applied")
        result = assess(self.cairo_only(), index(store.get_state()), NOW)
        self.assertNotIn("reservation_city_conflict:receipt-hotel", result["violations"])
        self.assertIn("reservation_outside_or_unknown_trip_window:receipt-hotel", result["unknowns"])
        self.assertEqual(index(store.get_state())["receipt-hotel"]["status"], "active")
        choice = store.submit(request(store, dict(op="decide_candidate", id="candidate-luxor", value="reject"),
                                      key="reject-after-date-change"), USER)
        self.assertEqual(choice["outcome"], "applied", choice)
        self.assertEqual(index(store.get_state())["receipt-hotel"]["status"], "active")
        cancel = receipt("receipt-hotel-cancelled", "cancelled")
        body = request(store, dict(op="transition", id="receipt-hotel", event="supersede"),
                       ingest_command(cancel), key="cancel-after-date-change")
        self.assertEqual(store.submit(body, TOOL)["outcome"], "applied")

    def test_verified_cancellation_releases_city_without_erasing_history(self):
        store = self.store_with_receipt()
        cancel = receipt("receipt-hotel-cancelled", "cancelled")
        body = request(store, dict(op="transition", id="receipt-hotel", event="supersede"),
                       ingest_command(cancel), key="cancel-receipt", reason="合成提供方确认取消")
        result = store.submit(body, TOOL)
        self.assertEqual(result["outcome"], "applied", result)
        objects = index(store.get_state())
        self.assertEqual(objects["receipt-hotel"]["status"], "superseded")
        self.assertEqual(objects["receipt-hotel-cancelled"]["status"], "active")
        self.assertNotIn("reservation_city_conflict:receipt-hotel", assess(self.cairo_only(), objects, NOW)["violations"])
        self.assertTrue(any(c["reason"] == "合成提供方确认取消" for c in store.get_history()["changes"]))

    def test_receipt_cannot_be_dropped_without_successor_evidence(self):
        store = self.store_with_receipt()
        before = store.get_state()
        for event in ("supersede", "contradict"):
            result = store.submit(request(store, dict(op="transition", id="receipt-hotel", event=event), key=event), TOOL)
            self.assertEqual(result["outcome"], "rejected")
            self.assertEqual(result["errors"][0]["code"], "COMMITTED_FACT_EVIDENCE")
            self.assertEqual(store.get_state(), before)

        incomplete = receipt("receipt-incomplete", "cancelled")
        incomplete["missing_fields"] = ["provider_receipt_missing"]
        result = store.submit(request(store, dict(op="transition", id="receipt-hotel", event="supersede"),
                                      ingest_command(incomplete), key="incomplete-cancel"), TOOL)
        self.assertEqual(result["outcome"], "rejected")
        self.assertEqual(store.get_state(), before)

    def test_profile_rejects_missing_receipt_and_duplicate_active_versions(self):
        state = initial_state()
        item = receipt()
        item["query"]["parameters"] = [p for p in item["query"]["parameters"] if p["name"] != "confirmation_ref"]
        state["objects"].append(item)
        with self.assertRaises(RuleError):
            validate_state(state)
        state = initial_state()
        state["objects"].extend([receipt(), receipt("receipt-duplicate")])
        with self.assertRaises(RuleError):
            validate_state(state)
