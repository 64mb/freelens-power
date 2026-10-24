import { describe, expect, it } from "vitest";
import { sqlRowDetails } from "./power-logs-sql-row";

describe("sqlRowDetails", () => {
  it("selects the largest JSON cell by UTF-8 bytes and preserves its original text", () => {
    const ascii = '{"value":"abcdefgh"}';
    const multibyte = ' {"value":"世界世界"} ';
    expect(multibyte.length).toBeLessThan(ascii.length);
    const result = sqlRowDetails(["first", "second", "message"], [ascii, multibyte, "request completed"]);
    expect(result.jsonColumn).toBe("second");
    expect(result.record.fieldsJson).toBe(multibyte);
    expect(result.record.message).toBe("request completed");
  });

  it("rejects malformed JSON and every JSON scalar and exposes all row fields", () => {
    const columns = ["broken", "number", "boolean", "null", "string", "count"];
    const row = ["{broken", "42", "true", "null", '"text"', 5];
    const result = sqlRowDetails(columns, row);
    expect(result.jsonColumn).toBeUndefined();
    expect(result.record.fieldsJson).toBeNull();
    expect(JSON.parse(result.record.message)).toEqual(
      Object.fromEntries(columns.map((name, index) => [name, row[index]])),
    );
    expect(result.record.message).toContain("\n");
  });

  it("accepts arrays without duplicating their contents in the message", () => {
    expect(sqlRowDetails(["events"], ['[{"status":"ready"}]'])).toMatchObject({
      jsonColumn: "events",
      record: { fieldsJson: '[{"status":"ready"}]', message: "" },
    });
  });

  it("maps recognized metadata without coercing arbitrary values", () => {
    const columns = ["timestamp", "pod", "podUid", "container", "level", "message", "previous", "fields"];
    expect(
      sqlRowDetails(columns, [1234, "sample-pod", "sample-uid", "app", "warn", "ready", true, "{}"]).record,
    ).toEqual({
      timestamp: 1234,
      pod: "sample-pod",
      podUid: "sample-uid",
      container: "app",
      level: "warn",
      message: "ready",
      previous: true,
      fieldsJson: "{}",
    });
    expect(sqlRowDetails(columns, [Number.NaN, 42, null, false, "custom", 8, "false", "{}"]).record).toEqual({
      timestamp: null,
      pod: "",
      podUid: "",
      container: "",
      level: "unknown",
      message: "",
      previous: false,
      fieldsJson: "{}",
    });
    expect(sqlRowDetails(["fields"], ["{}"]).record).toMatchObject({
      timestamp: null,
      pod: "",
      podUid: "",
      container: "",
      level: "unknown",
      previous: false,
    });
  });
});
