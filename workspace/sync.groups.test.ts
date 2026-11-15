import { expect, test } from "bun:test";
import { SyncRelay, UNGROUPED, type RelayTransport } from "./syncRelay.ts";

class Transport implements RelayTransport { packets: any[] = []; send(packet: unknown) { this.packets.push(packet); } close() {} actions() { return this.packets.filter(p => p.type === "ACTION"); } }

function fixture() {
  const groups: Record<string, string | null> = { a1: "A", a2: "A", a3: "A", b1: "B", b2: "B", u1: null };
  const relay = new SyncRelay({ random: () => 0, ackTimeoutMs: 60_000, groupFor: id => groups[id] });
  relay.configure(["https://site.test"], "fast");
  const t: Record<string, Transport> = {};
  for (const id of Object.keys(groups)) {
    const config = relay.register(id, "https://site.test"); t[id] = new Transport();
    relay.authenticate(id, config.token, t[id]!);
    relay.receive(id, t[id]!, { type: "PAGE", url: "https://site.test/casino" });
  }
  const click = (seq: number) => ({ type: "ACTION", id: `event_0000${seq}`, seq, epoch: relay.configFor("a1")!.epoch, origin: "https://site.test", url: "https://site.test/casino", action: "click", selector: "button[name=\"play\"]", fingerprint: { tag: "button", text: "Play" } });
  return { relay, t, groups, click };
}

test("each group keeps its own single administrator", () => {
  const { relay } = fixture();
  relay.setRole("a1", "admin"); relay.setRole("b1", "admin");
  expect(relay.adminOf("A")).toBe("a1"); expect(relay.adminOf("B")).toBe("b1");
  const roles = Object.fromEntries(relay.statuses().map(row => [row.profileId, row.role]));
  expect(roles).toMatchObject({ a1: "admin", a2: "follower", a3: "follower", b1: "admin", b2: "follower", u1: "manual" });
  relay.setRole("a2", "admin");
  expect(relay.adminOf("A")).toBe("a2"); expect(relay.adminOf("B")).toBe("b1");
  relay.stop();
});

test("admin actions only reach followers in the same group", () => {
  const { relay, t } = fixture();
  relay.setRole("a1", "admin"); relay.setRole("b1", "admin");
  const epoch = relay.configFor("a1")!.epoch;
  relay.receive("a1", t.a1!, { type: "ACTION", id: "event_00001", seq: 1, epoch, origin: "https://site.test", url: "https://site.test/casino", action: "click", selector: "button[name=\"play\"]", fingerprint: { tag: "button", text: "Play" } });
  expect(t.a2!.actions()).toHaveLength(1); expect(t.a3!.actions()).toHaveLength(1);
  expect(t.b2!.actions()).toHaveLength(0); expect(t.u1!.actions()).toHaveLength(0);
  expect(relay.followers("A").map(f => f.profileId).sort()).toEqual(["a2", "a3"]);
  expect(relay.followers("B").map(f => f.profileId)).toEqual(["b2"]);
  relay.stop();
});

test("changing one group's admin does not reset the other group's queue", () => {
  const { relay } = fixture();
  relay.setRole("a1", "admin"); relay.setRole("b1", "admin");
  const before = relay.configFor("b2")!.epoch;
  relay.setRole("a3", "admin");
  expect(relay.configFor("b2")!.epoch).toBe(before);
  expect(relay.configFor("b2")!.role).toBe("follower");
  relay.stop();
});

test("moving an admin into a group that already has one makes it manual", () => {
  const { relay, groups } = fixture();
  relay.setRole("a1", "admin"); relay.setRole("b1", "admin");
  groups.b1 = "A"; relay.regroup("b1");
  expect(relay.configFor("b1")!.role).toBe("manual");
  expect(relay.adminOf("A")).toBe("a1"); expect(relay.adminOf("B")).toBeUndefined();
  expect(relay.groupOf("u1")).toBe(UNGROUPED);
  relay.stop();
});

test("force followers can target a single group", () => {
  const { relay } = fixture();
  relay.setRole("a1", "admin", { forceFollowers: false }); relay.setRole("b1", "admin", { forceFollowers: false });
  const forced = relay.forceFollowers(undefined, "B");
  expect(forced).toEqual(["b2"]);
  expect(relay.configFor("a2")!.role).toBe("manual");
  relay.stop();
});

test("only the group administrator's viewport size is forwarded", () => {
  const layouts: Array<[string, number, number]> = [];
  const groups: Record<string, string> = { a1: "A", a2: "A" };
  const relay = new SyncRelay({ groupFor: id => groups[id], onAdminLayout: (id, layout) => layouts.push([id, layout.width, layout.height]) });
  relay.configure(["https://site.test"], "fast");
  const t: Record<string, Transport> = {};
  for (const id of Object.keys(groups)) { const c = relay.register(id, "https://site.test"); t[id] = new Transport(); relay.authenticate(id, c.token, t[id]!); }
  relay.setRole("a1", "admin");
  relay.receive("a2", t.a2!, { type: "LAYOUT", width: 1200, height: 800 });
  relay.receive("a1", t.a1!, { type: "LAYOUT", width: 99999, height: 800 });
  relay.receive("a1", t.a1!, { type: "LAYOUT", width: 1280, height: 720 });
  expect(layouts).toEqual([["a1", 1280, 720]]);
  relay.stop();
});
