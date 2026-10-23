import { describe, expect, it } from "vitest";
import { galleryAutomations, GALLERY_KEYS } from "./automation-gallery";

const stage = {
  id: "stage",
  name: "Stage",
  type: "status",
  options: { options: [{ id: "new", name: "New" }, { id: "review", name: "In review" }, { id: "won", name: "Won" }] },
};
const owner = { id: "owner", name: "Owner", type: "person" };
const due = { id: "due", name: "Due", type: "date" };

describe("galleryAutomations", () => {
  it("fits the approval template to the database: the stage asking for it, its people, the closing option", () => {
    const [approve] = galleryAutomations([due, stage, owner]);
    expect(approve.key).toBe("approveBeforeClosing");
    expect(approve.trigger).toEqual({ type: "property_changed", propertyId: "stage", to: "review" });
    expect(approve.actions).toEqual([
      { id: "approval", type: "approval", userIds: [], propertyIds: ["owner"], message: "", timeoutDays: 7, onTimeout: "stop" },
      { id: "set", type: "set_properties", values: { stage: "won" } },
    ]);
    expect(approve.messageValues.title).toBe("{{trigger.title}}");
  });

  it("leaves empty what the database has nothing for", () => {
    const all = galleryAutomations([]);
    expect(all.map((a) => a.key)).toEqual([...GALLERY_KEYS]);
    const [approve, notify, remind] = all;
    expect(approve.trigger).toEqual({ type: "property_changed", propertyId: null });
    expect(approve.actions[0]).toMatchObject({ type: "approval", propertyIds: [] });
    expect(approve.actions[1]).toEqual({ id: "set", type: "set_properties", values: {} });
    expect(notify.actions[0]).toMatchObject({ type: "notify", propertyIds: [] });
    expect(remind.trigger).toMatchObject({ type: "date_passed", date: "", status: null });
  });

  it("changes on any option when none sounds like asking, and finds closing options across languages", () => {
    const tr = { ...stage, options: { options: [{ id: "a", name: "Açık" }, { id: "k", name: "Kazanıldı" }] } };
    const [approve] = galleryAutomations([tr, owner]);
    expect(approve.trigger).toEqual({ type: "property_changed", propertyId: "stage" });
    expect(approve.actions[1]).toEqual({ id: "set", type: "set_properties", values: { stage: "k" } });
  });
});
