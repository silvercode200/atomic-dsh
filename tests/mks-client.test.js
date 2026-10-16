// Wave C tests (dsh-overrides 17): mini-key-switcher status-bar sources.
// Imports the PATCHED modules from the installed dsh-tui package directly, so
// the shipped behavior — not a copy — is what gets asserted.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { importTuiModule } from './tui-base.mjs';

const mks = await importTuiModule('lib/types/mksClient.js');

describe('loadMksConfig', () => {
    it('takes token from env MKS_SYNC_TOKEN first', () => {
        const cfg = mks.loadMksConfig({ MKS_SYNC_TOKEN: 'env-token' }, '/nonexistent-home');
        assert.strictEqual(cfg.syncToken, 'env-token');
        assert.strictEqual(cfg.app, 'dsh');
        assert.strictEqual(cfg.baseUrl, 'http://127.0.0.1:8350');
    });

    it('falls back to SWITCHER_SYNC_TOKEN', () => {
        const cfg = mks.loadMksConfig({ SWITCHER_SYNC_TOKEN: 'legacy-token' }, '/nonexistent-home');
        assert.strictEqual(cfg.syncToken, 'legacy-token');
    });

    it('reads refs.MKS_SYNC_TOKEN from ~/.dsh/.credentials.yaml without a YAML dep', () => {
        const home = fixtureHome(`
agent-default-model:
  provider: cli
refs:
  DSH_CLI_AUTH_TOKEN: sk-local-cli-proxy
  MKS_SYNC_TOKEN: 0123abcd
`);
        const cfg = mks.loadMksConfig({}, home);
        assert.strictEqual(cfg.syncToken, '0123abcd');
    });

    it('falls back to ~/.config/mks/config.json sync_token', () => {
        const home = mksConfigHome(JSON.stringify({ base_url: 'http://x:1', sync_token: 'json-token' }));
        const cfg = mks.loadMksConfig({}, home);
        assert.strictEqual(cfg.syncToken, 'json-token');
    });

    it('degrades to empty token when nothing exists (status fields stay hidden)', () => {
        const cfg = mks.loadMksConfig({}, '/nonexistent-home-for-wavec-tests');
        assert.strictEqual(cfg.syncToken, '');
    });
});

describe('parseSpending', () => {
    it('parses the real /api/apps/{name}/spending payload shape', () => {
        const payload = {
            source: 'logs/app_requests.jsonl',
            period: '24h',
            rows: [
                { key: 'haiku', requests: 59, cost_usd: 0.00034, prompt_tokens: 27627, completion_tokens: 8477 },
                { key: 'sonnet', requests: 15, cost_usd: 0.0000073 },
            ],
            summary: { period: '24h', requests: 76, cost_usd: 0.00035, avg_cost_per_request: 0.0000046 },
        };
        const parsed = mks.parseSpending(payload);
        assert.strictEqual(parsed.requests, 76);
        assert.ok(Math.abs(parsed.costUsd - 0.00035) < 1e-8);
        assert.strictEqual(parsed.perModel.get('haiku'), 59);
        assert.strictEqual(parsed.perModel.get('sonnet'), 15);
    });

    it('returns undefined on malformed payloads (never renders a wrong number)', () => {
        assert.strictEqual(mks.parseSpending(undefined), undefined);
        assert.strictEqual(mks.parseSpending(null), undefined);
        assert.strictEqual(mks.parseSpending('nope'), undefined);
        assert.strictEqual(mks.parseSpending({}), undefined);
        assert.strictEqual(mks.parseSpending({ rows: [] }), undefined);
        assert.strictEqual(mks.parseSpending({ summary: { requests: 'x', cost_usd: 1 } }), undefined);
    });

    it('ignores rows without a string key or numeric count', () => {
        const parsed = mks.parseSpending({ rows: [null, { requests: 3 }, { key: 'ok', requests: 'x' }, { key: 'good', requests: 2 }], summary: { requests: 2, cost_usd: 0 } });
        assert.strictEqual(parsed.perModel.size, 1);
        assert.strictEqual(parsed.perModel.get('good'), 2);
    });
});

describe('pickActiveModel', () => {
    const snap = counts => ({ requests: 0, costUsd: 0, perModel: new Map(Object.entries(counts)) });

    it('picks the model whose request count grew between polls', () => {
        const prev = snap({ opus: 3, haiku: 7 });
        const cur = snap({ opus: 3, haiku: 9 });
        assert.strictEqual(mks.pickActiveModel(prev, cur), 'haiku');
    });

    it('returns undefined without growth or without a previous snapshot', () => {
        const s = snap({ opus: 3 });
        assert.strictEqual(mks.pickActiveModel(undefined, s), undefined);
        assert.strictEqual(mks.pickActiveModel(s, s), undefined);
    });

    it('picks the largest delta on a tie in growth direction', () => {
        const prev = snap({ opus: 1, haiku: 1 });
        const cur = snap({ opus: 2, haiku: 5 });
        assert.strictEqual(mks.pickActiveModel(prev, cur), 'haiku');
    });

    it('treats a newly appeared model as growth', () => {
        const prev = snap({ opus: 3 });
        const cur = snap({ opus: 3, 'glm-5.3-flash': 1 });
        assert.strictEqual(mks.pickActiveModel(prev, cur), 'glm-5.3-flash');
    });
});

describe('formatSpendingCost', () => {
    it('keeps 4 digits below a tenth of a cent, 3 below a cent', () => {
        // 0.00035 rounds DOWN via IEEE754 (0.00034999...) — toFixed semantics
        assert.strictEqual(mks.formatSpendingCost(0.00035), '$0.0003');
        assert.strictEqual(mks.formatSpendingCost(0.00036), '$0.0004');
        assert.strictEqual(mks.formatSpendingCost(0.0001), '$0.0001');
        assert.strictEqual(mks.formatSpendingCost(0.009), '$0.009');
    });
    it('switches to two decimals at a cent and above', () => {
        assert.strictEqual(mks.formatSpendingCost(0.01), '$0.01');
        assert.strictEqual(mks.formatSpendingCost(1.5), '$1.50');
    });
    it('rejects non-numeric input', () => {
        assert.strictEqual(mks.formatSpendingCost(undefined), undefined);
        assert.strictEqual(mks.formatSpendingCost(NaN), undefined);
    });
});

// ---- fixture helpers ---------------------------------------------------------

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

// fixtureHome / mksConfigHome build throwaway HOME trees so the token
// resolution chain is exercised against files, not mocks.
function fixtureHome(credentialsYaml) {
    const home = mkdtempSync(join(tmpdir(), 'wavec-home-'));
    mkdirSync(join(home, '.dsh'), { recursive: true });
    writeFileSync(join(home, '.dsh', '.credentials.yaml'), credentialsYaml);
    return home;
}

function mksConfigHome(json) {
    const home = mkdtempSync(join(tmpdir(), 'wavec-home2-'));
    mkdirSync(join(home, '.config', 'mks'), { recursive: true });
    writeFileSync(join(home, '.config', 'mks', 'config.json'), json);
    return home;
}
