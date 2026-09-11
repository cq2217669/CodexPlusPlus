import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const revision = "test-placement";
const buttonAttr = `data-cpo-button-${revision}`;
const hostAttr = `data-cpo-composer-${revision}`;

class TestElement {
  tagName: string;
  textContent = "";
  parentElement: TestElement | null = null;
  children: TestElement[] = [];
  attributes = new Map<string, string>();
  rect = { left: 0, right: 100, top: 100, bottom: 130 };

  constructor(tagName = "div", label = "") {
    this.tagName = tagName.toUpperCase();
    this.textContent = label;
  }

  get parentNode() { return this.parentElement; }
  get firstChild() { return this.children[0] || null; }
  get isConnected(): boolean { return this.tagName === "BODY" || Boolean(this.parentElement?.isConnected); }
  get nextSibling() {
    const siblings = this.parentElement?.children || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  contains(node: TestElement): boolean { return node === this || this.children.some((child) => child.contains(node)); }
  getBoundingClientRect() { return this.rect; }
  appendChild(child: TestElement) { this.insertBefore(child, null); }
  insertBefore(child: TestElement, before: TestElement | null) {
    if (before) assert.equal(before.parentElement, this);
    child.remove();
    child.parentElement = this;
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child);
  }
  remove() {
    const siblings = this.parentElement?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  querySelectorAll(selector: string): TestElement[] {
    return this.children.flatMap((child) => [
      ...(selector === "button"
        ? child.tagName === "BUTTON" ? [child] : []
        : child.hasAttribute(selector.slice(1, -1)) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

async function setup() {
  const source = await readFile(
    new URL("../../../assets/inject/prompt-optimize-inject.js", import.meta.url), "utf8",
  );
  const extract = (start: string, end: string) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    return source.slice(from, to);
  };
  const body = new TestElement("body");
  const composer = new TestElement();
  composer.setAttribute("aria-label", "composer-surface");
  const input = new TestElement("textarea");
  const toolbar = new TestElement();
  const access = new TestElement("button", "完全访问");
  access.rect = { left: 20, right: 90, top: 100, bottom: 130 };
  const model = new TestElement("button", "6 Astra 高");
  model.rect = { left: 100, right: 200, top: 100, bottom: 130 };
  const send = new TestElement("button");
  send.setAttribute("aria-label", "Send message");
  send.rect = { left: 210, right: 240, top: 100, bottom: 130 };
  body.appendChild(composer);
  composer.appendChild(input);
  composer.appendChild(toolbar);
  toolbar.appendChild(access);
  toolbar.appendChild(model);
  toolbar.appendChild(send);
  const document = {
    body,
    createElement: (tag: string) => new TestElement(tag),
    querySelector: (selector: string) => body.querySelectorAll(selector)[0] || null,
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
  };
  const api = Function("Element", "HTMLElement", "document", "input", `
    const INSTANCE_REVISION = "${revision}";
    const BUTTON_ATTR = "${buttonAttr}";
    const runtime = { disposed: false };
    const isVisible = (element) => element.isConnected;
    const normalizeText = (text) => String(text || "").trim();
    const findComposerInput = () => input;
    const refreshButtonAppearance = () => {};
    const createButton = () => {
      const button = document.createElement("button");
      button.setAttribute(BUTTON_ATTR, "true");
      return button;
    };
    ${extract("  function isSendLikeLabel(", "  function findComposerInput(")}
    ${extract("  function buttonBelongsToComposer(", "  function scheduleSentDraftCleanup(")}
    ${extract("  function composerInsertAnchor(", "  function destroyAll(")}
    return { composerInsertAnchor, ensureButton, isAccessPermissionLikeLabel, isSendLikeLabel };
  `)(TestElement, TestElement, document, input) as {
    composerInsertAnchor(input: TestElement): { node: TestElement; before: TestElement | null } | null;
    ensureButton(): void;
    isAccessPermissionLikeLabel(text: string): boolean;
    isSendLikeLabel(text: string): boolean;
  };
  return { ...api, body, composer, input, toolbar, access, model, send };
}

describe("润色按钮定位", () => {
  it("固定在访问权限控件右侧", async () => {
    const fixture = await setup();
    fixture.ensureButton();
    assert.equal(fixture.composer.firstChild, fixture.input);
    assert.deepEqual(fixture.toolbar.children.map((child) => child.tagName), ["BUTTON", "SPAN", "BUTTON", "BUTTON"]);
    assert.equal(fixture.access.nextSibling?.nextSibling, fixture.model);
    assert.equal(fixture.body.querySelectorAll(`[${buttonAttr}]`).length, 1);
  });

  it("追问长内容时仍固定在访问权限控件右侧", async () => {
    const fixture = await setup();
    fixture.composer.setAttribute("data-composer-placement", "thread");
    const sendGroup = new TestElement();
    fixture.toolbar.insertBefore(sendGroup, fixture.send);
    sendGroup.appendChild(fixture.send);

    fixture.ensureButton();

    assert.equal(fixture.toolbar.children[0], fixture.access);
    assert.equal(fixture.access.nextSibling?.nextSibling, fixture.model);
    assert.deepEqual(sendGroup.children, [fixture.send]);
    assert.equal(fixture.body.querySelectorAll(`[${buttonAttr}]`).length, 1);
  });

  it("支持输入框到操作栏之间超过六层包装", async () => {
    const fixture = await setup();
    for (let depth = 0; depth < 8; depth += 1) {
      const wrapper = new TestElement();
      fixture.input.parentElement!.insertBefore(wrapper, fixture.input);
      wrapper.appendChild(fixture.input);
    }
    assert.deepEqual(fixture.composerInsertAnchor(fixture.input), {
      node: fixture.toolbar, before: fixture.model,
    });
  });

  it("模型名称变化不会影响访问权限旁的固定位置", async () => {
    const fixture = await setup();
    fixture.model.textContent = "custom-text";
    fixture.ensureButton();
    assert.equal(fixture.toolbar.children[0], fixture.access);
    assert.equal(fixture.access.nextSibling?.nextSibling, fixture.model);
  });

  it("访问权限被额外包装时仍插在其右侧", async () => {
    const fixture = await setup();
    const accessControl = new TestElement();
    fixture.toolbar.insertBefore(accessControl, fixture.access);
    accessControl.appendChild(fixture.access);
    fixture.ensureButton();
    assert.deepEqual(fixture.toolbar.children.map((child) => child.tagName), ["DIV", "SPAN", "BUTTON", "BUTTON"]);
    assert.equal(fixture.toolbar.children[1].nextSibling, fixture.model);
    assert.equal(accessControl.firstChild, fixture.access);
  });

  it("不把其他行的访问权限控件当作底栏锚点", async () => {
    const fixture = await setup();
    fixture.access.rect = { left: 20, right: 90, top: 40, bottom: 70 };
    assert.equal(fixture.composerInsertAnchor(fixture.input), null);
  });

  it("访问权限控件不可用时不回退到模型或发送按钮", async () => {
    const fixture = await setup();
    fixture.access.textContent = "custom-control";
    fixture.ensureButton();
    assert.equal(fixture.body.querySelectorAll(`[${buttonAttr}]`).length, 0);
  });

  it("操作栏延迟挂载时等待，不在输入区顶部插入悬浮按钮", async () => {
    const fixture = await setup();
    fixture.toolbar.remove();
    fixture.ensureButton();
    assert.equal(fixture.body.querySelectorAll(`[${buttonAttr}]`).length, 0);
    fixture.composer.appendChild(fixture.toolbar);
    fixture.ensureButton();
    assert.equal(fixture.access.nextSibling?.nextSibling, fixture.model);
  });

  it("重新归位仍可见的错位按钮，后续检查不重复创建", async () => {
    const fixture = await setup();
    fixture.ensureButton();
    const misplaced = fixture.access.nextSibling!;
    fixture.composer.insertBefore(misplaced, fixture.input);
    fixture.ensureButton();
    const placed = fixture.access.nextSibling;
    assert.notEqual(placed, misplaced);
    assert.equal(placed?.nextSibling, fixture.model);
    fixture.ensureButton();
    assert.equal(fixture.access.nextSibling, placed);
    assert.equal(fixture.body.querySelectorAll(`[${buttonAttr}]`).length, 1);
    assert.equal(fixture.body.querySelectorAll(`[${hostAttr}]`).length, 1);
  });

  it("发送控件暂时消失时保留当前输入栏的按钮，恢复后再对齐", async () => {
    const fixture = await setup();
    fixture.ensureButton();
    const placed = fixture.access.nextSibling;
    fixture.send.remove();
    fixture.ensureButton();
    assert.equal(fixture.body.querySelectorAll(`[${buttonAttr}]`).length, 1);
    assert.equal(fixture.access.nextSibling, placed);
    fixture.toolbar.appendChild(fixture.send);
    fixture.ensureButton();
    assert.equal(fixture.access.nextSibling?.nextSibling, fixture.model);
  });

  it("识别访问权限的中文状态与英文可访问名称", async () => {
    const fixture = await setup();
    for (const label of ["完全访问", "访问权限", "需要批准", "只读", "Full access", "Ask for approval", "Read-only", "Access mode"]) {
      assert.equal(fixture.isAccessPermissionLikeLabel(label), true, label);
    }
    assert.equal(fixture.isAccessPermissionLikeLabel("访问设置"), false);
  });

  it("识别发送和停止的完整标签，并支持 title 标签", async () => {
    const fixture = await setup();
    for (const label of ["Send", "Send message", "Submit prompt", "Stop generating", "发送", "发送消息", "提交提示词", "停止生成", "发送（Enter）"]) {
      assert.equal(fixture.isSendLikeLabel(label), true, label);
    }
    assert.equal(fixture.isSendLikeLabel("发送设置"), false);
    fixture.send.setAttribute("aria-label", "");
    fixture.send.setAttribute("title", "发送消息");
    assert.equal(fixture.composerInsertAnchor(fixture.input)?.before, fixture.model);
  });

  it("不越过当前表单借用其他输入区的发送按钮", async () => {
    const fixture = await setup();
    const form = new TestElement("form");
    fixture.composer.insertBefore(form, fixture.input);
    form.appendChild(fixture.input);
    assert.equal(fixture.composerInsertAnchor(fixture.input), null);
  });
});
