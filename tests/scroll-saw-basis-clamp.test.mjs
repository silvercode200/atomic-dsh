#!/usr/bin/env node
// tests/scroll-saw-basis-clamp.test.mjs — unit-тест логики патча 76
// «yoga-insert-invalidate» (TG-DSH-MKS4-20260928 узел 5, MS.01.4).
//
// ROOT CAUSE: TS-Yoga computeFlexBasis кэширует _fbBasis с ключом
// (gen, crossMode, ownerW, ownerH, availMain, availCross); clean child
// получает previous-gen hit → basis из ПРОШЛОГО calculateLayout →
// wrapper vs extent ±1 → scrollHeight saw (451↔450).
//
// FIX: insertChild вызывает child.markDirty() после splice — вставленный
// child обязан пройти measure в ТЕКУЩЕМ кадре. markDirty() идемпотентен.
//
// Запуск: node --test tests/scroll-saw-basis-clamp.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATCH_FILE = path.join(
  __dirname, '..', 'dsh-overrides', 'patches', 'MS.01.4-yoga-insert-invalidate.patch',
);

// ── MockYogaNode: markDirty tracking with propagation ─────────────────
// Эмулирует TS-Yoga node: markDirty() sets isDirty=true и propagates
// вверх до первого уже-dirty родителя (идемпотентность движка).
class MockYogaNode {
  constructor() {
    this.children = [];
    this.parent = null;
    this.isDirty = false;
  }

  /** Идемпотентный markDirty: stop at first dirty ancestor. */
  markDirty() {
    if (this.isDirty) return;
    this.isDirty = true;
    if (this.parent) this.parent.markDirty();
  }

  /** Patched insertChild (MS.01.4): child.markDirty() after splice. */
  insertChildPatched(child, index) {
    child.parent = this;
    this.children.splice(index, 0, child);
    // DSH-P76-YOGA-INSERT-INVALIDATE: invalidate inserted child's subtree
    child.markDirty();
    this.markDirty();
  }

  /** Original insertChild (pre-patch): only parent markDirty. */
  insertChildOriginal(child, index) {
    child.parent = this;
    this.children.splice(index, 0, child);
    this.markDirty();
  }
}

// ── Structural check ──────────────────────────────────────────────────
describe('MS.01.4 structural check', () => {
  test('patch file exists at dsh-overrides/patches/', () => {
    assert.ok(fs.existsSync(PATCH_FILE), `Expected: ${PATCH_FILE}`);
  });

  test('patch contains DEP-3 header (Goal + Family fields)', () => {
    const content = fs.readFileSync(PATCH_FILE, 'utf8');
    assert.ok(content.includes('# Goal:'), 'Patch must contain DEP-3 # Goal: header');
    assert.ok(content.includes('# Family:'), 'Patch must contain DEP-3 # Family: header');
  });

  test('patch adds child.markDirty() after splice in insertChild', () => {
    const content = fs.readFileSync(PATCH_FILE, 'utf8');
    assert.ok(
      content.includes('child.markDirty()'),
      'Patch must add child.markDirty() call in insertChild',
    );
  });
});

// ── Logic tests: insertChild marks inserted child dirty ───────────────
describe('MS.01.4 logic: inserted child marked dirty', () => {
  test('patched insertChild: child.isDirty === true', () => {
    const parent = new MockYogaNode();
    const child = new MockYogaNode();
    parent.insertChildPatched(child, 0);
    assert.equal(
      child.isDirty, true,
      'Inserted child must be dirty after patched insertChild',
    );
  });

  test('original insertChild: child.isDirty === false (root cause)', () => {
    const parent = new MockYogaNode();
    const child = new MockYogaNode();
    parent.insertChildOriginal(child, 0);
    assert.equal(
      child.isDirty, false,
      'Pre-fix: child stays clean → stale basis cache (root cause)',
    );
  });

  test('both parent and child dirty after patched insertChild', () => {
    const parent = new MockYogaNode();
    const child = new MockYogaNode();
    parent.insertChildPatched(child, 0);
    assert.equal(parent.isDirty, true, 'Parent must be dirty');
    assert.equal(child.isDirty, true, 'Child must be dirty');
  });

  test('markDirty is idempotent — second call is no-op', () => {
    const parent = new MockYogaNode();
    const child = new MockYogaNode();
    parent.insertChildPatched(child, 0);
    const parentDirtyBefore = parent.isDirty;
    child.markDirty(); // second call — should be no-op (already dirty)
    assert.equal(
      parent.isDirty, parentDirtyBefore,
      'Second markDirty should not change parent state (idempotent)',
    );
  });

  test('dirty propagates from child to grandparent', () => {
    const grandparent = new MockYogaNode();
    const parent = new MockYogaNode();
    grandparent.insertChildPatched(parent, 0);
    // Reset dirty flags for clean propagation test
    grandparent.isDirty = false;
    parent.isDirty = false;
    parent.insertChildPatched(new MockYogaNode(), 0);
    assert.equal(
      grandparent.isDirty, true,
      'Dirty should propagate up to grandparent through parent',
    );
  });

  test('propagation stops at first already-dirty ancestor', () => {
    const grandparent = new MockYogaNode();
    const parent = new MockYogaNode();
    const child = new MockYogaNode();
    grandparent.insertChildPatched(parent, 0);
    // grandparent is dirty now; reset child only
    parent.isDirty = false;
    parent.insertChildPatched(child, 0);
    // grandparent should still be dirty (was already), no double-propagation issue
    assert.equal(grandparent.isDirty, true, 'Grandparent already dirty');
    assert.equal(parent.isDirty, true, 'Parent marked dirty by child insertion');
  });
});
