/**
 * Ender-3 S1 Plus Cockpit - Klipper & Moonraker Client API
 * 
 * Provides:
 * - Direct Moonraker REST & WebSocket communication (http://192.168.1.21:7125)
 * - Automatic host detection (localStorage, URL query, window config, LAN default)
 * - Real-time WebSocket telemetry with exponential reconnect backoff
 * - HTTP polling fallback with adaptive intervals
 * - G-code command router (Temperature, Preheat, Z-Offset, Speed, Fan, Motion)
 * - Screws Tilt Calculate output parser (CW/CCW/turns -> dial angles)
 * - G-code file list management with thumbnail resolution
 * - File upload with progress tracking
 * - Remote ntfy relay fallback when outside LAN
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.KlipperAPI = factory();
    root.klipperApi = new root.KlipperAPI();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_HOST = 'http://192.168.1.21:7125';
  const NTFY_CMD_TOPIC = 'myender_kamelhin_cmd_82737';
  const NTFY_TELEMETRY_TOPIC = 'myender_kamelhin_telemetry_82737';

  class KlipperAPI {
    constructor(options = {}) {
      this.host = this._resolveHost(options.host);
      this.pollInterval = options.pollInterval || 2500;
      this.useNtfyFallback = options.useNtfyFallback !== false;

      this.ws = null;
      this.wsConnected = false;
      this.wsRetryTimer = null;
      this.wsRetryAttempts = 0;
      this.wsRpcId = 1;
      this.wsPendingRequests = new Map();

      this.pollingTimer = null;
      this.isPolling = false;
      this.lastTelemetryTs = 0;
      this.lastPingMs = 0;
      this.connected = false;

      // Telemetry normalized state
      this.state = {
        status: 'ready',            // 'printing' | 'paused' | 'ready' | 'offline' | 'error'
        stateMessage: 'Готов к печати',
        filename: '',
        progress: 0,                // 0 to 100
        hotend: 0,
        hotend_target: 0,
        bed: 0,
        bed_target: 0,
        fan_speed: 0,               // 0 to 100 (%)
        speed_factor: 100,          // %
        z: 0.0,
        toolhead: [0, 0, 0, 0],     // [X, Y, Z, E]
        layer: 0,
        total_layers: 0,
        time_left: 0,               // seconds
        print_duration: 0,          // seconds
        total_duration: 0,
        filament_used: 0,           // mm
        plug: { is_on: true, power: 0, voltage: 230, amperage: 0 },
        climate: { temp: null, humidity: null },
        lights: { nozzle: false, frame: false },
        ping: 0
      };

      // Callbacks
      this.listeners = {
        telemetry: new Set(),
        connection: new Set(),
        gcodeResponse: new Set(),
        error: new Set()
      };

      // Optional SSE stream for remote cloud relay
      this.sseSource = null;
    }

    // =========================================================================
    // HOST DETECTION & SETUP
    // =========================================================================
    _resolveHost(providedHost) {
      if (providedHost) return this._cleanUrl(providedHost);

      if (typeof window !== 'undefined') {
        // 1. URL search params e.g. ?host=http://192.168.1.21:7125
        const params = new URLSearchParams(window.location.search);
        const qHost = params.get('host') || params.get('moonraker');
        if (qHost) return this._cleanUrl(qHost);

        // 2. Window global configuration
        if (window.__MOONRAKER_HOST__) return this._cleanUrl(window.__MOONRAKER_HOST__);

        // 3. LocalStorage persistence
        try {
          const stored = localStorage.getItem('moonraker_host');
          if (stored) return this._cleanUrl(stored);
        } catch (e) {}

        // 4. Same-origin check (if served directly from Moonraker or Mainsail)
        if (window.location.port === '7125' || window.location.pathname.includes('/printer')) {
          return window.location.origin;
        }
      }

      return DEFAULT_HOST;
    }

    _cleanUrl(url) {
      return (url || '').trim().replace(/\/+$/, '');
    }

    setHost(newHost) {
      this.host = this._cleanUrl(newHost);
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('moonraker_host', this.host);
        }
      } catch (e) {}

      // Reconnect WebSocket & reset polling
      this.disconnectWebSocket();
      this.connectWebSocket();
      this.queryStatus();
    }

    getWsUrl() {
      const url = new URL(this.host);
      const wsProtocol = (url.protocol === 'https:') ? 'wss:' : 'ws:';
      return `${wsProtocol}//${url.host}/websocket`;
    }

    // =========================================================================
    // EVENT SUBSCRIPTION
    // =========================================================================
    on(event, fn) {
      if (this.listeners[event]) {
        this.listeners[event].add(fn);
      }
      return () => this.off(event, fn);
    }

    off(event, fn) {
      if (this.listeners[event]) {
        this.listeners[event].delete(fn);
      }
    }

    _emit(event, data) {
      if (this.listeners[event]) {
        this.listeners[event].forEach(fn => {
          try { fn(data); } catch (err) { console.error(`[KlipperAPI] Event error (${event}):`, err); }
        });
      }
    }

    // =========================================================================
    // LIFECYCLE: START & STOP
    // =========================================================================
    init() {
      this.connectWebSocket();
      this.startPolling();
      if (this.useNtfyFallback) {
        this.initNtfyStream();
      }
      return this;
    }

    destroy() {
      this.stopPolling();
      this.disconnectWebSocket();
      if (this.sseSource) {
        this.sseSource.close();
        this.sseSource = null;
      }
    }

    // =========================================================================
    // WEBSOCKET TELEMETRY & JSON-RPC
    // =========================================================================
    connectWebSocket() {
      if (typeof WebSocket === 'undefined') return;
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        return;
      }

      clearTimeout(this.wsRetryTimer);
      const wsUrl = this.getWsUrl();

      try {
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
          this.wsConnected = true;
          this.wsRetryAttempts = 0;
          this._setConnected(true);
          this._subscribeObjects();
        };

        this.ws.onmessage = (event) => {
          this._handleWsMessage(event.data);
        };

        this.ws.onclose = () => {
          this.wsConnected = false;
          this._scheduleWsReconnect();
        };

        this.ws.onerror = (err) => {
          this.wsConnected = false;
          this._emit('error', { type: 'websocket', error: err });
          try { this.ws.close(); } catch (e) {}
        };
      } catch (err) {
        this.wsConnected = false;
        this._scheduleWsReconnect();
      }
    }

    disconnectWebSocket() {
      clearTimeout(this.wsRetryTimer);
      if (this.ws) {
        try {
          this.ws.onclose = null;
          this.ws.onerror = null;
          this.ws.close();
        } catch (e) {}
        this.ws = null;
      }
      this.wsConnected = false;
    }

    _scheduleWsReconnect() {
      const delay = Math.min(1000 * Math.pow(1.5, this.wsRetryAttempts++), 12000);
      this.wsRetryTimer = setTimeout(() => {
        this.connectWebSocket();
      }, delay);
    }

    _subscribeObjects() {
      const subscribeReq = {
        jsonrpc: '2.0',
        method: 'printer.objects.subscribe',
        params: {
          objects: {
            print_stats: null,
            heater_bed: null,
            extruder: null,
            toolhead: null,
            fan: null,
            gcode_move: null,
            display_status: null
          }
        },
        id: this.wsRpcId++
      };
      this._sendWsRaw(subscribeReq);
    }

    _sendWsRaw(payload) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(payload));
        return true;
      }
      return false;
    }

    _handleWsMessage(dataStr) {
      try {
        const msg = JSON.parse(dataStr);

        // JSON-RPC Response
        if (msg.id && this.wsPendingRequests.has(msg.id)) {
          const { resolve, reject } = this.wsPendingRequests.get(msg.id);
          this.wsPendingRequests.delete(msg.id);
          if (msg.error) reject(msg.error);
          else resolve(msg.result);
          return;
        }

        // Moonraker Status Update Notification
        if (msg.method === 'notify_status_update' && Array.isArray(msg.params)) {
          const statusObj = msg.params[0] || {};
          this._mergeTelemetry(statusObj);
          return;
        }

        // Gcode Response Notification (crucial for SCREWS_TILT_CALCULATE and terminal)
        if (msg.method === 'notify_gcode_response' && Array.isArray(msg.params)) {
          const line = msg.params[0] || '';
          this._emit('gcodeResponse', line);
          return;
        }
      } catch (err) {
        console.warn('[KlipperAPI] WS parse error:', err);
      }
    }

    // =========================================================================
    // HTTP POLLING (ROBUST FALLBACK)
    // =========================================================================
    startPolling() {
      if (this.isPolling) return;
      this.isPolling = true;

      const loop = async () => {
        if (!this.isPolling) return;
        // If WebSocket is actively updating, we can slow down HTTP polling
        const interval = this.wsConnected ? 8000 : (this.state.status === 'printing' ? 1500 : this.pollInterval);
        await this.queryStatus().catch(() => {});
        this.pollingTimer = setTimeout(loop, interval);
      };

      loop();
    }

    stopPolling() {
      this.isPolling = false;
      clearTimeout(this.pollingTimer);
    }

    async queryStatus() {
      const url = `${this.host}/printer/objects/query?print_stats&heater_bed&extruder&toolhead&fan&gcode_move&display_status`;
      const startT = performance.now();

      try {
        const ctrl = new AbortController();
        const timeoutId = setTimeout(() => ctrl.abort(), 3500);

        const resp = await fetch(url, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          signal: ctrl.signal
        });
        clearTimeout(timeoutId);

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const ping = Math.round(performance.now() - startT);

        this.lastPingMs = ping;
        this._setConnected(true);

        if (data.result && data.result.status) {
          this._mergeTelemetry(data.result.status, ping);
        }
        return this.state;
      } catch (err) {
        this.lastPingMs = 0;
        // If WS is not connected either, mark offline
        if (!this.wsConnected) {
          this._setConnected(false);
        }
        throw err;
      }
    }

    _setConnected(val) {
      if (this.connected !== val) {
        this.connected = val;
        this.state.status = val ? (this.state.status === 'offline' ? 'ready' : this.state.status) : 'offline';
        this._emit('connection', { connected: val, ws: this.wsConnected, host: this.host });
      }
    }

    // =========================================================================
    // TELEMETRY NORMALIZATION
    // =========================================================================
    _mergeTelemetry(patch, ping = null) {
      this.lastTelemetryTs = Date.now();

      // Print Stats
      if (patch.print_stats) {
        const ps = patch.print_stats;
        if (ps.filename !== undefined) this.state.filename = ps.filename;
        if (ps.state !== undefined) {
          const raw = ps.state.toLowerCase();
          if (raw === 'printing') this.state.status = 'printing';
          else if (raw === 'paused') this.state.status = 'paused';
          else if (raw === 'complete') this.state.status = 'ready';
          else if (raw === 'standby' || raw === 'ready') this.state.status = 'ready';
          else if (raw === 'error') this.state.status = 'error';
          else this.state.status = raw;
          this.state.stateMessage = ps.message || this._defaultStatusLabel(this.state.status);
        }
        if (ps.print_duration !== undefined) this.state.print_duration = ps.print_duration;
        if (ps.total_duration !== undefined) this.state.total_duration = ps.total_duration;
        if (ps.filament_used !== undefined) this.state.filament_used = ps.filament_used;
      }

      // Display Status & Progress
      if (patch.display_status) {
        const ds = patch.display_status;
        if (ds.progress !== undefined) {
          this.state.progress = Math.min(100, Math.max(0, Math.round(ds.progress * 100)));
        }
      }

      // Hotend / Extruder
      if (patch.extruder) {
        const ext = patch.extruder;
        if (ext.temperature !== undefined) this.state.hotend = parseFloat(ext.temperature.toFixed(1));
        if (ext.target !== undefined) this.state.hotend_target = Math.round(ext.target);
      }

      // Bed
      if (patch.heater_bed) {
        const bed = patch.heater_bed;
        if (bed.temperature !== undefined) this.state.bed = parseFloat(bed.temperature.toFixed(1));
        if (bed.target !== undefined) this.state.bed_target = Math.round(bed.target);
      }

      // Part Fan
      if (patch.fan) {
        if (patch.fan.speed !== undefined) {
          this.state.fan_speed = Math.round(patch.fan.speed * 100);
        }
      }

      // Gcode Move & Speed Factor
      if (patch.gcode_move) {
        const gm = patch.gcode_move;
        if (gm.speed_factor !== undefined) {
          this.state.speed_factor = Math.round(gm.speed_factor * 100);
        }
        if (gm.gcode_position) {
          this.state.toolhead = gm.gcode_position;
          this.state.z = parseFloat((gm.gcode_position[2] || 0).toFixed(2));
        }
      }

      // Toolhead
      if (patch.toolhead) {
        const th = patch.toolhead;
        if (th.position) {
          this.state.toolhead = th.position;
          this.state.z = parseFloat((th.position[2] || 0).toFixed(2));
        }
        if (th.estimated_print_time && this.state.print_duration) {
          this.state.time_left = Math.max(0, Math.round(th.estimated_print_time - this.state.print_duration));
        }
      }

      // Estimate remaining time from progress if estimated_print_time not available
      if (this.state.status === 'printing' && this.state.progress > 0 && this.state.print_duration > 15) {
        const totalEst = (this.state.print_duration / (this.state.progress / 100));
        this.state.time_left = Math.max(0, Math.round(totalEst - this.state.print_duration));
      }

      if (ping !== null) {
        this.state.ping = ping;
      }

      // Pass directly to UI listeners
      this._emit('telemetry', Object.assign({}, this.state));
    }

    _defaultStatusLabel(status) {
      switch (status) {
        case 'printing': return 'Идёт печать...';
        case 'paused': return 'Печать на паузе';
        case 'offline': return 'Принтер обесточен или офлайн';
        case 'error': return 'Ошибка Klipper';
        case 'ready':
        default: return 'Готов к печати';
      }
    }

    // =========================================================================
    // REMOTE NTFY RELAY INTEGRATION (Optional fallback)
    // =========================================================================
    initNtfyStream() {
      if (typeof EventSource === 'undefined') return;
      try {
        if (this.sseSource) this.sseSource.close();
        this.sseSource = new EventSource(`https://ntfy.sh/${NTFY_TELEMETRY_TOPIC}/sse`);

        this.sseSource.onmessage = (e) => {
          try {
            const raw = JSON.parse(e.data);
            const msg = raw.message ? JSON.parse(raw.message) : raw;
            if (msg) {
              // Map ntfy structure into state
              if (msg.hotend !== undefined) this.state.hotend = parseFloat(msg.hotend);
              if (msg.hotend_target !== undefined) this.state.hotend_target = Math.round(msg.hotend_target);
              if (msg.bed !== undefined) this.state.bed = parseFloat(msg.bed);
              if (msg.bed_target !== undefined) this.state.bed_target = Math.round(msg.bed_target);
              if (msg.progress !== undefined) this.state.progress = parseInt(msg.progress);
              if (msg.filename) this.state.filename = msg.filename;
              if (msg.state) this.state.status = msg.state.toLowerCase();
              if (msg.z !== undefined) this.state.z = parseFloat(msg.z);
              if (msg.plug) this.state.plug = msg.plug;
              if (msg.climate) this.state.climate = msg.climate;
              if (msg.lights) this.state.lights = msg.lights;
              this._emit('telemetry', Object.assign({}, this.state));
            }
          } catch (err) {}
        };
      } catch (err) {}
    }

    async _sendNtfyRelay(cmd, params = {}) {
      try {
        fetch(`https://ntfy.sh/${NTFY_CMD_TOPIC}`, {
          method: 'POST',
          headers: { 'Title': 'MiniApp Command' },
          body: JSON.stringify({ cmd, ...params })
        }).catch(() => {});
      } catch (e) {}
    }

    // =========================================================================
    // CORE G-CODE & CONTROL METHODS
    // =========================================================================
    async sendGcode(script) {
      if (!script) return;
      const cleanScript = script.trim();

      // Mirror to ntfy relay for sync if enabled
      if (this.useNtfyFallback) {
        this._sendNtfyRelay('GCODE', { script: cleanScript });
      }

      try {
        const resp = await fetch(`${this.host}/printer/gcode/script`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ script: cleanScript })
        });
        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`Gcode error (${resp.status}): ${errText}`);
        }
        return await resp.json();
      } catch (err) {
        this._emit('error', { type: 'gcode', script: cleanScript, error: err });
        throw err;
      }
    }

    // Temperature Control
    async setTemperature(heater, temp) {
      const target = Math.max(0, Math.round(temp));
      const isBed = (heater === 'bed' || heater === 'heater_bed');
      const gcode = isBed ? `M140 S${target}` : `M104 S${target}`;
      return this.sendGcode(gcode);
    }

    // Preset Profiles
    async preheat(profile) {
      if (typeof profile === 'string') {
        const prof = profile.toUpperCase();
        if (prof === 'PETG') {
          return this.sendGcode('M104 S235\nM140 S78');
        } else if (prof === 'PLA') {
          return this.sendGcode('M104 S205\nM140 S60');
        } else if (prof === 'COOLDOWN' || prof === 'OFF') {
          return this.sendGcode('M104 S0\nM140 S0');
        }
      } else if (typeof profile === 'object') {
        const cmds = [];
        if (profile.hotend !== undefined) cmds.push(`M104 S${Math.round(profile.hotend)}`);
        if (profile.bed !== undefined) cmds.push(`M140 S${Math.round(profile.bed)}`);
        if (cmds.length > 0) return this.sendGcode(cmds.join('\n'));
      }
      throw new Error(`Unknown preheat profile: ${JSON.stringify(profile)}`);
    }

    // Baby-stepping Z-offset
    async adjustZOffset(delta) {
      const num = parseFloat(delta);
      if (isNaN(num)) return;
      const formatted = (num > 0 ? '+' : '') + num.toFixed(3);
      return this.sendGcode(`SET_GCODE_OFFSET Z_ADJUST=${formatted} MOVE=1`);
    }

    // Speed Factor (M220)
    async setSpeedFactor(pct) {
      const speed = Math.max(10, Math.min(300, Math.round(pct)));
      return this.sendGcode(`M220 S${speed}`);
    }

    // Part Cooling Fan Speed (M106 / M107)
    async setFanSpeed(pct) {
      const p = Math.max(0, Math.min(100, Math.round(pct)));
      if (p === 0) {
        return this.sendGcode('M107');
      }
      const pwm = Math.round((p / 100) * 255);
      return this.sendGcode(`M106 S${pwm}`);
    }

    // Print Job Controls
    async pausePrint() {
      if (this.useNtfyFallback) this._sendNtfyRelay('PAUSE');
      return fetch(`${this.host}/printer/print/pause`, { method: 'POST' });
    }

    async resumePrint() {
      if (this.useNtfyFallback) this._sendNtfyRelay('RESUME');
      return fetch(`${this.host}/printer/print/resume`, { method: 'POST' });
    }

    async cancelPrint() {
      if (this.useNtfyFallback) this._sendNtfyRelay('CANCEL');
      return fetch(`${this.host}/printer/print/cancel`, { method: 'POST' });
    }

    // Axis Homing & Jogging
    async home(axes = 'XYZ') {
      const cleanAxes = axes.toUpperCase();
      if (cleanAxes === 'XYZ' || cleanAxes === 'ALL') {
        return this.sendGcode('G28');
      }
      const parts = cleanAxes.split('').filter(a => ['X', 'Y', 'Z'].includes(a)).join(' ');
      return this.sendGcode(`G28 ${parts}`);
    }

    async jogMove(axis, distance, speed = 3000) {
      const ax = axis.toUpperCase();
      const dist = parseFloat(distance);
      if (!['X', 'Y', 'Z'].includes(ax) || isNaN(dist)) return;
      return this.sendGcode(`G91\nG1 ${ax}${dist.toFixed(2)} F${speed}\nG90`);
    }

    async extrude(length = 5, speed = 300) {
      const len = Math.abs(parseFloat(length) || 5);
      return this.sendGcode(`M83\nG1 E${len.toFixed(1)} F${speed}`);
    }

    async retract(length = 5, speed = 300) {
      const len = Math.abs(parseFloat(length) || 5);
      return this.sendGcode(`M83\nG1 E-${len.toFixed(1)} F${speed}`);
    }

    async motorsOff() {
      return this.sendGcode('M84');
    }

    async emergencyStop() {
      return fetch(`${this.host}/printer/emergency_stop`, { method: 'POST' });
    }

    async firmwareRestart() {
      return fetch(`${this.host}/printer/firmware_restart`, { method: 'POST' });
    }

    // =========================================================================
    // SCREWS TILT CALCULATE & CALIBRATION PARSER
    // =========================================================================
    /**
     * Executes SCREWS_TILT_CALCULATE and parses probe lines into dial instructions:
     * e.g. "Front-Left : x=30, y=30, z=0.00 : CW 01:15"
     */
    async runScrewsTiltCalculate() {
      // 1. Send SCREWS_TILT_CALCULATE G-code
      await this.sendGcode('SCREWS_TILT_CALCULATE');

      // 2. Poll gcode_store or wait for lines to appear
      // A full bed probe of 4 screws typically takes 15-25 seconds on Ender-3 S1 Plus
      return new Promise((resolve, reject) => {
        let attempts = 0;
        const maxAttempts = 35; // ~35 seconds timeout

        const checkConsole = async () => {
          attempts++;
          try {
            const resp = await fetch(`${this.host}/server/gcode_store?count=30`);
            if (resp.ok) {
              const data = await resp.json();
              const gcodeStore = (data.result && data.result.gcode_store) ? data.result.gcode_store : [];
              const lines = gcodeStore.map(item => item.message || '').filter(Boolean);

              const parsed = this.parseScrewsTiltOutput(lines);
              if (parsed && (parsed.FL || parsed.FR || parsed.RL || parsed.RR)) {
                resolve(parsed);
                return;
              }
            }
          } catch (e) {}

          if (attempts >= maxAttempts) {
            reject(new Error('Screws Tilt Calculate timeout (no probe results detected)'));
          } else {
            setTimeout(checkConsole, 1200);
          }
        };

        setTimeout(checkConsole, 3000);
      });
    }

    /**
     * Standalone Parser for SCREWS_TILT_CALCULATE output lines
     * Can parse string or array of strings.
     */
    parseScrewsTiltOutput(input) {
      const lines = Array.isArray(input) ? input : String(input).split(/\r?\n/);
      const results = {};

      // Standard Klipper regex:
      // // screw_name : x=30.0, y=30.0, z=0.00000 : CW 01:15
      // or // Front-Right : x=270.0, y=30.0, z=0.00000 : (base)
      const regex = /(?:^\/\/\s*)?([A-Za-z0-9_\-\s]+?)\s*:\s*x\s*=\s*([-\d.]+)\s*,\s*y\s*=\s*([-\d.]+)\s*,\s*z\s*=\s*([-\d.]+)\s*:\s*(.+)$/i;

      for (const line of lines) {
        const match = line.match(regex);
        if (!match) continue;

        const rawName = match[1].trim();
        const x = parseFloat(match[2]);
        const y = parseFloat(match[3]);
        const z = parseFloat(match[4]);
        const actionStr = match[5].trim();

        const key = this._mapScrewKey(rawName, x, y);
        if (!key) continue;

        const isBase = actionStr.toLowerCase().includes('base');
        let direction = isBase ? 'BASE' : 'OK';
        let turnsStr = '00:00';
        let hours = 0;
        let minutes = 0;
        let totalMinutes = 0;
        let degrees = 0;

        if (!isBase) {
          const dirMatch = actionStr.match(/(CW|CCW)\s*(\d+):(\d+)/i);
          if (dirMatch) {
            direction = dirMatch[1].toUpperCase();
            hours = parseInt(dirMatch[2], 10);
            minutes = parseInt(dirMatch[3], 10);
            turnsStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
            totalMinutes = (hours * 60) + minutes;
            // 60 minutes = 360 degrees
            const baseDeg = (totalMinutes / 60) * 360;
            degrees = (direction === 'CW') ? baseDeg : -baseDeg;
          }
        }

        const isLevel = isBase || totalMinutes <= 3 || Math.abs(z) < 0.035;

        results[key] = {
          key: key,
          name: rawName,
          x: x,
          y: y,
          z: z,
          direction: direction,
          turns: turnsStr,
          hours: hours,
          minutes: minutes,
          totalMinutes: totalMinutes,
          degrees: degrees,
          isBase: isBase,
          isLevel: isLevel,
          label: isBase ? 'БАЗА 0.0' : (totalMinutes === 0 ? 'ОК' : `${direction} ${turnsStr}`),
          raw: line
        };
      }

      return Object.keys(results).length > 0 ? results : null;
    }

    _mapScrewKey(name, x, y) {
      const lower = name.toLowerCase();
      if (lower.includes('front') && lower.includes('left') || lower === 'fl' || lower.includes('screw1')) return 'FL';
      if (lower.includes('front') && lower.includes('right') || lower === 'fr' || lower.includes('screw2')) return 'FR';
      if (lower.includes('rear') && lower.includes('left') || lower.includes('back') && lower.includes('left') || lower === 'rl' || lower.includes('screw3')) return 'RL';
      if (lower.includes('rear') && lower.includes('right') || lower.includes('back') && lower.includes('right') || lower === 'rr' || lower.includes('screw4')) return 'RR';

      // Fallback coordinate mapping for Ender-3 S1 Plus (300x300 bed)
      if (x < 150 && y < 150) return 'FL';
      if (x >= 150 && y < 150) return 'FR';
      if (x < 150 && y >= 150) return 'RL';
      if (x >= 150 && y >= 150) return 'RR';

      return null;
    }

    // =========================================================================
    // FILE MANAGEMENT & CATALOG
    // =========================================================================
    async fetchFilesList(root = 'gcodes') {
      const url = `${this.host}/server/files/list?root=${encodeURIComponent(root)}`;
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Files fetch failed: HTTP ${resp.status}`);
        const data = await resp.json();
        const rawFiles = data.result || [];

        return rawFiles.map(f => this._normalizeFileInfo(f, root));
      } catch (err) {
        this._emit('error', { type: 'files', error: err });
        throw err;
      }
    }

    _normalizeFileInfo(f, root) {
      const filename = f.path || f.filename || '';
      const cleanName = filename.replace(/\.(gcode|gco|g)$/i, '');
      const meta = f.metadata || {};

      let timeFormatted = '--';
      if (meta.estimated_time) {
        const totalSec = Math.round(meta.estimated_time);
        const hrs = Math.floor(totalSec / 3600);
        const mins = Math.floor((totalSec % 3600) / 60);
        timeFormatted = hrs > 0 ? `${hrs}ч ${mins}м` : `${mins} мин`;
      }

      let weightFormatted = '--';
      if (meta.filament_total) {
        // Approximate PLA/PETG weight ~3g per meter of 1.75mm
        const meters = meta.filament_total / 1000;
        const grams = Math.round(meters * 3.0);
        weightFormatted = `${grams} г`;
      } else if (meta.filament_weight_total) {
        weightFormatted = `${Math.round(meta.filament_weight_total)} г`;
      }

      // Find largest thumbnail if available
      let thumbnailUrl = null;
      if (meta.thumbnails && Array.isArray(meta.thumbnails) && meta.thumbnails.length > 0) {
        const sorted = meta.thumbnails.slice().sort((a, b) => (b.width * b.height) - (a.width * a.height));
        const best = sorted[0];
        if (best.relative_path) {
          const parentDir = filename.includes('/') ? filename.substring(0, filename.lastIndexOf('/') + 1) : '';
          thumbnailUrl = `${this.host}/server/files/${root}/${parentDir}${best.relative_path}`;
        }
      }

      return {
        filename: filename,
        displayName: cleanName,
        size: f.size || 0,
        modified: f.modified || 0,
        estimatedTime: timeFormatted,
        filamentWeight: weightFormatted,
        material: meta.filament_type || (filename.toUpperCase().includes('PETG') ? 'PETG' : 'PLA'),
        layerHeight: meta.layer_height ? `${meta.layer_height} мм` : '0.2 мм',
        thumbnail: thumbnailUrl,
        rawMeta: meta
      };
    }

    async startPrint(filename) {
      if (!filename) throw new Error('Filename is required to start print');
      if (this.useNtfyFallback) {
        this._sendNtfyRelay('START_PRINT', { filename });
      }

      const url = `${this.host}/printer/print/start`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename })
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Start print failed: ${errText}`);
      }
      return await resp.json();
    }

    // File Upload with Progress
    uploadFile(file, options = {}) {
      const root = options.root || 'gcodes';
      const autoPrint = Boolean(options.print);
      const onProgress = options.onProgress || (() => {});

      return new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append('file', file, file.name);
        formData.append('root', root);
        if (autoPrint) formData.append('print', 'true');

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${this.host}/server/files/upload`, true);

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            onProgress(pct, e.loaded, e.total);
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const res = JSON.parse(xhr.responseText);
              resolve(res);
            } catch (e) {
              resolve({ status: 'ok', response: xhr.responseText });
            }
          } else {
            reject(new Error(`Upload failed HTTP ${xhr.status}: ${xhr.responseText}`));
          }
        };

        xhr.onerror = () => reject(new Error('Network error during file upload'));
        xhr.send(formData);
      });
    }

    // =========================================================================
    // ADVANCED SERVICE & BOT MACROS
    // =========================================================================
    async setFlow(pct) {
      const val = parseInt(pct) || 100;
      return this.sendGcode(`M221 S${val}`);
    }

    async loadFilament() {
      return this.sendGcode('LOAD_FILAMENT');
    }

    async unloadFilament() {
      return this.sendGcode('UNLOAD_FILAMENT');
    }

    async prepareBed() {
      return this.sendGcode('PREPARE_BED');
    }

    async runBedMesh() {
      return this.sendGcode('BED_MESH_CALIBRATE');
    }

    async playSong(song) {
      if (song === 'mario') {
        return this.sendGcode('SONG_MARIO');
      } else if (song === 'star_wars' || song === 'imperial') {
        return this.sendGcode('SONG_STAR_WARS');
      }
      return this.sendGcode('M300 S1000 P200');
    }

    async restartMoonraker() {
      return fetch(`${this.host}/server/restart`, { method: 'POST' });
    }

    async toggleLight(channel) {
      if (channel === 'model') {
        return this.sendGcode('TOGGLE_LIGHT_MODEL');
      } else if (channel === 'bed') {
        return this.sendGcode('TOGGLE_LIGHT_BED');
      }
      return this.sendGcode('TOGGLE_LIGHTS');
    }

    async powerOn() {
      if (typeof window !== 'undefined' && window.Telegram && window.Telegram.WebApp && typeof window.Telegram.WebApp.sendData === 'function') {
        try {
          window.Telegram.WebApp.sendData(JSON.stringify({ cmd: 'POWER_SOCKET_ON' }));
        } catch (e) {}
      }
      this._sendNtfyRelay('POWER_SOCKET_ON');
      try {
        await fetch(`${this.host}/machine/device_power/device?device=printer&action=on`, { method: 'POST' });
      } catch (e) {}
      try {
        await this.sendGcode('POWER_SOCKET_ON');
      } catch (e) {}
    }

    async powerOff(safe = true) {
      const cmd = safe ? 'SAFE_POWER_OFF' : 'POWER_SOCKET_OFF';
      if (typeof window !== 'undefined' && window.Telegram && window.Telegram.WebApp && typeof window.Telegram.WebApp.sendData === 'function') {
        try {
          window.Telegram.WebApp.sendData(JSON.stringify({ cmd }));
        } catch (e) {}
      }
      this._sendNtfyRelay(cmd);
      try {
        await this.sendGcode(cmd);
      } catch (e) {}
    }
  }

  return KlipperAPI;
}));
