/** Repair of model-emitted tool input JSON whose only defects sit inside
 * string literals (fine-grained tool streaming passes it through unvalidated). */
import { describe, expect, it } from "bun:test"
import { parseToolInputObject, repairJsonStringLiterals } from "../proxy/toolInputJson"

describe("repairJsonStringLiterals", () => {
  it("escapes raw control characters inside strings", () => {
    expect(repairJsonStringLiterals('{"a":"x\ty"}')).toBe('{"a":"x\\ty"}')
    expect(repairJsonStringLiterals('{"a":"x\ny\rz"}')).toBe('{"a":"x\\ny\\rz"}')
    expect(repairJsonStringLiterals('{"a":"\b\f"}')).toBe('{"a":"\\b\\f"}')
    expect(repairJsonStringLiterals('{"a":"\u0001\u001f"}')).toBe('{"a":"\\u0001\\u001f"}')
  })

  it("leaves whitespace between tokens untouched", () => {
    expect(repairJsonStringLiterals('{\n\t"a": 1\n}')).toBe('{\n\t"a": 1\n}')
  })

  it("leaves invalid backslash escapes untouched for the parser to reject without corrupting paths", () => {
    expect(repairJsonStringLiterals('{"p":"C:\\dev\\x"}')).toBe('{"p":"C:\\dev\\x"}')
    expect(repairJsonStringLiterals('{"p":"C:\\Users\\new"}')).toBe('{"p":"C:\\Users\\new"}')
  })

  it("keeps valid escapes, including \\u with four hex digits", () => {
    const valid = '{"a":"\\" \\\\ \\/ \\b \\f \\n \\r \\t \\u00e9"}'
    expect(repairJsonStringLiterals(valid)).toBe(valid)
  })

  it("leaves a malformed \\u escape for the parser to reject, as Pi does", () => {
    expect(repairJsonStringLiterals('{"a":"\\u00g1"}')).toBe('{"a":"\\u00g1"}')
    expect(parseToolInputObject('{"a":"\\u00g1"}')).toBeUndefined()
  })

  it("does not treat an escaped quote as the end of the string", () => {
    expect(repairJsonStringLiterals('{"a":"say \\"\t\\""}')).toBe('{"a":"say \\"\\t\\""}')
  })

  it("returns already valid JSON unchanged", () => {
    const valid = '{"path":"/x","edits":[{"oldText":"\\tlet","newText":"\\tconst"}]}'
    expect(repairJsonStringLiterals(valid)).toBe(valid)
  })
})

describe("parseToolInputObject", () => {
  it("parses valid object JSON", () => {
    expect(parseToolInputObject('{"file_path":"/x"}')).toEqual({ file_path: "/x" })
    expect(parseToolInputObject("{}")).toEqual({})
  })

  it("parses an object whose strings hold a raw tab (the observed edit call)", () => {
    const raw = '{"path": "/repo/lib/render.ts", "edits": [{"oldText":"\tlet text = \\"\\";\\n\\tif (x) {","newText":"\tlet text = \\"y\\";"}]}'
    expect(() => JSON.parse(raw)).toThrow()
    expect(parseToolInputObject(raw)).toEqual({
      path: "/repo/lib/render.ts",
      edits: [{ oldText: "\tlet text = \"\";\n\tif (x) {", newText: "\tlet text = \"y\";" }],
    })
  })

  it("parses an object whose strings hold a raw newline", () => {
    expect(parseToolInputObject('{"command":"echo a\necho b"}')).toEqual({ command: "echo a\necho b" })
  })

  it("rejects an object whose strings hold an invalid backslash escape (including mixed C:\\Users\\new)", () => {
    expect(parseToolInputObject('{"file_path":"C:\\dev\\x.md"}')).toBeUndefined()
    expect(parseToolInputObject('{"file_path":"C:\\Users\\new"}')).toBeUndefined()
    expect(parseToolInputObject('{"file_path":"C:\\Users\\new\tfile.md"}')).toBeUndefined()
  })

  it("rejects truncated JSON, repaired or not", () => {
    expect(parseToolInputObject('{"file_path":')).toBeUndefined()
    expect(parseToolInputObject('{"file_path":"/x')).toBeUndefined()
    expect(parseToolInputObject('{"text":"a\tb"')).toBeUndefined()
    expect(parseToolInputObject('{"text":"a\\')).toBeUndefined()
  })

  it("rejects non-object roots", () => {
    expect(parseToolInputObject('["a","b"]')).toBeUndefined()
    expect(parseToolInputObject('["a\tb"]')).toBeUndefined()
    expect(parseToolInputObject('"just\ttext"')).toBeUndefined()
    expect(parseToolInputObject("42")).toBeUndefined()
    expect(parseToolInputObject("null")).toBeUndefined()
  })

  it("rejects a control character outside any string", () => {
    expect(parseToolInputObject('{\u0001"a":1}')).toBeUndefined()
  })

  it("rejects empty input", () => {
    expect(parseToolInputObject("")).toBeUndefined()
    expect(parseToolInputObject("  ")).toBeUndefined()
  })
})
