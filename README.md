# Study Assist

Extensión de navegador Chromium que usa IA (Claude y DeepSeek) para analizar preguntas de exámenes en plataformas educativas y proporcionar explicaciones detalladas.

## Plataformas Soportadas

- **NetAcad** (Cisco Networking Academy) — Detección completa via Shadow DOM, soporte para MCQ, matching, drag-and-drop
- **Moodle** — Detección de preguntas multichoice, true/false, con extracción de contexto del curso

## Características

- **Pipeline dual de IA** — DeepSeek Reasoner (económico, razonamiento) como primario + Claude (Anthropic) como fallback/validación
- **Banco de preguntas** — Base de datos local de preguntas NetAcad para respuestas instantáneas sin consumir API
- **Quick Mode** — Análisis con una sola tecla (SHIFT), respuesta inline en el botón SA
- **Full Mode** — Análisis detallado con overlay, streaming de respuesta
- **Tres modos de respuesta**: Guided Learning, Direct Answer, Hints Only
- **Detección de imágenes** — Envío de imágenes de preguntas a la API (URLs públicas preferidas sobre base64)
- **Dashboard** — Estadísticas de uso, costos, latencia, historial de requests
- **Contexto académico** — Extracción automática del nombre del curso en Moodle para mejorar prompts
- **Disguise Mode** — Apariencia de uBlock Origin para stealth
- **i18n** — Interfaz en inglés y español
- **Domain Allowlist** — Solo funciona en dominios que el usuario agrega manualmente

## Instalación

### 1. Clonar y construir

```bash
git clone <repo-url>
cd study-assist-extension
npm install
npm run build
```

### 2. Cargar en el navegador

1. Ir a `chrome://extensions/` (o `edge://extensions/`, `brave://extensions/`)
2. Activar **Developer Mode**
3. Click **Load unpacked** → seleccionar la carpeta raíz del proyecto
4. Pin de la extensión desde el ícono de puzzle

### 3. Configurar

1. Click en el ícono de Study Assist
2. Ingresar **Claude API Key** (de [console.anthropic.com](https://console.anthropic.com))
3. Ingresar **DeepSeek API Key** (de [platform.deepseek.com](https://platform.deepseek.com))
4. Agregar dominios permitidos (ej. `netacad.com`, tu dominio Moodle)
5. Activar el toggle ON

## Uso

### Atajos de Teclado

| Atajo               | Acción                                  |
| ------------------- | --------------------------------------- |
| **SHIFT**           | Analizar pregunta visible (Quick Mode)  |
| **CTRL+SHIFT**      | Forzar Claude directo (saltar DeepSeek) |
| **ALT+W**           | Recargar detección de preguntas         |
| **ALT+Q**           | Toggle visibilidad del botón SA         |
| **ALT+X**           | Cancelar request actual                 |
| **CTRL (mantener)** | Mostrar/ocultar overlay de respuesta    |

### Flujo de análisis

1. DeepSeek Reasoner analiza la pregunta (barato, con razonamiento)
2. Si DeepSeek falla o tiene baja confianza → fallback a Claude
3. Si hay imágenes y DeepSeek no las soporta → Claude directo
4. Para NetAcad: primero busca en el banco de preguntas local (respuesta instantánea)

### QA Manual (sin entrar a un quiz real)

Desde el **Panel de Control (Dashboard)** ahora existe un menú **🧪 QA Manual** para pruebas rápidas:

1. Abre cualquier página web normal (no `chrome://`)
2. En el Dashboard selecciona un escenario:
   - Moodle MCQ
   - Moodle V/F
   - NetAcad MCQ
   - NetAcad Matching
3. Verifica en la página:
   - Detección de pregunta(s)
   - Quick mode con `SHIFT`
   - En verdadero/falso, quick mode debe mostrar `V` o `F`
   - Non-quick al hacer clic en el badge
4. Usa `ALT+W` para re-detección y **Limpiar QA** para retirar el escenario

## Arquitectura

```
study-assist-extension/
├── manifest.json              # Manifest V3
├── src/
│   ├── background/            # Service worker (TypeScript)
│   │   ├── background.ts      # Routing de mensajes, lifecycle
│   │   └── modules/
│   │       ├── api.ts          # Orquestación (DeepSeek → Claude fallback)
│   │       ├── prompts.ts      # Construcción de prompts para cada modelo
│   │       ├── streaming.ts    # Streaming SSE para Claude
│   │       ├── parsing.ts      # Parseo de respuestas API
│   │       ├── questionBank.ts # Banco de preguntas local
│   │       ├── rateLimiter.ts  # Rate limiting
│   │       ├── usageTracker.ts # Tracking de uso/costos
│   │       ├── fetchUtils.ts   # Fetch con retry y timeout
│   │       ├── crypto.ts       # Encriptación de API keys
│   │       ├── extensionState.ts # Toggle, disguise mode
│   │       └── constants.ts    # Constantes, tipos compartidos
│   ├── content/               # Content scripts (TypeScript)
│   │   ├── content.ts         # Entry point, domain check, init
│   │   └── modules/
│   │       ├── detection.ts   # Detección NetAcad + Moodle (Shadow DOM, HTML)
│   │       ├── api.ts         # Comunicación con background (quick/full mode)
│   │       ├── ui.ts          # Overlay, botón SA, highlights
│   │       ├── keyboard.ts    # Atajos de teclado
│   │       ├── images.ts      # Extracción y optimización de imágenes
│   │       ├── state.ts       # Estado centralizado
│   │       └── utils.ts       # Utilidades DOM
│   └── types/
│       └── index.ts           # Definiciones de tipos compartidos
├── popup/                     # UI del popup
│   ├── popup.html/css/js      # Settings, API keys, domains
│   └── dashboard.html/css/js  # Estadísticas de uso
├── background/                # JS compilado (service worker)
├── content/                   # JS compilado (content scripts)
├── _locales/                  # i18n (en, es)
├── icons/                     # Íconos (+ ublock para disguise)
├── data/                      # Banco de preguntas
├── tests/                     # Test suite (Vitest)
└── scripts/                   # Build, package, scraping
```

## Desarrollo

```bash
npm install          # Instalar dependencias
npm run build        # Compilar TypeScript → JS
npm run watch        # Watch mode (desarrollo)
npm test             # Ejecutar tests (Vitest)
npm run test:watch   # Tests en watch mode
npm run package      # Construir carpeta dist/
npm run package:zip  # Construir dist.zip
```

### Tests

204 tests cubriendo:

- Detección de preguntas NetAcad (Shadow DOM, MCQ, matching)
- Detección de preguntas Moodle (multichoice, true/false, course name)
- Parseo de respuestas API (Claude, DeepSeek)
- Construcción de prompts
- Banco de preguntas (búsqueda, matching, scoring)
- Extracción de imágenes

## Pendiente

- [ ] Moodle: soporte para más tipos de preguntas (matching, drag-and-drop, fill-in-the-blank)
- [ ] Análisis de títulos de cuestionarios para filtrado inteligente (Opción A — curso + título cuando sea informativo)
- [ ] Mejora de prompts con datos reales de títulos de cuestionarios

## Privacidad

Todo se almacena localmente. La extensión solo se comunica con las APIs de Anthropic y DeepSeek usando las claves del usuario, únicamente cuando se activa manualmente el análisis. Sin telemetría, sin servidores remotos.
