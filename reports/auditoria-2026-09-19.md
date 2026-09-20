# Auditoría de código, seguridad y privacidad — Study Assist 1.3.0

Fecha: 19 de septiembre de 2026. Rama: dev. Commit revisado: 81d4441.

## Alcance y validación

Revisión de los puntos de entrada, pipeline de IA, adaptadores, streaming, almacenamiento, detección, popup, dashboard, permisos, documentación y herramientas de desarrollo.

- TypeScript: `npm run typecheck` pasó.
- Vitest: `npm test` pasó con **406 pruebas en 25 archivos**.
- Se ejecutaron diagnósticos adicionales cargando el TypeScript del proyecto en memoria, con proveedores, almacenamiento y puertos simulados; el DOM se comprobó con jsdom.
- Se usaron exclusivamente claves y datos ficticios en las reproducciones. No se consultaron proveedores de IA ni se leyeron claves reales del navegador.
- Se consultó npm para obtener avisos actuales de dependencias.
- No se realizó una prueba integral en Chromium ni una auditoría histórica de todos los commits. Las reproducciones DOM confirman inserción de elementos; no prueban ejecución de JavaScript bajo la CSP real del navegador.
- No se modificó el código de la extensión. La modificación preexistente de `icons/icon16.png` queda intacta.

Prioridades: **P1** = corregir primero, por pérdida de privacidad, uso no solicitado o respuestas incorrectas; **P2** = corregir después, por fiabilidad, retención o mantenimiento. Una prioridad no equivale a una calificación CVSS.

## Seguridad y privacidad

### S1 — P1: respuestas de IA interpretadas como HTML

Referencias: [respuesta libre](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/content/modules/api.ts:806>), [respuesta múltiple](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/content/modules/api.ts:602>), [huecos](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/content/modules/api.ts:799>).

El modo rápido intercala texto del proveedor directamente en `innerHTML`. Una respuesta a una pregunta de HTML puede romper la representación accidentalmente; una respuesta manipulada puede introducir elementos, imágenes, formularios o contenido engañoso en la página educativa.

**Reproducción:** devolver `<img src=x data-audit=unsafe>` como respuesta corta y ejecutar el manejador real. Se creó un elemento `img`, en vez de mostrar el texto literalmente.

**Alcance:** inserción HTML confirmada en el DOM de la página. La posibilidad de ejecutar manejadores JavaScript depende de las restricciones del navegador y de la página. Esto no demuestra acceso a las APIs privilegiadas de la extensión.

**Corrección:** construir el span y asignar `textContent`; aplicar la misma regla a todas las ramas rápidas. Mantener separado el formateo controlado del contenido del modelo.

### S2 — P1: nombres de modelos insertan HTML en dashboard y popup

Referencias: [modelo asignado](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/popup/dashboard.js:558>), [historial del dashboard](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/popup/dashboard.js:500>), [historial del popup](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/popup/popup.js:627>).

Los IDs procedentes de catálogos externos o de entrada manual se insertan sin escape. `shortModel()` únicamente elimina una fecha al final; no sanea HTML. También hay un nombre de proveedor sin escape en `activeMode`.

**Reproducción:** asignar un ID ficticio `<img src=x data-audit=model-injection>` y ejecutar `renderDashboard()`. El resultado contiene un elemento inyectado.

**Alcance:** HTML persistente controlado por datos externos en una página de la extensión, condicionado a que el modelo llegue a roles/historial. La CSP de MV3 bloquea scripts inline; no se ha demostrado una evasión de CSP ni robo automático de claves. Sí existe riesgo de alteración de interfaz y contenido engañoso.

**Corrección:** escapar todos los nombres/IDs y usar DOM con `textContent` donde sea posible; cubrir catálogos hostiles con pruebas. Revisar también la validación y representación de dominios del popup.

### S3 — P1: el cifrado de API keys usa únicamente entradas públicas

Referencia: [derivación de la clave](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/background/modules/crypto.ts:6>).

La clave AES se deriva de `chrome.runtime.id`, una sal constante y parámetros publicados en el código. El IV aleatorio protege frente a la repetición del cifrado, pero no aporta un secreto a la derivación. La afirmación de que esto proporciona una clave secreta única por instalación es incorrecta.

**Reproducción:** cifrar una clave ficticia y descifrarla con una implementación independiente usando exclusivamente el ID público y los parámetros del código. Recuperación: **correcta**.

**Condición de explotación:** obtener los valores cifrados del almacenamiento o una copia del perfil. No implica que un sitio web pueda leer `chrome.storage.local` por sí solo.

**Corrección:** definir el modelo de protección. Opciones: clave sólo durante la sesión y reingreso al reiniciar; contraseña maestra no almacenada, con sal aleatoria y derivación robusta; o almacén del sistema operativo mediante componente nativo. Guardar una clave aleatoria junto al ciphertext no protege una copia completa del almacenamiento. Además, un descifrado fallido debe producir un error explícito, en lugar de devolver el ciphertext como si fuese una clave en texto plano.

### S4 — P1: eventos sintéticos pueden consumir la API sin un gesto real

Referencias: [registro del clic](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/content/modules/ui.ts:262>), [manejador de análisis](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/content/modules/api.ts:629>), [teclado](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/content/modules/keyboard.ts:223>).

Los manejadores no distinguen eventos de usuario de eventos generados por scripts. El botón está en un DOM compartido con la página.

**Reproducción:** crear el botón real y llamar a `.click()` desde el DOM. El evento tenía `isTrusted=false` y llegó una petición al puerto simulado.

**Impacto:** una página permitida comprometida, o un script de terceros que ejecute allí, puede iniciar análisis y gasto sin una nueva acción del usuario. Los límites existentes reducen el volumen; no establecen consentimiento.

**Corrección:** exigir eventos confiables en los puntos de entrada de usuario; mantener la invocación interna separada. Validar también remitente, pestaña, marco, dominio y estructura de las solicitudes en background. La ausencia de `onMessageExternal` limita el acceso directo desde páginas, pero no evita este camino por el DOM.

### S5 — P1: revocar un dominio no revoca las pestañas abiertas

Referencias: [eliminar dominio](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/popup/popup.js:541>), [comprobación inicial](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/content/content.ts:44>), [entrada background](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/background/background.ts:65>).

La lista se comprueba al inicializar el content script. Eliminar un dominio sólo actualiza almacenamiento; no actualiza su estado en las pestañas abiertas. Background tampoco verifica la autorización actual del remitente antes de analizar.

**Reproducción:** iniciar en un dominio permitido, eliminarlo del almacenamiento y consultar el estado. Resultado: lista vacía, `isDomainAllowed=true` e `isActive=true`.

**Impacto:** pueden seguir enviándose preguntas desde una página que el usuario ya retiró de la lista, hasta recargarla.

**Corrección:** reaccionar a cambios de dominios, retirar UI/observadores y cancelar solicitudes; comprobar la autorización vigente en background usando datos del remitente, no sólo `context.pageUrl`.

### S6 — P2: preguntas y respuestas completas se conservan aunque el modo Dev esté apagado

Referencias: [trazas del primario](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/background/modules/api.ts:647>), [trazas del validador](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/background/modules/api.ts:863>), [log acumulativo](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/background/modules/fetchUtils.ts:11>), [política publicada](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/PRIVACY.md:14>).

Se guardan cuerpos completos de petición/respuesta en `lastApiRequestData` y respuestas en `errorLog`, incluso en operaciones exitosas y sin una condición de depuración. El historial también conserva texto de preguntas y respuestas. `errorLog` crece sin límite y puede agotar almacenamiento.

Esto contradice las afirmaciones de contenido transitorio y nunca almacenado en PRIVACY.md. Con el logging de desarrollo activo, parte del contenido también se remite al servicio local y puede persistir en disco.

**Borrado:** `clearUsageData()` deja `lastApiRequestData` y `errorLog`. El botón **Reset Completo** sí borra esas claves mediante operaciones adicionales: no confundir ambos caminos. Los archivos escritos por el servidor local no se eliminan mediante ese botón.

**Corrección:** modo privado con retención mínima; trazas completas sólo mediante opt-in explícito; redacción de datos sensibles, límites por tamaño/tiempo y borrado coherente. Hacer que el empaquetado de producción verifique el apagado del logging y actualizar la política para describir la conducta real.

### S7 — P2: secretos en encabezados personalizados quedan en texto plano

Referencias: [entrada de headers](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/popup/providers.js:756>), [persistencia](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/background/modules/llm/profiles.ts:467>), [estado público](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/background/modules/llm/profiles.ts:251>).

El campo genérico admite `Authorization`, `x-api-key` u otros secretos. Se guardan directamente dentro de `customProviders.headers` y vuelven en `getProviderState().presets`, aunque ese estado se describe como libre de claves.

**Reproducción:** guardar un proveedor ficticio con `x-api-key: fake-secret-header`. El valor permaneció en texto plano y apareció en el estado público.

**Corrección:** separar campos secretos de configuración pública, enmascararlos al devolver estado y excluirlos de logs/exportaciones. Aplicar a esos secretos el mismo mecanismo elegido para las API keys.

### S8 — P2: se permiten proveedores remotos por HTTP

Referencia: [validación de URL](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/popup/providers.js:736>).

Se aceptan tanto HTTPS como HTTP para cualquier host. Los adaptadores adjuntan credenciales y preguntas a esas peticiones.

**Condición:** que el usuario configure un endpoint HTTP remoto y conceda su permiso. En ese caso no existe cifrado de transporte para el contenido y las credenciales.

**Corrección:** exigir HTTPS a proveedores remotos, dejando una excepción explícita y acotada para servidores locales. Validar también en background, no únicamente en el formulario.

## Bugs funcionales confirmados

| ID / prioridad | Problema y evidencia | Corrección sugerida |
| --- | --- | --- |
| B1 / P1 | **Cancelar puede lanzar el validador.** Un primario cancelado sigue por el pipeline si hay validador. La reproducción produjo dos llamadas y `success:true`; la del validador no recibió señal de cancelación. Además, existe un único controlador global para todas las pestañas. [Orquestador](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/background/modules/api.ts:487>), [validador](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/background/modules/api.ts:850>). | Separar «cancelar todo» de «pasar al validador», que CTRL+SHIFT usa deliberadamente. Añadir ID y controlador por solicitud/pestaña, propagados a reintentos y validación. |
| B2 / P1 | **Se pierden imágenes antes del envío.** El primario recibe sólo el prompt; los adaptadores compatibles y Responses convierten bloques a texto. Una reproducción con imagen produjo un body sin su URL. El modelo puede contestar sobre una figura que no recibió. [Primario](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/background/modules/api.ts:634>), [adaptador](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/background/modules/llm/execute.ts:113>), [streaming](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/background/modules/llm/stream.ts:226>). | Conservar bloques multimodales en todo el recorrido y alinear las capacidades anunciadas con lo que realmente serializa cada adaptador. |
| B3 / P2 | **El modo rápido puede quedar esperando indefinidamente.** `sendQuickAnalysis()` no escucha desconexión, no tiene tiempo límite y no cierra el puerto al resolver. La simulación encontró cero listeners de desconexión y una promesa pendiente. [Puerto](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/content/modules/api.ts:450>). | Cierre único y explícito para resultado/error/desconexión/timeout/cancelación; liberar estado y listeners en `finally`. |
| B4 / P2 | **Errores SSE pueden terminar como éxito.** El evento Anthropic `error` notifica y continúa; devuelve un StreamResult normal. Responses también puede notificar error y después `onComplete`. El orquestador registra éxito y emite finalización. Reproducido con HTTP 200 y evento SSE de error. [Anthropic](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/background/modules/llm/stream.ts:198>), [Responses](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/background/modules/llm/stream.ts:422>). | Hacer terminales los errores; comprobar el evento de finalización esperado y propagar fallo/cancelación/truncamiento como estados distintos. |
| B5 / P1 | **El parser cambia el valor de números válidos.** Reproducción en primario y extractor rápido: `-12.5 → 12.5`; `1e-3 → 1`. Las expresiones regulares excluyen signo y exponente. [Parser](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/background/modules/parsing.ts:78>), [extracción rápida](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/background/modules/parsing.ts:143>). | Definir gramática numérica que preserve signo, exponente y separadores; evitar buscar «cualquier número» dentro de la explicación como respuesta. |
| B6 / P2 | **Los costos omiten llamadas intermedias.** Si el primario responde MEDIUM y se valida, sólo se registra el validador. Reproducción: dos llamadas, un registro. El reintento de matching también conserva el usage de la primera llamada. [Validación](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/background/modules/api.ts:562>), [uso final](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/background/modules/api.ts:951>). | Registrar cada intento del proveedor y agruparlo por análisis; separar llamadas facturables de preguntas resueltas. |
| B7 / P2 | **Solicitudes concurrentes pierden historial.** `trackUsage()` hace get → push → set sin serialización. Con almacenamiento simulado que copia valores como Chrome, dos escrituras simultáneas dejaron un registro. [Escritura](<C:/Users/Pardo/Desktop/fuck netacad/study-assist-extension/src/background/modules/usageTracker.ts:150>). | Serializar todas las mutaciones del historial, incluyendo limpieza y recorte; o usar un almacén transaccional. Corregir el mock de pruebas, que actualmente devuelve referencias compartidas. |

## Dependencias y superficie real

El audit del paquete raíz reportó **10 paquetes vulnerables: 1 crítico, 7 altos y 2 moderados**. Esto cuenta paquetes señalados, no diez exploits confirmados en el producto.

- **Crítico: Vitest 1.6.1.** El aviso trata de lectura/ejecución de archivos con el servidor UI de Vitest escuchando. La ejecución realizada fue `vitest run`; no prueba que esa superficie esté expuesta. [Aviso de Vitest](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp).
- Otros paquetes señalados: esbuild, form-data, nanoid, postcss, rollup, undici, vite, vite-node y ws.
- Vite/Vitest, jsdom y esbuild pertenecen a desarrollo/pruebas. Cheerio introduce Undici en el paquete raíz, pero se usa en herramientas de scraping. El empaquetador incluye salidas y recursos, no `node_modules`; no se identificaron importaciones de esas dependencias en el runtime TypeScript de la extensión.
- Actualizar y verificar estas dependencias es necesario para proteger el entorno de desarrollo. No aplicar `npm audit fix --force` automáticamente: las soluciones de Vitest/esbuild incluyen cambios mayores.
- El subpaquete `scripts/package.json` también se auditó: **8 paquetes con severidad alta**, relacionados con Puppeteer y sus dependencias (@puppeteer/browsers, basic-ftp, extract-zip, ip-address, js-yaml, puppeteer, puppeteer-core y ws). Son avisos del entorno de scraping. No sumar ambas cifras como vulnerabilidades independientes: puede haber paquetes y avisos compartidos.

## Otras mejoras recomendadas

1. **Separar secretos de content scripts.** No hay configuración de `storage.local.setAccessLevel`. Chrome permite limitar el almacenamiento a contextos de confianza; requeriría mover la lectura de preferencias del content script a mensajes con campos permitidos, además de considerar la versión mínima de Chrome.
2. **Fortalecer mensajes internos.** El router recibe mensajes privilegiados sin distinguir remitentes ni validar esquemas en runtime. TypeScript no valida datos al ejecutarse. Separar operaciones de configuración de las peticiones procedentes de pestañas y establecer límites de tamaño. Esto es defensa adicional, no una prueba de acceso directo desde sitios web.
3. **Timeout durante todo el cuerpo.** `fetchWithTimeout()` limpia el temporizador cuando llegan las cabeceras. Un JSON o stream que se queda abierto después puede esperar indefinidamente. Añadir deadline total y/o timeout de inactividad del stream, con pruebas de lectura bloqueada.
4. **Errores de detección y navegación.** Los awaits de detección rápida están fuera del try que libera el bloqueo. Encapsular todo el ciclo y descartar respuestas de solicitudes anteriores al navegar o cancelar/reiniciar.
5. **URLs de imágenes y minimización.** `isPublicImageUrl()` no distingue una URL firmada, una dirección privada o un recurso protegido fuera del patrón Moodle. Revisar qué URLs se envían y preferir contenido binario autorizado para imágenes privadas. No se ha demostrado SSRF contra los proveedores.
6. **Banco local ambiguo.** Actualmente una coincidencia primaria ≥80% puede imponerse incluso con conflicto real detectado. Considerar validar conflictos y comparar opciones/contexto antes de responder instantáneamente.
7. **Publicación automática verificable.** Añadir CI para tipos, pruebas, auditoría y empaquetado; comprobar flags de desarrollo, permisos y coherencia de versiones. Incluir popup/dashboard en revisión estática, hoy excluidos del typecheck.
8. **Reducir recursos expuestos.** Revisar si `data/*` y el dashboard necesitan ser web-accessible para todas las páginas; introducir permisos/contenido dinámicos por dominio cuando sea viable.
9. **Documentación fiel al producto.** Corregir afirmaciones de privacidad, cifrado, activación automática y cuota fija de almacenamiento. Eliminar divergencias entre README, AGENTS y código.

## Controles favorables y límites de la conclusión

El proyecto usa MV3, solicita permisos para hosts personalizados y su formateador del overlay detallado escapa HTML antes de aplicar formato. La interfaz habitual de proveedores devuelve `hasKey`, sin descifrar la API key para mostrarla. No se encontró un receptor `onMessageExternal` ni un puente de mensajes web que entregue claves.

La búsqueda de patrones de credenciales en archivos versionados señaló dos archivos de pruebas; no se ha establecido una filtración real de claves ni una intrusión. Tampoco debe inferirse de esta revisión que el proyecto está libre de otros fallos.

Chrome separa las variables de la página y las del content script, aunque comparten DOM. Por ello, insertar HTML en la página no equivale automáticamente a ejecutar código con permisos de extensión. La CSP de las páginas de extensión limita además la ejecución de scripts.

## Referencias técnicas oficiales

- [Chrome: almacenamiento y restricciones de acceso](https://developer.chrome.com/docs/extensions/reference/api/storage).
- [Chrome: aislamiento y DOM de content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts).
- [Chrome: Content Security Policy de extensiones](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy).

## Orden de trabajo propuesto

1. Eliminar inserciones HTML no escapadas; bloquear activaciones sintéticas y respetar revocación de dominios.
2. Definir protección de credenciales, separar headers secretos y minimizar trazas.
3. Corregir cancelación, imágenes y números.
4. Hacer robustos los puertos/streams y corregir contabilidad/concurrencia.
5. Actualizar dependencias, pruebas y verificaciones de publicación.

Este informe propone correcciones; no las aplica.
