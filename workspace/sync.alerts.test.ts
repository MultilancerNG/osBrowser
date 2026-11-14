import { expect, test } from "bun:test";
import { SyncRelay, type RelayTransport } from "./syncRelay.ts";

class Transport implements RelayTransport { packets: any[] = []; send(packet: unknown) { this.packets.push(packet); } close() {} }

test("admin actions report how many followers received them, and statuses expose the current page", () => {
  const events: Array<[string, string, number]> = [];
  const relay = new SyncRelay({ random: () => 0, ackTimeoutMs: 60_000, onAdminAction: (id, action, followers) => events.push([id, action, followers]) });
  relay.configure(["https://site.test"], "fast");
  const ids = ["admin", "f1", "f2"], transports = ids.map(() => new Transport());
  ids.forEach((id, index) => { const config = relay.register(id, "https://site.test"); relay.authenticate(id, config.token, transports[index]!); });
  relay.setRole("admin", "admin"); relay.setRole("f1", "follower"); relay.setRole("f2", "follower");
  ids.forEach((id, index) => relay.receive(id, transports[index]!, { type: "PAGE", url: "https://site.test/casino" }));
  relay.setPaused("f2", true);
  relay.receive("admin", transports[0]!, { type: "ACTION", id: "event_00001", seq: 1, epoch: relay.epoch, origin: "https://site.test", url: "https://site.test/casino", action: "click", selector: "button[name=\"play\"]", fingerprint: { tag: "button", text: "Play" } });
  expect(events).toEqual([["admin", "click", 1]]);
  expect(relay.statuses().find(row => row.profileId === "f1")?.page).toContain("https://site.test/casino");
  relay.stop();
});
