/**
 * Camera HUD & Live Tapo C210 Feed Controller
 * For Telegram Mini App (Ender-3 S1 Plus Cockpit)
 * 
 * Features:
 * - Auto-refresh snapshot feed (192.168.1.21:8889 / Moonraker fallback) with double-buffering (no flicker).
 * - Exponential backoff on network hitch / camera disconnects with automatic fast recovery.
 * - Fullscreen toggle with Telegram WebApp 7.0+ orientation lock ('landscape') & HTML5 fallback.
 * - Cinematic Atelier OS / Obsidian HUD overlay:
 *   - Real-time roundtrip latency (ms), dynamic FPS counter, live timestamp with blinking REC dot.
 *   - Telemetry pills: Extruder temp (fiery glow), Bed temp, 5015 Fan % (animated spin), Print progress & Z height.
 * - Instant high-res Snap capture with camera shutter flash effect & haptic feedback.
 * - Download snapshot or 1-tap share to Telegram chat.
 * - IR Night Vision / High Contrast filter toggles.
 * - Battery-friendly background sleep on tab switch.
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CameraHUD = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_PRIMARY_URL = 'http://192.168.1.21:8889/snapshot';
  const DEFAULT_FALLBACK_URL = 'http://192.168.1.21:7125/webcam/snapshot';

  /**
   * Helper for Telegram Haptic Feedback
   */
  function triggerHaptic(type = 'light') {
    try {
      const tg = window.Telegram && window.Telegram.WebApp;
      if (tg && tg.HapticFeedback) {
        if (type === 'selection') tg.HapticFeedback.selectionChanged();
        else if (type === 'heavy' || type === 'medium' || type === 'light') tg.HapticFeedback.impactOccurred(type);
        else if (type === 'success' || type === 'warning' || type === 'error') tg.HapticFeedback.notificationOccurred(type);
      } else if (navigator.vibrate) {
        navigator.vibrate(type === 'heavy' ? 40 : 15);
      }
    } catch (e) {}
  }

  class CameraHUD {
    /**
     * @param {HTMLElement|string} container - DOM Element or ID
     * @param {Object} options - Configuration options
     */
    constructor(container, options = {}) {
      this.container = typeof container === 'string' ? document.getElementById(container) : container;
      if (!this.container) {
        throw new Error(`[CameraHUD] Target container element not found: ${container}`);
      }

      this.options = Object.assign({
        primaryUrl: DEFAULT_PRIMARY_URL,
        fallbackUrl: DEFAULT_FALLBACK_URL,
        refreshInterval: 1000, // ms
        minInterval: 400,
        maxBackoff: 15000,
        aspectRatio: '16/9',
        autoStart: true,
        nightMode: false,
        highContrast: false,
      }, options);

      // State
      this.currentUrl = this.options.primaryUrl;
      this.isStreaming = false;
      this.isPaused = false;
      this.isFullscreen = false;
      this.nightModeActive = this.options.nightMode;
      this.consecutiveFailures = 0;
      this.currentBackoff = this.options.refreshInterval;

      // Stats
      this.latencyMs = 0;
      this.fps = 0;
      this.lastFrameTime = 0;
      this.frameCount = 0;
      this.fpsTimer = Date.now();
      this.telemetry = {
        hotendTemp: 0,
        hotendTarget: 0,
        bedTemp: 0,
        bedTarget: 0,
        fanSpeed: 0,
        printPercent: 0,
        currentZ: 0,
        state: 'standby',
      };

      // Timers & controllers
      this._pollTimer = null;
      this._clockTimer = null;
      this._activeImageLoader = null;
      this._doubleBufferImg = typeof Image !== 'undefined' ? new Image() : (typeof document !== 'undefined' ? document.createElement('img') : null);

      // Bound handlers
      this._onVisibilityChange = this._onVisibilityChange.bind(this);
      this._onFullscreenChange = this._onFullscreenChange.bind(this);

      this._initDOM();
      this._bindEvents();

      if (this.options.autoStart) {
        this.startStream();
      }
    }

    /**
     * Build UI markup, HUD overlay, controls & modal
     */
    _initDOM() {
      const c = this.container;
      c.classList.add('camera-hud-container');
      c.style.position = 'relative';
      c.style.overflow = 'hidden';
      c.style.backgroundColor = '#000000';
      c.style.borderRadius = '1rem';
      c.style.userSelect = 'none';

      c.innerHTML = `
        <!-- Main Video Viewport -->
        <div class="relative w-full h-full flex items-center justify-center overflow-hidden" style="aspect-ratio: ${this.options.aspectRatio};">
          <img id="hudCameraImg" src="${this.currentUrl}" alt="Tapo C210 Stream" class="w-full h-full object-contain transition-all duration-200" style="filter: brightness(1) contrast(1);">
          
          <!-- Shutter Flash Overlay -->
          <div id="hudShutterFlash" class="absolute inset-0 bg-white opacity-0 pointer-events-none transition-opacity duration-300"></div>

          <!-- Network Hitch Warning / Offline Banner -->
          <div id="hudOfflineBanner" class="absolute inset-0 bg-slate-950/85 backdrop-blur-sm flex flex-col items-center justify-center text-center p-4 transition-all duration-300 hidden z-20">
            <div class="w-12 h-12 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center text-2xl mb-2 animate-pulse">
              ⚠️
            </div>
            <h4 class="text-xs font-bold text-white mb-1">Потеря связи с камерой Tapo C210</h4>
            <p class="text-[10px] text-slate-400 mb-3 max-w-[240px]">Камера в локальной сети недоступна. Повторная попытка соединения...</p>
            <div class="flex items-center gap-2">
              <button id="hudRetryBtn" class="px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-xs font-bold">
                Повторить сейчас
              </button>
              <button id="hudSwitchFallbackBtn" class="px-3 py-1.5 rounded-lg bg-surfaceCard text-slate-300 border border-white/10 text-xs font-medium">
                Moonraker Snapshot
              </button>
            </div>
          </div>

          <!-- Top HUD Overlay (Bar) -->
          <div class="absolute top-2 left-2 right-2 flex items-center justify-between pointer-events-none z-10">
            <!-- Left Badges: Status + Latency + FPS -->
            <div class="flex items-center gap-1.5 pointer-events-auto">
              <div id="hudStatusBadge" class="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md border border-emerald-500/30 text-[10px] font-mono font-bold text-emerald-400 shadow-lg">
                <span id="hudStatusDot" class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                <span id="hudStatusText">LIVE</span>
              </div>
              <div id="hudLatencyPill" class="px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-[9px] font-mono text-slate-300 shadow">
                ⚡ <span id="hudLatencyVal">--</span> ms
              </div>
              <div id="hudFpsPill" class="px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-[9px] font-mono text-slate-400 hidden sm:block">
                <span id="hudFpsVal">1.0</span> FPS
              </div>
            </div>

            <!-- Right Badges: REC Clock + Model -->
            <div class="flex items-center gap-1.5 pointer-events-auto">
              <div class="flex items-center gap-1 px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-[9px] font-mono text-slate-300 shadow">
                <span class="w-1.5 h-1.5 rounded-full bg-rose-500 animate-ping"></span>
                <span id="hudClockText">00:00:00</span>
              </div>
              <span class="px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-[9px] text-cyan-400 font-bold hidden xs:inline-block">
                Tapo C210
              </span>
            </div>
          </div>

          <!-- Bottom HUD Telemetry Strip -->
          <div class="absolute bottom-2 left-2 right-2 pointer-events-none z-10 flex flex-col gap-1.5">
            <!-- Telemetry Bento Chips -->
            <div class="flex items-center gap-1.5 flex-wrap pointer-events-auto">
              <!-- Hotend Chip -->
              <div class="flex items-center gap-1 px-2 py-1 rounded-xl bg-black/70 backdrop-blur-md border border-white/10 text-[10px] font-mono tabular-nums shadow">
                <span id="hudHotendIcon">🔥</span>
                <span id="hudHotendTemp" class="font-bold text-white">0°C</span>
                <span id="hudHotendTarget" class="text-slate-500 text-[9px]">/ 0°C</span>
              </div>
              <!-- Bed Chip -->
              <div class="flex items-center gap-1 px-2 py-1 rounded-xl bg-black/70 backdrop-blur-md border border-white/10 text-[10px] font-mono tabular-nums shadow">
                <span>♨️</span>
                <span id="hudBedTemp" class="font-bold text-cyan-300">0°C</span>
                <span id="hudBedTarget" class="text-slate-500 text-[9px]">/ 0°C</span>
              </div>
              <!-- Fan Chip -->
              <div class="flex items-center gap-1 px-2 py-1 rounded-xl bg-black/70 backdrop-blur-md border border-white/10 text-[10px] font-mono tabular-nums shadow">
                <span id="hudFanIcon" class="inline-block transition-transform duration-500">💨</span>
                <span id="hudFanSpeed" class="font-bold text-slate-200">0%</span>
              </div>
              <!-- Z / Progress Chip -->
              <div class="flex items-center gap-1 px-2 py-1 rounded-xl bg-black/70 backdrop-blur-md border border-white/10 text-[10px] font-mono tabular-nums shadow ml-auto">
                <span class="text-emerald-400 font-bold" id="hudProgressVal">0%</span>
                <span class="text-slate-500">•</span>
                <span class="text-slate-300" id="hudZVal">Z: 0.00</span>
              </div>
            </div>

            <!-- Floating Controls Toolbar -->
            <div class="flex items-center justify-between bg-black/80 backdrop-blur-xl border border-white/10 rounded-xl p-1.5 pointer-events-auto shadow-2xl">
              <div class="flex items-center gap-1">
                <!-- Snap Button -->
                <button id="hudSnapBtn" class="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/30 text-xs font-bold transition-all active:scale-95">
                  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
                  <span>Снимок</span>
                </button>

                <!-- Pause / Play Stream -->
                <button id="hudPlayPauseBtn" class="p-1.5 rounded-lg bg-surfaceCard text-slate-300 hover:text-white border border-white/5 text-xs transition-all active:scale-95" title="Пауза / Возобновить">
                  <span id="hudPlayPauseIcon">⏸</span>
                </button>

                <!-- Night Mode / IR Filter -->
                <button id="hudNightBtn" class="p-1.5 rounded-lg bg-surfaceCard text-slate-300 hover:text-white border border-white/5 text-xs transition-all active:scale-95" title="Ночной IR фильтр">
                  <span id="hudNightIcon">🌙</span>
                </button>
              </div>

              <div class="flex items-center gap-1">
                <!-- Refresh Rate Cycle -->
                <button id="hudRateBtn" class="px-2 py-1 rounded-lg bg-surfaceCard text-[10px] font-mono text-slate-400 hover:text-slate-200 border border-white/5" title="Частота кадров">
                  <span id="hudRateLabel">1.0s</span>
                </button>

                <!-- Fullscreen Toggle Button -->
                <button id="hudFullscreenBtn" class="p-1.5 rounded-lg bg-surfaceCard text-slate-300 hover:text-white border border-white/5 text-xs transition-all active:scale-95" title="Во весь экран">
                  <svg id="hudFullscreenIcon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Snapshot Preview & Share Modal -->
        <div id="hudSnapModal" class="fixed inset-0 bg-black/90 backdrop-blur-md z-50 flex items-center justify-center p-4 transition-all duration-300 opacity-0 pointer-events-none">
          <div class="bg-surface border border-surfaceBorder rounded-2xl max-w-sm w-full p-4 shadow-2xl transform scale-95 transition-all duration-300" id="hudSnapModalCard">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-xs font-bold text-white flex items-center gap-1.5">
                <span>📸 Снимок стола</span>
                <span class="text-[9px] font-mono text-slate-500" id="hudSnapTimestamp"></span>
              </h3>
              <button id="hudSnapModalClose" class="w-6 h-6 rounded-full bg-white/10 hover:bg-white/20 text-slate-300 flex items-center justify-center text-xs">✕</button>
            </div>
            
            <div class="relative rounded-xl overflow-hidden bg-black/90 aspect-video mb-3 border border-white/10 flex items-center justify-center">
              <img id="hudSnapModalImg" src="" alt="Captured Frame" class="w-full h-full object-contain">
            </div>

            <div class="space-y-2">
              <button id="hudSaveDeviceBtn" class="w-full py-2.5 rounded-xl bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 border border-emerald-500/30 text-xs font-bold flex items-center justify-center gap-2 transition-all active:scale-98">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                Сохранить в галерею
              </button>

              <button id="hudSendTgBtn" class="w-full py-2.5 rounded-xl bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30 border border-cyan-500/30 text-xs font-bold flex items-center justify-center gap-2 transition-all active:scale-98">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                Отправить в Telegram бот
              </button>
            </div>
          </div>
        </div>
      `;

      // Cache Elements
      this.dom = {
        cameraImg: c.querySelector('#hudCameraImg'),
        shutterFlash: c.querySelector('#hudShutterFlash'),
        offlineBanner: c.querySelector('#hudOfflineBanner'),
        retryBtn: c.querySelector('#hudRetryBtn'),
        switchFallbackBtn: c.querySelector('#hudSwitchFallbackBtn'),
        statusBadge: c.querySelector('#hudStatusBadge'),
        statusDot: c.querySelector('#hudStatusDot'),
        statusText: c.querySelector('#hudStatusText'),
        latencyVal: c.querySelector('#hudLatencyVal'),
        fpsVal: c.querySelector('#hudFpsVal'),
        clockText: c.querySelector('#hudClockText'),
        hotendTemp: c.querySelector('#hudHotendTemp'),
        hotendTarget: c.querySelector('#hudHotendTarget'),
        hotendIcon: c.querySelector('#hudHotendIcon'),
        bedTemp: c.querySelector('#hudBedTemp'),
        bedTarget: c.querySelector('#hudBedTarget'),
        fanSpeed: c.querySelector('#hudFanSpeed'),
        fanIcon: c.querySelector('#hudFanIcon'),
        progressVal: c.querySelector('#hudProgressVal'),
        zVal: c.querySelector('#hudZVal'),
        snapBtn: c.querySelector('#hudSnapBtn'),
        playPauseBtn: c.querySelector('#hudPlayPauseBtn'),
        playPauseIcon: c.querySelector('#hudPlayPauseIcon'),
        nightBtn: c.querySelector('#hudNightBtn'),
        rateBtn: c.querySelector('#hudRateBtn'),
        rateLabel: c.querySelector('#hudRateLabel'),
        fullscreenBtn: c.querySelector('#hudFullscreenBtn'),
        fullscreenIcon: c.querySelector('#hudFullscreenIcon'),
        snapModal: c.querySelector('#hudSnapModal'),
        snapModalCard: c.querySelector('#hudSnapModalCard'),
        snapModalClose: c.querySelector('#hudSnapModalClose'),
        snapModalImg: c.querySelector('#hudSnapModalImg'),
        snapTimestamp: c.querySelector('#hudSnapTimestamp'),
        saveDeviceBtn: c.querySelector('#hudSaveDeviceBtn'),
        sendTgBtn: c.querySelector('#hudSendTgBtn'),
      };
    }

    /**
     * Bind UI & Event Listeners
     */
    _bindEvents() {
      // Snap button
      this.dom.snapBtn.addEventListener('click', () => {
        triggerHaptic('heavy');
        this.takeSnapshot();
      });

      // Play/Pause button
      this.dom.playPauseBtn.addEventListener('click', () => {
        triggerHaptic('light');
        if (this.isPaused) this.resume();
        else this.pause();
      });

      // Night filter toggle
      this.dom.nightBtn.addEventListener('click', () => {
        triggerHaptic('light');
        this.toggleNightMode();
      });

      // Refresh rate selector
      this.dom.rateBtn.addEventListener('click', () => {
        triggerHaptic('selection');
        this._cycleRefreshRate();
      });

      // Fullscreen button
      this.dom.fullscreenBtn.addEventListener('click', () => {
        triggerHaptic('medium');
        this.toggleFullscreen();
      });

      // Retry button on offline banner
      this.dom.retryBtn.addEventListener('click', () => {
        triggerHaptic('light');
        this.consecutiveFailures = 0;
        this.currentBackoff = this.options.refreshInterval;
        this.dom.offlineBanner.classList.add('hidden');
        this._scheduleNextFetch(50);
      });

      // Switch to Moonraker fallback button
      this.dom.switchFallbackBtn.addEventListener('click', () => {
        triggerHaptic('light');
        this.setCameraUrl(this.options.fallbackUrl);
        this.dom.offlineBanner.classList.add('hidden');
      });

      // Modal close
      this.dom.snapModalClose.addEventListener('click', () => this._closeSnapModal());
      this.dom.snapModal.addEventListener('click', (e) => {
        if (e.target === this.dom.snapModal) this._closeSnapModal();
      });

      // Modal Save Button
      this.dom.saveDeviceBtn.addEventListener('click', () => {
        triggerHaptic('success');
        this._downloadCapturedSnapshot();
      });

      // Modal Send to Telegram Button
      this.dom.sendTgBtn.addEventListener('click', () => {
        triggerHaptic('success');
        this._shareToTelegram();
      });

      // Page visibility & Fullscreen change
      if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('visibilitychange', this._onVisibilityChange);
        document.addEventListener('fullscreenchange', this._onFullscreenChange);
        document.addEventListener('webkitfullscreenchange', this._onFullscreenChange);
      }

      // Start live REC clock timer
      this._startClock();
    }

    /**
     * Start live image stream polling
     */
    startStream() {
      if (this.isStreaming) return;
      this.isStreaming = true;
      this.isPaused = false;
      this.consecutiveFailures = 0;
      this.currentBackoff = this.options.refreshInterval;
      this._scheduleNextFetch(50);
    }

    /**
     * Stop live image stream polling
     */
    stopStream() {
      this.isStreaming = false;
      if (this._pollTimer) {
        clearTimeout(this._pollTimer);
        this._pollTimer = null;
      }
    }

    /**
     * Pause streaming
     */
    pause() {
      this.isPaused = true;
      if (this.dom.playPauseIcon) this.dom.playPauseIcon.textContent = '▶';
      if (this.dom.statusText) this.dom.statusText.textContent = 'PAUSED';
      if (this.dom.statusBadge) {
        this.dom.statusBadge.className = 'flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md border border-amber-500/30 text-[10px] font-mono font-bold text-amber-400 shadow-lg';
      }
      if (this.dom.statusDot) {
        this.dom.statusDot.className = 'w-2 h-2 rounded-full bg-amber-400';
      }
    }

    /**
     * Resume streaming
     */
    resume() {
      this.isPaused = false;
      if (this.dom.playPauseIcon) this.dom.playPauseIcon.textContent = '⏸';
      this._scheduleNextFetch(50);
    }

    /**
     * Fetch next frame with Double-Buffering & Exponential Backoff
     */
    _scheduleNextFetch(delay) {
      if (!this.isStreaming || this.isPaused) return;
      if (this._pollTimer) clearTimeout(this._pollTimer);

      this._pollTimer = setTimeout(() => {
        this._fetchSingleFrame();
      }, delay);
    }

    _fetchSingleFrame() {
      if (!this.isStreaming || this.isPaused) return;

      const startTime = performance.now();
      const separator = this.currentUrl.includes('?') ? '&' : '?';
      const cacheBustUrl = `${this.currentUrl}${separator}_t=${Date.now()}`;

      const loader = typeof Image !== 'undefined' ? new Image() : (typeof document !== 'undefined' ? document.createElement('img') : {});
      let timedOut = false;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        loader.src = '';
        this._handleFetchError('Timeout (4000ms)');
      }, 4000);

      loader.onload = () => {
        if (timedOut) return;
        clearTimeout(timeoutId);

        const latency = Math.round(performance.now() - startTime);
        this.latencyMs = latency;
        this.dom.latencyVal.textContent = `${latency}`;

        // Swap image buffer without any white/black blink
        this.dom.cameraImg.src = loader.src;

        // Reset backoff & failures
        this.consecutiveFailures = 0;
        this.currentBackoff = this.options.refreshInterval;
        this.dom.offlineBanner.classList.add('hidden');

        // Status Badge -> LIVE
        this.dom.statusText.textContent = 'LIVE';
        this.dom.statusBadge.className = 'flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md border border-emerald-500/30 text-[10px] font-mono font-bold text-emerald-400 shadow-lg';
        this.dom.statusDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';

        // Calculate rolling FPS
        this._updateFps();

        // Schedule next regular fetch
        this._scheduleNextFetch(this.options.refreshInterval);
      };

      loader.onerror = () => {
        if (timedOut) return;
        clearTimeout(timeoutId);
        this._handleFetchError('Network Error');
      };

      loader.src = cacheBustUrl;
    }

    /**
     * Exponential backoff handler on network error
     */
    _handleFetchError(reason) {
      this.consecutiveFailures++;
      // Backoff: 1s -> 2s -> 4s -> 8s -> 15s max
      this.currentBackoff = Math.min(this.options.maxBackoff, Math.max(1000, this.options.refreshInterval * Math.pow(1.8, this.consecutiveFailures)));

      this.dom.statusText.textContent = `RETRY (${this.consecutiveFailures})`;
      this.dom.statusBadge.className = 'flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md border border-rose-500/30 text-[10px] font-mono font-bold text-rose-400 shadow-lg';
      this.dom.statusDot.className = 'w-2 h-2 rounded-full bg-rose-400 animate-ping';
      this.dom.latencyVal.textContent = '--';

      if (this.consecutiveFailures >= 3) {
        this.dom.offlineBanner.classList.remove('hidden');
      }

      this._scheduleNextFetch(this.currentBackoff);
    }

    /**
     * FPS Calculation over rolling 2.5s window
     */
    _updateFps() {
      this.frameCount++;
      const now = Date.now();
      const elapsed = (now - this.fpsTimer) / 1000;
      if (elapsed >= 2.5) {
        this.fps = (this.frameCount / elapsed).toFixed(1);
        this.dom.fpsVal.textContent = this.fps;
        this.frameCount = 0;
        this.fpsTimer = now;
      }
    }

    /**
     * Update Clock
     */
    _startClock() {
      const updateTime = () => {
        const d = new Date();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        if (this.dom.clockText) {
          this.dom.clockText.textContent = `${hh}:${mm}:${ss}`;
        }
      };
      updateTime();
      this._clockTimer = setInterval(updateTime, 1000);
    }

    /**
     * Public Method: updateTelemetry(stats)
     * Updates temperatures, fan speed & print progress on HUD overlay
     */
    updateTelemetry(stats = {}) {
      Object.assign(this.telemetry, stats);
      const t = this.telemetry;

      // Hotend
      if (t.hotendTemp !== undefined) {
        this.dom.hotendTemp.textContent = `${Math.round(t.hotendTemp)}°C`;
        this.dom.hotendTarget.textContent = `/ ${Math.round(t.hotendTarget || 0)}°C`;
        if (t.hotendTemp > 180) {
          this.dom.hotendTemp.className = 'font-bold text-rose-400 animate-pulse';
          this.dom.hotendIcon.textContent = '🔥';
        } else if (t.hotendTemp > 50) {
          this.dom.hotendTemp.className = 'font-bold text-amber-300';
          this.dom.hotendIcon.textContent = '🌡️';
        } else {
          this.dom.hotendTemp.className = 'font-bold text-white';
          this.dom.hotendIcon.textContent = '❄️';
        }
      }

      // Bed
      if (t.bedTemp !== undefined) {
        this.dom.bedTemp.textContent = `${Math.round(t.bedTemp)}°C`;
        this.dom.bedTarget.textContent = `/ ${Math.round(t.bedTarget || 0)}°C`;
      }

      // Fan Speed %
      if (t.fanSpeed !== undefined) {
        const fanPct = Math.round(t.fanSpeed);
        this.dom.fanSpeed.textContent = `${fanPct}%`;
        // Spin fan icon if active
        if (fanPct > 0) {
          this.dom.fanIcon.style.transform = `rotate(${(Date.now() / 4) % 360}deg)`;
        }
      }

      // Print progress & Z
      if (t.printPercent !== undefined) {
        this.dom.progressVal.textContent = `${Math.round(t.printPercent)}%`;
      }
      if (t.currentZ !== undefined) {
        this.dom.zVal.textContent = `Z: ${Number(t.currentZ).toFixed(2)}`;
      }
    }

    /**
     * High-res Snap Capture with Flash & Modal
     */
    takeSnapshot() {
      // 1. Trigger Shutter Flash Animation
      this.dom.shutterFlash.style.opacity = '0.9';
      setTimeout(() => {
        this.dom.shutterFlash.style.opacity = '0';
      }, 120);

      // 2. Capture image onto canvas to produce crisp blob
      const img = this.dom.cameraImg;
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || 1920;
      canvas.height = img.naturalHeight || 1080;
      const ctx = canvas.getContext('2d');

      // Apply any night vision / contrast filters in snapshot if active
      if (this.nightModeActive) {
        ctx.filter = 'grayscale(100%) brightness(1.25) contrast(1.35)';
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // Add watermark timestamp
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(16, canvas.height - 54, 460, 38);
      ctx.fillStyle = '#10b981';
      ctx.font = 'bold 20px monospace';
      const timeStr = new Date().toLocaleString();
      ctx.fillText(`ENDER-3 S1 PLUS • ${timeStr}`, 28, canvas.height - 28);

      const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
      this._lastCapturedDataUrl = dataUrl;

      // 3. Show Snapshot Modal
      this.dom.snapModalImg.src = dataUrl;
      this.dom.snapTimestamp.textContent = timeStr;
      this.dom.snapModal.classList.remove('opacity-0', 'pointer-events-none');
      this.dom.snapModalCard.classList.remove('scale-95');
    }

    _closeSnapModal() {
      this.dom.snapModal.classList.add('opacity-0', 'pointer-events-none');
      this.dom.snapModalCard.classList.add('scale-95');
    }

    _downloadCapturedSnapshot() {
      if (!this._lastCapturedDataUrl) return;
      const link = document.createElement('a');
      const filename = `Ender3_Snapshot_${Date.now()}.jpg`;
      link.download = filename;
      link.href = this._lastCapturedDataUrl;
      link.click();
      this._closeSnapModal();
    }

    _shareToTelegram() {
      // Telegram WebApp sendData or trigger command
      try {
        const tg = window.Telegram && window.Telegram.WebApp;
        if (tg) {
          if (typeof window.sendCommand === 'function') {
            window.sendCommand('TAKE_SNAPSHOT');
          } else if (tg.sendData) {
            tg.sendData(JSON.stringify({
              action: 'share_snapshot',
              timestamp: Date.now(),
              camera: 'Tapo C210',
            }));
          }
        }
      } catch (err) {}
      this._closeSnapModal();
    }

    /**
     * Fullscreen Toggle with Telegram WebApp Orientation Lock ('landscape')
     */
    toggleFullscreen() {
      const tg = window.Telegram && window.Telegram.WebApp;

      if (!this.isFullscreen) {
        // Request Fullscreen
        this.isFullscreen = true;
        this.container.classList.add('camera-hud-fullscreen');
        this.container.style.position = 'fixed';
        this.container.style.top = '0';
        this.container.style.left = '0';
        this.container.style.width = '100vw';
        this.container.style.height = '100vh';
        this.container.style.zIndex = '9999';
        this.container.style.borderRadius = '0';

        // Telegram 7.0+ Fullscreen & Orientation Lock
        try {
          if (tg && tg.requestFullscreen) tg.requestFullscreen();
          if (tg && tg.lockOrientation) tg.lockOrientation('landscape');
          if (screen.orientation && screen.orientation.lock) {
            screen.orientation.lock('landscape').catch(() => {});
          }
        } catch (e) {}

        if (this.dom.fullscreenIcon) {
          this.dom.fullscreenIcon.innerHTML = `<path d="M4 14h6v6m10-10h-6V4m0 6 7-7M3 21l7-7"/>`;
        }
      } else {
        // Exit Fullscreen
        this.isFullscreen = false;
        this.container.classList.remove('camera-hud-fullscreen');
        this.container.style.position = 'relative';
        this.container.style.top = '';
        this.container.style.left = '';
        this.container.style.width = '';
        this.container.style.height = '';
        this.container.style.zIndex = '';
        this.container.style.borderRadius = '1rem';

        try {
          if (tg && tg.exitFullscreen) tg.exitFullscreen();
          if (tg && tg.unlockOrientation) tg.unlockOrientation();
          if (screen.orientation && screen.orientation.unlock) {
            screen.orientation.unlock();
          }
        } catch (e) {}

        if (this.dom.fullscreenIcon) {
          this.dom.fullscreenIcon.innerHTML = `<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>`;
        }
      }
    }

    _onFullscreenChange() {
      const isDocFull = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (!isDocFull && this.isFullscreen) {
        this.toggleFullscreen();
      }
    }

    /**
     * IR Night Vision / High Contrast Toggle
     */
    toggleNightMode() {
      this.nightModeActive = !this.nightModeActive;
      if (this.nightModeActive) {
        if (this.dom.cameraImg) this.dom.cameraImg.style.filter = 'grayscale(100%) brightness(1.3) contrast(1.4)';
        if (this.dom.nightIcon) this.dom.nightIcon.textContent = '☀️';
        if (this.dom.nightBtn) this.dom.nightBtn.classList.add('bg-cyan-500/20', 'text-cyan-300', 'border-cyan-500/40');
      } else {
        if (this.dom.cameraImg) this.dom.cameraImg.style.filter = 'brightness(1) contrast(1)';
        if (this.dom.nightIcon) this.dom.nightIcon.textContent = '🌙';
        if (this.dom.nightBtn) this.dom.nightBtn.classList.remove('bg-cyan-500/20', 'text-cyan-300', 'border-cyan-500/40');
      }
    }

    /**
     * Refresh Rate Selector (Cycles: 0.5s -> 1.0s -> 2.0s -> 5.0s)
     */
    _cycleRefreshRate() {
      const rates = [500, 1000, 2000, 5000];
      const labels = ['0.5s', '1.0s', '2.0s', '5.0s'];
      const currentIndex = rates.indexOf(this.options.refreshInterval);
      const nextIndex = (currentIndex + 1) % rates.length;

      this.options.refreshInterval = rates[nextIndex];
      if (this.dom.rateLabel) this.dom.rateLabel.textContent = labels[nextIndex];
      this._scheduleNextFetch(50);
    }

    /**
     * Set Camera URL
     */
    setCameraUrl(url) {
      if (!url) return;
      this.currentUrl = url;
      this.consecutiveFailures = 0;
      this.currentBackoff = this.options.refreshInterval;
      this._scheduleNextFetch(50);
    }

    /**
     * Pause streaming when page is backgrounded to save mobile data & battery
     */
    _onVisibilityChange() {
      if (document.hidden) {
        if (this._pollTimer) {
          clearTimeout(this._pollTimer);
          this._pollTimer = null;
        }
      } else {
        if (this.isStreaming && !this.isPaused) {
          this._scheduleNextFetch(50);
        }
      }
    }

    /**
     * Teardown & cleanup
     */
    destroy() {
      this.stopStream();
      if (this._clockTimer) clearInterval(this._clockTimer);
      if (typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
        document.removeEventListener('fullscreenchange', this._onFullscreenChange);
        document.removeEventListener('webkitfullscreenchange', this._onFullscreenChange);
      }
      if (this.container) {
        this.container.innerHTML = '';
      }
    }
  }

  return CameraHUD;
}));
