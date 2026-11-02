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

**S7 — Image Preview.** Actúa sobre rutas de imagen en el prompt en edición y en el transcript.
Quote (requisito del usuario): "quiero usar el recomendado pero cuando pegamos una imagen la idea es que vaya teniendo esta estructura [Image #N], la idea es reducir tamaño de escritura y que sea entendible image #1 con la image#2, y asi sucecivamente, adicionalmente otra funcionalidad, es que si posicionamos el mouse en [Image #N] podemos la ruta para identificar nosotros como usuarios cual era la imagen o ruta o bien la previsualizacion."
Concretamente: al pegar una imagen el editor recibe `[Image #N]` (N incremental por sesión, empezando en 1) en lugar de la ruta completa; la ruta real queda asociada a ese N; el modelo debe poder resolver cada `[Image #N]` a su archivo; y poner el puntero sobre ese `[Image #N]` (en la banda sobre el editor) revela la ruta o la preview.

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
