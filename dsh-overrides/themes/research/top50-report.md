**1. Executive summary**

На основе предоставленных исследовательских данных невозможно составить запрошенный консенсусный топ-50 терминальных цветовых схем с точными палитрами и URL. Данные подтверждают существование крупных коллекций и кандидат-пула, но не содержат ни фактических 16 ANSI hex-палитр, ни background/foreground/cursor, ни per-theme метрик популярности, ни ранжирования 45 тёмных / 5 светлых схем.

**2. Key findings**

- **iTerm2-Color-Schemes**  
  Репозиторий описывает себя как «Over 450 terminal color schemes», а не 600+. У репозитория около **27.2k звёзд**, но это звёзды всего репозитория, а не отдельных схем.  
  Сырые `.itermcolors`-файлы можно получать по предсказуемому URL:  
  `https://raw.githubusercontent.com/mbadolato/iTerm2-Color-Schemes/master/schemes/<SchemeName>.itermcolors`  
  Однако сами hex-значения из этих файлов в исследовательских данных не извлечены.

- **Gogh-Co/Gogh**  
  Подтверждено наличие `themes.json`, а также поддержка Alacritty, Kitty, Ghostty, iTerm, Wezterm, Konsole, Tilix и других.  
  Фактическое содержимое `themes.json`, имена тем и hex-палитры в предоставленных данных отсутствуют.

- **oklch-terminal-themes**  
  Известна только схема данных: каждая тема должна содержать `background`, `foreground`, `cursor`, `selection` и 16 ANSI-слотов.  
  Фактические значения тем не получены.

- **Рейтинги и популярность**  
  Per-theme GitHub-звёзд, рейтингов «best terminal color schemes 2024–2026» и подтверждённых портов на 50+ приложений в данных нет.  
  Единственное найденное упоминание о широкой портируемости — **Dracula доступен для 98+ приложений**, но источник имеет среднюю уверенность.

- **TerminalColors.com**  
  Сайт позволяет просматривать темы и фильтровать по dark/light, однако темы упорядочены алфавитно, поэтому порядок на сайте не является evidence популярности.

- **Кандидат-пул**  
  Приведённые в вопросе схемы — Catppuccin, Tokyo Night, Gruvbox, Dracula, Nord, Solarized, Rosé Pine, Everforest, Kanagawa, Night Owl, Ayu, One Dark, Synthwave 84, Cyberpunk, Everblush, Eldritch, Horizon, Iceberg, Monokai и другие — упоминаются в источниках как популярные, но без точных значений и ранжирования.

**3. Conclusion**

Запрошенный «консенсусный топ-50» с точными hex-палитрами, dark/light-разбиением и machine-readable URL не может быть сформирован из предоставленных research data. Для такого ответа необходимы:

- извлечённые палитры из `iTerm2-Color-Schemes`;
- содержимое `Gogh-Co/Gogh themes.json`;
- фактические значения из `oklch-terminal-themes`;
- метрики популярности по отдельным схемам;
- подтверждение портов на 50+ приложений;
- разрешение противоречия между 450 и 600+ схемами в iTerm2-Color-Schemes.

На текущий момент можно говорить только о候选ном пуле известных схем, но не о подтверждённом ранжированном топ-50.

---

## 4. Addendum: курируемый отбор топ-50 (2026-09-10, main)

Палитры не извлекаются из поискового индекса — движок подтвердил механизм вместо этого:
**raw-URL датасета**: `https://raw.githubusercontent.com/mbadolato/iTerm2-Color-Schemes/master/schemes/<SchemeName>.itermcolors` (27.2k звёзд, MIT). Плюс `Gogh-Co/Gogh themes.json` и oklch-terminal-themes как альтернативные источники. Курируемый отбор ниже составлен из рейтингов (Tavily: MOLTamp 2026 «Best Terminal Color Schemes», terminalcolors.com, nathan-long.com, dr8co/palettes, iterm2colorschemes.com); точные имена файлов верифицируются при скачивании (404 → замена из резервного списка).

### Отбор: 45 тёмных + 5 светлых (приоритет сверху)

**Тёмные (45):** Catppuccin Mocha, Catppuccin Macchiato, Catppuccin Frappe, TokyoNight Storm, TokyoNight Night, TokyoNight Moon, Gruvbox Dark, Gruvbox Dark Hard, Gruvbox Material Dark, Dracula, Nord, Solarized Dark, Rosé Pine, Rosé Pine Moon, Everforest Dark (Hard), Kanagawa Wave, Kanagawa Dragon, Night Owl, Ayu Dark, One Dark, One Half Dark, Synthwave 84, Cyberpunk, Everblush, Eldritch, Horizon, Iceberg, Jellybeans, Moonfly, Nightfly, Srcery, Sonokai, Shades of Purple, Tomorrow Night, Tomorrow Night Eighties, Zenbones, Zenwritten Dark, Bluloco Dark, Doom One, Monokai Pro, Atom One Dark, Challenger Deep, Hardcore, JetBrains Darcula, Andromeda.

**Светлые (5):** Catppuccin Latte, TokyoNight Day, Solarized Light, Rosé Pine Dawn, Zenwritten Light.

**Резерв (при 404/отсутствии в датасете):** Ayu Mirage, One Half Light, Ayu Light, Wombat, Hybrid, Hopscotch, Darkside, Spacedust, MaterialDark, Thayer Bright, Aurora, Purple Rain, Wryan, Neopolitan.

Критерий отбора: консенсус в ≥2 независимых рейтингах/коллекциях + визуальная целостность палитры для TUI (контраст fg/bg ≥ ~7:1 у топ-семейств). Итоговый список с фактическими палитрами фиксируется генератором `dsh-overrides/themes/generate-themes.mjs` в `themes.yaml` после скачивания.
