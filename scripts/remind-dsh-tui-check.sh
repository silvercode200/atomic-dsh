#!/usr/bin/env bash
# remind-dsh-tui-check.sh — PostToolUse(Bash): напоминание АГЕНТУ после git commit.
#
# Юзер просил не показывать уведомления о новых версиях dsh-tui при старте сессий
# (SessionStart-хук check-dsh-tui-update.sh снят 2026-09-17), но проверять обновления
# надо — только по событию «после коммита» и с отчётом юзеру.
#
# Хук молчит для всех команд, кроме содержащих "git commit" (или git -C ... commit).
# Напоминание адресовано main-агенту; субагенты игнорируют (main проверит сам).

set -u

input="$(cat 2>/dev/null || true)"

case "$input" in
  *"git commit"*|*"git -C"*)
    case "$input" in
      *"git commit"*|*" commit -"*)
        echo "REMINDER (dsh-tui update): коммит прошёл — main-агент после волны запускает bash scripts/check-dsh-tui-update.sh и включает статус версий в отчёт юзеру. Субагентам: игнорировать, main проверит."
        ;;
    esac
    ;;
esac

exit 0
