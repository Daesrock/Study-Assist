# 📦 Distribución de Study Assist

## Cómo empaquetar la extensión para compartir

La extensión **NO está publicada** en Chrome Web Store, por lo que se distribuye directamente como archivos.

### Método Automático (Recomendado)

#### 1. Crear carpeta de distribución

```bash
npm run package
```

Esto genera la carpeta `dist/` con todos los archivos necesarios.

#### 2. Crear ZIP (opcional)

```bash
npm run package:zip
```

O comprimir manualmente:

- Clic derecho en la carpeta `dist/`
- "Enviar a" → "Carpeta comprimida (en zip)"
- Renombrar a `study-assist.zip`

### ¿Qué se incluye en la distribución?

✅ **Archivos incluidos:**

- `manifest.json` - Configuración de la extensión
- `background/` - Service worker (compilado de TypeScript)
- `content/` - Scripts de contenido (compilado de TypeScript)
- `popup/` - Interfaz del popup
- `icons/` - Iconos de la extensión
- `data/` - Banco de preguntas (opcional)
- `_locales/` - Traducciones (español e inglés)
- `INSTALLATION.md` - Instrucciones de instalación para el usuario

❌ **Archivos NO incluidos:**

- `src/` - Código fuente TypeScript
- `tests/` - Tests
- `node_modules/` - Dependencias de desarrollo
- Archivos de configuración (tsconfig, vitest, etc.)

### Instrucciones para el usuario final

El archivo `dist/INSTALLATION.md` contiene instrucciones completas en inglés para:

1. Cómo cargar la extensión en el navegador
2. Cómo configurar las API keys
3. Cómo usar la extensión
4. Solución de problemas comunes

## Distribución

### Opción 1: Compartir carpeta dist/

1. Ejecuta `npm run package`
2. Comprime la carpeta `dist/`
3. Comparte el archivo ZIP
4. El usuario extrae y carga en `chrome://extensions/`

### Opción 2: Repositorio Git

1. El usuario clona el repositorio
2. Ejecuta `npm install && npm run build`
3. Carga la carpeta raíz en `chrome://extensions/`

## Notas Importantes

⚠️ **La carpeta `dist/` no debe eliminarse después de instalar**

- Chrome necesita acceso permanente a los archivos
- Si se elimina, la extensión dejará de funcionar

⚠️ **Modo desarrollador requerido**

- Las extensiones no publicadas requieren "Developer mode" habilitado
- Cada navegador mostrará una advertencia sobre extensiones en modo desarrollador

⚠️ **Actualizaciones**

- Para actualizar, el usuario debe:
  1. Recibir la nueva versión empaquetada
  2. Reemplazar los archivos en su carpeta
  3. Hacer clic en "Reload" (🔄) en `chrome://extensions/`

## Scripts NPM disponibles

```bash
# Desarrollo
npm run build         # Compilar TypeScript → JavaScript
npm run watch         # Compilar en modo watch (desarrollo)
npm test              # Ejecutar tests

# Distribución
npm run package       # Crear carpeta dist/
npm run package:zip   # Crear dist.zip (requiere PowerShell en Windows)
```

## Estructura de dist/

```
dist/
├── manifest.json          # Manifest V3
├── INSTALLATION.md        # Guía de instalación
├── background/
│   └── background.js      # Service worker
├── content/
│   ├── content.js         # Content script
│   └── overlay.css        # Estilos del overlay
├── popup/
│   ├── popup.html         # Popup principal
│   ├── popup.js           # Lógica del popup
│   ├── popup.css          # Estilos del popup
│   ├── dashboard.html     # Dashboard de estadísticas
│   ├── dashboard.js       # Lógica del dashboard
│   └── dashboard.css      # Estilos del dashboard
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── data/
│   └── questions-bank.json  # Banco de preguntas (opcional)
└── _locales/
    ├── en/messages.json     # Inglés
    └── es/messages.json     # Español
```

## Tamaño típico

- Carpeta dist/: ~1.5 MB
- ZIP comprimido: ~500 KB

---

**Para cualquier duda sobre distribución, revisa la documentación de Chrome Extensions:**
https://developer.chrome.com/docs/extensions/mv3/linux_hosting/
