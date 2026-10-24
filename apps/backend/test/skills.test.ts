import assert from "assert";

import { ELEMENTS, PLAYABLE_ELEMENTS } from "../src/shared/elements.js";
import { ELEMENT_KITS, SKILL_IDS, SKILL_SLOTS, hasSkill, kitOf, slotOf, type ElementKit, type SkillId } from "../src/shared/skills.js";

/** The skills a kit fills its slots with, in slot order. */
const skillsOf = (kit: ElementKit) => SKILL_SLOTS.map((slot) => kit[slot]).filter((skill): skill is SkillId => skill !== undefined);

describe("element kits", () => {
  it("make exactly the elements with a kit playable", () => {
    assert.deepStrictEqual(PLAYABLE_ELEMENTS, ELEMENTS.filter((element) => kitOf(element) !== undefined));
    assert.ok(PLAYABLE_ELEMENTS.includes("fire"));
    assert.ok(PLAYABLE_ELEMENTS.includes("earth"));
    assert.ok(PLAYABLE_ELEMENTS.includes("wind"), "wind is playable, with no skills yet");
  });

  it("have only distinct real skills in their slots", () => {
    for (const kit of Object.values(ELEMENT_KITS)) {
      const skills = skillsOf(kit);
      assert.ok(skills.every((skill) => SKILL_IDS.includes(skill)));
      assert.strictEqual(new Set(skills).size, skills.length);
    }
  });

  it("give each skill to at most one element", () => {
    const owned = Object.values(ELEMENT_KITS).flatMap(skillsOf);
    assert.strictEqual(new Set(owned).size, owned.length);
  });

  it("allow a skill only to elements whose kit has it", () => {
    assert.ok(hasSkill("fire", "fireball"));
    assert.ok(hasSkill("fire", "twin_dragons"));
    assert.ok(!hasSkill("water", "fireball"));
    assert.ok(hasSkill("water", "water_whip"));
    assert.ok(!hasSkill("fire", "water_whip"));
    assert.ok(!hasSkill("lava", "fireball"));
    assert.ok(!hasSkill("constructor", "fireball"));
  });

  it("find the slot a skill sits in", () => {
    assert.strictEqual(slotOf("fire", "fireball"), "main");
    assert.strictEqual(slotOf("fire", "twin_dragons"), "ultimate");
    assert.strictEqual(slotOf("water", "fireball"), undefined);
    assert.strictEqual(slotOf("water", "water_whip"), "main");
    assert.strictEqual(slotOf("water", "torrent"), "second");
    assert.strictEqual(slotOf("water", "water_clone"), "third");
    assert.strictEqual(slotOf("water", "freezing_stream"), "ultimate");
    assert.strictEqual(slotOf("earth", "fireball"), undefined);
    assert.strictEqual(slotOf("earth", "boulders"), "second");
    assert.strictEqual(slotOf("earth", "stone_skin"), undefined, "kept, out of the kit");
    assert.strictEqual(slotOf("earth", "earth_wall"), undefined, "kept, out of the kit");
    assert.strictEqual(slotOf("earth", "burrow"), "third");
    assert.strictEqual(slotOf("earth", "stones"), "main");
    assert.strictEqual(slotOf("earth", "rupture"), "ultimate");
  });
});
