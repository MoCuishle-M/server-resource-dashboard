import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyState, serializePublic } from "../lib/domain";
import { liveHistory, liveView, readLive } from "../lib/npu-live";
import { layoutGroupAvailability } from "../lib/schedule";
import type { Actor, Booking, Resource, UsageRequest } from "../lib/types";

const base = Date.parse("2026-11-26T00:00:00+08:00");
const at = (minute: number) => base + minute*60_000;
const iso = (minute: number) => new Date(at(minute)).toISOString();
const actor: Actor = {userId:"u", displayName:"测试", email:"", role:"contact", groupId:"g1", employeeId:""};
const makeResource = (id: string, hidden = false): Resource => ({
  id, ip: `192.0.2.${id.slice(1)}`, name: `柜09-CPU${id.slice(1)}`, type:"NPU", zone:"blue", rack:"计算柜09",
  accessMode:"bare", sharingMode:"exclusive", location:"", note:"", hidden, status:"available",
  deleted:false, createdAt:iso(0), updatedAt:iso(0),
});
const booking = (id: string, resourceId: string, from: number, until: number, groupId="g1", priority: Booking["priority"]="normal"): Booking => ({
  id, requestId:id, resourceId, startAt:iso(from), endAt:iso(until), groupId, priority, status:"scheduled",
  purpose:"", parentId:"", createdAt:iso(0), updatedAt:iso(0),
});
const request = (id: string, weeklySection?: "day"|"multi", sourceRequestId?: string) =>
  ({id, weeklySection, sourceRequestId, resourceIds: []} as unknown as UsageRequest);
const groups = ["g1","g2"].map(id=>({id,name:id,contactName:"",employeeId:""}));
const now = at(1200);
const state = {...emptyState(), groups, resources:[makeResource("r1"),makeResource("r2"),makeResource("r3",true),makeResource("r4")],
  requests:[request("source","multi"),request("same-group-handoff",undefined,"source")],
  bookings:[
    booking("daily","r1",960,1380), booking("same-group-handoff","r1",1260,1380),
    booking("other-group","r2",960,1380,"g2"), booking("hidden","r3",960,1380),
    booking("already-dedicated","r4",1100,1260,"g1","high"), booking("daily-4","r4",950,1400),
  ],
};

test("ordinary availability stops at a same-group multi-node handoff and excludes currently dedicated machines", () =>{
  const data=liveView(state,actor,"g1",now,1,[],[]);
  assert.deepEqual(data.machines.map(x=>[x.id,x.until,x.status]),[["r1",at(1260),"uncertain"]]);
  assert.equal(data.machines[0].idle,null);
  assert.deepEqual(liveView(state,actor,"g1",at(1260),1,[],[]).machines.map(x=>x.id),["r4"]);
});

test("the visible timeline uses the same handoff even when the multi-node source request is private", () => {
  const mixed = {...state, requests: state.requests.map(r => r.id === "source"
    ? {...r, resourceIds: ["r1", "r3"]} : r)};
  const visible = serializePublic(mixed, actor, iso(1200), true);
  assert(!visible.requests.some(r => r.id === "source"));
  assert(!visible.bookings.some(b => b.resourceId === "r3"));
  const timeline = layoutGroupAvailability(visible.resources[0], visible.bookings, "g1",
    {startAt: iso(1200), endAt: iso(1380)});
  assert.deepEqual(timeline.map(row => [row.endAt, row.available, row.reason]),
    [[iso(1260), true, ""], [iso(1380), false, "多机任务占用"]]);
  assert.equal(liveView(mixed, actor, "g1", now, 1, [], []).machines[0].until, Date.parse(timeline[0].endAt));
});

test("anonymous, unassigned and cross-group requests cannot reach telemetry storage", async () =>{
  const db = {prepare(){throw Error("telemetry must not be queried");}} as unknown as D1Database;
  const url = new URL("https://example.test/api/npu-live?group=g2");
  await assert.rejects(readLive(db,state,{...actor,userId:"",role:"visitor"},url,now),{status:401});
  await assert.rejects(readLive(db,state,{...actor,role:"member",groupId:""},url,now),{status:403});
  await assert.rejects(readLive(db,state,actor,url,now),{status:403});
  url.searchParams.set("group","all");
  await assert.rejects(readLive(db,state,actor,url,now),{status:403});
});

test("admin overall view counts a shared machine and overlapping observations once", () => {
  const admin: Actor = {...actor,role:"admin"};
  const sharedState = {...state,bookings:[
    ...state.bookings, booking("share","r1",1198,1230,"g2"),
  ]};
  const days = [{resourceId:"r1",day:"2026-11-26",expected:8,samples:{
    1197:[8,0,8,0],1198:[8,8,8,0],
  }}] satisfies Parameters<typeof liveView>[5];
  const data = liveView(sharedState,admin,"",now,1,days,[]);
  assert.equal(data.group,"all");
  assert.deepEqual(data.machines.map(row=>row.id),["r1","r2","r3"]);
  const first = data.machines[0];
  assert.deepEqual(first.groupNames,["g1","g2"]);
  assert.equal(first.shared,true);
  assert.equal(first.until,at(1230));
  assert.equal(first.mean,50);
  assert.equal(liveView(sharedState,admin,"g1",now,1,days,[]).machines[0].until,at(1260));
});

test("history covers only the group's ordinary period and leaves missing observations unknown", () =>{
  const result = liveHistory([{resourceId:"r1",day:"2026-11-26",expected:8,samples:{
    1194:[8,8,8,0],1197:[8,4,8,0],1198:[4,0,4,0],1199:[0,0,0,0],
  }}],[{start:at(1196),end:at(1200)}],now,1);
  assert.equal(result.values.length,12);
  assert(result.values.slice(0,-1).every(x=>x===null));
  assert.equal(result.mean,100/3);
});

test("expired idle snapshots are not offered as available", () =>{
  const cards=Array.from({length:8},(_,i)=>({key:`${i}-0`,state:"idle",util:0,hbm:0}));
  const snapshots=(age:number)=>[{resourceId:"r1",expected:8,snapshot:{at:at(1200-age),cards}}];
  assert.equal(liveView(state,actor,"g1",now,1,[],snapshots(2)).machines[0].idle,8);
  assert.equal(liveView(state,actor,"g1",now,1,[],snapshots(4)).machines[0].idle,null);
});
