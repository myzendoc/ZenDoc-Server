import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeClinicalHtml, sanitizeSoapContent } from "../utils/clinicalHtml.js";

test("clinical HTML keeps formatting and removes executable markup", () => {
  const input = '<p style="color:red" onclick="steal()">Plan <strong>today</strong></p>'
    + '<img src=x onerror="steal()"><script>steal()</script><iframe src="https://evil.test"></iframe>';
  const output = sanitizeClinicalHtml(input);

  assert.equal(output, "<p>Plan <strong>today</strong></p>");
  assert.doesNotMatch(output, /script|iframe|onerror|onclick|style=/i);
});

test("SOAP content only retains supported sanitized sections", () => {
  const output = sanitizeSoapContent({
    subjective: "<p>Stable</p>",
    plan: '<div onmouseover="steal()">Follow up</div>',
    unexpected: "not retained",
  });

  assert.deepEqual(output, {
    subjective: "<p>Stable</p>",
    plan: "<div>Follow up</div>",
  });
});
