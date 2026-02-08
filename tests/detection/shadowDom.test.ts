/**
 * Tests for querySelectorAllDeep - Shadow DOM traversal
 * Validates that deep querying works when root element itself has a shadow root
 */

import { describe, it, expect, beforeEach } from "vitest";
import { querySelectorAllDeep } from "../../src/content/modules/utils";

describe("querySelectorAllDeep", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("should find elements in regular DOM", () => {
    document.body.innerHTML = `
      <div>
        <img src="test.png" class="test-img">
        <p>Text</p>
      </div>
    `;

    const results = querySelectorAllDeep("img", document.body);
    expect(results).toHaveLength(1);
    expect((results[0] as HTMLImageElement).src).toContain("test.png");
  });

  it("should find elements inside shadow DOM of root element", () => {
    // Create a custom element with a shadow root containing an img
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<p>Text</p><img src="shadow-img.png">';

    // When querySelectorAllDeep is called with the host as root,
    // it should find the img inside the shadow root
    const results = querySelectorAllDeep("img", host);
    expect(results).toHaveLength(1);
    expect((results[0] as HTMLImageElement).src).toContain("shadow-img.png");
  });

  it("should find elements in nested shadow DOMs", () => {
    // Simulate NetAcad structure: host > shadow > inner-host > shadow > img
    const outerHost = document.createElement("div");
    document.body.appendChild(outerHost);
    const outerShadow = outerHost.attachShadow({ mode: "open" });

    const innerHost = document.createElement("div");
    outerShadow.appendChild(innerHost);
    const innerShadow = innerHost.attachShadow({ mode: "open" });
    innerShadow.innerHTML = '<div class="mcq__body-inner"><p><img src="nested-img.png"></p></div>';

    // Search from outer host - should find the deeply nested img
    const results = querySelectorAllDeep("img", outerHost);
    expect(results).toHaveLength(1);
    expect((results[0] as HTMLImageElement).src).toContain("nested-img.png");
  });

  it("should find elements with class selector in nested shadow DOM", () => {
    const outerHost = document.createElement("div");
    document.body.appendChild(outerHost);
    const outerShadow = outerHost.attachShadow({ mode: "open" });

    const innerHost = document.createElement("div");
    outerShadow.appendChild(innerHost);
    const innerShadow = innerHost.attachShadow({ mode: "open" });
    innerShadow.innerHTML = '<div class="mcq__body-inner">Question text here</div>';

    const results = querySelectorAllDeep(".mcq__body-inner", outerHost);
    expect(results).toHaveLength(1);
    expect(results[0].textContent).toBe("Question text here");
  });

  it("should find multiple elements across shadow boundaries", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    // One img in shadow
    shadow.innerHTML = '<img src="img1.png"><div id="inner"></div>';
    const innerHost = shadow.querySelector("#inner")!;
    const innerShadow = innerHost.attachShadow({ mode: "open" });
    // Another img in nested shadow
    innerShadow.innerHTML = '<img src="img2.png">';

    const results = querySelectorAllDeep("img", host);
    expect(results).toHaveLength(2);
  });

  it("should work when root has no shadow root (regular element)", () => {
    const div = document.createElement("div");
    div.innerHTML = '<span class="test">Hello</span>';
    document.body.appendChild(div);

    const results = querySelectorAllDeep(".test", div);
    expect(results).toHaveLength(1);
    expect(results[0].textContent).toBe("Hello");
  });

  it("should return empty array when nothing matches", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<p>No images here</p>";

    const results = querySelectorAllDeep("img", host);
    expect(results).toHaveLength(0);
  });

  it("should work with ShadowRoot as root parameter", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<img src="test.png">';

    const results = querySelectorAllDeep("img", shadow);
    expect(results).toHaveLength(1);
  });
});
