-- wezterm.lua — конфиг живого стенда dsh на Colab VM (scripts/wezterm-live/).
-- Паритет с юзером: WezTerm 20240203-110809-5046fc22, JetBrains Mono,
-- truecolor. Растер настоящий (BSU/ESU путь рендера — цель стенда), но
-- GPU нет → Software front-end.
local wezterm = require 'wezterm'
local config = wezterm.config_builder()

-- Геометрия через env (WT_COLS/WT_ROWS) — гибкие прогоны без правки файла.
local cols = tonumber(os.getenv('WT_COLS') or '120')
local rows = tonumber(os.getenv('WT_ROWS') or '48')
config.initial_cols = cols
config.initial_rows = rows

-- Headless: без GPU/ compositor. webgpu_power_preference НЕ задаём:
-- в 20240203 значения camelCase ('LowPower'), а snake_case 'low_power' =
-- фатальная Configuration Error (mux-сокет не поднимается).
config.front_end = 'Software'

-- Шрифт = дефолт юзера WezTerm (JetBrains Mono, если найден через
-- fontconfig; иначе встроенный fallback).
config.font = wezterm.font('JetBrains Mono', { weight = 'Regular' })
config.font_size = 12.0

-- Чистое окно без лишнего хрома (сравнимость кадров между геометриями).
-- adjust_window_size_when_term_size_changed В 20240203 НЕТ: config_builder
-- строгий, неизвестное поле = Configuration Error-окно + дефолт 80x24.
config.hide_tab_bar_if_only_one_tab = true
config.window_padding = { left = 0, right = 0, top = 0, bottom = 0 }
config.window_decorations = 'NONE'

-- Поведение как у юзера: scrollback есть (E1-детектор считает копии
-- статус-строки в истории), audible_bell off.
config.scrollback_lines = 3500
config.audible_bell = 'Disabled'

-- Не расходиться с юзером в оптике строк: без лигатур-тюнинга,
-- дефолтная политика переноса.
return config
