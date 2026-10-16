// Resolves the patched dsh-tui package location for tests.
// Default matches scripts/apply-dsh-overrides.sh (TUI_BASE); override with env.
import { pathToFileURL } from 'url';

export const TUI_BASE = process.env.TUI_BASE
    ?? `${process.env.HOME}/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui`;

export async function importTuiModule(relPath) {
    return import(pathToFileURL(`${TUI_BASE}/${relPath}`).href);
}
