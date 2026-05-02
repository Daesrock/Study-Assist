import { describe, it, expect } from "vitest";
import { __testOnlyApiMatching } from "../../src/background/modules/api";

const { matchSingleAnswerToLetter, matchCorrectAnswerToLetter } = __testOnlyApiMatching;

const FINAL_EXAM_005_OPTIONS = [
  {
    letter: "A",
    text: "(config)# interface vlan 1\n(config-if)# ip address 192.168.1.2 255.255.255.0\n(config-if)# no shutdown",
  },
  {
    letter: "B",
    text: "(config)# interface gigabitethernet 1/1\n(config-if)# no switchport\n(config-if)# ip address 192.168.1.2 255.255.255.252",
  },
  {
    letter: "C",
    text: "(config)# ip routing",
  },
  {
    letter: "D",
    text: "(config)# interface gigabitethernet1/1\n(config-if)# switchport mode trunk",
  },
  {
    letter: "E",
    text: "(config)# interface fastethernet0/4\n(config-if)# switchport mode trunk",
  },
];

describe("api multi-answer option matching", () => {
  it("should match final-exam_005 answers as B, C", () => {
    const result = matchCorrectAnswerToLetter(
      {
        correctAnswers: [
          "(config)# interface gigabitethernet 1/1\n(config-if)# no switchport\n(config-if)# ip address 192.168.1.2 255.255.255.252",
          "(config)# ip routing",
        ],
      },
      FINAL_EXAM_005_OPTIONS,
    );

    expect(result).toBe("B, C");
  });

  it("should not map long command blocks to short command snippets", () => {
    const mergedAnswer = "(config)# interface gigabitethernet 1/1\n(config-if)# no switchport\n(config-if)# ip address 192.168.1.2 255.255.255.252\n(config)# ip routing";

    const letter = matchSingleAnswerToLetter(mergedAnswer, FINAL_EXAM_005_OPTIONS);

    expect(letter).toBe("B");
  });

  it("should avoid reusing the same option letter for multi-answer mappings", () => {
    const mergedAnswer = "(config)# interface gigabitethernet 1/1\n(config-if)# no switchport\n(config-if)# ip address 192.168.1.2 255.255.255.252\n(config)# ip routing";

    const result = matchCorrectAnswerToLetter(
      {
        correctAnswers: [mergedAnswer, "(config)# ip routing"],
      },
      FINAL_EXAM_005_OPTIONS,
    );

    expect(result).toBe("B, C");
  });
});
