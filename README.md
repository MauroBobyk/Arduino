# arduino-usb-web

Clase JavaScript para conectar un **Arduino** a una aplicación web desde el navegador, tanto por **cable USB (puerto serie)** como por **Bluetooth (BLE)**.

No requiere dependencias ni compilación: es un único archivo ES module.

## Transportes soportados

| Transporte | API del navegador | Hardware típico |
| ---------- | ----------------- | --------------- |
| Cable USB / puerto serie | [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) | Arduino Uno, Nano, Mega (con cable USB) |
| Bluetooth (BLE) | [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API) | HM-10, HC-08, nRF, ESP32 con BLE |

> ⚠️ **Importante:** Web Bluetooth solo funciona con módulos **BLE** (HM-10, HC-08, nRF, ESP32-BLE). Los módulos Bluetooth *clásicos* (HC-05, HC-06) no son visibles desde Web Bluetooth; para esos casos usa el cable USB o un módulo BLE.

> ⚠️ **Navegadores:** Web Serial y Web Bluetooth requieren Chrome, Edge u Opera. Web Serial no está disponible en Firefox/Safari. Ambas APIs exigen un contexto seguro: `https://` o `localhost`.

## Instalación

### Vía `<script type="module">`

```html
<script type="module">
  import ArduinoUSB from './arduino-usb.js';
  // ... usar la clase
</script>
```

### Vía npm / CDN

```js
import ArduinoUSB from 'arduino-usb-web'; // si se publica en npm
```

## Uso rápido

```js
import ArduinoUSB from './arduino-usb.js';

const arduino = new ArduinoUSB();

// Eventos
arduino.addEventListener('connect',    (e) => console.log('Conectado:', e.detail));
arduino.addEventListener('data',       (e) => console.log('Datos:', e.detail));
arduino.addEventListener('line',       (e) => console.log('Línea:', e.detail));
arduino.addEventListener('disconnect', (e) => console.log('Desconectado:', e.detail));
arduino.addEventListener('error',      (e) => console.error(e.detail));

// Conexión por cable USB
const btnUsb = document.querySelector('#btn-usb');
btnUsb.addEventListener('click', async () => {
  try {
    await arduino.connectUSB({ baudRate: 9600 });
  } catch (err) {
    console.error(err.message);
  }
});

// Conexión por Bluetooth (módulo BLE)
const btnBt = document.querySelector('#btn-bt');
btnBt.addEventListener('click', async () => {
  try {
    await arduino.connectBluetooth({ namePrefix: 'HM' });
  } catch (err) {
    console.error(err.message);
  }
});

// Enviar un comando
async function enviar() {
  await arduino.sendLine('LED:ON'); // envía "LED:ON\n"
}
```

## API

### `new ArduinoUSB(options?)`

| Opción | Por defecto | Descripción |
| ------ | ----------- | ----------- |
| `baudRate` | `9600` | Velocidad del puerto serie. |
| `lineEnding` | `'\n'` | Fin de línea usado por `sendLine()` y el evento `line`. |
| `dispatchLines` | `true` | Emite el evento `line` por cada línea completa recibida. |
| `bluetoothService` | UART nórdico | UUID del servicio UART BLE. |
| `bluetoothRxCharacteristic` | UART nórdico | UUID donde se **escribe** (RX del módulo). |
| `bluetoothTxCharacteristic` | UART nórdico | UUID que se **lee** por notificaciones (TX del módulo). |

### Propiedades

- `usbSupported` → `boolean`
- `bluetoothSupported` → `boolean`
- `connected` → `boolean`
- `transport` → `'usb' | 'bluetooth' | null`
- `portInfo` → objeto con la info del puerto USB
- `bluetoothDevice` → `{ name, id }` del dispositivo BLE

### Métodos

- `connectUSB(options?)` → abre el selector de puertos y conecta por USB.
- `connectBluetooth(options?)` → abre el selector de dispositivos y conecta por BLE.
- `send(data)` → envía `string`, `Uint8Array`, `ArrayBuffer` o `number`.
- `sendLine(text)` → envía texto más el fin de línea configurado.
- `disconnect()` → cierra la conexión activa.

### Eventos

| Evento | `event.detail` |
| ------ | -------------- |
| `connect` | `{ transport, ... }` |
| `data` | texto crudo recibido (string) |
| `line` | una línea completa (string, sin el fin de línea) |
| `disconnect` | `{ transport, reason? }` |
| `error` | objeto `Error` |

## Conexión con tu aplicación web

La clase está pensada para integrarse en tu frontend:

```js
import ArduinoUSB from './arduino-usb.js';

const arduino = new ArduinoUSB({ baudRate: 115200 });

arduino.addEventListener('line', (e) => {
  // Ejemplo: parsear datos tipo "temp=23.5"
  const [key, value] = e.detail.split('=');
  if (key === 'temp') actualizarTemperatura(value);
});

arduino.addEventListener('connect', (e) => {
  document.body.dataset.estado = 'conectado';
});

arduino.addEventListener('disconnect', () => {
  document.body.dataset.estado = 'desconectado';
});
```

## Sketch de ejemplo para Arduino

```cpp
void setup() {
  Serial.begin(9600);
}

void loop() {
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd == "LED:ON") {
      digitalWrite(LED_BUILTIN, HIGH);
      Serial.println("LED encendido");
    } else if (cmd == "LED:OFF") {
      digitalWrite(LED_BUILTIN, LOW);
      Serial.println("LED apagado");
    }
  }
}
```

⚖️ Licencia y Limitación de Responsabilidad
Este proyecto está publicado bajo la licencia GNU General Public License v3.0 (GPL-3.0). Podés consultar los términos completos en el archivo LICENSE.

¿Qué significa esto para las clases y proyectos?
Libertad de uso: Sos libre de descargar, modificar, usar y distribuir este código para tus trabajos prácticos, proyectos personales o profesionales.
Código abierto obligado: Si modificás este software y decidís compartirlo o publicarlo, estás obligado a hacerlo de forma pública y bajo esta misma licencia GPLv3.
Sin garantías ("As Is"): El software se entrega tal cual está, con fines puramente educativos. No se ofrece ninguna garantía de funcionamiento.
Exención de responsabilidad: El autor no se hace responsable por códigos que no compilen, fallas en el sistema, ni por cualquier daño físico o rotura de componentes de hardware (como placas Arduino, sensores o actuadores) derivados del uso de este programa. El uso corre por cuenta y riesgo del usuario.
