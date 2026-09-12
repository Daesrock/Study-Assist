# Prompt Caching de Claude — Análisis de factibilidad

**Fecha:** 08/09/2026 · **Versión:** 1.3.0 · **Veredicto: NO factible hoy** (técnicamente implementable, económicamente sin beneficio).

## 1. Requisitos oficiales (docs Anthropic)

- Mínimo cacheable: **Haiku 4.5 → 4,096 tokens** · Sonnet 4.6 → 1,024 · Opus 4.6 → 4,096.
- Hit requiere prefijo **100% idéntico**; TTL 5 min (1h opcional a 2×).
- Precios: writes 5m a **1.25×** input base · reads a **0.1×** · debajo del mínimo la API ignora `cache_control` sin error.
- Cambiar `thinking` invalida bloques de mensajes; imágenes agregadas/removidas invalidan mensajes (pero no un bloque `system` previo).

## 2. Estado actual del código

- **No existe parámetro `system`** en ningún path Claude (`ClaudeMessage` en `src/background/modules/constants.ts` no lo tiene; tampoco `src/background/modules/llm/stream.ts`).
- Todo va inline en **un solo mensaje `user`**: instrucciones estáticas + pregunta variable mezcladas (`prompts.ts`: `buildAnalysisPrompt`, `buildMatchingPrompt`, `buildClaudeValidationPrompt` + `buildMessageContent`).
- `usage` de Claude **ya lee** `cache_read_input_tokens` / `cache_creation_input_tokens` y los propaga (`api.ts` + `llm/stream.ts` → `NormalizedUsage.cacheHitTokens` / `cacheWriteTokens`).
- El costo es **LiteLLM-driven** (`usageTracker.estimateCost` + `pricing.computeUsageCost`): usa `input_per_token`, `output_per_token`, `cache_read_input_token_cost` y `cache_creation_input_token_cost`. La plomería de observabilidad de caché **ya está implementada**.

## 3. Números (por qué no cierra)

| Concepto | Tokens aprox. |
|---|---|
| Instrucciones estáticas por petición | ~150–300 |
| Pregunta + opciones (variable) | ~75–225 |
| **Total típico** | **~300–600** |
| Mínimo Haiku 4.5 (modelo default) | **4,096** |

Faltan ~7–10× contenido para calificar. Rellenar con few-shot hasta el mínimo **cuesta más** (writes a 1.25× sobre tokens que hoy no se envían) de lo que ahorrarían los hits a 0.1×. Los prompts de validación son peores: el blob de DeepSeek (1.5k–8k tokens, único por pregunta) es incacheable por diseño.

## 4. Refactor requerido (si algún día aplica)

`prompts.ts` (separar estático→`system` con `cache_control`, variable→`user`) + `api.ts` (3 builders) + `llm/stream.ts` + `constants.ts` (tipos `system`/`cache_control`) + adaptadores (`anthropic.ts`). Multi-archivo y riesgo en la ruta crítica; hoy el beneficio es ~$0. La parte de **medición/costo ya está hecha**.

## 5. Acción

1. **Observabilidad de caché**: ✅ implementada (se leen los campos de caché y se costean con precios LiteLLM de read/write).
2. **Revisitar si**: el default pasa a Sonnet, o se agrega contexto estable grande reutilizado por sesión (ej. "course pack" 2k+ tokens).
