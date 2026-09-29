ERP + Halloween 2026 — v0.4.3 PREPRODUCCIÓN
Fecha: 2026-09-29

OBJETIVO DE ESTA VERSIÓN
Cerrar el núcleo que debe quedar estable antes de imprimir Jacks: códigos, QR, lote maestro, recuperación, respaldos y consulta/canje.

CAMBIOS PRINCIPALES
1) Escáner QR
- La cámara queda por encima de todas las ventanas Halloween.
- Cancelar / X detienen la cámara y regresan a la pantalla anterior.
- La lectura tolera espacios/guiones raros, pero valida que el código exista realmente en Folios.
- Código manual sigue disponible.

2) Lotes Jack con QR reales
- Generar lote crea los Jacks en Folios y descarga UN paquete ZIP.
- En PRUEBAS el archivo empieza con PRUEBA_.
- En PRODUCCIÓN empieza con PRODUCCION_.
- Cada ZIP incluye:
  * MAESTRO.json = identidad exacta de los Jacks físicos del lote.
  * RESPALDO_INICIAL.json = foto completa del sistema justo después de crear el lote.
  * Jacks.csv = código, lote y archivo QR para maquetación.
  * QR/<codigo>.svg = QR real estándar de cada Jack.
  * LEEME.txt.
- QR: negro sobre blanco, corrección M, margen blanco de 4 módulos.
- El dato maestro siempre es el código Jack; el QR puede regenerarse desde ese código.

3) Respaldo en 3 capas
A. Paquete maestro del lote: responde “qué Jacks físicos existen”.
B. JSON completo de temporada: responde “qué pasó con cada Jack y cuál es el estado actual”.
C. Google Sheets/ERP: padrón de Jacks + movimientos nuevos como auditoría externa.

En Opciones existe:
- Copiar padrón de Jacks para Sheets (sugerencia de pestaña: Halloween_Jacks).
- Copiar movimientos nuevos para hoja (sugerencia: Halloween_Movimientos).
- Descargar respaldo JSON completo.

4) Catrina y canje final
- Catrina ya no es un toggle accidental.
- Entregar Catrina pide confirmación.
- Para revertirla hay que mantener presionado y después confirmar.
- Después del canje final desaparecen checkbox/botón de canje y queda sólo el estado realizado.
- Charro Negro queda ligado al canje final.

5) Limpieza visual
- “eventos” visible se renombró a “movimientos”.
- Si no hay sobres pendientes, no aparece un botón inútil de entrega.

MOTOR CONGELADO
folios_v2.js NO fue modificado.
SHA-256 esperado:
6c6ddadb46ec62f72baaa897a63e2a70546e54914d07eaeb37556a8ab150b01d

PRUEBA RECOMENDADA ANTES DE PRODUCCIÓN
1. Estar en modo PRUEBAS.
2. Generar 5–10 Jacks.
3. Confirmar que se descargó PRUEBA_Jacks_<lote>_IMPRESION.zip.
4. Abrir el ZIP y comprobar MAESTRO.json, RESPALDO_INICIAL.json, Jacks.csv y carpeta QR.
5. Abrir varios QR (o un PDF hecho con ellos) y escanearlos desde el HTML.
6. Activar un Jack, sumar varias compras y comprobar sobres cada $25.
7. Probar Catrina y canje.
8. Borrar temporada de prueba. El borrado limpia las bases del navegador, NO borra los ZIP/JSON descargados.
9. Recuperar/consultar Jacks y confirmar que quedan 0.
10. Repetir una prueba: restaurar MAESTRO.json extraído del ZIP y confirmar que reaparecen exactamente los códigos de prueba.
11. Borrar nuevamente la prueba.

PASO A PRODUCCIÓN
1. Activar PRODUCCIÓN 2026 escribiendo la frase solicitada.
2. Generar el lote real.
3. NO imprimir hasta comprobar el ZIP.
4. Copiar ese ZIP a DOS lugares distintos (por ejemplo PC + Drive).
5. Mandar ese mismo ZIP a Cloud para los PDFs de Jack. Jacks.csv indica qué SVG corresponde a cada código.
6. Pegar el padrón en Halloween_Jacks del ERP/Sheets.
7. Durante la temporada: respaldar movimientos a Halloween_Movimientos y descargar JSON completo con frecuencia.

TAMAÑO DE QR PARA IMPRESIÓN
Base recomendada: 15 mm de lado, ideal 18 mm si el diseño lo permite, siempre conservando el margen blanco.
Probar el PDF final en pantalla antes de imprimir.

ARCHIVOS DEL PAQUETE DEL ERP
- index.html
- halloween.js
- folios_v2.js
- qrcode_hw.js (generador QR local; QRCode for JavaScript de Kazuhiko Arase, licencia MIT)
- README_Halloween2026.txt
