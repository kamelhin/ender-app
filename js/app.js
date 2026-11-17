/**
 * Ender-3 S1 Plus Cockpit - Variant B (Huawei / Creality Dual-Theme)
 * 
 * Features:
 * - Huawei / Creality Dual-Theme Engine (Day Ceramic Frost & Night Space Graphite)
 * - Variant B Circular Thermostat Dial (Hotend / Bed toggle, SVG arc, side steppers + / -)
 * - Quick Material Preheat Presets (PLA, PETG, ABS, Cooldown)
 * - Bento Grid Smart Devices (24V Light toggle & slider, 220V Matter Plug telemetry, 5015 Fan, M220 Speed)
 * - Screws Tilt Calculate 4-Quadrant Visual Dials
 * - Tapo C200 Live Camera HUD
 * - G-code Catalog
 * - Telegram WebApp SDK Haptics & Smooth Toasts
 */

(function (window, document) {
  'use strict';

  const tg = window.Telegram && window.Telegram.WebApp;

  // -------------------------------------------------------------------------
  // APPLICATION STATE
  // -------------------------------------------------------------------------
  const state = {
    theme: 'night',               // 'day' | 'night'
    dialTarget: 'hotend',          // 'hotend' | 'bed'
    hotendTemp: 24.0,
    hotendTarget: 0,
    hotendPwm: 0,
    bedTemp: 22.0,
    bedTarget: 0,
    bedPwm: 0,
    fanSpeedPct: 0,
    speedFactor: 100,
    isLightOn: true,
    lightBrightness: 100,
    isPlugOn: true,
    plugVoltage: 234.8,
    plugPower: 6.2,
    printStatus: 'ready',         // 'ready' | 'printing' | 'paused' | 'error'
    currentFile: 'Файл не выбран',
    printPercent: 0,
    activeTab: 'dashboard',
    activeSubTab: 'camera'
  };

  const CIRCLE_CIRCUMFERENCE = 515.22; // 2 * PI * 82

  // -------------------------------------------------------------------------
  // TELEGRAM WEBAPP SDK & HAPTICS
  // -------------------------------------------------------------------------
  function initTelegram() {
    if (!tg) return;
    try {
      tg.ready();
      tg.expand();
      syncTelegramThemeColors();
    } catch (e) {
      console.warn('[Telegram WebApp] Init notice:', e);
    }
  }

  function haptic(style = 'light') {
    try {
      if (tg && tg.HapticFeedback) {
        if (style === 'success' || style === 'warning' || style === 'error') {
          tg.HapticFeedback.notificationOccurred(style);
        } else {
          tg.HapticFeedback.impactOccurred(style);
        }
      } else if (navigator.vibrate) {
        navigator.vibrate(20);
      }
    } catch (e) {}
  }

  function showToast(message, icon = '⚡') {
    const box = document.getElementById('toastBox');
    const msg = document.getElementById('toastMessage');
    if (!box || !msg) return;

    msg.textContent = `${icon} ${message}`;
    box.classList.add('show');
    clearTimeout(box._timer);
    box._timer = setTimeout(() => {
      box.classList.remove('show');
    }, 2400);
  }

  // -------------------------------------------------------------------------
  // THEME ENGINE: DAY (CERAMIC) & NIGHT (SPACE GRAPHITE)
  // -------------------------------------------------------------------------
  function initTheme() {
    const urlParams = new URLSearchParams(window.location.search);
    const paramTheme = urlParams.get('theme');
    if (paramTheme === 'day' || paramTheme === 'night') {
      applyTheme(paramTheme);
      return;
    }

    const saved = localStorage.getItem('ender_theme');
    if (saved === 'day' || saved === 'night') {
      applyTheme(saved);
      return;
    }

    if (tg && tg.colorScheme === 'light') {
      applyTheme('day');
    } else {
      applyTheme('night');
    }
  }

  function applyTheme(themeName) {
    state.theme = themeName;
    const html = document.documentElement;
    const themeIcon = document.getElementById('themeIcon');

    if (themeName === 'day') {
      html.setAttribute('data-theme', 'day');
      html.classList.remove('dark');
      if (themeIcon) themeIcon.textContent = '🌙'; // Click to switch to night
    } else {
      html.setAttribute('data-theme', 'night');
      html.classList.add('dark');
      if (themeIcon) themeIcon.textContent = '☀️'; // Click to switch to day
    }

    localStorage.setItem('ender_theme', themeName);
    syncTelegramThemeColors();
    renderDial();
  }

  function syncTelegramThemeColors() {
    if (!tg) return;
    try {
      const headerColor = state.theme === 'day' ? '#F2F5F9' : '#11141B';
      const bgColor = state.theme === 'day' ? '#F2F5F9' : '#11141B';
      if (typeof tg.setHeaderColor === 'function') tg.setHeaderColor(headerColor);
      if (typeof tg.setBackgroundColor === 'function') tg.setBackgroundColor(bgColor);
    } catch (e) {}
  }

  window.toggleTheme = function () {
    haptic('medium');
    const newTheme = state.theme === 'day' ? 'night' : 'day';
    applyTheme(newTheme);
    showToast(newTheme === 'day' ? 'Дневная тема (Huawei Ceramic)' : 'Ночная тема (Creality Dark)', newTheme === 'day' ? '☀️' : '🌙');
  };

  // -------------------------------------------------------------------------
  // HERO DIAL CONTROLLER (VARIANT B CIRCULAR THERMOSTAT)
  // -------------------------------------------------------------------------
  window.selectDialTarget = function (target) {
    haptic('selection');
    state.dialTarget = target;

    const btnHotend = document.getElementById('dialTabHotend');
    const btnBed = document.getElementById('dialTabBed');
    const progressArc = document.getElementById('dialProgressArc');

    if (target === 'hotend') {
      if (btnHotend) {
        btnHotend.style.backgroundColor = 'var(--surface-card)';
        btnHotend.style.color = 'var(--accent-hotend)';
        btnHotend.style.boxShadow = 'var(--card-shadow)';
      }
      if (btnBed) {
        btnBed.style.backgroundColor = 'transparent';
        btnBed.style.color = 'var(--text-muted)';
        btnBed.style.boxShadow = 'none';
      }
      if (progressArc) progressArc.setAttribute('stroke', 'var(--accent-hotend)');
    } else {
      if (btnBed) {
        btnBed.style.backgroundColor = 'var(--surface-card)';
        btnBed.style.color = 'var(--accent-bed)';
        btnBed.style.boxShadow = 'var(--card-shadow)';
      }
      if (btnHotend) {
        btnHotend.style.backgroundColor = 'transparent';
        btnHotend.style.color = 'var(--text-muted)';
        btnHotend.style.boxShadow = 'none';
      }
      if (progressArc) progressArc.setAttribute('stroke', 'var(--accent-bed)');
    }

    renderDial();
  };

  function renderDial() {
    const isHotend = state.dialTarget === 'hotend';
    const currentTemp = isHotend ? state.hotendTemp : state.bedTemp;
    const targetTemp = isHotend ? state.hotendTarget : state.bedTarget;
    const maxTemp = isHotend ? 300 : 110;

    const currentValEl = document.getElementById('dialCurrentValue');
    const targetLabelEl = document.getElementById('dialTargetLabel');
    const statusIconEl = document.getElementById('dialStatusIcon');
    const statusTextEl = document.getElementById('dialStatusText');
    const progressArc = document.getElementById('dialProgressArc');
    const modePillEl = document.getElementById('dialModePill');
    const dualStatusEl = document.getElementById('dialTargetDualStatus');
    const leftTargetEl = document.getElementById('dialLeftTarget');
    const leftIconEl = document.getElementById('dialLeftIcon');
    const pwmEl = document.getElementById('dialPwmPct');

    if (currentValEl) currentValEl.textContent = Math.round(currentTemp);
    if (targetLabelEl) targetLabelEl.textContent = targetTemp > 0 ? `Цель: ${targetTemp}°C` : 'Цель: 0°C (Выкл)';
    if (leftTargetEl) leftTargetEl.textContent = `${targetTemp}°C`;

    // Status Badge Logic
    if (targetTemp > 0) {
      if (currentTemp < targetTemp - 2) {
        if (statusIconEl) statusIconEl.textContent = '🔥';
        if (statusTextEl) statusTextEl.textContent = 'Нагрев...';
        if (leftIconEl) leftIconEl.textContent = '🔥';
        if (modePillEl) {
          modePillEl.textContent = 'Нагрев';
          modePillEl.style.color = isHotend ? 'var(--accent-hotend)' : 'var(--accent-bed)';
        }
        if (pwmEl) pwmEl.textContent = '100%';
      } else {
        if (statusIconEl) statusIconEl.textContent = '✅';
        if (statusTextEl) statusTextEl.textContent = 'Стабильно';
        if (leftIconEl) leftIconEl.textContent = '✅';
        if (modePillEl) {
          modePillEl.textContent = 'Готов';
          modePillEl.style.color = 'var(--accent-creality)';
        }
        if (pwmEl) pwmEl.textContent = '35%';
      }
    } else {
      if (statusIconEl) statusIconEl.textContent = '❄️';
      if (statusTextEl) statusTextEl.textContent = currentTemp > 45 ? 'Остывание' : 'Охлаждено';
      if (leftIconEl) leftIconEl.textContent = '❄️';
      if (modePillEl) {
        modePillEl.textContent = 'Ожидание';
        modePillEl.style.color = 'var(--text-secondary)';
      }
      if (pwmEl) pwmEl.textContent = '0%';
    }

    // Arc offset calculation
    if (progressArc) {
      const pct = Math.min(Math.max(currentTemp / maxTemp, 0), 1);
      const offset = CIRCLE_CIRCUMFERENCE * (1 - pct);
      progressArc.style.strokeDashoffset = offset;
    }

    if (dualStatusEl) {
      dualStatusEl.textContent = `E: ${Math.round(state.hotendTemp)}° / ${state.hotendTarget}° • B: ${Math.round(state.bedTemp)}° / ${state.bedTarget}°`;
    }
  }

  window.stepDialTemp = function (delta) {
    haptic('light');
    const isHotend = state.dialTarget === 'hotend';
    let current = isHotend ? state.hotendTarget : state.bedTarget;
    let next = current + delta;

    const max = isHotend ? 300 : 110;
    if (next < 0) next = 0;
    if (next > max) next = max;

    if (isHotend) {
      state.hotendTarget = next;
      sendKlipperGCode(`M104 S${next}`);
      showToast(`Сопло: целевая ${next}°C`, '🔥');
    } else {
      state.bedTarget = next;
      sendKlipperGCode(`M140 S${next}`);
      showToast(`Стол: целевая ${next}°C`, '♨️');
    }

    renderDial();
  };

  window.toggleHeaterPower = function () {
    haptic('medium');
    const isHotend = state.dialTarget === 'hotend';
    const current = isHotend ? state.hotendTarget : state.bedTarget;

    if (current > 0) {
      // Turn off
      if (isHotend) {
        state.hotendTarget = 0;
        sendKlipperGCode('M104 S0');
        showToast('Сопло: нагрев отключен', '❄️');
      } else {
        state.bedTarget = 0;
        sendKlipperGCode('M140 S0');
        showToast('Стол: нагрев отключен', '❄️');
      }
    } else {
      // Turn on default
      const defaultTemp = isHotend ? 205 : 60;
      if (isHotend) {
        state.hotendTarget = defaultTemp;
        sendKlipperGCode(`M104 S${defaultTemp}`);
        showToast(`Сопло: включен нагрев ${defaultTemp}°C`, '🔥');
      } else {
        state.bedTarget = defaultTemp;
        sendKlipperGCode(`M140 S${defaultTemp}`);
        showToast(`Стол: включен нагрев ${defaultTemp}°C`, '♨️');
      }
    }

    renderDial();
  };

  window.applyPreheatPreset = function (preset) {
    haptic('medium');
    let e = 0, b = 0, name = '';

    switch (preset) {
      case 'PLA':
        e = 205; b = 60; name = 'PLA (205° / 60°)';
        break;
      case 'PETG':
        e = 235; b = 78; name = 'PETG (235° / 78°)';
        break;
      case 'ABS':
        e = 245; b = 100; name = 'ABS (245° / 100°)';
        break;
      case 'COOLDOWN':
        e = 0; b = 0; name = 'Охлаждение (Выкл)';
        break;
    }

    state.hotendTarget = e;
    state.bedTarget = b;

    sendKlipperGCode(`M104 S${e}\nM140 S${b}`);
    renderDial();
    showToast(`Преднагрев: ${name}`, preset === 'COOLDOWN' ? '❄️' : '🔥');
  };

  // -------------------------------------------------------------------------
  // BENTO PERIPHERALS: LIGHTS, 220V MATTER PLUG, FAN 5015, SPEED M220
  // -------------------------------------------------------------------------
  window.handleLightToggle = function (isChecked) {
    haptic('medium');
    state.isLightOn = isChecked;
    const txt = document.getElementById('lightStateText');
    if (txt) txt.textContent = isChecked ? `Включена (${state.lightBrightness}%)` : 'Выключена';
    
    sendKlipperGCode(isChecked ? `SET_PIN PIN=caselight VALUE=${state.lightBrightness / 100}` : `SET_PIN PIN=caselight VALUE=0`);
    showToast(isChecked ? 'Подсветка 24V включена' : 'Подсветка 24V выключена', '💡');
  };

  window.handleLightBrightness = function (val) {
    state.lightBrightness = parseInt(val, 10);
    const textEl = document.getElementById('lightBrightnessText');
    const stateText = document.getElementById('lightStateText');
    if (textEl) textEl.textContent = `${state.lightBrightness}%`;
    if (stateText && state.isLightOn) stateText.textContent = `Включена (${state.lightBrightness}%)`;

    if (state.isLightOn) {
      sendKlipperGCode(`SET_PIN PIN=caselight VALUE=${state.lightBrightness / 100}`);
    }
  };

  window.toggleLight = function () {
    const input = document.getElementById('toggleLightInput');
    if (input) {
      input.checked = !input.checked;
      handleLightToggle(input.checked);
    }
  };

  window.handlePlugToggle = function (isChecked) {
    haptic('warning');
    state.isPlugOn = isChecked;
    const txt = document.getElementById('plugStateText');
    if (txt) txt.textContent = isChecked ? 'Tuya ВКЛ' : 'Tuya ВЫКЛ';

    if (window.klipperApi && typeof window.klipperApi._sendNtfyRelay === 'function') {
      window.klipperApi._sendNtfyRelay(isChecked ? 'PLUG_ON' : 'PLUG_OFF');
    }
    showToast(isChecked ? 'Розетка 220V: Питание подано' : 'Розетка 220V: Питание отключено', '⚡');
  };

  window.setFanSpeed = function (pct) {
    haptic('light');
    state.fanSpeedPct = pct;
    const txt = document.getElementById('fanSpeedPct');
    const icon = document.getElementById('fanSpinIcon');
    if (txt) txt.textContent = `${pct}%`;

    if (icon) {
      if (pct > 0) {
        icon.style.display = 'inline-block';
        icon.style.animation = `spin ${Math.max(0.3, 1.5 - (pct / 100))}s linear infinite`;
      } else {
        icon.style.animation = 'none';
      }
    }

    const pwm = Math.round((pct / 100) * 255);
    sendKlipperGCode(`M106 S${pwm}`);
    showToast(`Обдув 5015: ${pct}%`, '🌀');
  };

  window.setSpeedFactor = function (factor) {
    haptic('light');
    state.speedFactor = factor;
    const txt = document.getElementById('speedFactorVal');
    if (txt) txt.textContent = `${factor}%`;

    sendKlipperGCode(`M220 S${factor}`);
    showToast(`Скорость M220: ${factor}%`, '🚀');
  };

  // -------------------------------------------------------------------------
  // CALIBRATION & MOTION JOGGER
  // -------------------------------------------------------------------------
  window.runScrewsTiltCalculate = function () {
    haptic('medium');
    showToast('Вычисление Screws Tilt...', '🎛️');
    sendKlipperGCode('SCREWS_TILT_CALCULATE');
  };

  window.homeAxes = function (axes) {
    haptic('medium');
    let gcode = 'G28';
    if (axes === 'XY') gcode = 'G28 X Y';
    if (axes === 'Z') gcode = 'G28 Z';
    
    sendKlipperGCode(gcode);
    showToast(`Парковка: ${axes}`, '🏠');
  };

  window.jogMove = function (axis, dir) {
    haptic('light');
    const distance = 10 * dir;
    sendKlipperGCode(`G91\nG1 ${axis}${distance} F3000\nG90`);
    showToast(`Перемещение ${axis} ${distance > 0 ? '+' : ''}${distance}мм`, '🎯');
  };

  window.emergencyStopM112 = function () {
    haptic('error');
    if (confirm('ВНИМАНИЕ! Немедленно остановить принтер (M112 Emergency Stop)?')) {
      sendKlipperGCode('M112');
      showToast('АВАРИЙНАЯ ОСТАНОВКА M112 ВЫЗВАНА!', '🚨');
    }
  };

  // -------------------------------------------------------------------------
  // PRINT CONTROLS & MODALS
  // -------------------------------------------------------------------------
  window.openStopModal = function () {
    haptic('warning');
    const el = document.getElementById('stopModalBackdrop');
    if (el) el.classList.add('active');
  };

  window.closeStopModal = function () {
    const el = document.getElementById('stopModalBackdrop');
    if (el) el.classList.remove('active');
  };

  window.confirmStopPrint = function () {
    closeStopModal();
    haptic('error');
    sendKlipperGCode('CANCEL_PRINT');
    showToast('Печать отменена', '🛑');
  };

  // -------------------------------------------------------------------------
  // TAB NAVIGATION
  // -------------------------------------------------------------------------
  window.switchTab = function (tabId) {
    haptic('selection');
    state.activeTab = tabId;

    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-tab-item').forEach(el => el.classList.remove('active'));

    const targetTab = document.getElementById(`tab-${tabId}`);
    if (targetTab) targetTab.classList.add('active');

    const navBtn = document.getElementById(tabId === 'dashboard' ? 'nav-cockpit' : `nav-${tabId}`);
    if (navBtn) navBtn.classList.add('active');
  };

  window.switchViewportSubTab = function (subtab) {
    haptic('selection');
    state.activeSubTab = subtab;

    const btnCamera = document.getElementById('subtabBtnCamera');
    const btn3d = document.getElementById('subtabBtn3d');
    const viewCamera = document.getElementById('cameraViewportSub');
    const view3d = document.getElementById('threeViewportSub');

    if (subtab === 'camera') {
      if (btnCamera) {
        btnCamera.style.backgroundColor = 'var(--surface-card)';
        btnCamera.style.color = 'var(--accent-creality)';
        btnCamera.style.boxShadow = 'var(--card-shadow)';
      }
      if (btn3d) {
        btn3d.style.backgroundColor = 'transparent';
        btn3d.style.color = 'var(--text-muted)';
        btn3d.style.boxShadow = 'none';
      }
      if (viewCamera) viewCamera.classList.remove('hidden');
      if (view3d) view3d.classList.add('hidden');
    } else {
      if (btn3d) {
        btn3d.style.backgroundColor = 'var(--surface-card)';
        btn3d.style.color = 'var(--accent-creality)';
        btn3d.style.boxShadow = 'var(--card-shadow)';
      }
      if (btnCamera) {
        btnCamera.style.backgroundColor = 'transparent';
        btnCamera.style.color = 'var(--text-muted)';
        btnCamera.style.boxShadow = 'none';
      }
      if (view3d) view3d.classList.remove('hidden');
      if (viewCamera) viewCamera.classList.add('hidden');
    }
  };

  // -------------------------------------------------------------------------
  // CAMERA FEED ACTIONS
  // -------------------------------------------------------------------------
  window.captureCameraSnapshot = function () {
    haptic('light');
    const feed = document.getElementById('cameraFeed');
    if (feed) {
      feed.src = `http://192.168.1.114:1984/api/frame.jpeg?src=tapo&t=${Date.now()}`;
      showToast('Снимок Tapo C200 обновлен', '📸');
    }
  };

  window.refreshCameraStream = function () {
    captureCameraSnapshot();
  };

  window.toggleCameraFullscreen = function () {
    haptic('light');
    const container = document.getElementById('cameraContainer');
    if (!container) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      container.requestFullscreen().catch(() => {});
    }
  };

  // -------------------------------------------------------------------------
  // G-CODE SENDER (MOONRAKER REST & LOCAL SIMULATION)
  // -------------------------------------------------------------------------
  function sendKlipperGCode(gcode) {
    if (window.klipperApi && typeof window.klipperApi.sendGcode === 'function') {
      window.klipperApi.sendGcode(gcode);
    } else {
      console.log('[Klipper G-Code]', gcode);
    }
  }

  window.manualRefreshTelemetry = function () {
    haptic('light');
    showToast('Синхронизация телеметрии...', '🔄');
    if (window.klipperApi && typeof window.klipperApi.fetchTelemetry === 'function') {
      window.klipperApi.fetchTelemetry();
    }
  };

  // -------------------------------------------------------------------------
  // REAL-TIME TELEMETRY LISTENER & LIVE RENDER
  // -------------------------------------------------------------------------
  function hookTelemetry() {
    if (window.klipperApi && window.klipperApi.on) {
      window.klipperApi.on('telemetry', (data) => {
        if (data.hotend !== undefined) state.hotendTemp = data.hotend;
        if (data.hotend_target !== undefined) state.hotendTarget = data.hotend_target;
        if (data.bed !== undefined) state.bedTemp = data.bed;
        if (data.bed_target !== undefined) state.bedTarget = data.bed_target;
        if (data.fan_speed !== undefined) state.fanSpeedPct = data.fan_speed;
        if (data.speed_factor !== undefined) state.speedFactor = data.speed_factor;
        if (data.progress !== undefined) state.printPercent = data.progress;
        if (data.filename !== undefined) state.currentFile = data.filename || 'Файл не выбран';
        if (data.status !== undefined) state.printStatus = data.status;
        if (data.plug) {
          if (data.plug.voltage !== undefined && data.plug.voltage !== null) state.plugVoltage = parseFloat(data.plug.voltage);
          if (data.plug.power !== undefined && data.plug.power !== null) state.plugPower = parseFloat(data.plug.power);
          if (data.plug.amperage !== undefined && data.plug.amperage !== null) state.plugAmps = parseFloat(data.plug.amperage);
          if (data.plug.is_on !== undefined && data.plug.is_on !== null) state.isPlugOn = Boolean(data.plug.is_on);
        }
        renderDial();
        updateTelemetryUI();
      });
    }

    // Live update loop for timestamps
    setInterval(() => {
      const hudTs = document.getElementById('hudTimestamp');
      if (hudTs) {
        const now = new Date();
        hudTs.textContent = now.toTimeString().split(' ')[0];
      }
    }, 1000);
  }

  function updateTelemetryUI() {
    // Temperatures
    const hudE = document.getElementById('hudExtruderTemp');
    const hudB = document.getElementById('hudBedTemp');
    if (hudE) hudE.textContent = `${Math.round(state.hotendTemp)}°C`;
    if (hudB) hudB.textContent = `${Math.round(state.bedTemp)}°C`;

    // Smart Plug Telemetry
    const vEl = document.getElementById('plugVoltage');
    const pEl = document.getElementById('plugPower');
    const aEl = document.getElementById('plugAmps');
    const plugInput = document.getElementById('togglePlugInput');
    const plugTxt = document.getElementById('plugStateText');

    if (vEl) vEl.textContent = `${(state.plugVoltage || 230.0).toFixed(1)} V`;
    if (pEl) pEl.textContent = `${(state.plugPower || 0.0).toFixed(1)} W`;
    if (aEl) aEl.textContent = `${(state.plugAmps || 0.0).toFixed(2)} A`;
    if (plugInput) plugInput.checked = state.isPlugOn;
    if (plugTxt) plugTxt.textContent = state.isPlugOn ? 'Умная розетка ВКЛ' : 'Умная розетка ВЫКЛ';

    // Fan and Speed
    const fanTxt = document.getElementById('fanSpeedPct');
    const fanIcon = document.getElementById('fanSpinIcon');
    if (fanTxt) fanTxt.textContent = `${state.fanSpeedPct}%`;
    if (fanIcon) {
      if (state.fanSpeedPct > 0) {
        fanIcon.style.display = 'inline-block';
        fanIcon.style.animation = `spin ${Math.max(0.3, 1.5 - (state.fanSpeedPct / 100))}s linear infinite`;
      } else {
        fanIcon.style.animation = 'none';
      }
    }

    const speedTxt = document.getElementById('speedFactorVal');
    if (speedTxt) speedTxt.textContent = `${state.speedFactor}%`;

    // Print Progress & File
    const fileEl = document.getElementById('currentFileName');
    const progressEl = document.getElementById('printPercent');
    const progressBar = document.getElementById('mainProgressBar');
    const statusTitleEl = document.getElementById('printStatusTitle');
    const statusSubEl = document.getElementById('statusSub');

    if (fileEl) fileEl.textContent = state.currentFile;
    if (progressEl) progressEl.textContent = `${state.printPercent}%`;
    if (progressBar) progressBar.style.width = `${Math.min(100, Math.max(0, state.printPercent))}%`;

    let label = 'Режим ожидания';
    if (state.printStatus === 'printing') label = 'Печать детали...';
    else if (state.printStatus === 'paused') label = 'Печать на паузе';
    else if (state.printStatus === 'error') label = 'Ошибка';
    else if (state.printStatus === 'offline') label = 'Принтер обесточен';

    if (statusTitleEl) statusTitleEl.textContent = label;
    if (statusSubEl) statusSubEl.textContent = label;
  }

  // -------------------------------------------------------------------------
  // INITIALIZATION
  // -------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initTelegram();
    renderDial();
    hookTelemetry();
  });

})(window, document);
