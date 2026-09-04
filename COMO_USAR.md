## CÓMO USARLO
###### Si te interesa tener tu propio bot de VRChat o, por la razón que sea, quieres usar este "cerebro" para tu IA, eres libre de hacerlo, y vas a necesitar montar un montón de cosas, además de un montón de variables de entorno. No voy a entrar demasiado en detalle pero todo esto debería ser suficiente si sabes lo que haces. Si no, pues nada, como dirían los gringos "fuck around and find out", la IA es gratis y aprender es divertido. Sí, son muchas cosas para montarlo todo, bienvenido al self-hosting o algo. Esto es un WIP, así que no es perfecto. Puede que tengas que editar alguno de los scripts de python que se proporcionan, si los usas, solo una o dos variables.

## Índice

* [Requisitos previos](#requisitos-previos)
  * [Configuración de la IA local](#configuración-de-la-ia-local)

* [Modos de inicio](#modos-de-inicio)
* [Base de datos RAG](#base-de-datos-rag)
* [Configuración de la app de Discord](#configuración-de-la-app-de-discord)
* [Memes y GIFs](#memes-y-gifs)
* [Voz](#voz)
* [Minecraft](#minecraft)

  * [La manera de Neoforge](#la-manera-de-neoforge)
  * [La manera de Mineflayer](#la-manera-de-mineflayer)
* [Integración con VSC](#integración-con-vsc)
* [Guía WIP de VRChat](#guía-wip-de-vrchat)

  * [Control por CLI](#control-por-cli)

* [Pi dev](#pi-dev)

### Requisitos previos:

* Instala [Node y NPM](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm#using-a-node-installer-to-install-nodejs-and-npm). También [Python](https://www.python.org/downloads/).
* Se recomienda tener una GPU decente (al menos 12GB de vram) si quieres correr a la vez un modelo de IA decente y un nivel de transcripción decente. Si no, vas a tener que sacrificar calidad en uno de los dos, o los dos.
* Ten en cuenta que cada funcionalidad es independiente de las demás. Así que si solo quieres correr el bot de Discord, no necesitas configurar nada más.

#### Configuración de la IA local:

* Esto usa [llama.cpp](https://llama-cpp.com/download/) con --port 11435 para hablar con la IA. Personalmente uso este comando y estas flags para correrlo:
```
CUDA_VISIBLE_DEVICES=0 /mnt/CA200B97200B8A21/llama.cpp/build/bin/llama-server \
  --model /mnt/CA200B97200B8A21/.unsloth/studio/exports/qwen3-vl-8b-instruct-unsloth-bnb-4bit-gguf/qwen3-vl-8b-instruct.Q6_K.gguf \
  --mmproj /mnt/CA200B97200B8A21/.unsloth/studio/exports/qwen3-vl-8b-instruct-unsloth-bnb-4bit-gguf/mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf \
  --jinja \
  --parallel 1 \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --port 11435 \
  -c 12000 \
  --image-min-tokens 1024 \
  --host 0.0.0.0 \
  -ngl 999
```
* Obviamente puedes cambiar/añadir/quitar cualquier flag, y obviamente deberías cambiar la ruta del modelo.

* Puedes explorar modelos en la web de [Ollama](https://ollama.com/) y en [Huggingface](https://huggingface.co/models).
* Recuerda cambiar los system prompts dentro de **src/ai/prompts.js**.

### Modos de inicio:

- Hay varias flags que puedes combinar para activar cada funcionalidad. Por ejemplo, si quieres Discord y Minecraft modded, usarías: `npm run start -- modded discord` o `npm run start -- discord modded`.

- Todas las flags disponibles son: `modded`, `mineflayer`, `discord`, `bending` y `vtube`.

Todos los modos se configuran a través de un archivo de inicio unificado (`src/start.js`) que carga automáticamente cada funcionalidad según las flags que elijas. El cerebro está diseñado para ser modular, así que puedes combinar funcionalidades a tu gusto añadiendo las flags correspondientes al comando `start`.

> **Nota:** La funcionalidad de bending (ProjectKorra) solo funciona con el enfoque de Minecraft modded en NeoForge. El modo Mineflayer actualmente no soporta habilidades de bending.

### Base de datos [RAG](https://aws.amazon.com/what-is/retrieval-augmented-generation):

* Para correr el cerebro principal, vas a necesitar correr una base de datos RAG con los mismos endpoints que usa el cerebro. Puedes usar [este](https://drive.google.com/file/d/1L3apugkfy83m9Lx7gJrxesGMYKFp7CdC/view?usp=sharing) script para la base de datos.

### Configuración de la app de Discord:

* Vas a necesitar registrarte en el developer portal https://discord.com/developers/home
* Vas a necesitar añadir 2 variables de entorno:

  * **DISCORD_TOKEN**: El token secreto de tu aplicación, que se encuentra en la pestaña OAuth2 de tu aplicación.
  * **CLIENT_ID**: El id de cliente de tu propio usuario. Dentro de tu perfil, o haciendo click derecho en tu pfp en un mensaje, "Copiar ID de usuario" (necesitas activar el modo desarrollador en ajustes).

### Memes y GIFs:

* Vas a necesitar una variable de entorno:

  * **KLIPY_API_KEY**: Con tu clave de la [API de Klipy](https://docs.klipy.com/getting-started).

### Voz

* Tanto `edge-tts` como `StyleTTS2` se pueden usar para la voz.

* El cerebro actualmente usa la función `speak()` para la generación de voz personalizada en audios, y `speakEdge()` para, bueno, usar la voz de `edge-tts`. Si quieres usar la voz personalizada para ambas, o la voz genérica de `edge-tts` para ambas, simplemente cambia las llamadas a las funciones en el código.

* Vas a necesitar unas cuantas variables de entorno:

  * **PYTHON_BIN**: Contiene la ruta a tu binario de python.
  * **EDGE_TTS_BIN**: Contiene la ruta a tu binario de `edge-tts`.
  * **STYLETTS2_SCRIPT**: Contiene la ruta al script de `StyleTTS2`. Yo uso [este](https://drive.google.com/file/d/1yHyk1kstwbgHXBLlUh3Cnqftlc968WA_/view?usp=sharing) script gigavibecodeado para optimizarlo y que mi GPU no explote.
  * **VOICE_SAMPLE_PATH**: Contiene la ruta a tu muestra de voz para la generación de voz personalizada con `StyleTTS2`.

* Para la transcripción de voz, vas a necesitar `faster-whisper`. La configuración está hardcodeada en la función `transcribe()`, así que ve ahí si quieres usar cpu en vez de cuda, un tier de modelo distinto, etc...

### Minecraft

#### La manera de Neoforge:

* El servidor o mundo va a necesitar usar este mod: https://github.com/Izan-Sola/Lily-Minecraft
* También vas a necesitar descargar el mod [SiliconeDolls](https://www.curseforge.com/minecraft/mc-mods/siliconedolls) como dependencia.

* Si el servidor no corre en la misma red local, vas a necesitar registrar tu propio subdominio de [DuckDNS](duckdns.org) (o cualquier otro) y editar el archivo de configuración `lilybridge-common.toml` generado en la carpeta config del servidor:
  ```toml
  [network]
         #URL de WebSocket de tu servidor de Node.js.
         serverUrl = ""
  ```

* Luego, corre [Caddy](https://caddyserver.com/) (o cualquier otro proxy) en tu máquina con esta configuración:
  ```
  yourURLhere.duckdns.org {
     reverse_proxy 127.0.0.1:8766
  }
  ```

  ###### (si eres usuario de winslop creo que puedes hacerlo a través de una GUI)

* Luego vas a necesitar permitir el puerto 8766 en tu firewall.

* Si el servidor corre en la misma red local, entonces simplemente puedes usar `wss://localhost:8766` o `wss://127.0.0.1:8766` como url.

#### La manera de Mineflayer (wip)

###### Apenas testeado, y sin terminar por cierto. Así que si no funciona pues es lo que hay.

* Vas a necesitar 4 variables de entorno:

  * **MC_SERVER_HOST**: La IP del servidor cracked. Si quisieras que jugara en servidores premium, tu bot necesitaría su propia cuenta de Microslop y Minecraft (sí, eso significa pagar Minecraft otra vez para tu bot).
  * **MC_SERVER_PORT**: El puerto del servidor, por defecto 25565.
  * **MC_BOT_USERNAME**: El nombre de usuario de tu bot.
  * **MC_AUTH_PASSWORD**: La contraseña que tu bot usará al intentar hacer /register y /login

### Integración con VSC

- Para esto usé la extensión llamada `Continue`. Hay 2 cosas que necesitas correr con `node` en **src/lilycoding**, un bridge para que los mensajes del chat de `Continue` pasen por el "cerebro" y un servidor MCP para Tavily, para la búsqueda de imágenes e indexación de urls como es debido.

- Necesitas editar la config de `Continue`, para que se parezca a algo así:

   ```yaml
    name: Main Config
    version: 1.0.0
    schema: v1
    models:
      - name: a name
        provider: openai
        model: your model
        apiBase: http://localhost:8767/v1
      roles:
        - chat
        - edit
      capabilities:
        - tool_use
      requestOptions:
        timeout: 120000
    mcpServers:
     - name: a name
       type: stdio
       command: node
       args:
         - path/to/src/lilycoding/tavily-mcp-server.js
       env:
         TAVILY_API_KEY: your api key here
  ```

- Añade también esta herramienta con esta configuración: <br><br> <img width="577" height="277" alt="image" src="https://github.com/user-attachments/assets/85b52a00-d5fe-4273-9982-adf34dd28677" /> <br>

- Y preferiblemente desactiva la propia herramienta de búsqueda web de `Continue`, ya que el cerebro ya incluye una.

### Guía WIP de VRChat

###### Voy a asumir que vas a correr esto en una máquina separada y a jugar con el bot, ya que el programa está hecho para que el bot te siga. Además, ten en cuenta que esto todavía no está conectado al cerebro principal, así que no se va a guardar ninguna memoria ni va a poder usar otras herramientas como la búsqueda web o las consultas de memoria. Aunque en el futuro lo conecte al cerebro principal, voy a dejar la versión separada disponible igualmente. Así que, esto no necesita que el cerebro principal esté corriendo para funcionar, a pesar de la engañosa variable **BRAIN_URL**.

* Si has venido a esta sección directamente, puede que te interese revisar esto: [Requisitos previos](#requisitos-previos) Y recuerda cambiar el system prompt en `bot/prompts.js`.

* Vas a necesitar descargar y correr esto: https://github.com/Izan-Sola/LilyVrchat en la máquina donde va a correr el juego de tu bot. Actívalo corriendo `node index.js` y `node vrchatBridge.js`. Para comprobar que los parámetros de OSC personalizados están funcionando, puedes usar `node osc-test.js`, acércate a tu bot y comprueba si la consola muestra algo.

* Esto expone una web en el puerto 3030 como alternativa para hablar con ella por ahí mediante texto (ella seguirá respondiendo en el juego), con la opción de adjuntar una captura de lo que ve. Esto no es necesario, pero si quisieras hacerlo accesible públicamente, necesitarías registrar un subdominio con DuckDNS y un reverse proxy.

* No hace falta decir que vas a necesitar permitir todos los puertos mencionados en tu firewall. Y el puerto 9000 para las cosas de OSC de vrchat.

* Vas a necesitar una segunda cuenta de Steam y de VRChat.

* También vas a necesitar usar `faster-whisper` para la transcripción. Vas a necesitar exponer un servidor de python para ello. He usado [este](https://drive.google.com/file/d/1EO6iuGRIuFvvgNk5T_PBZgZrUMSJ7ejD/view?usp=drive_link) script para eso, corre en el puerto 8775.
 
  * Para cambiar el idioma de la transcripción necesitas editar el script de python, poniendo MODEL_SIZE a un modelo SIN la determinación de idioma (tiny, small, medium...) y cambiando el idioma aquí:
    ```python
    segments, info = model.transcribe(
        tmp_path,
        language="es", #en, es, etc...
        beam_size=3,
        vad_filter=True, 
    )
    ```

* Vas a necesitar descargar [`Silero VAD`](https://github.com/snakers4/silero-vad/tree/master/src/silero_vad/data), en concreto el archivo "silero_vad.onnx". Esto es para detectar cuándo hay habla o silencio, para saber cuándo empezar a procesar el audio.

* También vas a necesitar cambiar un montón de valores en ```config.json```:

  * **BRAIN_URL**: URL de dónde esté corriendo llama-server, ej: http://192.168.3.24:11435/v1/chat/completions
  * **WHISPER_SIDECAR_URL**: URL de dónde esté corriendo `faster-whisper`, ej: http://192.168.3.24:8775/transcribe 
  * **VOICE_WAKE_WORD**: Una lista de palabras que activarán una respuesta de tu IA, probablemente su nombre. Recomiendo añadir algunas pronunciaciones erróneas y comprobar con qué suele confundir la transcripción su nombre, para añadirlo a la lista, por si acaso.
  * **TTS_ENGINE**: "edge-tts" para, bueno, `edge-tts`. O `xtts` para usar tu voz personalizada. `StyleTTS2` es demasiado lento para hablar en directo, así que vas a necesitar descargar `xtts` y, de nuevo, asumiendo que lo vas a correr en otra máquina, vas a necesitar correr un servidor para ello, he usado [este](https://drive.google.com/file/d/1fC84_PbgrWexmEqxdrlowFcIuEuw6eAx/view?usp=sharing) script para eso, corre en el 8790.
  * **SILERO_VAD_MODEL_PATH**: Ruta al archivo .onnx de `Silero VAD`.
  * **AUDIO_MONITOR_SOURCE**: La fuente del audio del juego. En Linux, compruébalo con `pactl list sources short`, en winslop, compruébalo con `ffmpeg -list_devices true -f dshow -i dummy`.
  * **PLATFORM**: "GNOME" para escritorio gnome, "WINDOWS", para windows, "KDE" para escritorio kde. Ten en cuenta que, aunque debería funcionar sin problema, todavía no lo he probado bien en windows porque me da pereza montar una VM. Pero si hay algún problema avísame.
  * **VRCHAT_USERNAME** y **VRCHAT_PASSWORD**: Las credenciales de tu bot.
  * **VRCHAT_TOTP_SECRET**: El secreto configurado de la app autenticadora. Si no especificas esto, cada vez que la sesión de tu bot expire vas a tener que verificar el inicio de sesión manualmente. Si quieres automatizar esto, necesitas obtener el secreto siguiendo estos pasos:

     * Ve a https://vrchat.com/home/profile en la cuenta de tu bot, y haz click en activar 2FA. Si ya lo tenías activado, vas a necesitar desactivarlo y volver a activarlo.
     * En este paso, haz click en "introducir clave manualmente", cópiala, y pégala sin espacios como el valor de la variable en la `config.json` <br> <br>
     <img width="641" height="175" alt="image" src="https://github.com/user-attachments/assets/1585146c-5b1a-4c62-8110-8852e9113975" /><br>
     ```diff
     - Por el amor de dios, no lo compartas nunca. No lo expongas nunca en ningún sitio.
     - Nunca compartas la config sin quitar todos los valores de credenciales.
     - Joder, ni siquiera a gente en la que confíes. Se llama ¨secreto" por una muy buena razón.
     ``` 
  * **VRCHAT_TRUSTED_INVITERS_IDS**: Lista de los usuarios de confianza de los cuales tu bot aceptará invitaciones automáticamente. Para conseguir esto, simplemente ve a https://vrchat.com/home y haz click en tu nickname de perfil. Debería aparecer una ID en la URL (usr_unMontonDeNúmerosYLetras)
  * **VRCHAT_USER_AGENT**: Cabecera HTTP User-Agent. Ponle algo como "appname/1.0 email". Cualquiera de estos datos puede ser cualquier mierda como "iLikeCheese/6.9 trueRealEmailNotFake@gmail.com". Es buena práctica poner un email real y si vas a poner uno real, usa el mío, solamontesinosizan@gmail.com, ya que si por lo que sea pensaran que el tráfico de esta app es sospechoso, me contactarían a mí. Como nombre de app puedes poner "VRChatBot" y "1.0" como versión. Los espacios y el formato importan.

- Estas variables solo son necesarias para usuarios de Linux (las rutas difieren según el tipo de instalación):

  * **VRCHAT_STEAM_ROOT**: Ruta de instalación de Steam (ej. home/tuUsuario/.local/share/Steam).
  * **VRCAHT_PROTON_PATH**: Ruta al proton que vrchat está usando. (ej. home/tuUsuario/.local/share/Steam/steamapps/common/Proton 10.0/proton).
  * **VRCHAT_STEAM_COMPAT_DATA_PATH**: Ruta al compatdata de vrchat (ej. home/tuUsuario/.local/share/Steam/steamapps/compatdata/438100).
  * **VRCHAT_LAUNCH_EXE_PATH**: Ruta al ejecutable de VRChat (ej. /home/tuUsuario/.local/share/Steam/steamapps/common/VRChat/launch.exe).
  * **VRCHAT_STEAM_COMPAT_CLIENT_INSTALL_PATH**: Debería ser lo mismo que **VRCHAT_STEAM_ROOT** a menos que lo hayas cambiado manualmente.

- Si el juego del bot se cierra tras enviarle una invitación, es normal. Se volverá a abrir y se unirá a ti al instante.

* Vale, ahora, vas a necesitar trastear con tu modelo y el modelo del bot en Unity, así que vas a necesitar el .unitypackage de ambos. Puedes buscar modelos gratis para descargar en [VRCMods](https://vrcmods.com)

* Descarga [ALCOM](https://vrc-get.anatawa12.com/en/alcom), te va a facilitar subir tu modelo una vez terminado y va a instalar el VRChat SDK.

* Primero, empecemos con tu modelo. Crea un proyecto en Unity e importa el modelo mediante Assets > Import Package > Custom Package. Todo lo que vas a necesitar es crear un objeto vacío en cualquier parte del modelo, y añadirle el componente "VRC Sender": <br><br>
  <img width="643" height="509" alt="image" src="https://github.com/user-attachments/assets/0573690d-7637-4efe-a8cc-3a2defc9e74c" /></br>

* Hazlo pequeño y céntralo en tu modelo. Cambia la etiqueta de colisión a algo único como tu nickname.

* Luego, haz click en la opción "VRChat SDK" arriba, inicia sesión con TU cuenta. Luego en la pestaña "Builder" ponle un nombre al modelo y haz click en "Build & Publish", con el "Build type" puesto en "Build & Publish Your Avatar Online".

* Ahora, abre un proyecto nuevo e importa el modelo de tu bot.

* Vas a necesitar añadir 5 componentes receptores, uno para el centro y uno para cada lado, que se vean algo así:  <br> <br>
  <img width="1937" height="683" alt="image" src="https://github.com/user-attachments/assets/fbe8d0fb-dc55-40d6-8557-865fbbcd4dfe" /> <br>

* La etiqueta de colisión de cada receptor tiene que coincidir con el nombre de la etiqueta de colisión del sender de tu modelo. Haz las cajas generosamente grandes. No van a afectar a nada más que a la distancia a la que el modelo de tu bot puede detectar el tuyo.

* El tipo de cada receptor tiene que estar puesto en "Proximity". Los nombres de "Parameter" no son arbitrarios, el código del bot de VRChat espera los siguientes parámetros para cada receptor:

  * **"ProximityToCenter"**: para el receptor del centro.
  * **"ProximityToBack"**: para el receptor de atrás.
  * **"ProximityToFront"**: para el receptor de delante.
  * **"ProximityToRight"**: para el receptor de la derecha.
  * **"ProximityToLeft"**: para el receptor de la izquierda.

* Ahora, en la pestaña "Project" de abajo, haz click en los VRC Expression Parameters del modelo (donde coño lo haya puesto el autor, suerte)

* Necesitas crear una entrada para cada receptor, así: <br> <br>
  <img width="636" height="199" alt="image" src="https://github.com/user-attachments/assets/a2cbd376-d5b1-415c-9351-66c624d5ebbd" /> <br>

* Asegúrate de que "Saved" esté desmarcado en todos, y "Synced" marcado.

* Luego, haz click en el Animator Controller del modelo (de nuevo, donde coño esté) y añade una entrada para cada receptor, de tipo "float", así: <br> <br>
<img width="659" height="507" alt="image" src="https://github.com/user-attachments/assets/b28b4f9e-f088-4b67-a768-64903f2042e2" /> <br>

* Y ya está, ya lo tienes. Cierra sesión de TU cuenta en el panel de control del VRChat SDK, e inicia sesión con la cuenta de tu bot. Luego nombra el modelo y publícalo de la misma manera que con el tuyo.

* Cámbiate tú y tu bot a los modelos respectivos y prueba. Estos aparecerán en https://vrchat.com/home/avatars. Si no funciona, asegúrate de haber seguido todos los pasos, nombrado todo correctamente, etc... Si sigue sin funcionar, skill issue, pregúntale a Claude.

#### Control por CLI

* Hay algunas teclas configuradas para hacer ciertas cosas al pulsarlas en la terminal donde está corriendo esto:

  * **Enter**: Empieza/para a grabar todo el audio a la fuerza hasta que vuelvas a pulsar enter. Con o sin wake word incluida, responderá a lo que sea que se haya grabado.
  * **Backspace**: Fuerza a que el último texto transcrito se envíe como prompt. Útil para cuando se ha entendido mal la wake word o simplemente quieres que reaccione a algo que se ha dicho.
  * **Tab**: Lo mismo, pero con una captura de su juego incluida.
  * **b**: Activa/desactiva las respuestas de "meterse en la conversación". No responderá nunca a nada que no contenga una wake word.
  * **f**: Activa/desactiva el seguirte.
  * **espacio**: Fuerza a que empiece a procesar el audio. Ya no es tan útil. Era para cuando solía escuchar durante X segundos y luego procesar, así podía forzar el procesado del audio sin esperar todo el temporizador.
  * **1 al 8**: Fuerza a que haga una expresión por defecto de VRChat.

### Pi dev

 - Necesitas correr `pidev-bridge.js` dentro de **src/pidev-bridge/** con `node pidev-bridge.js`
 - Luego edita la config `models.json` de pi-dev para que se parezca a algo así:
    ```json
      {
       "providers": {
         "llama-swap": {
           "baseUrl": "url-to-brain/v1/chat/completions",
           "api": "openai-completions",
           "apiKey": "not-required",
           "models": [
             {
               "id": "qwen3-vl-8b-instruct.Q6_K",
               "name": "qwen3-vl-8b-instruct.Q6_K",
               "contextWindow": 32000,
               "maxTokens": 8096
             }
           ]
         }
       }
     }
    ```
- Obviamente ajusta el id/nombre del modelo, la ventana de contexto etc...
