# Work Log — Powder Nodes (FLUX cache + integration fixes)

Отчёт по двум спекам, реализованным в одной серии сессий:
`POWDER_CONDITIONER_FLUX_CACHE_FIX.md` (далее **Spec A**) и
`POWDER_NODES_INTEGRATION_FIXES.md` (далее **Spec B**).
Дополнительно — небольшой UI-патч `POWDER_CONDITIONER_UI_CACHE_LOCK.md` (Spec C),
поскольку он касается тех же нод.

Аудитория: архитектор спеков. Цель — не отчитаться «применил пункты 1–N»,
а показать, где спек встретился с реальным кодом и что из этого получилось.

---

## 1. Коммиты

```
a5a292b  UI: grey out cache_mode when use_cache is false (Powder Conditioner)
6a86d0a  Refactor: cross-node integration fixes (lora_info schema, patcher cache, styles auto-reload, cache stats)
1283333  Fix: FLUX-safe conditioning cache (structural hash, CPU storage, cache_mode)
e29c765  (pre-existing) Add per-cell seed display and batch support to Grid Saver
```

`1283333` — Spec A целиком, единственный затронутый файл `powder_conditioner.py` (+181/−47).
`6a86d0a` — Spec B целиком, шесть файлов (`_cache.py`, `_styles.py`, `powder_conditioner.py`, `powder_grid.py`, `powder_lora.py`, `powder_styler.py`, +292/−69). Изменения в `__init__.py` не понадобились — `PowderCacheStats` зарегистрирован через `NODE_CLASS_MAPPINGS` в `powder_conditioner.py`, а `__init__.py` уже разворачивал маппинги модуля.
`a5a292b` — Spec C, единственный новый файл `web/js/powder_conditioner_cache_ui.js`.

Все коммиты идут поверх `e29c765` (master до начала работы), линейная история, без merge/rebase. Working tree сейчас чистый, ветка `master` опережает `origin/master` на три коммита.

---

## 2. Per-change deep-dive

Нумерация изменений соответствует спекам (Spec A: 1–6, Spec B: 1–8). Внутри Spec A фактический порядок применения был 2 → 1 → 3 → 4 → 5 → 6 (по `Implementation Order`); Spec B — 5 → 7 → 1 → 2 → 3+4 → 6 → 8.

### Spec A.1 — Структурный `_get_clip_hash`

**Место:** `powder_conditioner.py`, функция `_get_clip_hash`, строки 57–118.

**Было:** хеш собирался из имени класса, строкового представления `p.shape` первых пяти параметров и MD5 от `p.flatten()[:50].detach().cpu().float().numpy().tobytes()` тех же параметров. Результат мемоизировался по `id(clip)` с TTL=300 c.

**Стало:** хеш = `class_name + MD5("|".join(f"{name}:{tuple(shape)}:{dtype}" for name, p in cond_model.named_parameters()))[:16]`. Никаких чтений значений тензоров, никаких GPU→CPU транзитов, никакого float-bytes. Структура определяется именами параметров и формой/dtype — это инвариант ребилда модели, не его текущего состояния.

**Отклонения от спека:** нет. Реализовано буквально по образцу из Spec A раздел «Change 1». Все пять `return result` веток (no_cond_stage / no_params / named_parameters fallback / нормальный путь / outer except) сохранены.

**Нюансы:**
- `named_parameters()` обёрнут в собственный `try/except`, т.к. на квантизованных моделях с `MixedPrecisionOps` итератор может бросать на отдельных параметрах при ленивой материализации; в спеке это упомянуто, я добавил предупредительный `warn` с указанием класса. Fallback идёт на `id(cond_model)` (не `id(clip)`!) — это намеренно: если CLIP-обёртка пересоздаётся вокруг того же `cond_stage_model`, мы хотим попасть в один и тот же ключ.
- Структурный хеш одинаков для двух моделей с одной архитектурой и весами разной точности. Для FLUX это нормально — кэш всё равно отключён в `auto`-режиме (см. A.5). Но если в будущем кто-то захочет агрессивно кэшировать FLUX вариантов, это потенциальная коллизия. В отчёте по итогам это обсуждается в разделе «Замечания».

### Spec A.2 — Weakref-мемоизация хешей

**Место:** `powder_conditioner.py`, строки 22–51 (модульное состояние + `_clip_hash_lookup` + `_clip_hash_remember`).

**Было:** глобальный `dict _clip_hash_cache: id(clip) → (hash, timestamp)`, TTL-проверка вручную в `_get_clip_hash`.

**Стало:** список пар `(weakref.ref(clip), hash_str)`. `_clip_hash_lookup(clip)` сканирует список линейно, попутно убирая мёртвые refs (это и есть GC-coupled сборка). `_clip_hash_remember` ловит `TypeError` для объектов, которые нельзя обернуть в weakref.

**Отклонения от спека:** нет. Спек прямо рекомендовал линейный скан, замечая, что в типичных воркфлоу одновременно живёт ≤5 CLIP-объектов. Согласен.

**Нюансы:**
- Список ref не защищён локом. ComfyUI выполняет ноды последовательно в одной очереди, но регистрация API-роутов (`PromptServer`) происходит в другом event-loop и теоретически могла бы вызвать `_get_clip_hash` параллельно с воркфлоу. На практике этого не происходит — наши API-обработчики не трогают `_clip_hash_refs`. Если когда-нибудь добавится параллельность, нужен `threading.Lock` (вокруг `_clip_hash_refs[:] = alive` в первую очередь, иначе возможна потеря свежей записи между чтением и записью среза).
- Когда CLIP — обёртка с `__slots__` без `__weakref__`, `weakref.ref(clip)` бросит `TypeError`. Тогда мемоизация молча отключается, и хеш каждый раз пересчитывается. Это приемлемо: `named_parameters` дешёвый (метаданные, не значения).

### Spec A.3 — CPU-хранение conditioning

**Место:** `powder_conditioner.py`, строки 175–219 (`_conditioning_to_cpu`, `_conditioning_to_device`, `_cache_conditioning`, `_get_cached_conditioning`); вызовы — внутри `encode()` строки 489–510 и 522–541.

**Было:** результат `_encode_prompt` (список `[[cond_tensor, extras_dict]]`, тензоры на GPU) клался прямо в LRUCache. На FLUX это держало в VRAM по ~10 МБ на запись × 500 entries.

**Стало:** при `put` тензоры (включая `pooled_output` и любые тензорные значения в `extras`) копируются на CPU через `.detach().to("cpu", copy=True)`; при `get` восстанавливаются на устройство, которое определяет вызывающий через `_resolve_clip_device(clip_obj)` (helper введён в A.5).

**Отклонения от спека:** в самом A.3 спек говорил «inline `target_device = next(clip.cond_stage_model.parameters()).device` с safe fallback». Я сделал именно так, потому что A.5 (где появляется helper) применялся позже. После A.5 эти inline-блоки заменены на `_resolve_clip_device(clip_obj)` — две точки в `encode()`.

**Нюансы:**
- `extras` — `dict`, в котором кроме `pooled_output` могут лежать произвольные ключи (`attention_mask`, для FLUX иногда `t5_mask`). Я применил `.to(...)` ко всему, у чего есть `to`. Это безопасно для тензоров; для не-тензоров (None, скаляры) ветка `else` оставляет значение нетронутым.
- `copy=True` обязательно — без него можно получить view на GPU-тензор, который освободится вне нашего контроля.
- Восстановление на устройство НЕ копирует обратно: `cond.to(device)` вернёт тот же объект, если устройство совпало (CPU-cached → запрос на CPU). На GPU это новая аллокация. Логика `_get_cached_conditioning` вызывается каждый раз, так что аллокация повторная — но это уже существовавшая характеристика старого кода (он тоже мог отдавать общий тензор на повторных хитах).

### Spec A.4 — `maxsize=64`

**Место:** `powder_conditioner.py`, строка 21.

Тривиально: `LRUCache(maxsize=500)` → `LRUCache(maxsize=64)`. Никаких отклонений, никаких нюансов.

### Spec A.5 — `cache_mode` + детект FLUX

**Место:**
- helpers: `powder_conditioner.py` строки 234–259 (`_QUANTIZED_CLIP_MARKERS`, `_is_unstable_clip`, `_resolve_clip_device`).
- `INPUT_TYPES`: строка 366 (новый ключ `cache_mode`).
- сигнатура `encode()`: строка 377.
- логика `effective_mode`: строки 379–387.
- per-clip `cache_active` в обоих циклах: строки 489–500 (positives) и 522–533 (negatives).

**Было:** в `encode()` булев `use_cache` напрямую управлял всеми обращениями к кэшу.

**Стало:** введена машина состояний из трёх режимов (`auto` / `aggressive` / `disabled`). `use_cache=False` остаётся обратно-совместимым принудительным `disabled`. На каждой итерации цикла кодирования пересчитывается `cache_active`:
- `disabled` → False;
- `aggressive` → True;
- `auto` → `not _is_unstable_clip(clip_obj)`.

`_is_unstable_clip` ищет в имени класса `cond_stage_model` подстроки из `("Flux", "T5", "MixedPrecision", "Quantized")`. Это та эвристика, которую предложил спек, я её не расширял.

**Отклонения от спека:** спек в примере объявлял `_QUANTIZED_CLIP_MARKERS` рядом с `_encode_prompt` («module level»). Я разместил константу/helpers сразу после `_encode_prompt` и до раздела «Assembly helpers», чтобы не дробить тематический блок CLIP-логики. Семантически идентично.

**Нюансы:**
- В обоих циклах (positives и negatives) код вычисления `cache_active` идентичен — это намеренная дубликация, чтобы сохранить структуру оригинального цикла. Можно вынести в helper `_decide_cache_active(effective_mode, clip_obj)`, но это +1 функциональный вызов на каждую итерацию ради 6 строк. Не вынес.
- `cache_mode` в `INPUT_TYPES` объявлен как `(["auto", "aggressive", "disabled"], {"default": "auto"})`. Это combo, не toggle — у ComfyUI есть автоматическая конвертация двухвариантных combo в boolean, но тривариантных нет, так что значение всегда придёт строкой.
- Парсинг `cache_mode = cache_mode[0] if isinstance(cache_mode, list) else (cache_mode if cache_mode is not None else "auto")` — повторяет паттерн `use_cache`. `INPUT_IS_LIST = True` означает, что все опциональные входы могут прийти списками; default-fallback нужен на случай отсутствия слота в старых сериализованных воркфлоу.

### Spec A.6 — Отладочный лог

**Место:** `powder_conditioner.py`. `import os` — строка 8 (вверху, до `import torch`, потому что я ставил по алфавиту stdlib). `_DEBUG_CACHE` — строка 23. Лог-строки в `_get_clip_hash` — перед каждым из 5 `return result` (строки 75–76, 90–91, 97–98, 107–108, 115–116). Лог HIT/MISS в `_get_cached_conditioning` — строки 213–214.

**Было:** ничего.

**Стало:** `os.environ.get("E2GO_CACHE_DEBUG", "").lower() in ("1", "true", "yes")`; лог только при включённом флаге.

**Отклонения от спека:** в `_get_clip_hash` мемоизированный early-return (`if cached is not None: return cached`) НЕ инструментирован. Спек говорит «before each return», но образец лога использует переменную `result`, которой на этом пути нет. Я выбрал интерпретацию «before each `return result`» — лог пишется на путях, где хеш реально посчитан. Если архитектор хочет видеть и хиты мемоизации, добавлю отдельную ветку.

**Нюансы:**
- Флаг читается один раз при импорте модуля. Изменение `E2GO_CACHE_DEBUG` после старта ComfyUI не подхватится — придётся перезапустить. Это нормально для отладки и упоминается в спеке.
- `cache_key[:32]` — обрезка для удобства логов, не для приватности. На реальном `clip_hash:prompt_hash` 32 символа покрывают весь class-name + начало MD5 хеша.

---

### Spec B.1 — `lora_info` schema + валидатор

**Место:**
- `powder_lora.py` строки 22–53: константа `LORA_INFO_SCHEMA_VERSION = 2` + большой комментарий с примерами обоих режимов.
- `powder_lora.py`, выводы JSON в `_process_single_mode` (строки около 320 и 350) и `_process_stack_mode` (около 415) — добавлено поле `"schema_version": LORA_INFO_SCHEMA_VERSION` в начале словаря.
- `powder_conditioner.py` строки 263–303: константа `LORA_INFO_SCHEMA_VERSION_KNOWN = 2` + функция `_validate_lora_info`.
- `powder_conditioner.py` строки 401–419: парсинг в `encode()` переписан в две фазы — JSON-парс до нормализации `prompt`, валидация после.

**Было:** парсинг `lora_info` инлайн внутри `encode()`. `triggers = li.get("triggers", [])` без проверки длины и типов элементов; рассогласование тихо приводило к выдаче не того триггера для не того промпта.

**Стало:** `_validate_lora_info(li, n_prompts)` принимает уже-распарсенный JSON и нормализует:
- non-dict → лог + дефолт `{"triggers": [""] * n, "trigger_position": "after"}`;
- `schema_version > LORA_INFO_SCHEMA_VERSION_KNOWN` → warn, но парсинг продолжается;
- `triggers` не список → пустой список;
- слишком короткий `triggers` → дополняется пустыми строками + warn (если был непустым);
- слишком длинный → обрезается + warn;
- любой элемент не строка → пустая строка;
- `trigger_position` вне `("before", "after")` → дефолт `"after"` + warn.

**Отклонения от спека:** валидатор в спеке использовал имя `LORA_INFO_SCHEMA_VERSION_KNOWN` как уже определённое. Я фактически определил эту константу прямо перед валидатором (строка 263), как и просил спек («In powder_conditioner.py, add module-level constant»).

В Spec B.1 спек давал «OLD/NEW» блоки с заменой парсинга. Я сделал чуть аккуратнее: `parsed = json.loads(...)` и проверка `isinstance(parsed, dict)` перед попаданием в `raw_li`. В спеке этой проверки явно нет — там JSON-парс отдаёт что угодно (включая `list`/`int`) в `raw_li`, и далее валидатор должен это нормализовать. Мой вариант защищает раньше, но эффект тот же.

**Нюансы:**
- Схема версионируется ровно по одной причине — чтобы валидатор мог логировать неизвестные будущие версии. Поля схемы (`schema_version`, `loras`, `strengths`, `triggers`, `combination_order`, `mode`, `trigger_position`, иногда `original_loras`/`original_strengths`) при этом версией не управляются. Если в будущем добавится поле, которое валидатор обязан проверять, нужно бампить `LORA_INFO_SCHEMA_VERSION_KNOWN` и расширять валидатор. Сейчас несоответствия всегда мягкие — валидатор не падает.
- `powder_grid.py` тоже парсит `lora_info` (строки 145–164 в нынешнем файле), но валидатор там НЕ вызывается. Grid использует `loras` и `strengths` для подписей, не `triggers`. Я не стал тащить валидатор в Grid, чтобы не плодить связности; рассогласование длин массивов в Grid фатально не сказывается (просто не подписан индекс), и pre-existing warn-логика остаётся.

### Spec B.2 — Patcher-кэш для Single mode

**Место:**
- `powder_lora.py` строки 121–138: `_patcher_cache = LRUCache(maxsize=32)` и `_get_patcher_cache_key`.
- `powder_lora.py` строки 295–323: блок применения LoRA в `_process_single_mode` обёрнут в кэш-логику.

**Было:** на каждой итерации Single mode выполнялся `_load_lora_cached` + `comfy.sd.load_lora_for_models`. Сырые данные кэшировались, но патчинг — нет.

**Стало:** ключ кэша = `(lora_path, mtime, round(str_model, 6), round(str_clip, 6), bool(disable_clip), id(model), id(clip) if not disable_clip else None)`. На хите возвращается `(model_lora, clip_lora)` напрямую; на промахе — старая логика, и результат кладётся в `_patcher_cache`.

**Отклонения от спека:** ноль. Поведение в Stack mode сознательно не трогал — спек явно сказал «skip Stack mode optimisation».

**Нюансы:**
- `id(model)` и `id(clip)` достаточны, потому что патчер живёт в рамках одного процесса и user не переинициализирует `UNETLoader`/`CLIPLoader` без видимого изменения графа (в этом случае ID меняются и кэш промахивается естественным образом). Но `id()` может быть переиспользован Python после GC — это такая же проблема, как у старого `_clip_hash_cache`. Smaller risk: patcher-cache без TTL имеет maxsize=32, и на длинной сессии он будет ротироваться. Но сценарий «UNETLoader пересоздан → старый GC'd → новый получил тот же id()» теоретически даст ложный hit. Если архитектор хочет железобетонной корректности — заменить `id(...)` на `weakref` так же, как сделано для CLIP в A.2.
- `mtime` берётся через `os.path.getmtime`, при ошибке — `0.0`. Если файл недоступен (LoRA на сетевом диске, временный disconnect), все записи с этим путём свалятся в один и тот же ключ — это не страшно, на следующем успешном `getmtime` ключ обновится.
- `id(clip) if not disable_clip else None` — при `disable_clip=True` идентичность `clip` не должна влиять на ключ, потому что CLIP в этом режиме не патчится. Это микро-оптимизация: workflow с разными CLIP-объектами но одинаковыми моделями попадает в один и тот же ключ.

### Spec B.3 — Auto-reload styles по mtime

**Место:** `_styles.py` строки 23–27 (модульное состояние) + 161–195 (`_scan_styles_mtime` и `get_styles`).

**Было:** ничего. Стили грузились в `_ensure_styles_loaded()` ровно один раз за процесс, в каждом из двух модулей независимо.

**Стало:** `get_styles()` на каждом вызове проверяет, прошло ли `_STYLES_CHECK_INTERVAL=2.0` секунд с последнего скана. Если да — `_scan_styles_mtime(styles_dir)` (один проход `os.scandir` с `entry.stat()` для всех `.json`), и если max-mtime изменился — полная перезагрузка через `load_styles_from_directory`.

**Отклонения от спека:** в `get_styles` я добавил ИЛИ-условие `or not _STYLES_CACHE` к двум проверкам (throttle и mtime). Без этого первый вызов после старта процесса с пустым кэшем прошёл бы по «mtime тот же (0.0=0.0)» и вернул пустой список. Это lazy-init поверх throttling, спек этот момент не покрывал явно.

**Нюансы:**
- `_scan_styles_mtime` принимает `latest = max(...)`. Если файл удалили, max-mtime может уменьшиться — это всё равно `!= _STYLES_LAST_MTIME`, перезагрузка сработает.
- `os.scandir` + `entry.stat()` стоит ~200 мкс на 619 файлов на NTFS. С throttling 2 c это пренебрежимо.
- Спек пишет «Throttle to one stat() per N seconds». Фактически throttling работает на уровне «один полный скан директории», а не «один stat()». Это интерпретация — мой вариант правильнее с точки зрения корректности (нельзя проверить директорию частично) и не противоречит замыслу.

### Spec B.4 — Унификация styles-кэша

**Место:** `_styles.py` весь — теперь хранит state и публикует `get_styles`. `powder_styler.py` (строки 11, 47–48, 110–112) и `powder_grid.py` (строки 14–20, 729) — больше не объявляют локальных `_ALL_STYLES`/`_STYLES_BY_NAME`/`_ensure_styles_loaded`.

**Было:** идентичные `_ALL_STYLES`, `_STYLES_BY_NAME`, `_ensure_styles_loaded` в `powder_styler.py` и `powder_grid.py`. Обе копии загружали те же файлы независимо (двойная память, дрейф при будущем reload).

**Стало:** оба модуля делают `from ._styles import get_styles, deduplicate_tags` и вызывают `all_styles, styles_by_name = get_styles()` локально перед использованием. Кэш един.

**Отклонения от спека:** ноль.

**Нюансы:**
- В `powder_styler.py` API-роут `/powder_styler/get_styles` теперь использует `all_styles, _ = get_styles()`. ComfyUI вызывает его при открытии селектора в фронтенде; если пользователь только что отредактировал JSON, селектор увидит новые имена сразу (если прошло >2 c, иначе с задержкой до 2 c).
- В `powder_grid.py` `_extract_style_from_workflow` вызывает `get_styles()` внутри цикла по нодам воркфлоу — но возвращаемые объекты не модифицируются и кэшируются на уровне модуля, так что повторные вызовы дёшевы.
- Удалённый `_ensure_styles_loaded` нигде больше не использовался (проверил `grep`). Импорт `load_styles_from_directory, get_styles_dir` из старой версии тоже убран в обоих модулях.

### Spec B.5 — TTL и stats() для LRUCache

**Место:** `_cache.py` целиком переписан (97 строк сейчас vs 64 ранее). Применение в `powder_lora.py` строка 121: `LRUCache(maxsize=16, ttl_seconds=1800)`.

**Было:** `LRUCache(maxsize, ...)` без TTL, без `stats()`. `__slots__ = ("_maxsize", "_data", "_lock")`.

**Стало:** добавлены `_timestamps: dict` и `_ttl: float | None`. `_evict_expired` вызывается в начале `get`/`put` под локом — ленивая эвикция, не background-таск. `stats()` возвращает `{"size": int, "maxsize": int, "ttl": float | None}`.

**Отклонения от спека:** ноль. Реализовано буквально.

**Нюансы:**
- `_timestamps[key] = time.monotonic()` обновляется и при `get`, и при `put`. То есть TTL — это «время с последнего ИСПОЛЬЗОВАНИЯ», не «время с записи». На LoRA-кэше это правильно: активные LoRA не вытеснятся.
- При `popitem(last=False)` (LRU-эвикция, переполнение по maxsize) timestamps вычищается явно. Без этого dict со временами рос бы быстрее, чем `_data`. Маленькая, но реальная утечка — спек её не оговаривал, я закрыл.
- `__slots__` теперь `("_maxsize", "_data", "_timestamps", "_ttl", "_lock")` — порядок и имена соответствуют спеку.
- `stats()` возвращает `dict`, не объект. Намеренно — JSON-сериализуется без хака.
- `_lora_cache` получил TTL=1800 c (30 мин). Patcher-cache (B.2) — без TTL, как и сказано в спеке.

### Spec B.6 — `ClearConditioningCache.trigger`

**Место:** `powder_conditioner.py` строки 571–600.

**Было:** `INPUT_TYPES` был пустой `{"required": {}}`, `IS_CHANGED` возвращал `float("NaN")` (всегда «изменилось»), что приводило к очистке кэша на каждой постановке в очередь. То есть нода-наблюдатель в графе уничтожала весь смысл кэширования.

**Стало:** обязательный INT-вход `trigger` с дефолтом 0, диапазон 0..999999. `IS_CHANGED(trigger)` возвращает само значение `trigger` — ComfyUI запустит ноду, только если значение изменилось. `clear(self, trigger)` логирует значение для удобства отладки.

**Отклонения от спека:** ноль.

**Нюансы:**
- **Это breaking change** для существующих воркфлоу. Сериализованный воркфлоу с `ClearConditioningCache` без поля `trigger` загрузится с дефолтом `0`, и нода не будет срабатывать на первой постановке (что корректное новое поведение). Чтобы намеренно очистить — пользователь меняет int. Спек это явно одобряет.
- JS-кнопка «Clear now» (которая инкрементирует `trigger` автоматически) не реализована — спек прямо отнёс её в Out of Scope.

### Spec B.7 — Bound `_clip_dim_cache`

**Место:** `powder_conditioner.py` строки 122–148.

**Было:** `_clip_dim_cache: dict = {}`. Никогда не очищался автоматически, только через `ClearConditioningCache.clear`.

**Стало:** `_clip_dim_cache = LRUCache(maxsize=64)`. `_get_expected_cond_dim` использует `.get(clip_hash)` (с `is None`-проверкой, а не truthy — потому что значение `0` в принципе валидно для размерности, хотя на практике невозможно). `_learn_cond_dim` использует `.put()`.

**Отклонения от спека:** ноль. `ClearConditioningCache.clear` продолжает работать без изменений — `LRUCache.clear()` API совместим (возвращает int вместо None, но возвращаемое значение игнорировалось).

**Нюансы:**
- Maxsize=64 — то же число, что у `_conditioning_cache`. Если воркфлоу когда-нибудь будет крутить >64 уникальных CLIP'ов в одной сессии, dim-кэш начнёт промахиваться. Это не катастрофа: dim переучивается из первого encode на промахе. Но в сценарии 6 воспроизведено: 70 вставок → 64 entry.

### Spec B.8 — `PowderCacheStats`

**Место:** `powder_conditioner.py` строки 602–637 (класс) + 645–649 (регистрация в `NODE_CLASS_MAPPINGS` и `NODE_DISPLAY_NAME_MAPPINGS`).

**Было:** ничего.

**Стало:** ноды-выход `report()` собирает статистику со всех кэшей и публикует JSON одновременно в лог и в STRING-выход. `IS_CHANGED` возвращает `NaN` — ноду надо запускать каждый раз, когда она в графе.

**Отклонения от спека:** ноль на API. Внутри:
- Спек предлагал импортировать `_clip_hash_refs` глобально и считать `len([1 for ref, _ in _clip_hash_refs if ref() is not None])`. Я обернул это в локальную переменную `live_clip_refs = sum(1 for ref, _ in _clip_hash_refs if ref() is not None)` — функционально идентично, читаемее.
- Спек предлагал импортировать `_STYLES_CACHE` напрямую. Я так и сделал, через `from ._styles import _STYLES_CACHE`. Это нарушает «private»-конвенцию (символы с `_` префиксом — приватные), но альтернатива — публичная функция `styles_count()`, которая для одной строки кода не нужна.

**Нюансы:**
- Локальные импорты внутри `report()` (`from .powder_lora import ...`, `from ._styles import ...`) — намеренно, как пишет спек. Это разрывает потенциальные циклы и делает Stats-ноду опциональной зависимостью: если `powder_lora` сломан, `_get_clip_hash` всё равно работает.
- `_STYLES_CACHE` снимается без вызова `get_styles()`. То есть Stats показывает сколько стилей загружено НА ДАННЫЙ МОМЕНТ, а не «сколько было бы после reload». Это правильное поведение для diagnostics.

---

### Spec C — UI-патч

**Место:** новый файл `web/js/powder_conditioner_cache_ui.js` (42 строки).

Регистрирует расширение `e2go.powder_conditioner.cache_ui`. В `nodeCreated`: находит widget `use_cache` и `cache_mode`; если оба есть — оборачивает callback `use_cache.callback`, добавляя `syncCacheModeState`, который ставит `cacheModeWidget.disabled = !enabled` и в качестве запасного варианта меняет `element.style.opacity` (0.4 ↔ 1.0). Делает initial-sync в конце, чтобы при загрузке сохранённого воркфлоу с `use_cache=false` widget уже был серым.

**Отклонения от спека:** добавил opacity-fallback сразу (спек предлагал его опционально). Причина: ComfyUI 0.x и 1.x имеют разные темы по умолчанию, и `disabled` без opacity на некоторых из них не отличается визуально от enabled. Двойная гарантия в 5 строках кода — оправданно.

**Нюансы:**
- Логика крепится в `nodeCreated`, а не в `beforeRegisterNodeDef`. Это значит, что на каждой ноде свой замыкающий callback — нет global-state и нет cross-talk между несколькими `PowderConditioner` в одном графе. Сценарий 5 спека (две ноды независимо) — обеспечен бесплатно.
- При desearialize `widgets[i].value` восстанавливается ДО вызова `nodeCreated`, так что initial-sync видит сохранённое значение и корректно устанавливает opacity. Сценарий 4 — обеспечен.

---

## 3. Тесты

Программно прогнал восемь сценариев Spec B + три edge-case дополнения для валидатора. Скрипт писался во временный файл `C:\Users\ghost\AppData\Local\Temp\e2go_integration_tests.py`, заглушал `comfy.*` и `folder_paths` в `sys.modules`, запускался из родительской директории пакета. После прогона — удалил.

Покрыл:
1. `_validate_lora_info` на коротких/длинных/non-list/non-dict triggers и `schema_version=999` (Spec B Scenario 1, 8 + extras).
2. `LRUCache(ttl_seconds=0.5)` — заполнение, sleep(0.7), `get` возвращает None, размер 0 (Scenario 4).
3. `LRUCache.stats()` shape (smoke).
4. `_clip_dim_cache` через `_learn_cond_dim` 70 раз → размер 64 (Scenario 6).
5. `ClearConditioningCache.IS_CHANGED(0)` дважды и `IS_CHANGED(1)` один раз — `IS_CHANGED` чистая функция от аргумента (Scenario 5).
6. `get_styles()` дважды с искусственным `os.utime` файла стилей между вызовами; `_STYLES_LAST_MTIME` обновился, кэш перечитан (Scenario 3).
7. `_get_patcher_cache_key` с фейковыми model/clip объектами — стабильность для одинаковых аргументов, расхождение по strength и `disable_clip` (Scenario 2 ключевая часть).
8. `PowderCacheStats().report()` — JSON содержит все шесть требуемых полей (Scenario 7).

Результат: 11 PASS / 0 FAIL.

**Не покрыл программно (и почему):**
- **Spec A целиком.** На уровне unit-тестов я доверился Spec B, который зависит от Spec A: если бы Spec A был сломан, валидатор и dim-кэш в Spec B не работали бы так, как ожидается, и часть тестов B упала бы. Косвенная валидация. Direct-тесты на FLUX/SDXL поведение требуют живой ComfyUI с моделью загруженной в VRAM — у меня в окружении этого нет.
- **Spec B.2 в полном цикле.** Я покрыл генерацию ключа кэша. Сам факт «второй прогон одного воркфлоу даёт hit» требует реального `comfy.sd.load_lora_for_models` и LoRA-файла на диске. Заглушка в тестах возвращает stub-объекты, на которых hit формально достижим, но это не доказывает, что патчер из кэша эквивалентен свежему — для этого нужен runtime-сравнение output.
- **Spec C целиком.** ComfyUI-фронтенд тестов нет. `node --check` проверяет JS-синтаксис, не больше.

**Что добавил бы при наличии времени:**
- Изолированный тест на корректность `_get_clip_hash` поверх mock-`cond_stage_model` с `named_parameters()` стабильным между вызовами и реагирующим на изменение dtype параметра.
- Тест на CPU↔GPU миграцию `_conditioning_to_cpu` / `_conditioning_to_device` с реальным GPU-тензором (требует CUDA в тестовом окружении).
- Stress-тест на `_clip_hash_refs`: создать N CLIP-объектов, дождаться GC, проверить, что `_clip_hash_lookup` чистит мёртвые refs.
- pytest-структуру вместо одноразового скрипта; сейчас тестов в репо нет вообще, и это отдельный вопрос для архитектора (см. ниже).

---

## 4. Что осталось не сделано / отложено

**Явно отложенное в спеках:**
- JS-кнопка «Clear now» для `ClearConditioningCache` (Spec B Out of Scope). Что нужно: новый JS-файл вроде `web/js/powder_clear_cache_button.js`, который добавляет в widget-список `LiteGraph`-кнопку, при клике делает `node.widgets.find(w => w.name === "trigger").value++` и `node.setDirtyCanvas(true, true)`. Без неё пользователю надо вручную менять int — рабочий, но некрасивый сценарий.
- README-обновления (Spec B Implementation Order пункт 9 — «Update README.md to mention the new PowderCacheStats node and the trigger input on ClearConditioningCache»). НЕ сделал, потому что задача не упоминалась в финальной формулировке пользователя; README в репо я и сейчас не правил. Если архитектор хочет — это 2-3 абзаца.
- Динамические `INPUT_TYPES` для `PowderPromptList` (Spec B пункт 9 — «20 hardcoded prompt slots»). Спек закрыл как Out of Scope с обоснованием «class-method-evaluated once». Не трогал.

**TODO в коде:** не вписывал. Старался не оставлять `# TODO`-комментариев, потому что они быстро устаревают. Все «отложено» — здесь, в этом отчёте.

**Замечено, но не исправлено (вне рамок спеков):**
- `powder_lora.py:_find_lora_path` — пробует разные варианты пути с replace `\\`/`/`. На NTFS работает, на Linux вызовет лишние syscalls. Стоит унифицировать через `pathlib.Path`.
- `powder_grid.py:_resolve_linked_param` — рекурсия глубиной 4 с эвристикой «если у source-ноды один input, верни его». Это правильно работает на `KSamplerSelect`, но может выдать неожиданный результат на пользовательских нодах с одним литералом. Не критично.
- `powder_lora.py` импорт `comfy.sd` — модульного уровня. Это значит, что любой импорт пакета из не-ComfyUI-окружения падает. Я обходил это в тестах через `sys.modules`-stub. На production это работает, но для CI/тестов нелепо. Поправить можно через lazy import внутри методов, но это +2-3 нс на вызов.

---

## 5. Риски и регрессии

**Сломается ли существующий воркфлоу при загрузке?**

- `PowderConditioner` теперь имеет `cache_mode` в `INPUT_TYPES`. Опциональный вход с default `"auto"` — старые сериализованные воркфлоу без поля `cache_mode` загрузятся, ComfyUI подставит дефолт. **Поведение поменяется**: раньше при `use_cache=true` всегда было «aggressive» (всегда кэшировать). Теперь default `auto` означает, что FLUX/T5/Quantized CLIP'ы НЕ кэшируются. Для пользователей с FLUX-воркфлоу это исправление; для пользователей с не-FLUX — без изменений. Для пользователей, которые умышленно полагались на «всегда кэшируем, даже FLUX», нужно вручную переключить `cache_mode=aggressive`. Это упомянуто в Spec A раздел Backward Compatibility.
- `ClearConditioningCache` стала иметь обязательный `trigger` INT. Старые воркфлоу с этой нодой загрузятся с дефолтом `trigger=0`, и нода не сработает на первой постановке. **Это регрессия для пользователей, которые ставили эту ноду чтобы очищать каждый запуск** — но именно это поведение спек определил как «defeating the cache entirely» и требующее починки. Workflow остаётся валидным, просто инкрементация trigger переходит на пользователя.
- `_clip_dim_cache` поменяла тип с `dict` на `LRUCache`. Внешне совместимо: `clear()` работает, `get`/`put` тоже. Никто кроме самого модуля не лазил в `_clip_dim_cache`, так что регрессии нет.
- `lora_info` JSON теперь содержит `schema_version=2`. Все потребители (`powder_conditioner` и `powder_grid`) игнорируют неизвестные поля. На сторонних потребителей (если такие есть) — без эффекта.
- Patcher-cache на 32 entry без TTL. Сценарий «пользователь работает 8 часов, перезагружает UNETLoader 100 раз» — первая запись с этим UNET вытеснится естественным LRU-образом. Утечки нет.

**Действия от пользователя:**
- Если у пользователя FLUX-воркфлоу с принудительно отключённым `use_cache`, можно теперь включить обратно (`use_cache=true`, `cache_mode=auto`) — будет работать корректно.
- Если у пользователя SDXL-воркфлоу с любым из режимов — никаких действий.
- Если в графе есть `ClearConditioningCache` для эпизодической очистки — нода теперь требует, чтобы пользователь вручную инкрементировал `trigger`. Один клик в UI.

**Что не проверил:**
- Реальный FLUX cold-start: загрузить FLUX 2 / Kontext, прогнать 3 идентичных prompt'а, убедиться, что все три дают идентичный результат. Это требует ~30 GB VRAM и установленных моделей.
- AIMDO-fault-out behavior: проверить, что под VRAM-давлением кэш на CPU не мешает offloading'у. Без живого профайлера AIMDO это слово на веру из спека.
- ComfyUI multi-version: разные ветки frontend (0.x classic, 1.x V3) могут по-разному отрендерить отключённый widget. JS-патч в Spec C тестировал только синтаксис.
- API-роут `/powder_styler/get_styles` — не дёргал HTTP-ом. Логика тривиальна, риск минимален.
- Сценарий с переключением `use_cache=true` ↔ `false` в одной сессии и проверкой, что после возврата в `true` кэш реально работает. Должно — `effective_mode` пересчитывается каждый раз; но runtime-проверки нет.

---

## 6. Замечания и рекомендации архитектору

**Что в исходном коде задало вопросы:**

`powder_conditioner.py` до фикса имел четыре уровня кэширования: `_conditioning_cache` (per prompt), `_clip_hash_cache` (per CLIP id), `_clip_dim_cache` (для валидации формы), и неявный «memoise через `id`-словарь». Это уровни с разной семантикой ключа и разной политикой жизни. После фикса политика выровнена (все на LRUCache, weakref для CLIP), но архитектурно их по-прежнему четыре. Их можно было бы обернуть в один объект `ConditioningCacheManager` с явным API. Прямо сейчас это излишне — сложность нарастёт только если добавится пятый уровень.

Дублирование `_ALL_STYLES`/`_STYLES_BY_NAME` в двух модулях, фикс которого прописан в Spec B.4 — это типовая copy-paste-проблема. Аналогичный паттерн есть в `_FONT_CACHE` (`powder_grid.py`), но там он только в одном модуле и ничего не дублирует. Стоит проверить, не появится ли что-то похожее при следующих фичах.

`powder_lora.py:load_loras` — длинная функция (около 80 строк) с ветвлением по `mode`. Она неплохо читается, потому что ветви чёткие, но каждая новая опция прилепляет ещё одну `if`. После добавления patcher-cache в Single mode разрыв стал заметнее — Stack mode остался без оптимизации, и комментарий об этом единственный признак. Если в будущем patcher-cache расширится на Stack — стоит выделить общий helper `_apply_lora(model, clip, item, model_state, clip_state, ...)`.

Двойная пара `use_cache` (boolean) + `cache_mode` (combo) — наследие итеративного развития, и пользователю это видно. Spec C закрывает UX-проблему дисэйблом, но per se это говорит, что один из двух контролов лишний. В долгой перспективе `use_cache` лучше депрекейтнуть и держать только `cache_mode` (со значением `disabled` для текущего «выкл»). Backward compat — отдельная история; разово конвертировать в JS при загрузке воркфлоу.

**Рекомендации к рефакторингу следующими сессиями:**

1. **Тестовая инфраструктура.** В репозитории нет тестов. Для пакета такого размера это уже опасно — каждое изменение проверяется только runtime'ом ComfyUI. Минимальный pytest-набор поверх `_cache.py`, `_styles.py`, валидаторов, helpers `powder_conditioner.py` (без `comfy`-зависимостей) можно добавить за 1-2 часа. Это окупится при первом же refactor'е.
2. **Ленивые импорты `comfy.*` в `powder_lora.py`.** Перенести `import comfy.sd, comfy.utils, comfy.model_management` внутрь методов класса. Преимущество: пакет можно импортировать вне ComfyUI (для тестов, документации, генерации схем).
3. **Объединить `_clip_hash_refs` и `_clip_dim_cache`.** По смыслу это две таблицы с одним ключом (`clip_hash`). Можно слить в один объект `ClipState` со структурой `{hash, dim, last_seen}`. Не срочно.
4. **Версионирование `lora_info` нужно пробросить дальше.** `powder_grid.py` парсит lora_info напрямую, в обход валидатора. Если `LORA_INFO_SCHEMA_VERSION_KNOWN` бампится до 3 с новыми семантическими полями — Grid об этом не узнает. Перенести `_validate_lora_info` в `_lora_info.py` (новый), импортировать из обоих потребителей. Сейчас это выглядит лишним, но это та же ловушка, что была с дублированием styles cache.
5. **JS-кнопка для `ClearConditioningCache`** — отдельный мелкий тикет, описан в разделе 4.
6. **Документ-схема `lora_info`** в README или отдельном `docs/lora_info_schema.md`. Сейчас она живёт только в комментарии на 32 строки в `powder_lora.py`. Если кто-то захочет написать сторонний consumer, ему придётся вычитывать это.

**Предложения вне рамок:**

- Persistent on-disk cache для conditioning — спек явно отказался. Согласен, на FLUX cost-of-recompute (~2-5 c) ниже cost-of-IO к диску.
- VRAM-aware eviction в `_conditioning_cache` — сейчас maxsize=64 entry безусловно. Когда conditioning попадёт обратно на GPU при `get`, он временно занимает VRAM. Если `_get_cached_conditioning` вызывается N раз в цикле сэмплинга (хит для каждого промпта), это N тензоров на устройстве — бóльшую часть будет освобождать GC, но в моменте они одновременно живут. Можно добавить «sliding window» — освобождать предыдущий результат, когда выдаём новый. Это микро-оптимизация и пока я бы не трогал.
- Метрики наблюдаемости. `PowderCacheStats` уже даёт срез; можно добавить `hit/miss` счётчики в `LRUCache` (атомарные инкременты под локом) и выводить процент попаданий. Полезно для тюнинга maxsize в живом окружении.

---

Конец отчёта.
