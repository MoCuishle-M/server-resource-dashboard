import test from "node:test";
import assert from "node:assert/strict";
import { resourceSearch } from "../lib/resource-search";

const resources = [
  { name: "蓝区计算柜01", ip: "192.0.2.1", type: "950DT  * 8卡", note: "共享训练" },
  { name: "绿区C02-B07", ip: "192.0.2.11", type: "910C 8卡", note: "联系192.0.2.1" },
  { name: "IPv6-server", ip: "2001:db8::a", type: "950DT  * 8卡", note: "" },
];
const matches = (query: string) => resources.filter(resourceSearch(query)).map(r => r.ip);

test("IP lists accept spaces, English commas, line breaks, tabs and repeated separators", () => {
  for (const separator of [" ", ",", "\n", "\r\n", "\t", ", \n\t,"]) {
    assert.deepEqual(matches(`  192.0.2.1${separator}2001:DB8::A,192.0.2.1, `), ["192.0.2.1", "2001:db8::a"]);
  }
});
test("complete IPs match only the IP field exactly and unknown IPs return no results", () => {
  assert.deepEqual(matches("192.0.2.1"), ["192.0.2.1"]);
  assert.deepEqual(matches("192.0.2.1,192.0.2.99"), ["192.0.2.1"]);
  assert.deepEqual(matches("192.0.2.99"), []);
});
test("text and partial address searches retain phrase spacing and ignore case", () => {
  assert.deepEqual(matches("蓝区"), ["192.0.2.1"]);
  assert.deepEqual(matches("950dt  * 8卡"), ["192.0.2.1", "2001:db8::a"]);
  assert.deepEqual(matches("共享训练"), ["192.0.2.1"]);
  assert.deepEqual(matches("192.0.2."), ["192.0.2.1", "192.0.2.11"]);
  assert(resourceSearch("上海机房")({ ...resources[0], location: "上海机房" }));
});
test("empty lists show all resources", () => {
  for (const query of ["", " \t\n", ", ,\n"]) assert.equal(matches(query).length, resources.length);
});
