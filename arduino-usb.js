/*
  Copyright (C) 2026, Mauro Bobyk.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://gnu.org>.
*/
/**
 * arduino-usb.js
 * -----------------------------------------------------------------------------
 * Clase para conectar un Arduino a una aplicación web desde el navegador.
 *
 * Soporta dos transportes:
 *   1. USB / puerto serie  ->  Web Serial API  (navigator.serial)
 *   2. Bluetooth (BLE)     ->  Web Bluetooth API (navigator.bluetooth)
 *
 * Uso:
 *   import ArduinoUSB from './arduino-usb.js';
 *
 *   const arduino = new ArduinoUSB();
 *   arduino.addEventListener('connect',    e => console.log('Conectado', e.detail));
 *   arduino.addEventListener('data',       e => console.log('Datos:', e.detail));
 *   arduino.addEventListener('line',       e => console.log('Línea:', e.detail));
 *   arduino.addEventListener('disconnect', e => console.log('Desconectado'));
 *   arduino.addEventListener('error',      e => console.error(e.detail));
 *
 *   await arduino.connectUSB({ baudRate: 9600 });       // Cable USB
 *   await arduino.connectBluetooth({ namePrefix: 'HM' }); // Bluetooth BLE
 *
 *   await arduino.sendLine('HOLA');   // Envía "HOLA\n"
 *   await arduino.disconnect();
 * -----------------------------------------------------------------------------
 */

/** UUIDs del servicio UART nórdico (NUS), estándar en módulos BLE tipo HM-10, HC-08, nRF, ESP32-BLE. */
const NORDIC_UART_SERVICE   = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NORDIC_UART_RX_CHAR  = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // Escribimos aquí (RX del módulo)
const NORDIC_UART_TX_CHAR  = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // Leemos aquí (TX del módulo, notifica)

class ArduinoUSB extends EventTarget {
  /**
   * @param {Object} [options] Configuración por defecto.
   * @param {number} [options.baudRate=9600]           Velocidad en baudios para USB.
   * @param {string} [options.lineEnding='\n']         Fin de línea usado por sendLine() y el evento 'line'.
   * @param {boolean} [options.dispatchLines=true]     Emitir también el evento 'line' por cada línea completa.
   * @param {string} [options.bluetoothService]        UUID del servicio Bluetooth UART.
   * @param {string} [options.bluetoothRxCharacteristic] UUID de la característica donde ESCRIBIMOS.
   * @param {string} [options.bluetoothTxCharacteristic] UUID de la característica que LEEMOS (notificaciones).
   */
  constructor(options = {}) {
    super();

    this._options = {
      baudRate: 9600,
      lineEnding: '\n',
      dispatchLines: true,
      bluetoothService: NORDIC_UART_SERVICE,
      bluetoothRxCharacteristic: NORDIC_UART_RX_CHAR,
      bluetoothTxCharacteristic: NORDIC_UART_TX_CHAR,
      ...options,
    };

    // Estado interno
    this._transport = null; // 'usb' | 'bluetooth' | null

    // Web Serial
    this._port = null;
    this._reader = null;
    this._writer = null;
    this._readLoopRunning = false;
    this._textDecoder = new TextDecoder();

    // Web Bluetooth
    this._btDevice = null;
    this._btService = null;
    this._btWriteChar = null; // característica donde escribimos
    this._btReadChar = null;  // característica con notificaciones que leemos
    this._btNotifyHandler = null;

    // Buffer para reconstruir líneas
    this._lineBuffer = '';
  }

  // -------------------------------------------------------------------------
  // Propiedades de estado
  // -------------------------------------------------------------------------

  /** Indica si Web Serial (cable USB) está disponible en este navegador. */
  get usbSupported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  /** Indica si Web Bluetooth está disponible en este navegador. */
  get bluetoothSupported() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  /** Devuelve true si hay una conexión activa (USB o Bluetooth). */
  get connected() {
    return this._transport !== null;
  }

  /** Transporte activo: 'usb', 'bluetooth' o null. */
  get transport() {
    return this._transport;
  }

  /** Información del puerto serie conectado (solo USB). */
  get portInfo() {
    return this._port ? this._port.getInfo() : null;
  }

  /** Nombre/ID del dispositivo Bluetooth conectado (solo Bluetooth). */
  get bluetoothDevice() {
    if (!this._btDevice) return null;
    return { name: this._btDevice.name, id: this._btDevice.id };
  }

  // -------------------------------------------------------------------------
  // Conexión por USB (Web Serial API)
  // -------------------------------------------------------------------------

  /**
   * Conecta por cable USB / puerto serie. Muestra el selector de puertos del navegador.
   * @param {Object} [options]
   * @param {number} [options.baudRate]        Baudios (por defecto los del constructor).
   * @param {Array}  [options.filters]         Filtros de Web Serial (p. ej. [{ usbVendorId: 0x2341 }]).
   * @returns {Promise<Object>} Información del puerto conectado.
   */
  async connectUSB(options = {}) {
    if (!this.usbSupported) {
      throw new Error('Web Serial API no está disponible en este navegador. Usa Chrome/Edge y sirve la página por HTTPS o localhost.');
    }
    if (this.connected) await this.disconnect();

    const { baudRate = this._options.baudRate, filters = [] } = options;

    let port;
    try {
      port = filters.length
        ? await navigator.serial.requestPort({ filters })
        : await navigator.serial.requestPort();
    } catch (err) {
      if (err && err.name === 'NotFoundError') {
        throw new Error('No se seleccionó ningún puerto serie.');
      }
      throw err;
    }

    await port.open({ baudRate });

    this._port = port;
    this._transport = 'usb';
    this._writer = null; // se crea al primer envío

    this._emit('connect', { transport: 'usb', baudRate, port: port.getInfo() });

    // La lectura corre en segundo plano; no bloquea connectUSB().
    this._startReadLoop();

    return port.getInfo();
  }

  // -------------------------------------------------------------------------
  // Conexión por Bluetooth (Web Bluetooth API)
  // -------------------------------------------------------------------------

  /**
   * Conecta por Bluetooth Low Energy (BLE) a un módulo UART (HM-10, HC-08, nRF, ESP32-BLE...).
   * @param {Object} [options]
   * @param {string} [options.name]              Nombre exacto del dispositivo.
   * @param {string} [options.namePrefix]        Prefijo del nombre (p. ej. 'HM', 'HC-08').
   * @param {string} [options.service]           UUID del servicio UART.
   * @param {string} [options.rxCharacteristic]  UUID donde ESCRIBIMOS (RX del módulo).
   * @param {string} [options.txCharacteristic]  UUID que LEEMOS por notificaciones (TX del módulo).
   * @returns {Promise<Object>} { name, id } del dispositivo.
   */
  async connectBluetooth(options = {}) {
    if (!this.bluetoothSupported) {
      throw new Error('Web Bluetooth API no está disponible en este navegador.');
    }
    if (this.connected) await this.disconnect();

    const {
      name = '',
      namePrefix = '',
      service = this._options.bluetoothService,
      rxCharacteristic = this._options.bluetoothRxCharacteristic,
      txCharacteristic = this._options.bluetoothTxCharacteristic,
    } = options;

    const request = { optionalServices: [service] };
    const filters = [];
    if (name) filters.push({ name });
    if (namePrefix) filters.push({ namePrefix });

    if (filters.length) {
      request.filters = filters;
      delete request.optionalServices;
      // Sin servicios opcionales no podríamos acceder al UART: los agregamos igual.
      request.optionalServices = [service];
    }

    let device;
    try {
      device = await navigator.bluetooth.requestDevice(request);
    } catch (err) {
      if (err && err.name === 'NotFoundError') {
        throw new Error('No se seleccionó ningún dispositivo Bluetooth.');
      }
      throw err;
    }

    const server = await device.gatt.connect();
    const btService = await server.getPrimaryService(service);
    const writeChar = await btService.getCharacteristic(rxCharacteristic);
    const readChar = await btService.getCharacteristic(txCharacteristic);

    await readChar.startNotifications();
    this._btNotifyHandler = (event) => {
      const value = event.target.value;
      if (value) this._handleIncoming(this._textDecoder.decode(value));
    };
    readChar.addEventListener('characteristicvaluechanged', this._btNotifyHandler);

    this._btDevice = device;
    this._btService = btService;
    this._btWriteChar = writeChar;
    this._btReadChar = readChar;
    this._transport = 'bluetooth';

    // Si el módulo se apaga o se aleja, el navegador cierra la conexión.
    device.addEventListener('gattserverdisconnected', () => this._onBluetoothDisconnected());

    const info = { name: device.name, id: device.id };
    this._emit('connect', { transport: 'bluetooth', device: info });
    return info;
  }

  // -------------------------------------------------------------------------
  // Envío de datos
  // -------------------------------------------------------------------------

  /**
   * Envía datos al dispositivo conectado.
   * @param {string|Uint8Array|ArrayBuffer|ArrayBufferView|number} data Datos a enviar.
   * @returns {Promise<void>}
   */
  async send(data) {
    if (!this.connected) {
      throw new Error('No hay conexión activa. Llama a connectUSB() o connectBluetooth() primero.');
    }

    const bytes = this._toBytes(data);

    if (this._transport === 'usb') {
      if (!this._writer) {
        this._writer = this._port.writable.getWriter();
      }
      await this._writer.write(bytes);
    } else if (this._transport === 'bluetooth') {
      await this._btWriteChar.writeValue(bytes);
    }
  }

  /**
   * Envía texto y agrega el fin de línea configurado (por defecto '\n').
   * Equivale a Serial.println() del lado de Arduino.
   * @param {string} text
   * @returns {Promise<void>}
   */
  sendLine(text) {
    return this.send(String(text) + this._options.lineEnding);
  }

  // -------------------------------------------------------------------------
  // Desconexión
  // -------------------------------------------------------------------------

  /** Cierra la conexión activa (USB o Bluetooth). */
  async disconnect() {
    if (!this.connected) return;

    const transport = this._transport;

    try {
      if (transport === 'usb') {
        await this._cancelReadLoop();
        if (this._writer) {
          try { await this._writer.close(); } catch (err) { /* ignorar */ }
          this._writer = null;
        }
        if (this._port) {
          try { await this._port.close(); } catch (err) { /* ignorar */ }
          this._port = null;
        }
      } else if (transport === 'bluetooth') {
        this._cleanupBluetooth();
        if (this._btDevice && this._btDevice.gatt && this._btDevice.gatt.connected) {
          this._btDevice.gatt.disconnect();
        }
      }
    } finally {
      this._transport = null;
      this._emit('disconnect', { transport });
    }
  }

  // -------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------

  /** Convierte cualquier entrada soportada a Uint8Array. */
  _toBytes(data) {
    if (typeof data === 'string') {
      return new TextEncoder().encode(data);
    }
    if (data instanceof Uint8Array) {
      return data;
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    return new Uint8Array([data]);
  }

  /** Emite un evento con detalle. */
  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Procesa texto entrante: emite 'data' y, si corresponde, 'line'. */
  _handleIncoming(text) {
    this._emit('data', text);

    if (this._options.dispatchLines !== false) {
      this._lineBuffer += text;
      const lines = this._lineBuffer.split(this._options.lineEnding);
      this._lineBuffer = lines.pop() || '';
      for (const line of lines) {
        this._emit('line', line.replace(/\r$/, ''));
      }
    }
  }

  /** Bucle de lectura del puerto serie (corre en segundo plano). */
  async _startReadLoop() {
    if (this._readLoopRunning) return;
    this._readLoopRunning = true;

    try {
      this._reader = this._port.readable.getReader();
      while (true) {
        const { value, done } = await this._reader.read();
        if (done) break;
        this._handleIncoming(this._textDecoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if (this._transport === 'usb') {
        this._emit('error', err);
      }
    } finally {
      try { this._reader && this._reader.releaseLock(); } catch (err) { /* ignorar */ }
      this._reader = null;
      this._readLoopRunning = false;

      // Si el puerto desapareció sin que llamáramos a disconnect(), el cable se desconectó.
      if (this._transport === 'usb' && (!this._port || !this._port.readable)) {
        this._transport = null;
        this._port = null;
        this._emit('disconnect', { transport: 'usb', reason: 'device-unplugged' });
      }
    }
  }

  /** Detiene el bucle de lectura del puerto serie. */
  async _cancelReadLoop() {
    if (this._reader) {
      try { await this._reader.cancel(); } catch (err) { /* ignorar */ }
      try { this._reader.releaseLock(); } catch (err) { /* ignorar */ }
      this._reader = null;
    }
  }

  /** Limpia referencias y suscripciones Bluetooth. */
  _cleanupBluetooth() {
    if (this._btReadChar && this._btNotifyHandler) {
      try {
        this._btReadChar.removeEventListener('characteristicvaluechanged', this._btNotifyHandler);
      } catch (err) { /* ignorar */ }
    }
    if (this._btReadChar) {
      try { this._btReadChar.stopNotifications(); } catch (err) { /* ignorar */ }
    }
    this._btNotifyHandler = null;
    this._btReadChar = null;
    this._btWriteChar = null;
    this._btService = null;
    this._btDevice = null;
  }

  /** Se ejecuta cuando el navegador informa que el BLE se desconectó. */
  _onBluetoothDisconnected() {
    if (this._transport !== 'bluetooth') return;
    this._cleanupBluetooth();
    this._transport = null;
    this._emit('disconnect', { transport: 'bluetooth', reason: 'gattserverdisconnected' });
  }
}

export { ArduinoUSB };
export default ArduinoUSB;

// Acceso global (útil si se incluye con <script type="module">).
if (typeof window !== 'undefined' && !window.ArduinoUSB) {
  window.ArduinoUSB = ArduinoUSB;
}
