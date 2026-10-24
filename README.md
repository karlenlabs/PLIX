# PLIX

PLIX — компактный плеер для настольной Яндекс Музыки в Windows.
Приложение использует React, Vite, Tauri 2 и Rust. Управление воспроизведением
работает через системную медиасессию; Яндекс Музыка должна быть запущена отдельно.

## Возможности

- Обложка, название трека, воспроизведение/пауза, переключение треков и перемотка.
- Громкость и выключение звука для приложения Яндекс Музыки.
- Светлая и тёмная темы, закрепление поверх окон, меню и значок в трее.
- Сохраняемые настройки оформления и визуализация с FFT-аудиоданными.
- DEV Visual Tuning для настройки поверхности, цветов и диагностики визуальных слоёв.

Доступность медиакоманд зависит от активной медиасессии Яндекс Музыки.
Захват аудио для визуализации зависит от поддержки process-loopback в Windows.

## Требования

- Windows 11 — основная целевая платформа.
- Настольное приложение Яндекс Музыки и Microsoft Edge WebView2 Runtime.
- Node.js 20.19+ или 22.12+ с npm, совместимый с Vite 7.
- Rust с MSVC toolchain, Visual Studio Build Tools с C++ и Windows SDK.

Все команды ниже выполняются из корня этой копии проекта.

## Установка и запуск

```powershell
npm ci
npm run tauri -- dev
```

Для браузерного frontend используйте `npm run dev`. Нативные медиакоманды
требуют запуска через Tauri. `start-dev.bat` запускает приложение из каталога,
в котором находится сам BAT-файл.

## Проверка и сборка

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml --locked
```

Первая команда создаёт production frontend в `dist/`; вторая проверяет Rust-код.
Эти команды не создают release EXE. Для сборки desktop production используйте
Tauri CLI, который включает production protocol и встраивает frontend:

```powershell
npm run tauri -- build --no-bundle --features tauri/custom-protocol
```

Не используйте обычный `cargo build --release` вместо Tauri CLI:
`src-tauri/build.rs` проверяет наличие production protocol.

## DEV-инструменты

`npm run dev:tuning` запускает DEV player и панель Visual Tuning.
Каталог `src/dev/` сохранён полностью: его валидаторы используются также
DEV-мостом в конфигурации Vite. Диагностические режимы активируются в DEV.
Постоянные алгоритмы палитры находятся в `src/palette/`, оформление — в
`src/design/`. Сохранённые DEV-настройки остаются в локальном хранилище браузера.

## Структура

- `src/` — интерфейс, оформление, визуализация и DEV-инструменты.
- `src-tauri/` — Windows-интеграция, аудио, хранение настроек и ресурсы приложения.
- `scripts/` — запуск DEV-панели, подготовка иконок и явное восстановление настроек.
- `assets/branding/plix/` — исходная графика и превью брендинга.
- [Контекстное меню](CONTEXT-MENU.md) — поведение и управление с клавиатуры.

Исторические тестовые наборы, прототипы, локальные данные и сборочные результаты
не входят в эту публичную копию. `package-lock.json` и `src-tauri/Cargo.lock`
фиксируют зависимости. Конфигурационные идентификаторы Ympleer сохранены для
совместимости настроек и Windows-интеграции.

## Сторонний код

- Lucide: [ISC license](src/context_menu/context-menu-icons/LICENSE).
- Локальный Windows-профиль Tauri single-instance: [MIT license](src-tauri/vendor/tauri-plugin-single-instance/LICENSE-MIT)
  и [описание происхождения](src-tauri/vendor/tauri-plugin-single-instance/UPSTREAM.md).
- Зависимости npm и Cargo сохраняют собственные лицензии.
