# `lora_info` JSON Schema

This document describes the JSON contract emitted by **Powder Lora Loader** and consumed by **Powder Conditioner** and **Powder Grid Save**. Third-party nodes can also produce or consume `lora_info` if they conform to the schema.

## Schema version

Current version: **2** (introduced 2026-04).

The `schema_version` field is the canonical version marker. Consumers should:

- **Treat missing `schema_version` as version 1** (legacy, pre-2026-04).
- **Log a warning on unknown versions higher than the consumer knows**, but attempt best-effort parse using known fields.
- **Never fail** on an unknown version — graceful degradation.

The version is bumped when:
- A field changes meaning.
- A field is removed.
- A required field is added.

The version is **not** bumped for:
- New optional fields.
- New values in enum-like fields (e.g., a new `mode` value would bump; a new `combination_order` value would not, as long as old values remain valid).

## Stack mode example

Stack mode applies all enabled LoRAs to a single model. The output is one model, repeated per prompt.

```json
{
  "schema_version": 2,
  "loras": ["lora_a + lora_b"],
  "strengths": [1.0],
  "triggers": ["trigA, trigB", "trigA, trigB", "trigA, trigB"],
  "combination_order": "Loras first",
  "mode": "stack",
  "original_loras": ["lora_a", "lora_b"],
  "original_strengths": [0.8, 1.0],
  "trigger_position": "after"
}
```

Field-by-field:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `schema_version` | int | yes | `2` for current. |
| `loras` | array of string | yes | Stack mode: single combined display name (`"lora_a + lora_b"`). Length = 1. |
| `strengths` | array of number | yes | Stack mode: placeholder `[1.0]`. The actual per-LoRA strengths are in `original_strengths`. |
| `triggers` | array of string | yes | One trigger string **per output prompt**. Length = N_prompts. In Stack mode, all entries are the same combined trigger. |
| `combination_order` | string | yes | `"Loras first"` or `"Prompts first"`. Affects how triggers/prompts are zipped in Single mode; in Stack mode informational only. |
| `mode` | string | yes | `"stack"` for Stack mode. |
| `original_loras` | array of string | optional, Stack only | Per-LoRA names before combining. |
| `original_strengths` | array of number | optional, Stack only | Per-LoRA strengths before combining. |
| `trigger_position` | string | yes | `"before"` or `"after"`. Where Conditioner places the trigger relative to the prompt+style. |

## Single mode example

Single mode keeps each LoRA separate. The output is N_loras × N_prompts combinations.

```json
{
  "schema_version": 2,
  "loras": ["lora_a", "lora_b"],
  "strengths": [0.8, 1.0],
  "triggers": ["trigA", "trigA", "trigB", "trigB"],
  "combination_order": "Loras first",
  "mode": "single",
  "trigger_position": "after"
}
```

For 2 LoRAs × 2 prompts with `combination_order="Loras first"`:
- Output index 0: lora_a, prompt 0, trigger `"trigA"`
- Output index 1: lora_a, prompt 1, trigger `"trigA"`
- Output index 2: lora_b, prompt 0, trigger `"trigB"`
- Output index 3: lora_b, prompt 1, trigger `"trigB"`

`triggers[i]` aligns with output index `i`. Length of `triggers` = N_loras × N_prompts.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `schema_version` | int | yes | |
| `loras` | array of string | yes | Per-LoRA display names. Length = N_loras. |
| `strengths` | array of number | yes | Per-LoRA `strength_model`. Length = N_loras. |
| `triggers` | array of string | yes | One trigger per output combination. Length = N_loras × N_prompts. |
| `combination_order` | string | yes | Determines ordering of the triggers array. |
| `mode` | string | yes | `"single"`. |
| `trigger_position` | string | yes | |

## Validation

The `Powder Conditioner` validates `lora_info` via `_validate_lora_info(li, n_prompts)` (see `powder_conditioner.py`). The validator:

- Treats non-dict input as default `{"triggers": [""]*n, "trigger_position": "after"}`.
- Pads `triggers` with empty strings if too short, truncates if too long. Logs a warning when the array is non-empty and length-mismatched.
- Coerces non-string trigger entries to `""`.
- Coerces unknown `trigger_position` values to `"after"`.
- Logs but does not fail on unknown `schema_version`.

This means consumers downstream of Conditioner can rely on `triggers` being exactly `n_prompts` strings, every entry guaranteed to be a string.

## Consumers

Currently:

- **`powder_conditioner.PowderConditioner`** — uses `triggers`, `trigger_position`. Validates via `_validate_lora_info`.
- **`powder_grid.PowderGridSaver`** — uses `loras`, `strengths`, `original_loras`, `original_strengths` for grid labels. Does not validate; treats malformed inputs as missing labels.

If a third consumer is added, consider centralising `_validate_lora_info` into a shared module (`_lora_info.py`) per the work-log architect note.

## Backward compatibility

When a v1 `lora_info` (no `schema_version`) is received:
- `schema_version` is treated as `1`.
- All other fields parse as in v2 (the schema is unchanged in field semantics from v1 to v2; v2 only adds the version marker).
- No warnings logged for missing version field.

When a future v3 `lora_info` is received:
- Validator logs warning about unknown version.
- Known fields (currently v2 set) parse normally.
- Unknown fields are ignored.
- Behaviour as if it were v2.

## See also

- `powder_lora.py` — emitter (`_process_stack_mode`, `_process_single_mode`).
- `powder_conditioner.py` — primary consumer (`_validate_lora_info`).
- `powder_grid.py` — secondary consumer.
