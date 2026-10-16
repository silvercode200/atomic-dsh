#!/usr/bin/env node
// tests/scroll-saw-unmount-capture.test.mjs — unit-тест логики патча 79
// «scroll-saw-unmount-capture» (TG-DSH-MKS4-20260928 узел 5).
//
// ROOT CAUSE: measure effect (useLayoutEffect) читает ПРЕДЫДУЩИЙ
// calculateLayout pass. Ряд mount-ящийся в frame N и unmount-ящийся в
// frame N+1 НИКОГДА не измеряется → heightsRef missing/stale → heightOf
// возвращает kindAvg (±1 off) → bottomPad расходится с real yoga height →
// maxChildBottom осциллирует ±1 (418↔417) при scroll.
//
// FIX: в setRowRef ref callback, при unmount (el=null), захватить yoga
// height ПРЕДЫДУЩЕГО элемента из localRefs BEFORE deleting.
//
// Этот тест моделирует логику heightsRef/heightOf/total/bottomPad/
// maxChildBottom БЕЗ React/Yoga — чистая логика, демонстрирующая что
// unmount-capture устраняет ±1 осцилляцию.
//
// Запуск: node tests/scroll-saw-unmount-capture.test.mjs

import assert from 'node:assert/strict';

// ── Модель: mocks объектов ─────────────────────────────────────────────
// Эмулирует Ink DOM element с yogaNode (getComputedHeight возвращает
// последний calculateLayout результат).
class MockYogaNode {
  constructor(height) { this._h = height; }
  getComputedHeight() { return this._h; }
  getComputedTop() { return 0; }
}

class MockElement {
  constructor(height) { this.yogaNode = new MockYogaNode(height); }
}

// Эмулирует heightsRef, localRefs, kindAvgRef MessageList.js
const HEIGHTS_CACHE_MAX = 5000;

function makeListModel() {
  const heightsRef = new Map();       // heightsRef.current
  const localRefs = new Map();        // localRefs.current
  const kindAvgRef = new Map();       // kindAvgRef.current
  const heightsVersion = { val: 0 };  // heightsVersionRef.current

  const heightOf = (rowId, kind) =>
    heightsRef.get(rowId) ??
    (Math.round(kindAvgRef.get(kind)?.avg ?? 0) || 2); // DEFAULT_ROW_HEIGHT=2

  // computeTotalAndOffsets: эмулирует строки 476-480
  function computeTotalAndOffsets(rows) {
    const offsets = new Array(rows.length);
    let total = 0;
    for (let i = 0; i < rows.length; i++) {
      offsets[i] = total;
      total += heightOf(rows[i].id, rows[i].kind);
    }
    return { offsets, total };
  }

  // computeBottomPad: эмулирует строки 674-676
  function computeBottomPad(rows, start, end, total, offsets) {
    const mountedBottom = end < rows.length ? offsets[end] : total;
    return total - mountedBottom;
  }

  // computeMaxChildBottom: эмулирует render-node-to-output.js:685-699
  // children = [topPad_spacer, ...mounted_rows, bottomPad_spacer]
  // yoga heights: spacers use heightOf, mounted rows use REAL yoga height
  function computeMaxChildBottom(rows, start, end, offsets, total) {
    let topPad = offsets[start] ?? 0;
    let bottomPad = computeBottomPad(rows, start, end, total, offsets);

    // Simulate yoga layout: stack children vertically
    let y = 0;
    let maxBottom = 0;

    // topPad spacer (height = topPad, from heightOf)
    y += topPad;
    maxBottom = Math.max(maxBottom, y);

    // mounted rows (height = REAL yoga height, not heightOf)
    for (let i = start; i < end; i++) {
      const el = localRefs.get(rows[i].id);
      const realH = el?.yogaNode.getComputedHeight() ?? heightOf(rows[i].id, rows[i].kind);
      y += realH;
      maxBottom = Math.max(maxBottom, y);
    }

    // bottomPad spacer (height = bottomPad, from heightOf)
    y += bottomPad;
    maxBottom = Math.max(maxBottom, y);

    return maxBottom;
  }

  // measureEffect: эмулирует useLayoutEffect (строки 857-877)
  // ЧИТАЕТ ПРЕДЫДУЩИЙ calculateLayout — НЕ текущий
  // В модели: prevLayoutHeights содержит высоты из ПРЕДЫДУЩЕГО frame
  let prevLayoutHeights = new Map();

  function measureEffect() {
    let changed = false;
    for (const [id, el] of localRefs) {
      // В реальном коде: el.yogaNode?.getComputedHeight()
      // но useLayoutEffect читает ПРЕДЫДУЩИЙ pass — моделируем через
      // prevLayoutHeights (ряд мог быть absent в предыдущем frame)
      const h = prevLayoutHeights.get(id);
      if (h !== undefined && h > 0 && heightsRef.get(id) !== h) {
        heightsRef.set(id, h);
        heightsVersion.val++;
        changed = true;
      }
    }
    return changed;
  }

  // writeOutput: эмулирует calculateLayout — записывает heights в
  // prevLayoutHeights для следующего frame
  function writeOutput(rows, start, end) {
    const next = new Map();
    for (let i = start; i < end; i++) {
      const el = localRefs.get(rows[i].id);
      if (el) {
        next.set(rows[i].id, el.yogaNode.getComputedHeight());
      }
    }
    prevLayoutHeights = next;
  }

  // setRowRef WITHOUT MS.01.1 unmount-capture (original behavior)
  function setRowRefOriginal(rowId, el) {
    if (el)
      localRefs.set(rowId, el);
    else
      localRefs.delete(rowId);
  }

  // setRowRef WITH MS.01.1 unmount-capture (unmount-time height capture)
  function setRowRefPatched(rowId, el) {
    if (el) {
      localRefs.set(rowId, el);
    } else {
      // DSH-P79: capture height before deleting
      const prev = localRefs.get(rowId);
      if (prev !== undefined) {
        const h = prev.yogaNode?.getComputedHeight();
        if (h !== undefined && h > 0 && heightsRef.get(rowId) !== h) {
          if (heightsRef.size >= HEIGHTS_CACHE_MAX) {
            const oldest = heightsRef.keys().next().value;
            if (oldest !== undefined)
              heightsRef.delete(oldest);
          }
          heightsRef.set(rowId, h);
          heightsVersion.val++;
        }
      }
      localRefs.delete(rowId);
    }
  }

  return {
    heightsRef, localRefs, kindAvgRef, heightsVersion,
    heightOf, computeTotalAndOffsets, computeBottomPad, computeMaxChildBottom,
    measureEffect, writeOutput,
    setRowRefOriginal, setRowRefPatched,
  };
}

// ── Тесты ─────────────────────────────────────────────────────────────

function testRootCauseOscillationWithoutPatch() {
  // Сценарий: 3 ряда, R1 имеет real height=2, но heightsRef[R1] missing
  // (kindAvg для этого kind = 1). При scroll R1 входит/выходит из mount
  // window в consecutive frames → measure effect никогда не захватывает.
  //
  // БЕЗ патча 79: maxChildBottom осциллирует 418↔417 (total+1 ↔ total)
  // С патчем 79: maxChildBottom стабилен

  const model = makeListModel();

  // R0: height=10 (correct in heightsRef)
  // R1: height=2 (real), heightsRef missing → kindAvg=1
  // R2: height=5 (correct in heightsRef)
  const rows = [
    { id: 'r0', kind: 'user' },
    { id: 'r1', kind: 'assistant' },
    { id: 'r2', kind: 'tool' },
  ];

  // Seed heightsRef for R0 and R2 (correctly measured)
  model.heightsRef.set('r0', 10);
  model.heightsRef.set('r2', 5);
  // R1: NOT in heightsRef → heightOf falls back to kindAvg

  // Seed kindAvg: assistant kind avg = 1 (stale/wrong)
  model.kindAvgRef.set('assistant', { sum: 1, n: 1, avg: 1 });

  // Simulate scroll: R1 enters and leaves mount window
  // Frame 0: only R0 mounted (start=0, end=1)
  // Frame 1: R0+R1 mounted (start=0, end=2) — R1 enters
  // Frame 2: only R0 mounted (start=0, end=1) — R1 leaves

  const heights = { r0: 10, r1: 2, r2: 5 };

  // --- БЕЗ патча 79 ---
  const modelOrig = makeListModel();
  modelOrig.heightsRef.set('r0', 10);
  modelOrig.heightsRef.set('r2', 5);
  modelOrig.kindAvgRef.set('assistant', { sum: 1, n: 1, avg: 1 });

  // Frame 0: R0 mounted
  modelOrig.setRowRefOriginal('r0', new MockElement(heights.r0));
  modelOrig.writeOutput(rows, 0, 1);
  modelOrig.measureEffect();

  // Frame 1: R1 enters (mount in frame 1)
  modelOrig.setRowRefOriginal('r1', new MockElement(heights.r1));
  // measureEffect reads PREVIOUS layout (frame 0) — R1 wasn't mounted → no capture
  modelOrig.measureEffect();
  let { offsets: o1, total: t1 } = modelOrig.computeTotalAndOffsets(rows);
  let mcb1 = modelOrig.computeMaxChildBottom(rows, 0, 2, o1, t1);
  // writeOutput: calculateLayout for frame 1 — R1 now has height 2
  modelOrig.writeOutput(rows, 0, 2);

  // Frame 2: R1 leaves (unmount in frame 2)
  modelOrig.setRowRefOriginal('r1', null);
  // measureEffect: R1 not in localRefs → no capture
  modelOrig.measureEffect();
  let { offsets: o2, total: t2 } = modelOrig.computeTotalAndOffsets(rows);
  let mcb2 = modelOrig.computeMaxChildBottom(rows, 0, 1, o2, t2);
  modelOrig.writeOutput(rows, 0, 1);

  // БЕЗ патча: R1 mounted → maxChildBottom = total + 1 (real=2, heightOf=1)
  //            R1 unmounted → maxChildBottom = total
  assert.ok(mcb1 !== mcb2,
    `БЕЗ патча: maxChildBottom должен осциллировать (mounted=${mcb1} vs unmounted=${mcb2})`);
  assert.equal(Math.abs(mcb1 - mcb2), 1,
    `БЕЗ патча: разница должна быть ±1 (got ${Math.abs(mcb1 - mcb2)})`);

  // --- С патчем 79 ---
  const modelPatched = makeListModel();
  modelPatched.heightsRef.set('r0', 10);
  modelPatched.heightsRef.set('r2', 5);
  modelPatched.kindAvgRef.set('assistant', { sum: 1, n: 1, avg: 1 });

  // Frame 0: R0 mounted
  modelPatched.setRowRefPatched('r0', new MockElement(heights.r0));
  modelPatched.writeOutput(rows, 0, 1);
  modelPatched.measureEffect();

  // Frame 1: R1 enters
  modelPatched.setRowRefPatched('r1', new MockElement(heights.r1));
  modelPatched.measureEffect();
  let { offsets: p1, total: pt1 } = modelPatched.computeTotalAndOffsets(rows);
  let pmcb1 = modelPatched.computeMaxChildBottom(rows, 0, 2, p1, pt1);
  modelPatched.writeOutput(rows, 0, 2);

  // Frame 2: R1 leaves — unmount capture!
  modelPatched.setRowRefPatched('r1', null);
  // heightsRef should now have R1 = 2 (captured at unmount)
  assert.equal(modelPatched.heightsRef.get('r1'), 2,
    'С патчем: heightsRef[R1] должен быть захвачен при unmount (= 2)');

  modelPatched.measureEffect();
  let { offsets: p2, total: pt2 } = modelPatched.computeTotalAndOffsets(rows);
  let pmcb2 = modelPatched.computeMaxChildBottom(rows, 0, 1, p2, pt2);
  modelPatched.writeOutput(rows, 0, 1);

  // С патчем: maxChildBottom стабилен (R1 unmounted → bottomPad uses correct 2)
  assert.equal(pmcb1, pmcb2,
    `С патчем: maxChildBottom стабилен (mounted=${pmcb1} vs unmounted=${pmcb2})`);

  console.log(`  БЕЗ патча: mounted=${mcb1} unmounted=${mcb2} (Δ=${Math.abs(mcb1-mcb2)})`);
  console.log(`  С патчем:  mounted=${pmcb1} unmounted=${pmcb2} (Δ=${Math.abs(pmcb1-pmcb2)})`);
  console.log('  ✓ ±1 осцилляция устранена');
}

function testUnmountCaptureIdempotent() {
  // Если heightsRef уже имеет правильное значение, unmount capture не
  // должен перезаписывать его (идемпотентность через !== check)
  const model = makeListModel();
  model.heightsRef.set('r1', 5);  // already correct

  const el = new MockElement(5);  // same height
  model.setRowRefPatched('r1', el);
  model.setRowRefPatched('r1', null);  // unmount

  assert.equal(model.heightsRef.get('r1'), 5,
    'Идемпотентность: heightsRef не должен измениться если значение то же');
  console.log('  ✓ Идемпотентность: heightsRef не изменён при совпадении значения');
}

function testUnmountCaptureSkipsZeroHeight() {
  // Если yogaNode возвращает 0 или undefined (ряд не был в layout),
  // capture не должен записывать (h > 0 check)
  const model = makeListModel();

  const el = new MockElement(0);  // zero height — invalid
  model.setRowRefPatched('r1', el);
  model.setRowRefPatched('r1', null);

  assert.equal(model.heightsRef.get('r1'), undefined,
    'Skip: heightsRef не должен записать 0 height');
  console.log('  ✓ Skip: 0/undefined height не записывается');
}

function testUnmountCaptureUpdatesStaleEntry() {
  // Если heightsRef имеет stale значение (1), а yoga даёт правильное (2),
  // unmount capture должен обновить
  const model = makeListModel();
  model.heightsRef.set('r1', 1);  // stale

  const el = new MockElement(2);  // correct
  model.setRowRefPatched('r1', el);
  model.setRowRefPatched('r1', null);

  assert.equal(model.heightsRef.get('r1'), 2,
    'Update: stale heightsRef должен быть обновлён до правильного значения');
  console.log('  ✓ Update: stale значение обновлено до правильного');
}

function testScrollSimulationMultiFrame() {
  // Полная симуляция scroll: R1 входит/выходит из mount window
  // несколько раз (как при wheel scroll). Проверяем, что после первого
  // unmount-capture, maxChildBottom стабилен во всех последующих frames.
  const model = makeListModel();
  const rows = [
    { id: 'r0', kind: 'user' },
    { id: 'r1', kind: 'assistant' },
    { id: 'r2', kind: 'tool' },
  ];
  const heights = { r0: 10, r1: 2, r2: 5 };

  model.heightsRef.set('r0', 10);
  model.heightsRef.set('r2', 5);
  model.kindAvgRef.set('assistant', { sum: 1, n: 1, avg: 1 });

  // Initial: R0 mounted
  model.setRowRefPatched('r0', new MockElement(heights.r0));
  model.writeOutput(rows, 0, 1);
  model.measureEffect();

  const scrollHeights = [];

  // Simulate 5 scroll cycles: R1 enters then leaves
  for (let cycle = 0; cycle < 5; cycle++) {
    // R1 enters
    model.setRowRefPatched('r1', new MockElement(heights.r1));
    model.measureEffect();
    const { offsets: e1, total: et1 } = model.computeTotalAndOffsets(rows);
    const mcbIn = model.computeMaxChildBottom(rows, 0, 2, e1, et1);
    model.writeOutput(rows, 0, 2);
    scrollHeights.push(mcbIn);

    // R1 leaves
    model.setRowRefPatched('r1', null);
    model.measureEffect();
    const { offsets: e2, total: et2 } = model.computeTotalAndOffsets(rows);
    const mcbOut = model.computeMaxChildBottom(rows, 0, 1, e2, et2);
    model.writeOutput(rows, 0, 1);
    scrollHeights.push(mcbOut);
  }

  // After first unmount-capture (cycle 0, frame 2), heightsRef[R1] = 2
  // All subsequent frames should have stable maxChildBottom
  const firstOut = scrollHeights[1]; // first unmount
  const stableValue = firstOut;      // should be the same as mounted

  for (let i = 2; i < scrollHeights.length; i++) {
    assert.equal(scrollHeights[i], stableValue,
      `Frame ${i}: maxChildBottom=${scrollHeights[i]} должен быть стабилен (${stableValue})`);
  }

  // Verify no oscillation after first capture
  const uniqueHeights = new Set(scrollHeights.slice(2));
  assert.equal(uniqueHeights.size, 1,
    `После первого unmount-capture: все maxChildBottom должны совпадать (got ${uniqueHeights.size} unique values)`);

  console.log(`  Scroll heights: [${scrollHeights.join(', ')}]`);
  console.log(`  После 1-го capture: все значения = ${stableValue} (стабильно)`);
  console.log('  ✓ Многоцикловой scroll: стабильно после первого capture');
}

// ── Run ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const tests = [
  ['Root cause: ±1 осцилляция БЕЗ патча, устранена С патчем', testRootCauseOscillationWithoutPatch],
  ['Идемпотентность unmount capture', testUnmountCaptureIdempotent],
  ['Skip 0/undefined height', testUnmountCaptureSkipsZeroHeight],
  ['Update stale entry', testUnmountCaptureUpdatesStaleEntry],
  ['Многоциклевой scroll: стабильно после первого capture', testScrollSimulationMultiFrame],
];

for (const [name, fn] of tests) {
  try {
    console.log(`\n[${name}]`);
    fn();
    passed++;
  } catch (e) {
    console.error(`  ✗ FAIL: ${e.message}`);
    failed++;
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
