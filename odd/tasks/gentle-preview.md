# gentle-preview — dos plugins de preview para Pi / Gentle Shell

Un repositorio, dos paquetes npm independientes (`gentle-quick-peek`, `gentle-image-preview`), portados a la API de extensiones de Pi desde `midudev/better-claude`.
Pruebas de integración aisladas en `/home/erickfm/D-SSD/personal/gs-lab`.

## Specs

**S1 — Alcance.** Dos plugins nuevos: `quick peek` e `image preview`, para "GS (gentle-shell) y/o pi".
Quote: "quiero implementar lo que es quick peek e image preview."

**S2 — Un repo, dos paquetes.** Un único proyecto con dos plugins, publicables por separado.
Quote: "en un unico proyecto como se tiene aca https://github.com/midudev/better-claude pero que contiene 2 plugins, en pi.dev y/o npm seran obviamente 2 plugins apartes."

**S3 — Instalación exacta.** Estos cuatro comandos deben funcionar de punta a punta:
Quote:
```
gentle-shell install npm:gentle-quick-peek
gentle-shell install npm:gentle-image-preview

pi install npm:gentle-quick-peek
pi install npm:gentle-image-preview
```

**S4 — Plataformas.** "Considerar que debe funcionar para windows, wsl, linux, omarchy, mac".

**S5 — Nombre.** El proyecto se llama `gentle-preview` (decisión L2). Directorio creado: `/home/erickfm/D-SSD/personal/projects/gentle-preview`.

**S6 — Quick Peek.** Port pi-nativo (decisión L2), con la fidelidad funcional del original: desde la sesión en curso, una ruta de archivo se puede inspeccionar sin abrirla — un archivo de código muestra sus líneas numeradas y coloreadas, con la línea `:N` iluminada; una imagen, video o documento muestra su thumbnail; y siempre se ven nombre, tipo, tamaño y antigüedad. Un click abre el archivo en el visor del sistema o el file manager con el archivo seleccionado. Debe haber camino de teclado siempre, y hover de mouse en fullscreen.
Restricciones de plataforma que la spec hereda (evidencia E3): Pi no expone render de mensajes built-in, así que el peek no se dispara por hover sobre la respuesta del asistente sino desde una superficie propia de la extensión.
Corrección L5 (orden de la lista). Quote: "me muestra 4 incluyendome la carpeta packages/quick-peek/lib cuando solo dije nmobrame 3 archivos".
Regla: una respuesta que nombra una carpeta junto a sus archivos no debe hacer que la carpeta parezca un archivo más. Los archivos se listan antes que los directorios, dentro de cada grupo se conserva el orden de aparición, y un directorio se marca con `/` final.

**S7 — Image Preview.** Actúa sobre rutas de imagen en el prompt en edición y en el transcript.
Quote (requisito del usuario): "quiero usar el recomendado pero cuando pegamos una imagen la idea es que vaya teniendo esta estructura [Image #N], la idea es reducir tamaño de escritura y que sea entendible image #1 con la image#2, y asi sucecivamente, adicionalmente otra funcionalidad, es que si posicionamos el mouse en [Image #N] podemos la ruta para identificar nosotros como usuarios cual era la imagen o ruta o bien la previsualizacion."
Concretamente: al pegar una imagen el editor recibe `[Image #N]` en lugar de la ruta completa; la ruta real queda asociada a ese N; el modelo debe poder resolver cada `[Image #N]` a su archivo; y poner el puntero sobre ese `[Image #N]` (en la banda sobre el editor) revela la ruta o la preview.

Corrección L5 (numeración). Quote: "no respeto que si no tengo imagen dentro del inputo debe consdierarse nuevamente como el 1."
Regla: el número pertenece al borrador, no a la sesión. Un borrador sin imágenes empieza en 1; dentro del borrador el siguiente número es uno más que el mayor token presente. El bloque `[Image refs]` se materializa en cada mensaje enviado, así el historial queda inequívoco aunque un número vuelva a usarse más tarde.

Corrección L8 (atajo). Quote: "aprovecha de hacer la correccion que si los usuarios estan pegando con ctrl+v usar ese por defecto".
Regla: `ctrl+v` es el atajo por defecto y `GENTLE_IMAGE_PREVIEW_SHORTCUT` sigue permitiendo moverlo. Tomar el atajo obliga a cubrir lo que hacía el pegado nativo de Pi, porque la última extensión que registra gana: imagen → `[Image #N]`, rutas de archivos copiados → sus rutas, texto → el texto, nada legible → nada. Ningún pegado se traga en silencio.

Corrección L5 (destino). Quote: "luego de eso saque un screenshoot y me aparece en el tmp, no deberia estar segun yo".
Regla: una imagen pegada no va al directorio temporal mientras exista una carpeta de imágenes real. Precedencia: `GENTLE_IMAGE_PREVIEW_DIR`, `OMARCHY_SCREENSHOT_DIR`, `$XDG_PICTURES_DIR/screenshots`, un `~/Pictures/screenshots` existente, y sólo entonces el cache temporal acotado. Sólo se poda el cache temporal; una imagen idéntica reutiliza el archivo que ya está en disco.

**S8 — Verificación.** CI matriz en GitHub Actions sobre `ubuntu-latest`, `windows-latest` y `macos-latest` (unit tests, typecheck, pack dry-run) más prueba manual del usuario en Windows, WSL y macOS (decisión L2). Los casos que dependen del emulador real de terminal y del puntero no se declaran verificados sin esa prueba.

**S9 — Rutas.** Código en `/home/erickfm/D-SSD/personal/projects/gentle-preview`. Pruebas en `/home/erickfm/D-SSD/personal/gs-lab` ("en gs-lab haremos las prueba de los plugins"), con el patrón de launcher aislado ya usado por `launch-voice-lab.sh` y `launch-emote-lab.sh`.

## Tasks

| ID | Tarea | Specs | Ruta | Commit |
| --- | --- | --- | --- | --- |
| T1 | Scaffold del monorepo: pnpm workspaces, tsconfig estricto, runner de tests, LICENSE, .gitignore, CI matriz | S2, S5 | inline | 98d078c |
| T2 | `quick-peek`: resolución de rutas (absolutas, `~`, relativas, `:line:column`) y extracción de preview (código con línea iluminada, imagen, metadatos) | S6 | worker | 87e4059, 5951b24 |
| T3 | `quick-peek`: overlay TUI con teclado y MouseRegion en fullscreen; click abre visor/file manager por plataforma; fallback sin soporte gráfico | S6 | worker | 8b988b7 |
| T4 | `image-preview`: paste → `[Image #N]`, mapa de sesión, expansión del token antes del modelo | S7 | worker | b9caf68, 0118482, f81df34 |
| T5 | `image-preview`: banda de chips sobre el editor, hover → ruta o preview, click abre el visor | S7 | worker | 621cbe1 |
| T6 | Empaquetado: `pi` manifest por paquete, READMEs, docs de instalación para GS y pi | S2, S3 | inline | 98d078c, b9caf68, 87e4059 |
| T7 | Tests unitarios por paquete y CI matriz ubuntu/windows/macos | S8 | inline | 12bdf8e |
| T8 | `gs-lab`: launcher aislado y corrida de verificación en Omarchy con evidencia | S9 | inline | parcial — launcher fuera del repo; ver L4 |
| T9 | Cierre: reporte, plataformas sin verificar, decisión de publicación en npm | S8 | inline | ver L4 |
| T10 | `image-preview`: numeración por borrador y destino de la imagen pegada fuera de `os.tmpdir()` | S7 | inline | edc3746 |
| T11 | `quick-peek`: archivos antes que directorios en la lista de la sesión | S6 | inline | ec26c28 |
| T12 | Repositorio público, issue-first, reglas de contribución y atribución | S2, S8 | inline | cc828c6 |
| T13 | Publicación en npm (`gentle-quick-peek@0.1.0`, `gentle-image-preview@0.1.0`) y previews para el gallery de pi.dev | S3 | inline | 633b380 + npm |
| T14 | Arreglo de los tests que asumían POSIX para que la matriz CI pase en Windows y macOS | S4, S8 | worker | ver L6 |
| T15 | `image-preview`: `ctrl+v` por defecto con fallback de rutas y texto, versión 0.2.0 | S7, S4 | worker | ver L8 |

## Log

**L1 — Pedido original (verbatim).**

> a cursor le habia dicho que queria implementar lo siguiente
> quiero implementar 2 plugins nuevos para GS (gentle-shell) y/o pi
>
> en claude code una persona lo implemento
>
> quiero implementar lo que es quick peek e image preview.
>
> Estos se instalaran
> /home/erickfm/D-SSD/personal/projects
> en un unico proyecto como se tiene aca
> https://github.com/midudev/better-claude
>
> pero que contiene 2 plugins, en pi.dev y/o npm seran obviamente 2 plugins apartes.
>
> Para el proyecto tenemos que darle un nombre
> e idealmente usar recomendaciones para que podamos ver cual darle
>
> en gs-lab haremos las prueba de los plugins.
>
> claramente se puede instalar los 2 plugins con
> gentle-shell install npm:gentle-quick-peek
> gentle-shell install npm:gentle-image-preview
>
> o
>
> pi install npm:gentle-quick-peek
> pi install npm:gentle-image-preview
>
> Considerar que debe funcionar para windows, wsl, linux, omarchy, mac
>
> este es el repositorio prinicipal donde va el codigo
> estaes la ruta para las pruebas /home/erickfm/D-SSD/personal/gs-lab

**L2 — Decisiones del usuario.**

- Nombre del proyecto: `gentle-preview`.
- Quick Peek: "TUI nativo de pi (recomendado)".
- Image Preview: "quiero usar el recomendado pero cuando pegamos una imagen la idea es que vaya teniendo esta estructura [Image #N]..." (ver S7).
- Verificación: "CI matriz + tu prueba manual (recomendado)".

**L3 — Evidencia recogida (no especulación).**

- E1: los plugins de referencia son `midudev/better-claude` → `plugins/quick-peek` y `plugins/image-preview`; READMEs leídos completos. Quick Peek: rutas linkeadas, hover con Quick Look o primeras 20 líneas coloreadas, click → `open -R`/`explorer /select,`/`org.freedesktop.FileManager1`/`wslpath -w`. Image Preview: hover sobre `[Image #N]`, ventana AppKit / Windows Forms / Tk X11, o kitty graphics en terminal.
- E2: `gentle-shell install npm:<pkg>` delega en `pi install` contra el home resuelto (`lib/gentle-shell-launcher.ts:1343`).
- E3: `@earendil-works/pi-tui` exporta `Image`, `MouseRegion`, `renderImage`, `imageFallback`, `detectCapabilities`. Pi enruta mouse normalizado solo en fullscreen (`docs/tui.md`); en regular manda la terminal.
- E4: no existe hook de render para mensajes built-in: `registerMessageRenderer`/`registerEntryRenderer` van por `customType` y `registerToolRenderer` por tool call (`dist/core/extensions/types.d.ts:1250-1256`).
- E5: pi no adjunta la imagen pegada al prompt: la escribe en `os.tmpdir()/pi-clipboard-<uuid>.<ext>` e inserta la **ruta** en el editor (`dist/modes/interactive/interactive-mode.js:2479-2488`). `InputEvent` acepta `{action:"transform", text, images}` (`types.d.ts:910-927`), que es donde se expande el token.
- E6: convenciones del repo hermano `gentle-voice`: pnpm workspace, `tsconfig.json` strict + `noEmit`, tests con `node --experimental-strip-types --test` vía `scripts/run-tests.mjs`, CI matriz ubuntu/windows/macos con node 22, `pi` manifest en package.json con keyword `pi-package`.
- E7: homes distintos — GS usa `~/.gentle-shell/agent`, pi por defecto `~/.pi/agent`.

**L4 — Entrega, desviaciones y límites de la verificación.**

- Estado del árbol: 91 tests (54 `quick-peek` + 37 `image-preview`) en 0 fallos, `npm run typecheck` limpio, `npm run pack:check` genera los dos tarballs. Commits por unidad: 98d078c, b9caf68, 0118482, 621cbe1, 87e4059, 5951b24, 8b988b7, 12bdf8e, f81df34.
- Desviación 1 (evidencia): el atajo de `quick-peek` es `alt+o`, no `alt+p`. `alt+p` es default de `app.model.cycleBackward` en Windows/WSL (`pi-coding-agent/dist/core/keybindings.js:33`); `alt+o` no aparece en los defaults ni en `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS`.
- Desviación 2 (evidencia): `image-preview` no toma `ctrl+v`. `app.clipboard.pasteImage` no está reservado, la última extensión registrada gana (`dist/core/extensions/runner.js:459-474`), y en el home de GS ese atajo ya lo ocupa `paste-image-to-screenshots.ts`. Default `ctrl+shift+v`, configurable con `GENTLE_IMAGE_PREVIEW_SHORTCUT`; ponerlo en `ctrl+v` es opt-in documentado.
- Defecto encontrado al inspeccionar el artefacto y corregido en f81df34: `image-preview` usaba *parameter properties* de TypeScript, que jiti acepta pero cualquier loader strip-only rechaza. Ahora los dos paquetes cargan igual bajo strip-only.
- Carga del artefacto empaquetado verificada: los dos tarballs se instalaron con `pi install` en un home aislado (`gs-lab/preview-agent`) y `pi list` los lista; el contenido extraído carga con una API de Pi simulada y registra `/peek` + `alt+o` (quick-peek) y `/image-paths` + `session_start`/`input`/`session_shutdown` (image-preview).
- Límite de la verificación interactiva (T8): el home aislado arranca sin proveedor (`auth.json` de 2 bytes), así que la TUI de GS levanta y termina sin llegar al prompt. La verificación de render, hover y click en Omarchy queda pendiente de credenciales en ese home o de la corrida manual del usuario, que es lo que S8 asigna explícitamente.
- Nota operativa: el primer arranque en un home de laboratorio nuevo provisiona el companion `npm:gentle-engram` de Gentle Shell **dentro de ese home**; `GENTLE_SHELL_NO_AUTO_SETUP` no lo bloquea y nunca toca `~/.gentle-shell` ni `~/.pi`. El launcher ahora falla cerrado (exit 3) cuando no hay proveedor, en vez de morir en silencio.

**L5 — Corrección del usuario tras la primera prueba manual (verbatim).**

> /home/erickfm/Pictures/screenshots/screenshot-2026-11-02_15-05-41.png
> me indicaste que le dijera nombrame 3 archivos, y me muestra 4 incluyendome la carpeta packages/quick-peek/lib
> cuando solo dije nmobrame 3 archivos
> luego de eso saque un screenshoot y me aparece en el tmp, no deberia estar segun yo, porque no corresponde a lo que le pregunte.
>
> tambien hice el screen shot me aparecio la image #1 y luego borre y me aparecio el siguiente numero que es image #2 y asi sucecivamente cada vez que iba borrando, no respeto que si no tengo imagen dentro del inputo debe consdierarse nuevamente como el 1.

Resuelto en edc3746 (numeración por borrador, destino fuera del temporal) y ec26c28 (archivos antes que directorios). La carpeta que aparece en la lista es intencional: una carpeta también se puede espiar y muestra sus primeras entradas; lo que estaba mal era el orden, que la hacía parecer un archivo más.

**L6 — Publicación, repositorio y hallazgos de la entrega.**

- Repositorio público creado: https://github.com/efolchmontiel/gentle-preview (`main` = commit de scaffold, 98d078c). Issue #1 y PR #2 (`Closes #1`), con la regla de que sólo el dueño mergea.
- Publicado en npm: `gentle-quick-peek@0.1.0` y `gentle-image-preview@0.1.0`, ambos con `latest` apuntando a 0.1.0, `pi.image` y `assets/` en el tarball. El gallery de pi.dev toma el paquete por la keyword `pi-package`.
- Verificación end-to-end de S3 en un home aislado: `pi install npm:gentle-quick-peek` + `pi install npm:gentle-image-preview` y después `gentle-shell --home <lab>` **sin** `-e`; el banner lista `quick-peek.ts` e `image-preview.ts` y `/peek` abre el overlay. El camino por npm alcanza.
- Hallazgo 1: npm publica primero un placeholder `0.0.0-stage` y la versión real aparece al terminar el escaneo (minutos). El registro mostraba sólo el placeholder, no un fallo del publish.
- Hallazgo 2: `npm install`/`pi install` fallaban con `ETARGET` porque el packument cacheado todavía tenía sólo el placeholder. `npm cache clean --force` lo resuelve; con `--cache` fresco la 0.1.0 resuelve.
- Hallazgo 3: `pi install <ruta.tgz>` acepta el archivo pero al cargar lo trata como extensión y falla con `Unknown file extension ".tgz"`. Para probar un tarball hay que instalarlo por nombre (`npm:`) o extraerlo, no declararlo como paquete de archivo.
- Hallazgo 4: la CI matriz encontró 11 fallos (10 en Windows, 1 en macOS) en tres niveles distintos, y mi primera lectura —"es sólo la suite"— era incorrecta. (a) **Defecto real de producción** en `image-preview/lib/clipboard.ts`: `readViaWindowsClipboard` decidía la conversión de ruta con `process.platform` en vez de la plataforma inyectada, así que en un host macOS o Windows el backend WSL nunca llamaba a `wslpath`. (b) Un fixture que escribía en `/tmp/...` y en Windows resolvía a `D:\tmp\...`. (c) Ocho casos de resolución de rutas con fixtures POSIX sobre el `resolve()` del host, más la falta de una costura para resolver rutas win32 desde Linux. Arreglado en su nivel: plataforma inyectada en el backend del portapapeles, `path` opcional en `PathResolutionContext` (default: el `node:path` del host), y cada caso corre ahora en las dos flavours sin saltear nada por `process.platform`.
- Limitación conocida, marcada y no arreglada: `parseLocation` interpreta un `C:12` suelto como ruta `C` más línea 12. Ningún caso real lo dispara y cambiarlo es otra decisión.
- Las cuatro capturas de los READMEs salen de una sesión real de Gentle Shell con las extensiones cargadas: el overlay se dibuja encima del banner de arranque y no pinta fondo, así que se capturó el ANSI real por filas y columnas visibles y se re-renderizó como frame estático.
- Limpieza pedida: borrados los artefactos de prueba en `/tmp` (`gentle-preview-*`, `gp-load*`, `gpshots`, logs de ghostty/foot/wl-copy, caché npm temporal) y los `.tgz` del repo; sesiones tmux y servidor HTTP de captura cerrados.

**L7 — Estrategia de entrega (frontera de slice).**

La rama `feat/gentle-preview-plugins` acumula 17 commits y ~4470 líneas propias sobre `main`, muy por encima del slice de ~400. La entrega elegida es **un solo PR (#2)** porque es la implementación inicial completa y partirla en dos PRs encadenados exigiría reescribir la historia ya publicada; el cuerpo del PR deja constancia de que se puede reordenar en PRs encadenados (uno por paquete) si el dueño lo prefiere antes de revisar. Frontera registrada acá: `main` = 98d078c (scaffold + tooling + feature doc), PR #2 = todo lo demás, con cortes internos legibles: tooling y CI, `quick-peek` (modelo, capa OS, wiring y docs), `image-preview` (modelo, capa OS, wiring y docs), capturas y atribución. Todo commit posterior a esta nota debe ir en una rama nueva y un PR nuevo, no en #2.

**L8 — `ctrl+v` por defecto (verbatim).**

> aprovecha de hacer la correccion que si los usuarios estan pegando con ctrl+v usar ese por defecto, y que dependiendo la ruta que se este usando pega con /tmp/ o en donde tiene el screenshoot, por ejemplo nosotros lo tenemos en ctrl+v en la ruta /home/erickfm/Pictures/screenshots/ al presionar ctrl+v

Decisión: el atajo por defecto pasa a `ctrl+v` y el handler cubre imagen, rutas de archivos copiados y texto, para no romper el pegado que antes hacía Pi. El destino ya resolvía a `/home/erickfm/Pictures/screenshots` en esta máquina (por `OMARCHY_SCREENSHOT_DIR`) y no se toca; `/tmp` queda sólo como último recurso cuando no existe ninguna carpeta de imágenes. Rama `feat/ctrl-v-default`, stacked sobre `fix/package-metadata`; issue #5. Frontera de slice de esta rama: sólo `packages/image-preview/**` y la línea del README raíz que documentaba el atajo viejo.
