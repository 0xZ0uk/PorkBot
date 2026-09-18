import {
  composeSystemPrompt,
  DATA_CHANNEL_NOTICE,
  INGESTION_PATHS,
  untrustedPromptSection,
} from "@porkbot/core";
import { describe, expect, it } from "vitest";
import { fixturesFor, INJECTION_FIXTURES, labelledFixture } from "./ingestion-fixtures.ts";

/**
 * The adversarial fixtures are only useful if they cover the whole ingestion
 * surface and if the composer keeps every one of them out of the instruction
 * channel. This suite pins both: a new entry in `INGESTION_PATHS` fails here
 * until it has a fixture (and E10.4's suite, in turn, builds on this list), and
 * each fixture's marker is checked against the composed prompt so the
 * instruction/data separation is proven on hostile text rather than on a
 * friendly sample.
 */

describe("the injection fixtures", () => {
  it("covers every registered ingestion path", () => {
    for (const path of INGESTION_PATHS) {
      expect(
        fixturesFor(path).length,
        `ingestion path "${path}" has no adversarial fixture`,
      ).toBeGreaterThan(0);
    }
  });

  it("names a distinct attack and a marker that is present in the content", () => {
    const markers = new Set<string>();

    for (const fixture of INJECTION_FIXTURES) {
      expect(fixture.origin.trim()).not.toBe("");
      expect(fixture.attempts.trim()).not.toBe("");
      expect(fixture.content).toContain(fixture.marker);
      expect(markers.has(fixture.marker), `marker "${fixture.marker}" is not distinct`).toBe(false);
      markers.add(fixture.marker);
    }
  });

  it("labels each fixture through the path it arrived on", () => {
    for (const fixture of INJECTION_FIXTURES) {
      const labelled = labelledFixture(fixture);

      expect(labelled.label).toBe("untrusted");
      expect(labelled.path).toBe(fixture.path);
      expect(labelled.origin).toBe(fixture.origin);
      expect(labelled.content).toBe(fixture.content);
    }
  });

  it("keeps every hostile marker inside the data channel, never as instruction", () => {
    for (const fixture of INJECTION_FIXTURES) {
      const section = untrustedPromptSection(labelledFixture(fixture), {
        id: "ingested.0",
        order: 900,
      });

      expect(section.channel).toBe("data");

      const prompt = composeSystemPrompt({ bot: { name: "Porky" }, sections: [section] });
      const rendered = prompt.sections.find((candidate) => candidate.id === "ingested.0");

      expect(rendered?.channel).toBe("data");
      expect(rendered?.body.startsWith(DATA_CHANNEL_NOTICE)).toBe(true);
      expect(rendered?.body).toContain(fixture.marker);

      for (const instruction of prompt.sections.filter(
        (candidate) => candidate.channel === "instruction",
      )) {
        expect(
          instruction.body,
          `fixture for ${fixture.path} reached the instruction channel`,
        ).not.toContain(fixture.marker);
      }
    }
  });
});
