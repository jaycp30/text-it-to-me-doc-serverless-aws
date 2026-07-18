import { describe, it, expect } from "vitest";

import {
  ERROR_COPY,
  ApiError,
  classifyError,
  resolveErrorCopy,
  UNKNOWN_CODE,
} from "./errors.js";

// Every backend code the API can return should have frontend copy. Kept in sync
// with backend/functions/processPrescription/errors.js + getUploadUrl codes.
const BACKEND_CODES = [
  "MISSING_IMAGES", "TOO_MANY_IMAGES", "MISSING_USER", "MISSING_CONTACT",
  "UNSUPPORTED_FILE", "IMAGE_UNREADABLE", "SCHEDULE_CREATE_FAILED",
  "DUPLICATE_IN_PROGRESS", "PREVIOUS_UPLOAD_FAILED", "PROCESSING_FAILED",
  "INVALID_PAGE", "UPLOAD_URL_FAILED",
];
// Client-derived codes.
const CLIENT_CODES = ["UPLOAD_FAILED", "TIMEOUT", "NETWORK_ERROR"];

describe("ERROR_COPY coverage", () => {
  it("has title/body/retry copy for every known code", () => {
    for (const code of [...BACKEND_CODES, ...CLIENT_CODES]) {
      expect(ERROR_COPY[code], `missing copy for ${code}`).toBeTruthy();
      expect(ERROR_COPY[code].title).toBeTruthy();
      expect(ERROR_COPY[code].body).toBeTruthy();
      expect(ERROR_COPY[code].retry).toBeTruthy();
    }
  });

  it("gives different retry guidance for different failure types", () => {
    // The whole point of #11: guidance must not be one-size-fits-all.
    expect(ERROR_COPY.UNSUPPORTED_FILE.retry).not.toBe(ERROR_COPY.NETWORK_ERROR.retry);
    expect(ERROR_COPY.DUPLICATE_IN_PROGRESS.retry).not.toBe(ERROR_COPY.IMAGE_UNREADABLE.retry);
  });
});

describe("classifyError", () => {
  it("maps an aborted request to TIMEOUT", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyError(abort)).toEqual({ code: "TIMEOUT" });
  });

  it("maps a fetch TypeError (offline/DNS) to NETWORK_ERROR", () => {
    expect(classifyError(new TypeError("Failed to fetch"))).toEqual({ code: "NETWORK_ERROR" });
  });

  it("passes through a known backend code with its diagnostics", () => {
    const err = new ApiError("IMAGE_UNREADABLE", "blurry", { status: 422, requestId: "req-1", detail: "no json" });
    expect(classifyError(err)).toEqual({ code: "IMAGE_UNREADABLE", requestId: "req-1", detail: "no json" });
  });

  it("falls back to the HTTP status when an ApiError has no/unknown code", () => {
    expect(classifyError(new ApiError(undefined, "gateway timeout", { status: 504 })).code).toBe("TIMEOUT");
    expect(classifyError(new ApiError("NONSENSE", "weird", { status: 502 })).code).toBe("SCHEDULE_CREATE_FAILED");
    expect(classifyError(new ApiError(undefined, "teapot", { status: 418 })).code).toBe(UNKNOWN_CODE);
  });

  it("classifies an unexpected error as UNKNOWN and keeps its message as detail", () => {
    expect(classifyError(new Error("kaboom"))).toEqual({ code: UNKNOWN_CODE, detail: "kaboom" });
  });
});

describe("resolveErrorCopy", () => {
  it("returns the matching copy for a known code", () => {
    expect(resolveErrorCopy("TIMEOUT")).toBe(ERROR_COPY.TIMEOUT);
  });

  it("falls back to generic copy for an unknown code", () => {
    const copy = resolveErrorCopy("SOMETHING_NEW");
    expect(copy.title).toBeTruthy();
    expect(copy.body).toBeTruthy();
    expect(copy.retry).toBeTruthy();
  });
});
