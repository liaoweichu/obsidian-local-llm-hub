import { describe, expect, it } from "vitest";
import { ALL_EVENT_VARIABLE_NAMES, getEventVariable, setEventVariable } from "./eventVariables";
import { extractInputVariables } from "./inputVariables";
import type { SidebarNode } from "./types";

describe("eventVariables", () => {
  it("sets both current and legacy event variable names", () => {
    const variables = new Map<string, unknown>();

    setEventVariable(variables, "_eventFilePath", "folder/note.md");

    expect(variables.get("_eventFilePath")).toBe("folder/note.md");
    expect(variables.get("__eventFilePath__")).toBe("folder/note.md");
  });

  it("reads legacy event variable names as fallback", () => {
    const variables = new Map<string, unknown>([
      ["__eventFileContent__", "legacy content"],
    ]);

    expect(getEventVariable(variables, "_eventFileContent")).toBe("legacy content");
  });

  it("lists both current and legacy event variable names for system variable filtering", () => {
    expect(ALL_EVENT_VARIABLE_NAMES).toContain("_eventFile");
    expect(ALL_EVENT_VARIABLE_NAMES).toContain("__eventFile__");
  });
});

describe("extractInputVariables", () => {
  it("does not treat legacy event variables as required workflow inputs", () => {
    const nodes: SidebarNode[] = [
      {
        id: "save",
        type: "note",
        properties: {
          path: "{{__eventFilePath__}}",
          content: "{{__eventFileContent__}}",
          mode: "overwrite",
        },
      },
    ];
    expect(extractInputVariables(nodes)).toEqual([]);
  });
});
