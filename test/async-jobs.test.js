import test from "node:test";
import assert from "node:assert/strict";
import {
  asyncJobHeartbeatLabel,
  deepResearchJobPatch,
  heartbeatAutomationForAsyncJob,
  imageJobCompletedPatch,
  imageJobWaitingPatch,
  textJobPatch,
} from "../src/async-jobs.js";

test("heartbeat helpers expose expected async schedules", () => {
  assert.equal(asyncJobHeartbeatLabel("image"), "1-minute");
  assert.equal(asyncJobHeartbeatLabel("deep-research"), "10-minute");
  assert.equal(asyncJobHeartbeatLabel("unknown"), "10-minute");

  const automation = heartbeatAutomationForAsyncJob("job-1", "image");
  assert.equal(automation.kind, "heartbeat");
  assert.equal(automation.destination, "thread");
  assert.equal(automation.intervalSeconds, 60);
  assert.match(automation.prompt, /job-1/);
});

test("image job transitions wait until an asset pointer is available", () => {
  assert.deepEqual(imageJobWaitingPatch({ async_status: "queued" }), {
    status: "waiting",
    asyncStatus: "queued",
    message: "No image asset pointer yet.",
  });
});

test("image job completion transition records image artifacts", () => {
  const transition = imageJobCompletedPatch({
    history: { async_status: "complete", title: "Image Chat" },
    imagePath: "/tmp/image.png",
    contentType: "image/png",
  });

  assert.deepEqual(transition, {
    patch: { status: "completed", asyncStatus: "complete", message: undefined },
    artifacts: {
      image: "/tmp/image.png",
      imageContentType: "image/png",
      chatTitle: "Image Chat",
    },
  });
});

test("Deep Research transition waits when no report text is available", () => {
  const transition = deepResearchJobPatch({
    history: { async_status: "running" },
    report: { text: "", status: "running" },
    responsePath: "/tmp/response.md",
  });

  assert.deepEqual(transition, {
    patch: {
      status: "waiting",
      asyncStatus: "running",
      deepResearchStatus: "running",
      message: "Deep Research status: running; no report text yet.",
    },
    clearArtifacts: ["responseMarkdown"],
  });
});

test("Deep Research transition fails when report status fails without text", () => {
  const transition = deepResearchJobPatch({
    history: { async_status: "done" },
    report: { text: "", status: "failed" },
    responsePath: "/tmp/response.md",
  });

  assert.equal(transition.patch.status, "failed");
  assert.equal(transition.patch.deepResearchStatus, "failed");
  assert.deepEqual(transition.clearArtifacts, ["responseMarkdown"]);
});

test("Deep Research completion transition records response metadata", () => {
  const transition = deepResearchJobPatch({
    history: { async_status: "done", title: "Research Chat" },
    report: { text: "final report", status: "finished", reportMessageId: "msg-1" },
    responsePath: "/tmp/report.md",
  });

  assert.deepEqual(transition, {
    patch: {
      status: "completed",
      responseLength: 12,
      asyncStatus: "done",
      deepResearchStatus: "finished",
      message: undefined,
    },
    artifacts: {
      responseMarkdown: "/tmp/report.md",
      chatTitle: "Research Chat",
      reportMessageId: "msg-1",
    },
    responseText: "final report",
  });
});

test("text job transition waits until assistant text is available", () => {
  const transition = textJobPatch({
    history: { async_status: "in_progress" },
    text: "",
    responsePath: "/tmp/response.md",
  });

  assert.deepEqual(transition, {
    patch: { status: "waiting", asyncStatus: "in_progress", message: "No assistant text yet." },
    clearArtifacts: ["responseMarkdown"],
  });
});

test("text job completion transition records response artifact", () => {
  const transition = textJobPatch({
    history: { async_status: "done", title: "Text Chat" },
    text: "assistant response",
    responsePath: "/tmp/text.md",
  });

  assert.deepEqual(transition, {
    patch: { status: "completed", responseLength: 18, asyncStatus: "done", message: undefined },
    artifacts: {
      responseMarkdown: "/tmp/text.md",
      chatTitle: "Text Chat",
    },
    responseText: "assistant response",
  });
});
