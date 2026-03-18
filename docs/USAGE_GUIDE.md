# E2GO Nodes — Usage Scenarios

**[English](#english)** | **[Русский](#русский)**

---

<a id="english"></a>

## Scenario 1: Simple Generation with Style

**Nodes:** Powder Styler + Powder Conditioner

The simplest use case — apply an artistic style to your prompt without LoRA.

**Setup:**
1. Add `CLIPLoader` and connect to `Powder Conditioner` → clip
2. Add `Powder Styler`, select a style (e.g. "Aquarel Watercolor")
3. Connect `Styler.style` → `Conditioner.style`
4. Type your prompt directly or via a `PrimitiveStringMultiline` → `Conditioner.prompt`
5. Connect `Conditioner.positive_conditioning` / `negative_conditioning` to your sampler

**What happens:**
- The Styler wraps your prompt with style prefix/suffix and generates a negative
- The Conditioner assembles the final text and encodes it through CLIP
- You can preview the assembled text via `Conditioner.final_positive` output

---

## Scenario 2: LoRA Testing (Single Mode)

**Nodes:** Powder Lora Loader + Powder Conditioner

Compare multiple LoRAs side by side on the same prompt.

**Setup:**
1. Add `Powder Lora Loader`, set **mode = Single**
2. Add 3-4 LoRA slots, select different LoRAs, enable triggers
3. Connect a single prompt to `Lora Loader.prompt`
4. Connect all 5 outputs of Lora Loader to `Powder Conditioner`
5. Connect Conditioner to your sampler

**What happens:**
- Each LoRA creates a separate model copy
- With 1 prompt and 4 LoRAs → 4 images, each with a different LoRA
- Trigger text is automatically added to each prompt
- `disable_clip = true` skips CLIP weight loading for faster iteration

**Tip:** Connect the output to `Powder Grid Save` to get a labeled comparison grid.

---

## Scenario 3: Batch Prompts with LoRA Stack

**Nodes:** Powder Prompt List + Powder Lora Loader (Stack) + Powder Conditioner

Generate multiple scenes with the same set of LoRAs applied.

**Setup:**
1. Add `Powder Prompt List`, create 3 prompt slots:
   - "A cat sitting on a windowsill"
   - "A medieval castle at sunset"
   - "Portrait of a woman in a garden"
2. Add `Powder Lora Loader`, set **mode = Stack**
3. Add 2 LoRAs (e.g. a style LoRA + a detail LoRA)
4. Connect `Prompt List.positive_prompts` → `Lora Loader.prompt`
5. Connect `Prompt List.negative_prompts` → `Lora Loader.negative_prompt`
6. Connect Lora Loader → Conditioner → Sampler

**What happens:**
- Both LoRAs are stacked onto one model
- 3 prompts × 1 stacked model = 3 images
- Each image has both LoRAs applied

---

## Scenario 4: Full Comparison Grid

**Nodes:** Powder Prompt List + Powder Lora Loader (Single) + Powder Styler + Powder Conditioner + Powder Grid Save

The most powerful setup — compare multiple LoRAs across multiple prompts with style, all assembled into a grid.

**Setup:**
1. `Powder Prompt List` — 2 prompts
2. `Powder Styler` — select a style
3. `Powder Lora Loader` — **mode = Single**, **combination_order = Loras first**, add 3 LoRAs
4. Connect: Prompt List → Lora Loader → Conditioner ← Styler
5. Connect: Conditioner → Sampler → `Powder Grid Save`
6. Connect `Lora Loader.lora_info` → both Conditioner and Grid Save

**What happens:**
- 3 LoRAs × 2 prompts = 6 images
- With **Loras first**: columns = LoRAs, rows = prompts
- Grid shows LoRA names and prompt text as labels
- Style prefix/suffix and LoRA triggers are automatically inserted
- Grid is saved with JSON metadata

**Combination order matters:**
- `Loras first` → LoRA1-Prompt1, LoRA1-Prompt2, LoRA2-Prompt1, LoRA2-Prompt2...
- `Prompts first` → Prompt1-LoRA1, Prompt1-LoRA2, Prompt2-LoRA1, Prompt2-LoRA2...

---

## Scenario 5: Style Exploration

**Nodes:** Powder Styler + Powder Conditioner

Compare how different styles affect the same prompt.

**Setup:**
1. Add `Powder Styler` with 1 slot
2. Connect to `Conditioner`
3. Run once, then change the style and run again
4. Connect `Conditioner.final_positive` to a text preview node to see the assembled prompt

**Advanced:** Use multiple style slots to combine styles:
- Slot 1: "Baroque Caravaggio" (positive + negative)
- Slot 2: "Manga Tarot" (positive only, negative disabled)

Styles are combined: all prefixes merge, all suffixes merge, all negatives merge. Duplicate tags are automatically removed.

---

## Scenario 6: Quick LoRA Trigger Setup

**Nodes:** Powder Lora Loader

Auto-load and save trigger text for LoRAs.

**How it works:**
1. When you select a LoRA, the node automatically looks for a `.txt` file next to it
   - `my_lora.safetensors` → looks for `my_lora.txt`
2. If found, the trigger text is loaded into the Trigger field
3. When you manually edit the trigger and run, the text is saved back to the `.txt` file
4. Next time you use this LoRA, the trigger is loaded automatically

**Tip:** You can toggle individual triggers on/off with "Use Trigger" without deleting the text.

---

## Scenario 7: Cache Optimization

**Nodes:** Powder Conditioner + Powder Clear Conditioning Cache

Speed up repeated runs by using the conditioning cache.

**How caching works:**
- Each (CLIP model + prompt text) pair is cached after first encoding
- On subsequent runs with the same prompt/CLIP, the cached result is used (instant)
- Cache detects CLIP model changes automatically (different LoRA = different CLIP = re-encode)

**When to clear cache:**
- After loading a completely different base model
- If you notice stale results
- To free GPU/RAM memory
- Add `Powder Clear Conditioning Cache` node and run it once

---

## Node Compatibility

| Node combination | Works | Notes |
|---|:---:|---|
| Lora Loader alone (no Conditioner) | yes | Outputs raw prompts without style/trigger assembly |
| Styler alone (no Lora Loader) | yes | Connect style directly to Conditioner |
| Prompt List alone (no Lora Loader) | yes | Connect prompts directly to Conditioner |
| Conditioner without Lora/Styler | yes | Acts as a simple CLIP encoder with caching |
| Grid Save without Lora Loader | yes | Just assembles images into a grid without LoRA labels |
| All nodes together | yes | Full pipeline with maximum flexibility |

---

<a id="русский"></a>

# E2GO Nodes — Сценарии использования

**[English](#english)** | **[Русский](#русский)**

---

## Сценарий 1: Простая генерация со стилем

**Ноды:** Powder Styler + Powder Conditioner

Самый простой вариант — применить художественный стиль к промпту без LoRA.

**Настройка:**
1. Добавьте `CLIPLoader` и подключите к `Powder Conditioner` → clip
2. Добавьте `Powder Styler`, выберите стиль (например "Aquarel Watercolor")
3. Подключите `Styler.style` → `Conditioner.style`
4. Введите промпт напрямую или через `PrimitiveStringMultiline` → `Conditioner.prompt`
5. Подключите `Conditioner.positive_conditioning` / `negative_conditioning` к сэмплеру

**Что происходит:**
- Styler оборачивает промпт стилевыми prefix/suffix и генерирует negative
- Conditioner собирает финальный текст и кодирует через CLIP
- Можно просмотреть собранный текст через выход `Conditioner.final_positive`

---

## Сценарий 2: Тестирование LoRA (режим Single)

**Ноды:** Powder Lora Loader + Powder Conditioner

Сравнение нескольких LoRA рядом на одном промпте.

**Настройка:**
1. Добавьте `Powder Lora Loader`, установите **mode = Single**
2. Добавьте 3-4 слота LoRA, выберите разные LoRA, включите триггеры
3. Подключите один промпт к `Lora Loader.prompt`
4. Подключите все 5 выходов Lora Loader к `Powder Conditioner`
5. Подключите Conditioner к сэмплеру

**Что происходит:**
- Каждая LoRA создаёт отдельную копию модели
- 1 промпт и 4 LoRA → 4 изображения, каждое с отдельной LoRA
- Триггер-текст автоматически добавляется к каждому промпту
- `disable_clip = true` пропускает CLIP-веса для ускорения

**Совет:** Подключите выход к `Powder Grid Save` для сравнительного grid с подписями.

---

## Сценарий 3: Batch-промпты со стэком LoRA

**Ноды:** Powder Prompt List + Powder Lora Loader (Stack) + Powder Conditioner

Генерация нескольких сцен с одним набором LoRA.

**Настройка:**
1. Добавьте `Powder Prompt List`, создайте 3 слота:
   - "A cat sitting on a windowsill"
   - "A medieval castle at sunset"
   - "Portrait of a woman in a garden"
2. Добавьте `Powder Lora Loader`, **mode = Stack**
3. Добавьте 2 LoRA (стилевую + детализирующую)
4. Подключите `Prompt List.positive_prompts` → `Lora Loader.prompt`
5. Подключите `Prompt List.negative_prompts` → `Lora Loader.negative_prompt`
6. Подключите Lora Loader → Conditioner → Sampler

**Что происходит:**
- Обе LoRA стэкаются в одну модель
- 3 промпта × 1 стэк = 3 изображения
- Каждое изображение с обеими LoRA

---

## Сценарий 4: Полная сравнительная таблица (Grid)

**Ноды:** Powder Prompt List + Powder Lora Loader (Single) + Powder Styler + Powder Conditioner + Powder Grid Save

Самая мощная конфигурация — сравнение нескольких LoRA на нескольких промптах со стилем, собранное в grid.

**Настройка:**
1. `Powder Prompt List` — 2 промпта
2. `Powder Styler` — выберите стиль
3. `Powder Lora Loader` — **mode = Single**, **combination_order = Loras first**, добавьте 3 LoRA
4. Подключите: Prompt List → Lora Loader → Conditioner ← Styler
5. Подключите: Conditioner → Sampler → `Powder Grid Save`
6. Подключите `Lora Loader.lora_info` → и в Conditioner, и в Grid Save

**Что происходит:**
- 3 LoRA × 2 промпта = 6 изображений
- При **Loras first**: столбцы = LoRA, строки = промпты
- Grid показывает имена LoRA и текст промптов в подписях
- Стилевые prefix/suffix и триггеры LoRA автоматически вставляются
- Grid сохраняется с JSON-метаданными

**Порядок комбинаций важен:**
- `Loras first` → LoRA1-Промпт1, LoRA1-Промпт2, LoRA2-Промпт1, LoRA2-Промпт2...
- `Prompts first` → Промпт1-LoRA1, Промпт1-LoRA2, Промпт2-LoRA1, Промпт2-LoRA2...

---

## Сценарий 5: Исследование стилей

**Ноды:** Powder Styler + Powder Conditioner

Сравнение влияния разных стилей на один промпт.

**Настройка:**
1. Добавьте `Powder Styler` с 1 слотом
2. Подключите к `Conditioner`
3. Запустите, смените стиль и запустите снова
4. Подключите `Conditioner.final_positive` к ноде предпросмотра текста для просмотра собранного промпта

**Продвинуто:** Несколько слотов стилей для комбинирования:
- Слот 1: "Baroque Caravaggio" (позитив + негатив)
- Слот 2: "Manga Tarot" (только позитив, негатив выключен)

Стили комбинируются: все prefix объединяются, все suffix объединяются, все negative объединяются. Дублирующиеся теги удаляются автоматически.

---

## Сценарий 6: Быстрая настройка триггеров LoRA

**Ноды:** Powder Lora Loader

Автоматическая загрузка и сохранение триггер-текста для LoRA.

**Как это работает:**
1. При выборе LoRA нода автоматически ищет `.txt` файл рядом
   - `my_lora.safetensors` → ищет `my_lora.txt`
2. Если найден, триггер-текст загружается в поле Trigger
3. При ручном редактировании триггера и запуске текст сохраняется обратно в `.txt`
4. В следующий раз триггер загрузится автоматически

**Совет:** Можно переключать отдельные триггеры через "Use Trigger" не удаляя текст.

---

## Сценарий 7: Оптимизация кэширования

**Ноды:** Powder Conditioner + Powder Clear Conditioning Cache

Ускорение повторных запусков через кэш кодирования.

**Как работает кэш:**
- Каждая пара (CLIP-модель + текст промпта) кэшируется после первого кодирования
- При повторных запусках с тем же промптом/CLIP используется кэш (мгновенно)
- Кэш автоматически определяет смену CLIP-модели (другая LoRA = другой CLIP = перекодировка)

**Когда очищать кэш:**
- После загрузки совершенно другой базовой модели
- При подозрении на устаревшие результаты
- Для освобождения GPU/RAM памяти
- Добавьте `Powder Clear Conditioning Cache` и запустите один раз

---

## Совместимость нод

| Комбинация | Работает | Примечания |
|---|:---:|---|
| Lora Loader без Conditioner | да | Выдаёт сырые промпты без сборки стилей/триггеров |
| Styler без Lora Loader | да | Подключите style напрямую к Conditioner |
| Prompt List без Lora Loader | да | Подключите промпты напрямую к Conditioner |
| Conditioner без Lora/Styler | да | Работает как простой CLIP-энкодер с кэшированием |
| Grid Save без Lora Loader | да | Просто собирает изображения в grid без подписей LoRA |
| Все ноды вместе | да | Полный пайплайн с максимальной гибкостью |
