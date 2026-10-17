// tests/run-code-syntax-error-recovery.test.js — TDD red→green для core-патча 09.
// «run_code syntax-error recovery» (TG-DSH-CODERUN-20261018).
//
// КОНТРАКТ (TDD red, до патча 09 — падает на assert.doesNotThrow):
//   Когда runtime.run() возвращает {error: {kind:"exception", message:"..."}}
//   (синтаксическая ошибка в программе — обрезанный tool_call от relay/model,
//    напр. «Unterminated template literal»), run_code.execute ДОЛЖЕН:
//     - ВЕРНУТЬ результат с isError:true и content-текстом ошибки
//       (стандартный tool-error protocol — модель видит ошибку, self-corrects);
//     - НЕ выбрасывать CodeRunFailedError (который убивает весь ход агента
//       через schedulerFailure → executeToolCalls re-throw → turn/end
//       {kind:"error"} → agent/error — диагностика подтверждена в
//       dsh-agent-loop/lib/index.js:746 no-try-catch + :611-626 catch).
//
// ROOT CAUSE (sonnet-debugger, code:line evidence):
//   - dsh-tools/lib/index.js:1337 runtime.run({program: args.code}) →
//     worker-thread/lib/index.js:786 stripTypeScriptTypes throws на обрезанном
//     code → :789 failureBeforeWorker({kind:"exception", message:...}).
//   - dsh-tools/lib/index.js:1353-1355: if (result.error) throw new
//     CodeRunFailedError(...) — throw, НЕ return. Этот throw пробивает
//     runGroup (dispatch promise reject → schedulerFailure re-throw →
//     executeToolCalls без try-catch → step() без try-catch → turn() catch
//     turnEnds={kind:"error"} → throwError). Модель НЕ получает tool_result.
//
// FIX (core-patch 09):
//   Вместо throw — return {content:[{type:"text", text:"Error: ..."}],
//   isError:true, error:{message, info:{name:"CodeRunFailedError",
//   code:result.error.kind}}}. Совпадает с каноном toolErrorResult
//   (dsh-tools/lib/index.js:3492-3506) и normalizeDispatchResult:3451
//   (scheduler уже умеет isError:true returns).
//
// Запуск (Zorin OK — pure ESM import + node:test, БЕЗ React/Yoga/GUI/сети):
//   node --test tests/run-code-syntax-error-recovery.test.js
//
// ИНСТРУМЕНТ: ToolRuntime.prototype.requireCodeTransport.call(fakeThis) —
// достаёт реальный run_code tool definition на минимальном fake-this (патч 05
// использовал тот же приём в repro-runcode-desc.mjs). createRunCodeTool не
// экспортируется — это единственный чистый способ достучаться без
// конструирования полного ToolRuntime (его конструктор тянет ctx.systemPrompt,
// layers, super(ctx,"tools") и т.д.).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DSH_TOOLS_INDEX = process.env.DSH_TOOLS_INDEX ||
	join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');

const FOUND = existsSync(DSH_TOOLS_INDEX);
const mod = FOUND ? await import(DSH_TOOLS_INDEX) : {};
const { ToolRuntime, CodeRunFailedError } = mod;

/**
 * Минимальный fake-registry для requireCodeTransport(): предоставляет 4
 * option-getter'а, которые createRunCodeTool читает из options (а options
 * собирает requireCodeTransport из this-методов). Ни registry, ни ctx, ни
 * layers для теста синтаксической ошибки НЕ нужны — runtime.run() фейлит
 * ДО любого sub-call dispatch.
 *
 * @param {object} runtime - mock runtime с методом run()
 * @returns {object} fake this-bound registry
 */
function fakeRegistry(runtime) {
	return {
		defaultMode: 'typescript',
		maxParallelSubCalls: 10,
		shapeDispatchLog: () => ({}),
		requireCodeRuntime: () => runtime,
		// schemas() вызывается в execute (index.js:1327) для сборки sub-call
		// bindings — на синтаксической ошибке до dispatch не доходит, но цикл
		// drive() стартует ДО runtime.run, поэтому итератор нужен.
		schemas: () => [],
		ctx: { get: () => runtime }
	};
}

/**
 * Достаёт run_code tool definition из живого dsh-tools (post-05 state).
 * @param {object} runtime - mock runtime
 * @returns {object} {definition, execute}
 */
function getRunCodeDefinition(runtime) {
	const fake = fakeRegistry(runtime);
	// requireCodeTransport собирает options из this-методов и зовёт
	// createRunCodeTool(this, options) — определение кешируется в this.codeTransport.
	return ToolRuntime.prototype.requireCodeTransport.call(fake);
}

/**
 * Минимальный exec: execute(args, exec) на синтаксической ошибке трогает
 * только exec.signal (addEventListener для abort-bridge). agent/rootCallId/
 * token нужны только для sub-call dispatch, который не доходит.
 */
function fakeExec() {
	const ac = new AbortController();
	return { signal: ac.signal };
}

test('run_code.execute: синтаксическая ошибка программы → isError:true return, НЕ throw', { skip: !FOUND }, async () => {
	// Симулируем truncated tool_call: 2-й template literal без закрывающего backtick
	// (тот же паттерн, что в инциденте TG-DSH-CODERUN-20261018 — relay обрезал code).
	const truncatedCode = 'const a = `ok`\nconst b = `unterminated';
	const syntaxErrorMessage = 'Unterminated template literal. (1:17)';

	// Mock runtime: run() возвращает {error: {kind:"exception", message:...}}
	// — точно как worker-thread:789 failureBeforeWorker на stripTypeScriptTypes throw.
	const mockRuntime = {
		language: 'typescript',
		run: async () => ({
			logs: [],
			error: { kind: 'exception', message: syntaxErrorMessage }
		})
	};

	const definition = getRunCodeDefinition(mockRuntime);
	assert.equal(definition.name, 'run_code', 'достали run_code definition');

	const exec = fakeExec();

	// RED (до патча 09): execute выбрасывает CodeRunFailedError → test падает на throw.
	// GREEN (после патча 09): execute возвращает isError:true результат.
	// Прямой await — любой throw провалит тест естественным путём.
	const result = await definition.execute({ code: truncatedCode }, exec);

	assert.ok(result, 'execute должен вернуть результат (не undefined)');
	assert.equal(result.isError, true, 'результат должен быть isError:true');
	assert.ok(Array.isArray(result.content), 'content должен быть массивом');
	assert.ok(result.content.length > 0, 'content не пуст');
	assert.equal(result.content[0].type, 'text', 'content[0].type=text');
	assert.ok(
		/Error/i.test(result.content[0].text),
		`content text должен содержать "Error", got: ${JSON.stringify(result.content[0].text).slice(0, 120)}`
	);
	// Сообщение об ошибке синтаксиса должно дойти до модели (для self-correction).
	assert.ok(
		result.content[0].text.includes(syntaxErrorMessage) ||
		/Unterminated/i.test(result.content[0].text),
		`content text должен нести исходное сообщение синтаксической ошибки, got: ${JSON.stringify(result.content[0].text).slice(0, 200)}`
	);
	// error-поле (для scheduler error.info): канон toolErrorResult.
	assert.ok(result.error, 'должно быть error-поле');
	assert.equal(typeof result.error.message, 'string');
});

test('run_code.execute: обрезанный второй template literal (репро инцидента) → isError:true', { skip: !FOUND }, async () => {
	// Точная форма инцидента: 3865B code, второй template literal без закрывающего backtick,
	// БЕЗ description (патч 05 сделал description опциональным).
	const incidentCode = [
		'const r1 = await tools.bash({ command: "echo hello" })',
		'const summary = `',
		'Result: ${r1.stdout}',
		'// relay truncated here — no closing backtick'
	].join('\n');

	const mockRuntime = {
		language: 'typescript',
		run: async () => ({
			logs: [],
			error: { kind: 'exception', message: 'Unterminated template literal. (3:0)' }
		})
	};

	const definition = getRunCodeDefinition(mockRuntime);
	const exec = fakeExec();

	const result = await definition.execute({ code: incidentCode }, exec);

	assert.equal(result.isError, true, 'isError:true');
	assert.equal(result.content[0].type, 'text');
	assert.match(result.content[0].text, /Error/i);
});

test('run_code.execute: успешный прогон НЕ isError (regression guard)', { skip: !FOUND }, async () => {
	// Guard: патч 09 не должен ломать success-path — runtime.run без error
	// возвращает {logs, result} как раньше.
	const mockRuntime = {
		language: 'typescript',
		run: async () => ({
			logs: ['hello world'],
			value: 42
		})
	};

	const definition = getRunCodeDefinition(mockRuntime);
	const exec = fakeExec();

	const result = await definition.execute({ code: 'return 42' }, exec);

	assert.equal(result.isError, undefined, 'success path: isError не выставлен');
	assert.deepEqual(result.logs, ['hello world']);
	assert.equal(result.result, 42);
});

test('CodeRunFailedError всё ещё экспортируется (API stability)', { skip: !FOUND }, () => {
	// Guard: патч 09 убирает throw, но класс остаётся в exports (другие сайты
	// могут его ловить / инстанцировать — не ломаем API).
	assert.ok(CodeRunFailedError, 'CodeRunFailedError экспортируется');
	assert.equal(typeof CodeRunFailedError, 'function');
});
