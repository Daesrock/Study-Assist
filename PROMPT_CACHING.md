# Prompt Caching de Claude — Análisis de factibilidad

**Fecha:** 08/09/2026 · **Versión:** 1.2.2 · **Veredicto: NO factible hoy** (técnicamente implementable, económicamente sin beneficio).

## 1. Requisitos oficiales (docs Anthropic)

- Mínimo cacheable: **Haiku 4.5 → 4,096 tokens** · Sonnet 4.6 → 1,024 · Opus 4.6 → 4,096.
- Hit requiere prefijo **100% idéntico**; TTL 5 min (1h opcional a 2×).
- Precios: writes 5m a **1.25×** input base · reads a **0.1×** · debajo del mínimo la API ignora `cache_control` sin error.
- Cambiar `thinking` invalida bloques de mensajes; imágenes agregadas/removidas invalidan mensajes (pero no un bloque `system` previo).

## 2. Estado actual del código

- **No existe parámetro `system`** en ningún path Claude (`ClaudeRequestBody` en `src/background/modules/constants.ts` no lo tiene; tampoco `streaming.ts`).
- Todo va inline en **un solo mensaje `user`**: instrucciones estáticas + pregunta variable mezcladas (`prompts.ts`: `buildAnalysisPrompt`, `buildMatchingPrompt`, `buildClaudeValidationPrompt` + `buildMessageContent`).
- `usage` de Claude **ignora** `cache_read_input_tokens` / `cache_creation_input_tokens` (`api.ts` y `streaming.ts`).
- `calculateCost` (`usageTracker.ts`) **ya soporta** `inputCacheHit` (0.1×) para los 3 modelos Claude, pero **solo DeepSeek lo alimenta**; Claude siempre paga precio full. No existe precio de writes (1.25×).

## 3. Números (por qué no cierra)

| Concepto | Tokens aprox. |
|---|---|
| Instrucciones estáticas por petición | ~150–300 |
| Pregunta + opciones (variable) | ~75–225 |
| **Total típico** | **~300–600** |
| Mínimo Haiku 4.5 (modelo default) | **4,096** |

Faltan ~7–10× contenido para calificar. Rellenar con few-shot hasta el mínimo **cuesta más** (writes a 1.25× sobre tokens que hoy no se envían) de lo que ahorrarían los hits a 0.1×. Los prompts de validación son peores: el blob de DeepSeek (1.5k–8k tokens, único por pregunta) es incacheable por diseño.

## 4. Refactor requerido (si algún día aplica)

`prompts.ts` (separar estático→`system` con `cache_control`, variable→`user`) + `api.ts` (3 builders) + `streaming.ts` + `constants.ts` (tipos `system`/`cache_control`/usage) + `usageTracker.ts` (precio writes + thread `cacheHitTokens`). Multi-archivo, riesgo en ruta crítica, beneficio actual ~$0.

## 5. Acción propuesta (pospuesta)

1. **Plomería de observabilidad**: leer campos de caché del `usage` y pasarlos a `calculateCost`. Barato, sin riesgo, deja medición lista.
2. **Revisitar si**: default pasa a Sonnet, o se agrega contexto estable grande reutilizado por sesión (ej. "course pack" 2k+ tokens).
