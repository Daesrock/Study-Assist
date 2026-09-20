# Correcciones de la auditoría — 19 de septiembre de 2026

Implementadas en `dev`, sin commit, push, publicación ni llamadas facturables a proveedores. Se conservó el cambio previo del usuario en `icons/icon16.png`.

## Seguridad y privacidad

- **S1/S2:** respuestas rápidas, modelos, etiquetas, dominios y metadatos se escapan al renderizar; regresiones ejecutan la interfaz real con contenido HTML malicioso.
- **S3:** las credenciales siguen siendo persistentes, por elección del usuario. AES-GCM utiliza ahora una clave aleatoria de 256 bits; migra el cifrado anterior y rechaza datos corruptos, sin interpretarlos como claves en texto plano. `chrome.storage.local` se restringe a contextos confiables. Los content scripts acceden solo a preferencias seleccionadas mediante mensajes.
- **S4:** las entradas de análisis de la página requieren eventos de usuario confiables. El background comprueba emisor, privilegios, tamaño y forma de las solicitudes; las páginas no pueden configurar proveedores ni leer su estado o historial.
- **S5:** se comprueba la URL del frame emisor y la lista vigente de dominios. Cambiarla cancela solicitudes activas y notifica a pestañas abiertas. QA requiere registro explícito desde el dashboard, restringido a example.com.
- **S6:** registros de error desactivados por defecto, limitados a 64 KB y metadatos sin cuerpos, URLs ni credenciales. Contenido del historial opt-in y acotado. Borrar uso elimina también diagnósticos; desactivar contenido conserva métricas pero retira texto. La migración elimina contenido antiguo y trazas completas. Logging local desactivado; builds de producción bloquean su activación accidental.
- **S7:** todos los valores de encabezados personalizados, incluidos endpoints alternativos, se cifran y se excluyen del estado público.
- **S8:** HTTPS obligatorio salvo loopback; se bloquean URLs con credenciales, consultas o fragmentos. Solicitudes a proveedores sin cookies ni redirecciones. Filtro conservador de imágenes privadas o firmadas para evitar reenviar sus URLs.

**Límite deliberado:** el secreto de cifrado está en el mismo perfil para evitar contraseñas al reiniciar. No protege contra una copia completa del perfil, malware del usuario o una página privilegiada de la extensión comprometida. No equivale al almacén seguro del sistema operativo. Los proveedores reciben las claves necesarias para autenticación y el contenido solicitado; se aplican sus políticas.

## Funcionamiento

- **B1:** cancelación por solicitud/frame; detener no inicia validación. CTRL+SHIFT distingue el salto del proveedor principal de la cancelación total.
- **B2:** conservación de imágenes URL/base64 en Chat Completions y Responses, tanto normal como streaming, incluido el proveedor principal.
- **B3:** cierre y limpieza de puertos, tiempos máximos, rechazo de desconexiones, liberación de bloqueos ante errores de detección y descarte de respuestas de generaciones canceladas.
- **B4:** `stream: true` en Responses, terminales SSE comprobados, errores/incompletos no se notifican como éxito, límites de cuerpo/evento y espera inactiva. Contadores externos normalizados antes de llegar a la UI.
- **B5:** números con signo, decimales y exponentes preservados; no se toma arbitrariamente un número del razonamiento.
- **B6:** contabilización por intento, incluidos principal de confianza media, validador, reintentos y fallos. Los fallos sin uso final no reciben un costo inventado; IDs agrupan intentos. Los costos siguen siendo orientativos, no sustituyen la factura del proveedor.
- **B7:** escrituras del historial, borrado y recorte serializados. Mocks de almacenamiento ahora copian valores como Chrome, evitando ocultar carreras por referencias compartidas.

Las correcciones de OpenAI se contrastaron con [imágenes y visión](https://developers.openai.com/api/docs/guides/images-vision) y [streaming](https://developers.openai.com/api/docs/guides/streaming-responses). No se añadió OAuth para utilizar una suscripción ChatGPT como acceso general a la API.

## Verificación y entrega

- TypeScript, sintaxis de scripts de interfaz y empaquetado comprobados.
- Suite ampliada desde 406 a **471 pruebas, todas aprobadas en 30 archivos**.
- `npm audit` y `npm audit --prefix scripts`: cero vulnerabilidades conocidas tras actualizar ambos paquetes y lockfiles. Esto no es una garantía de ausencia de vulnerabilidades.
- Build de producción sin source maps embebidos; distribución regenerada en `dist`.
- Chrome/Chromium mínimo: **102**, por la restricción de acceso al almacenamiento. Desarrollo verificado con Node **24.11.1**.

## Comprobaciones manuales restantes

No se efectuó una sesión real de Chrome con las claves del usuario ni una prueba de pentesting externa. Al recargar la extensión conviene comprobar guardar/modificar/borrar un proveedor, analizar una página permitida, cancelar, retirar el dominio y ejecutar QA. El permiso temporal de QA en memoria caduca al reiniciarse el service worker; en tal caso se relanza el escenario desde el dashboard.

Permanece una advertencia de datos existente: `questions-bank-ccna3-ccnadesdecero.json`, `final-exam_163`, parece multirrespuesta pero tiene `correctAnswer` singular. No se modificó sin contrastar la respuesta correcta. Tampoco se cambiaron las reglas de selección entre bancos con conflictos ni se desplegó CI: son mejoras de comportamiento/flujo separadas de las correcciones verificadas aquí.

Al cargar esta versión se migrarán las credenciales válidas y se eliminarán textos/trazas antiguos, sin perder métricas. Esa eliminación no tiene deshacer dentro de la extensión. Los archivos de un servidor de logs de desarrollo ejecutado previamente no están en Chrome y no se borraron.
