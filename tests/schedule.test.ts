import test from "node:test";
import assert from "node:assert/strict";
import { calendarRange, customRange, layoutBookings, shiftDate, timelineTicks } from "../lib/schedule";
import type { Booking } from "../lib/types";
import { bookingAvailability, displayBookings, requestPriorityPreview } from "../lib/priority";
import type { Resource } from "../lib/types";

const booking = (id: string, startAt: string, endAt: string, status: Booking["status"] = "scheduled") => ({ id, startAt, endAt, status } as Booking);

test("Beijing weeks run Monday midnight to the following Monday across year and month boundaries", () => {
  assert.deepEqual(calendarRange("2026-10-21", "week"), {
    startAt: "2026-10-18T16:00:00.000Z", endAt: "2026-10-25T16:00:00.000Z",
  });
  assert.deepEqual(calendarRange("2026-10-25", "week"), calendarRange("2026-10-19", "week"));
  assert.deepEqual(calendarRange("2027-01-01", "week"), {
    startAt: "2026-12-27T16:00:00.000Z", endAt: "2027-01-03T16:00:00.000Z",
  });
  assert.equal(shiftDate("2028-02-28", 1), "2028-02-29");
  assert.equal(shiftDate("2028-03-01", -1), "2028-02-29");
});

test("single-day view covers the entire 24 hours and custom input always uses Beijing time", () => {
  assert.deepEqual(calendarRange("2026-10-21", "day"), {
    startAt: "2026-10-20T16:00:00.000Z", endAt: "2026-10-21T16:00:00.000Z",
  });
  assert.deepEqual(customRange("2026-10-21T23:15", "2026-10-22T01:45"), {
    startAt: "2026-10-21T15:15:00.000Z", endAt: "2026-10-21T17:45:00.000Z",
  });
  assert.throws(() => customRange("", ""), /填写完整/);
  assert.throws(() => customRange("2026-10-22T00:00", "2026-10-22T00:00"), /晚于/);
  assert.throws(() => customRange("2026-10-23T00:00", "2026-10-22T00:00"), /晚于/);
});

test("timeline ticks include exact range endpoints with ordered and bounded density", () => {
  const week = calendarRange("2026-10-21", "week");
  assert.equal(timelineTicks(week).length, 8);
  for (const range of [week, calendarRange("2026-10-21", "day"), customRange("2026-10-21T23:15", "2026-10-22T01:45"), customRange("2026-01-01T00:00", "2027-01-01T00:00")]) {
    const ticks = timelineTicks(range);
    assert.equal(ticks[0].at, range.startAt);
    assert.equal(ticks.at(-1)!.at, range.endAt);
    assert.equal(ticks[0].percent, 0);
    assert.equal(ticks.at(-1)!.percent, 100);
    assert(ticks.length <= 11);
    assert(ticks.every((t, i) => !i || t.percent > ticks[i - 1].percent));
  }
});

test("continuous bookings are clipped once and touching boundaries are excluded", () => {
  const range = customRange("2026-10-21T00:00", "2026-10-23T00:00");
  const spanning = booking("long", "2026-10-20T21:00:00+08:00", "2026-10-24T09:00:00+08:00");
  const layout = layoutBookings([spanning,
    booking("before", "2026-10-20T00:00:00+08:00", range.startAt),
    booking("after", range.endAt, "2026-10-24T00:00:00+08:00"),
  ], range);
  assert.equal(layout.bars.length, 1);
  assert.equal(layout.bars[0].left, 0);
  assert.equal(layout.bars[0].width, 100);
  assert.equal(layout.bars[0].continuesBefore, true);
  assert.equal(layout.bars[0].continuesAfter, true);
  assert.equal(spanning.startAt, "2026-10-20T21:00:00+08:00");
});

test("overlapping shared bookings get separate lanes, adjacent bookings reuse a lane, and released history remains", () => {
  const range = customRange("2026-10-21T00:00", "2026-10-22T00:00");
  const at = (h: string) => `2026-10-21T${h}:00+08:00`;
  const layout = layoutBookings([
    booking("a", at("01:00"), at("04:00")),
    booking("b", at("02:00"), at("05:00")),
    booking("c", at("04:00"), at("06:00"), "released"),
    booking("cancel", at("01:00"), at("07:00"), "cancelled"),
    booking("preempted", at("01:00"), at("07:00"), "preempted"),
  ], range);
  assert.equal(layout.lanes, 3);
  assert.deepEqual(layout.bars.map(b => [b.booking.id, b.lane]), [["a", 0], ["preempted:gap0", 1], ["b", 2], ["c", 0]]);
  assert.equal(layout.bars[0].width, 12.5);
});

test("priority preview splits partial overlaps and distinguishes shared peers and exclusive conflicts", () => {
  const at = (hour: number) => `2026-10-21T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const low = { ...booking("low", at(1), at(10)), priority: "normal", resourceId: "r" } as Booking;
  const high = { ...low, id: "high", startAt: at(4), endAt: at(6), priority: "high" } as Booking;
  const peer = { ...high, id: "peer" };
  const resource = { id: "r", sharingMode: "shared" } as Resource;
  const segments = bookingAvailability(low, [low, high, peer]);
  assert.deepEqual(segments.map(s => [s.startAt, s.endAt, s.blockedBy.length]), [[at(1), at(4), 0], [at(4), at(6), 2], [at(6), at(10), 0]]);
  const preview = requestPriorityPreview(resource, [high], high, "high")!;
  assert.equal(preview.equals.length, 1);
  assert.equal(preview.blocking.length, 0);
  assert.equal(requestPriorityPreview({ ...resource, sharingMode: "exclusive" }, [high], high, "high")!.blocking.length, 1);
  assert.equal(requestPriorityPreview(resource, [high], { startAt: at(6), endAt: at(8) }, "normal")!.blocking.length, 0);
  assert.equal(requestPriorityPreview(resource, [low], high, "high")!.affected.length, 1);
  assert.equal(requestPriorityPreview(resource, [high], { startAt: "", endAt: "" }, "high"), null);
});

test("legacy preempted intervals display only lost gaps, including nested preemptions", () => {
  const at = (h: number) => `2026-10-21T${String(h).padStart(2, "0")}:00:00.000Z`;
  const original = { ...booking("original", at(1), at(10), "preempted"), parentId: "" };
  const before = { ...booking("before", at(1), at(4)), parentId: original.id };
  const after = { ...booking("after", at(6), at(10), "preempted"), parentId: original.id };
  const tail = { ...booking("tail", at(8), at(10)), parentId: after.id };
  assert.deepEqual(displayBookings([original, before, after, tail]).filter(b => b.status === "preempted").map(b => [b.startAt, b.endAt]), [[at(4), at(6)], [at(6), at(8)]]);
});
