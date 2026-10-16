#!/usr/bin/env node
// tests/repetition-guard.test.js — unit- и интеграционные тесты патча repguard
// (dsh-llm-pi-ai), узел api-retry задачи TG-DSH-TUI-RETRY-20260917.
//
// ЧТО тестирует:
//  1) чистую функцию dshPatchDetectRepetition, которую патч 9 (repguard)
//     врезает в dsh-llm-pi-ai/lib/index.js и экспортирует для тестов;
//  2) ИНТЕГРАЦИЮ: реальный генератор toStreamChunks извлекается из
//     пропатченного файла и прогоняется по синтетическому стриму дельт —
//     петля повторов обрывается LlmError TIMEOUT, разнообразные дельты — нет.
//     Реальный кейс — session ab4e8a78 turn 3 step 10 (17.09.2026): glm-5.3
//     повторяла JSON-фрагмент ~66 байт ~3000 раз внутри args run_code
//     (~398 КБ за 16m49s «Embellishing»).
//
// Запуск: node tests/repetition-guard.test.js
// Таргет: env DSH_LLM_PIAI_PATCH_TARGET (копия для изоляции) или глобальная
// установка dsh (npm root -g). TDD: до патча — RED (экспорта нет), после — GREEN.
//
// Пороги дефолтов (см. патч): окно 204800, args-кап 524288, minRepeats 51,
// maxPeriod 1024, minLoopBytes 2048 (байтовый пол от ASCII-art: короткие юниты
// требуют пропорционально больше повторов — детект требует >=2048 байт
// периодичного хвоста). Чистая функция читает только аргументы, не env.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";

function resolveTarget() {
	const env = process.env.DSH_LLM_PIAI_PATCH_TARGET;
	if (env && existsSync(env)) return env;
	const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
	const p = `${root}/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`;
	if (!existsSync(p)) throw new Error(`target not found: ${p} (установлен ли dsh?)`);
	return p;
}

const target = resolveTarget();
console.log(`target: ${target}`);

let mod;
try {
	mod = await import(target);
} catch (e) {
	console.log(`RED: import target failed: ${e.message}`);
	process.exit(1);
}

if (typeof mod.dshPatchDetectRepetition !== "function") {
	console.log("RED: dshPatchDetectRepetition не экспортирована — патч repguard не применён");
	process.exit(1);
}

const detect = mod.dshPatchDetectRepetition;
// Реальный фрагмент петли из session ab4e8a78 (шаг 10, ~66 байт).
const FRAG = '","description":"Show full activity loader and template rendering';
// Нормальный текст: абзацы с уникальным содержимым.
const normalText = Array.from({ length: 400 }, (_, i) =>
	`Paragraph ${i}: the quick brown fox analyses step ${i} with unique data ${i * 7} and varied conclusions.`).join("\n");

let failed = 0;
const cases = [];
const check = (name, fn) => cases.push([name, fn]);

// --- детекция петли (чистая функция) ------------------------------------------

check("синтетическая петля: фрагмент ×3000 детектируется (кейс абзаца в)", () => {
	const r = detect(FRAG.repeat(3000), 0, {});
	assert.equal(r.detected, true);
	assert.equal(r.reason, "loop");
});

check("реальная форма: префикс + фрагмент ×3000 без хвоста — детект (петля жива)", () => {
	const r = detect(`{"code":"ok()","description":"x${FRAG.repeat(3000)}`, 0, {});
	assert.equal(r.detected, true);
	assert.equal(r.reason, "loop");
});

check("граница повторов: ×50 не детектируется, ×51 детектируется", () => {
	assert.equal(detect(FRAG.repeat(50), 0, {}).detected, false);
	assert.equal(detect(FRAG.repeat(51), 0, {}).detected, true);
});

check("вердикт петли несёт period и repeats", () => {
	const r = detect("abcdef".repeat(400), 0, {}); // период 6, 400 повторов
	assert.equal(r.detected, true);
	assert.equal(r.period, 6);
	assert.equal(r.repeats, Math.max(51, Math.ceil(2048 / 6)));
});

check("петля в глубине длинного буфера видна через окно последних 200КБ", () => {
	const big = normalText.repeat(14).slice(0, 350000) + FRAG.repeat(3000);
	assert.equal(big.length > 500000, true);
	assert.equal(detect(big, 0, {}).detected, true);
});

check("петля, ЗАВЕРШИВШАЯСЯ хвостом, не детектируется (абортить нечего)", () => {
	const r = detect(`${FRAG.repeat(3000)}(конец дублирования)`, 0, {});
	assert.equal(r.detected, false);
});

// --- отсутствие ложных срабатываний ------------------------------------------

check("нормальный разнообразный текст не детектируется", () => {
	assert.equal(detect(normalText, 0, {}).detected, false);
});

check("10 повторов юнита — ниже порога, не детектируется", () => {
	assert.equal(detect("unit ".repeat(10), 0, {}).detected, false);
});

check("односимвольный пробег 2000 — не детект (minLoopBytes), 3000 — детект", () => {
	assert.equal(detect("a".repeat(2000), 0, {}).detected, false);
	assert.equal(detect("a".repeat(3000), 0, {}).detected, true);
});

// --- объём args ---------------------------------------------------------------

check("args свыше 512КБ детектируются (reason volume)", () => {
	const r = detect(normalText, 600000, {});
	assert.equal(r.detected, true);
	assert.equal(r.reason, "volume");
	assert.equal(r.bytes, 600000);
});

check("args ниже 512КБ не триггерят volume", () => {
	assert.equal(detect(normalText, 500000, {}).reason === "volume", false);
});

// --- переопределение порогов (чистая функция принимает opts) -------------------

check("пороги переопределяются opts: minRepeats=10 + minLoopBytes=100 ловит ×10", () => {
	const r = detect(FRAG.repeat(10), 0, { minRepeats: 10, minLoopBytes: 100 });
	assert.equal(r.detected, true);
	assert.equal(r.repeats, 10);
});

check("пустой/не-строковый буфер — не детект, не падает", () => {
	assert.equal(detect("", 0, {}).detected, false);
	assert.equal(detect(undefined, 0, {}).detected, false);
	assert.equal(detect(null, 999999, {}).reason, "volume");
});

// --- интеграция: реальный генератор toStreamChunks из пропатченного файла -------

async function loadPatchedStream() {
	const src = readFileSync(target, "utf8");
	const HB = "// dsh-patch-repguard begin";
	const HE = "// dsh-patch-repguard end";
	const hb = src.indexOf(HB);
	const he = src.indexOf(HE);
	assert.ok(hb >= 0 && he > hb, "repguard-хелперы не найдены в пропатченном файле");
	const helperSrc = src.slice(hb, he + HE.length);
	const fb = src.indexOf("async function* toStreamChunks");
	const fe = src.indexOf("//#endregion", fb);
	assert.ok(fb >= 0 && fe > fb, "toStreamChunks не найден в пропатченном файле");
	const fnSrc = src.slice(fb, fe);
	const code = `class LlmError extends Error {
	constructor(message, code) { super(message); this.code = code; }
}
const CallId = (x) => x;
${helperSrc}
${fnSrc}
export { toStreamChunks, LlmError };
`;
	return import("data:text/javascript;charset=utf-8," + encodeURIComponent(code));
}

check("ИНТЕГРАЦИЯ: генератор toStreamChunks обрывает петлю дельт LlmError TIMEOUT", async () => {
	const m = await loadPatchedStream();
	async function* loopStream() {
		yield { type: "toolcall_start", contentIndex: 0, partial: { content: [{ type: "toolCall", id: "call_1", name: "run_code" }] } };
		for (let i = 0; i < 200; i++) yield { type: "toolcall_delta", contentIndex: 0, delta: FRAG };
	}
	let err;
	try {
		for await (const chunk of m.toStreamChunks(loopStream(), 100000)) void chunk;
	} catch (e) {
		err = e;
	}
	assert.ok(err instanceof m.LlmError, `ожидался LlmError, получено: ${err}`);
	assert.equal(err.code, "TIMEOUT");
	assert.match(err.message, /repetition loop detected/);
});

check("ИНТЕГРАЦИЯ: разнообразные дельты генератор не обрывает (инвариант STREAM_CLOSED, не TIMEOUT)", async () => {
	const m = await loadPatchedStream();
	async function* okStream() {
		yield { type: "toolcall_start", contentIndex: 0, partial: { content: [{ type: "toolCall", id: "call_1", name: "run_code" }] } };
		for (let i = 0; i < 30; i++) yield { type: "toolcall_delta", contentIndex: 0, delta: `chunk-${i}-with-unique-payload-${i * 31};` };
	}
	let err;
	try {
		for await (const chunk of m.toStreamChunks(okStream(), 100000)) void chunk;
	} catch (e) {
		err = e;
	}
	// Стрим кончился без done/error — штатный инвариант модуля (STREAM_CLOSED);
	// важно, что это НЕ TIMEOUT-аборт репгарда.
	assert.ok(err instanceof m.LlmError, `ожидался LlmError STREAM_CLOSED, получено: ${err}`);
	assert.equal(err.code, "STREAM_CLOSED");
});

// --- сводка -------------------------------------------------------------------

for (const [name, fn] of cases) {
	try {
		await fn();
		console.log(`PASS ${name}`);
	} catch (e) {
		failed += 1;
		console.log(`FAIL ${name}: ${e.message}`);
	}
}
console.log(failed === 0 ? "\nGREEN: все проверки пройдены" : `\n${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
