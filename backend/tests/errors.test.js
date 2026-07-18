import { describe, it, expect } from "vitest";

import { CODES, ProcessingError, errorResponse } from "../functions/processPrescription/errors.js";

const HEADERS = { "Content-Type": "application/json" };

describe("CODES catalog", () => {
  it("is frozen so typos throw instead of producing undefined codes", () => {
    expect(Object.isFrozen(CODES)).toBe(true);
  });

  it("maps each key to a matching string value", () => {
    for (const [key, value] of Object.entries(CODES)) {
      expect(value).toBe(key);
    }
  });
});

describe("ProcessingError", () => {
  it("carries code, statusCode, message and detail", () => {
    const err = new ProcessingError(CODES.UNSUPPORTED_FILE, 415, "bad type", "image/gif");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ProcessingError");
    expect(err.code).toBe("UNSUPPORTED_FILE");
    expect(err.statusCode).toBe(415);
    expect(err.message).toBe("bad type");
    expect(err.detail).toBe("image/gif");
  });
});

describe("errorResponse", () => {
  it("builds a Lambda-proxy response with error + code in the body", () => {
    const res = errorResponse({
      headers: HEADERS,
      statusCode: 422,
      code: CODES.IMAGE_UNREADABLE,
      message: "Could not read this prescription.",
    });
    expect(res.statusCode).toBe(422);
    expect(res.headers).toBe(HEADERS);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ error: "Could not read this prescription.", code: "IMAGE_UNREADABLE" });
  });

  it("includes detail and requestId only when provided", () => {
    const withExtras = JSON.parse(errorResponse({
      headers: HEADERS,
      statusCode: 500,
      code: CODES.PROCESSING_FAILED,
      message: "boom",
      detail: "stack-ish",
      requestId: "req-123",
    }).body);
    expect(withExtras).toEqual({ error: "boom", code: "PROCESSING_FAILED", detail: "stack-ish", requestId: "req-123" });

    const withoutExtras = JSON.parse(errorResponse({
      headers: HEADERS,
      statusCode: 500,
      code: CODES.PROCESSING_FAILED,
      message: "boom",
    }).body);
    expect(withoutExtras).not.toHaveProperty("detail");
    expect(withoutExtras).not.toHaveProperty("requestId");
  });
});
