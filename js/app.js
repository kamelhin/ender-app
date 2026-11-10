/**
 * Ender-3 S1 Plus Cockpit - Main Application Controller
 * 
 * Features:
 * - Telegram WebApp SDK Initialization & Safe Area Handling
 * - Taptic Engine Haptic Feedback Helper
 * - Responsive 4-Tab Navigation with Battery-Saving Viewport Toggles
 * - Real-Time Telemetry Loop (Glow Effects, Progress, Temperatures, Z, Time)
 * - Deep Integration with Three.js 3D Bed Viewport & Tapo C210 Camera HUD
 * - Drag-and-Drop STL / G-Code Upload Zone with OrcaSlicer Handshake
 * - Screws Tilt Calculate 4-Quadrant Circular Dial Rendering
 * - Modals for Starting, Canceling, and Safe Powering Off Prints
 */

(function (window, document) {
  'use strict';

  // =========================================================================
  // GLOBAL STATE & VARIABLES
  // =========================================================================
  const tg = window.Telegram && window.Telegram.WebApp;
  let currentActiveTab = 'dashboard';
  let currentActiveSubTab = 'camera';
  let currentJogStepMm = 10.0;
  let filesCatalogCache = [];
  let pendingPrintFilename = null;
  let isNightVisionActive = false;
  let nozzleLightState = false;

  // Global Instances
  window.app = window.app || {};

  // =========================================================================
  // TELEGRAM WEBAPP SDK INITIALIZATION
  // =========================================================================
  function initTelegramWebApp() {
    if (!tg) return;

    try {
      tg.ready();
      tg.expand();

      // Setup dark theme styles to match Obsidian Luxury palette
      if (typeof tg.setHeaderColor === 'function') {
        tg.setHeaderColor('#06080D');
      }
      if (typeof tg.setBackgroundColor === 'function') {
        tg.setBackgroundColor('#06080D');
      }

      // Enable closing confirmation if print is currently running
      if (typeof tg.enableClosingConfirmation === 'function') {
        tg.enableClosingConfirmation();
      }
    } catch (err) {
      console.warn('[App] Telegram WebApp setup warning:', err);
    }
  }

  // =========================================================================
  // TAPTIC ENGINE HAPTIC FEEDBACK HELPER
  // =========================================================================
  function haptic(type = 'medium') {
    try {
      if (tg && tg.HapticFeedback) {
        switch (type) {
          case 'light':
            tg.HapticFeedback.impactOccurred('light');
            break;
          case 'medium':
            tg.HapticFeedback.impactOccurred('medium');
            break;
          case 'heavy':
            tg.HapticFeedback.impactOccurred('heavy');
            break;
          case 'rigid':
            tg.HapticFeedback.impactOccurred('rigid');
            break;
          case 'soft':
            tg.HapticFeedback.impactOccurred('soft');
            break;
          case 'success':
            tg.HapticFeedback.notificationOccurred('success');
            break;
          case 'warning':
            tg.HapticFeedback.notificationOccurred('warning');
            break;
          case 'error':
            tg.HapticFeedback.notificationOccurred('error');
            break;
          case 'selection':
            tg.HapticFeedback.selectionChanged();
            break;
          default:
            tg.HapticFeedback.impactOccurred('medium');
        }
        return;
      }

      // Browser Fallback (Android Vibration API)
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        if (type === 'heavy' || type === 'error') navigator.vibrate(28);
        else if (type === 'medium' || type === 'warning') navigator.vibrate(16);
        else navigator.vibrate(8);
      }
    } catch (e) {}
  }

  // Backward compatibility alias
  function triggerHaptic(type = 'light') {
    haptic(type);
  }

  // =========================================================================
  // TOAST NOTIFICATIONS
  // =========================================================================
  let toastHideTimer = null;
  function showToast(message, type = 'info', duration = 2200) {
    const toastBox = document.getElementById('toastBox');
    const toastMsg = document.getElementById('toastMessage');
    if (!toastBox) return;

    clearTimeout(toastHideTimer);

    if (toastMsg) {
      toastMsg.textContent = message;
    } else {
      toastBox.textContent = message;
    }

    // Border & color styling based on type
    if (type === 'error') {
      toastBox.style.borderColor = 'rgba(239, 68, 68, 0.5)';
      toastBox.style.color = '#F87171';
    } else if (type === 'warning') {
      toastBox.style.borderColor = 'rgba(245, 158, 11, 0.5)';
      toastBox.style.color = '#FBBF24';
    } else {
      toastBox.style.borderColor = 'rgba(16, 185, 129, 0.4)';
      toastBox.style.color = '#10B981';
    }

    toastBox.classList.add('show');
    toastHideTimer = setTimeout(() => {
      toastBox.classList.remove('show');
    }, duration);
  }

  // =========================================================================
  // NAVIGATION TAB SWITCHING & BATTERY-SAVER LOGIC
  // =========================================================================
  function switchTab(tabId) {
    haptic('light');
    currentActiveTab = tabId;

    // 1. Hide all tab sections, display selected tab
    const tabs = ['dashboard', 'camera', 'service', 'files'];
    tabs.forEach(t => {
      const el = document.getElementById(`tab-${t}`);
      if (el) {
        if (t === tabId) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      }
    });

    // 2. Update Floating Capsule Navigation Bar
    const navMapping = {
      dashboard: 'nav-cockpit',
      camera: 'nav-camera',
      service: 'nav-service',
      files: 'nav-files'
    };

    Object.entries(navMapping).forEach(([t, btnId]) => {
      const btn = document.getElementById(btnId);
      if (btn) {
        if (t === tabId) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      }
    });

    // 3. Viewport & Rendering Power Management
    if (tabId === 'camera') {
      if (currentActiveSubTab === 'camera') {
        if (window.cameraHUD) window.cameraHUD.resume();
        if (window.viewer3D) window.viewer3D.pause();
      } else {
        if (window.cameraHUD) window.cameraHUD.pause();
        if (window.viewer3D) {
          window.viewer3D.resume();
          setTimeout(() => window.viewer3D._onResize(), 60);
        }
      }
    } else {
      // Pause heavy loops to save smartphone battery
      if (window.cameraHUD) window.cameraHUD.pause();
      if (window.viewer3D) window.viewer3D.pause();
    }

    // 4. If files tab is opened, refresh catalog
    if (tabId === 'files') {
      loadFilesCatalog();
    }
  }

  // Camera & 3D Sub-Tab Switcher
  function switchViewportSubTab(subTabId) {
    haptic('medium');
    currentActiveSubTab = subTabId;

    const camSub = document.getElementById('cameraViewportSub');
    const threeSub = document.getElementById('threeViewportSub');
    const btnCam = document.getElementById('subtabBtnCamera');
    const btn3d = document.getElementById('subtabBtn3d');

    if (subTabId === 'camera') {
      if (camSub) camSub.classList.remove('hidden');
      if (threeSub) threeSub.classList.add('hidden');

      if (btnCam) {
        btnCam.className = 'flex-1 py-1.5 rounded-xl text-xs font-bold transition-all duration-200 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
      }
      if (btn3d) {
        btn3d.className = 'flex-1 py-1.5 rounded-xl text-xs font-bold transition-all duration-200 text-slate-400 hover:text-white';
      }

      if (window.cameraHUD) window.cameraHUD.resume();
      if (window.viewer3D) window.viewer3D.pause();
    } else {
      if (camSub) camSub.classList.add('hidden');
      if (threeSub) threeSub.classList.remove('hidden');

      if (btn3d) {
        btn3d.className = 'flex-1 py-1.5 rounded-xl text-xs font-bold transition-all duration-200 bg-cyan-500/20 text-cyan-400 border border-cyan-500/30';
      }
      if (btnCam) {
        btnCam.className = 'flex-1 py-1.5 rounded-xl text-xs font-bold transition-all duration-200 text-slate-400 hover:text-white';
      }

      if (window.cameraHUD) window.cameraHUD.pause();
      if (window.viewer3D) {
        window.viewer3D.resume();
        setTimeout(() => window.viewer3D._onResize(), 60);
      }
    }
  }

  // =========================================================================
  // LIVE TELEMETRY RENDERING LOOP
  // =========================================================================
  function renderTelemetry(data) {
    if (!data) return;

    // 1. Connection Ping and Live Badge
    const pingEl = document.getElementById('livePing');
    if (pingEl && data.ping !== undefined) {
      pingEl.textContent = `${Math.max(12, Math.min(999, Math.round(data.ping)))}ms`;
    }

    // 2. Status Badge & Dot
    const status = (data.status || 'ready').toLowerCase();
    const dot = document.getElementById('statusDot');
    const sub = document.getElementById('statusSub');
    const badge = document.getElementById('printStateBadge');

    if (status === 'printing') {
      if (dot) dot.className = 'w-3.5 h-3.5 rounded-full bg-emerald-400 shadow-[0_0_14px_#10B981]';
      if (sub) sub.textContent = 'Идёт печать...';
      if (badge) {
        badge.textContent = 'Печать активна';
        badge.className = 'text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40';
      }
      // Toggle Pause / Resume buttons
      const btnPause = document.getElementById('btnPause');
      const btnResume = document.getElementById('btnResume');
      if (btnPause) btnPause.classList.remove('hidden');
      if (btnResume) btnResume.classList.add('hidden');
    } else if (status === 'paused') {
      if (dot) dot.className = 'w-3.5 h-3.5 rounded-full bg-amber-400 shadow-[0_0_14px_#F59E0B]';
      if (sub) sub.textContent = 'Печать на паузе';
      if (badge) {
        badge.textContent = 'Пауза';
        badge.className = 'text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40';
      }
      const btnPause = document.getElementById('btnPause');
      const btnResume = document.getElementById('btnResume');
      if (btnPause) btnPause.classList.add('hidden');
      if (btnResume) btnResume.classList.remove('hidden');
    } else if (status === 'offline') {
      if (dot) dot.className = 'w-3.5 h-3.5 rounded-full bg-rose-500 shadow-[0_0_14px_#EF4444]';
      if (sub) sub.textContent = 'Принтер обесточен (24V ВЫКЛ)';
      if (badge) {
        badge.textContent = 'Офлайн';
        badge.className = 'text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/40';
      }
    } else {
      if (dot) dot.className = 'w-3.5 h-3.5 rounded-full bg-emerald-500 shadow-[0_0_12px_#10B981]';
      if (sub) sub.textContent = 'Готов к печати';
      if (badge) {
        badge.textContent = 'Режим ожидания';
        badge.className = 'text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30';
      }
    }

    // 3. Print Progress & Active File
    const pct = Math.min(100, Math.max(0, parseInt(data.progress || 0, 10)));
    const pctEl = document.getElementById('printPercent');
    if (pctEl) pctEl.textContent = `${pct}%`;

    const progressEl = document.getElementById('mainProgress');
    if (progressEl) progressEl.style.width = `${pct}%`;

    const fileEl = document.getElementById('currentFile');
    if (fileEl && data.filename) {
      fileEl.textContent = data.filename.replace(/\.(gcode|gco|g)$/i, '');
      fileEl.title = data.filename;
    }

    // 4. Metrics: Z-Height, Current Layer, Time Remaining
    const zEl = document.getElementById('currentZ');
    if (zEl && data.z !== undefined) {
      zEl.textContent = `${parseFloat(data.z).toFixed(2)} мм`;
    }

    const layerEl = document.getElementById('currentLayer');
    if (layerEl) {
      const curL = data.layer || 0;
      const totL = data.total_layers || 0;
      layerEl.textContent = totL > 0 ? `${curL} / ${totL}` : `${curL}`;
    }

    const timeEl = document.getElementById('timeRemaining');
    if (timeEl) {
      if (data.time_left && data.time_left > 0) {
        const totalMins = Math.round(data.time_left / 60);
        const hrs = Math.floor(totalMins / 60);
        const mins = totalMins % 60;
        timeEl.textContent = hrs > 0 ? `~${hrs}ч ${mins}м` : `~${mins} мин`;
      } else {
        timeEl.textContent = (status === 'printing') ? 'Расчёт...' : '--:--';
      }
    }

    // 5. Extruder Temperature & Thermal Effects
    const extCur = parseFloat(data.hotend || 0);
    const extTar = parseFloat(data.hotend_target || 0);

    const extTempEl = document.getElementById('extruderTemp');
    if (extTempEl) extTempEl.textContent = `${extCur.toFixed(1)}°C`;

    const extTarEl = document.getElementById('extruderTarget');
    if (extTarEl) extTarEl.textContent = `/ ${Math.round(extTar)}°C`;

    const extBar = document.getElementById('extruderBar');
    if (extBar) {
      const p = Math.min(100, Math.max(4, (extCur / 260) * 100));
      extBar.style.width = `${p}%`;
    }

    // Fire Glow effect on card if heating up
    const extCard = document.getElementById('extruderCard');
    const extFlame = document.getElementById('extruderFlameIcon');
    if (extCard) {
      if (extTar > 0 && extCur < (extTar - 2)) {
        extCard.classList.add('card-heating');
        extCard.classList.remove('card-cooling');
        if (extFlame) extFlame.classList.add('animate-flame');
      } else if (extTar === 0 && extCur > 48) {
        extCard.classList.add('card-cooling');
        extCard.classList.remove('card-heating');
        if (extFlame) extFlame.classList.remove('animate-flame');
      } else {
        extCard.classList.remove('card-heating', 'card-cooling');
        if (extFlame) extFlame.classList.remove('animate-flame');
      }
    }

    // 6. Bed Temperature & Thermal Effects
    const bedCur = parseFloat(data.bed || 0);
    const bedTar = parseFloat(data.bed_target || 0);

    const bedTempEl = document.getElementById('bedTemp');
    if (bedTempEl) bedTempEl.textContent = `${bedCur.toFixed(1)}°C`;

    const bedTarEl = document.getElementById('bedTarget');
    if (bedTarEl) bedTarEl.textContent = `/ ${Math.round(bedTar)}°C`;

    const bedBar = document.getElementById('bedBar');
    if (bedBar) {
      const p = Math.min(100, Math.max(4, (bedCur / 100) * 100));
      bedBar.style.width = `${p}%`;
    }

    const bedCard = document.getElementById('bedCard');
    if (bedCard) {
      if (bedTar > 0 && bedCur < (bedTar - 2)) {
        bedCard.classList.add('card-heating');
      } else {
        bedCard.classList.remove('card-heating');
      }
    }

    // 7. 5015 Part Cooling Fan Speed
    const fanPct = Math.round(data.fan_speed || 0);
    const fanSpeedEl = document.getElementById('fanSpeedPct');
    if (fanSpeedEl) fanSpeedEl.textContent = `${fanPct}%`;

    const fanBar = document.getElementById('fanBar');
    if (fanBar) fanBar.style.width = `${fanPct}%`;

    const fanIcon = document.getElementById('fanBreezeIcon');
    if (fanIcon) {
      if (fanPct > 0) fanIcon.classList.add('animate-spin');
      else fanIcon.classList.remove('animate-spin');
    }

    // 8. Speed Factor M220
    const speedPct = Math.round(data.speed_factor || 100);
    const speedFactorEl = document.getElementById('speedFactorVal');
    if (speedFactorEl) speedFactorEl.textContent = `${speedPct}%`;

    const speedBar = document.getElementById('speedBar');
    if (speedBar) {
      const p = Math.min(100, Math.max(10, (speedPct / 150) * 100));
      speedBar.style.width = `${p}%`;
    }

    // 9. Toolhead Coordinates Overlay (3D Viewport)
    if (data.toolhead && Array.isArray(data.toolhead)) {
      const thX = document.getElementById('toolheadX');
      const thY = document.getElementById('toolheadY');
      const thZ = document.getElementById('toolheadZ');
      if (thX) thX.textContent = (data.toolhead[0] || 0).toFixed(1);
      if (thY) thY.textContent = (data.toolhead[1] || 0).toFixed(1);
      if (thZ) thZ.textContent = (data.toolhead[2] || 0).toFixed(2);
    }

    // 10. Pass to Camera HUD Overlay
    const hudExt = document.getElementById('hudExtruderTemp');
    if (hudExt) hudExt.textContent = `${extCur.toFixed(1)}°C`;
    const hudBed = document.getElementById('hudBedTemp');
    if (hudBed) hudBed.textContent = `${bedCur.toFixed(1)}°C`;
    const hudZ = document.getElementById('hudZHeight');
    if (hudZ) hudZ.textContent = `${parseFloat(data.z || 0).toFixed(2)}`;
    const hudTime = document.getElementById('hudTimestamp');
    if (hudTime) {
      const now = new Date();
      hudTime.textContent = now.toTimeString().split(' ')[0];
    }
  }

  // =========================================================================
  // SCREWS TILT CALCULATE DIALS RENDERING
  // =========================================================================
  async function runScrewsTiltCalculate() {
    haptic('medium');
    const btn = document.getElementById('btnScrewsTilt');
    const originalText = btn ? btn.innerHTML : '';

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<svg class="animate-spin" xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path></svg><span>Замер...</span>`;
    }

    showToast('📐 CR-Touch замеряет 4 винта стола...', 'info', 4000);

    try {
      const results = await window.klipperApi.runScrewsTiltCalculate();
      haptic('success');
      showToast('✅ Замер винтов стола успешно завершён!', 'success');

      // Update Timestamp
      const tsEl = document.getElementById('screwsTiltTimestamp');
      if (tsEl) {
        tsEl.textContent = `Обновлено: ${new Date().toLocaleTimeString()}`;
      }

      // Update each screw quadrant
      ['RL', 'RR', 'FL', 'FR'].forEach(key => {
        const item = results[key];
        if (!item) return;

        const valEl = document.getElementById(`screw${key}_val`);
        const badgeEl = document.getElementById(`screw${key}_badge`);
        const dialEl = document.getElementById(`screw${key}_dial`);
        const cardEl = document.getElementById(`screw${key}_card`);
        const wheelEl = document.getElementById(`screw${key}_wheel`);

        if (valEl) valEl.textContent = item.label;
        if (badgeEl) badgeEl.textContent = item.isBase ? 'BASE' : (item.isLevel ? 'OK' : item.direction);

        // Calculate and apply rotation degrees
        if (dialEl) {
          const rotationAngle = item.degrees || 0;
          dialEl.style.transform = `rotate(${rotationAngle}deg)`;
        }

        // Apply theme color classes
        if (cardEl && wheelEl) {
          cardEl.className = 'screw-dial-item';
          wheelEl.className = 'screw-dial-wheel';

          if (item.isBase || item.isLevel) {
            cardEl.classList.add('dial-ok');
            wheelEl.classList.add('dial-ok-border');
            if (dialEl) dialEl.style.background = '#10B981';
            if (valEl) valEl.className = 'text-[10px] font-mono font-bold text-emerald-400';
          } else if (item.direction === 'CW') {
            cardEl.classList.add('dial-cw');
            wheelEl.classList.add('dial-cw-border');
            if (dialEl) dialEl.style.background = '#06B6D4';
            if (valEl) valEl.className = 'text-[10px] font-mono font-bold text-cyan-400';
          } else {
            cardEl.classList.add('dial-ccw');
            wheelEl.classList.add('dial-ccw-border');
            if (dialEl) dialEl.style.background = '#F59E0B';
            if (valEl) valEl.className = 'text-[10px] font-mono font-bold text-amber-400';
          }
        }
      });
    } catch (err) {
      haptic('error');
      showToast(`❌ Ошибка замера: ${err.message}`, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
    }
  }

  // =========================================================================
  // FILE CATALOG MANAGEMENT & DRAG-AND-DROP
  // =========================================================================
  async function loadFilesCatalog() {
    const container = document.getElementById('filesContainer');
    if (!container) return;

    try {
      const files = await window.klipperApi.fetchFilesList('gcodes');
      filesCatalogCache = files;
      renderFilesList(files);
    } catch (err) {
      // Fallback: try loading local files.json if available
      try {
        const resp = await fetch(`files.json?t=${Date.now()}`);
        if (resp.ok) {
          const localFiles = await resp.json();
          filesCatalogCache = localFiles;
          renderFilesList(localFiles);
          return;
        }
      } catch (e) {}

      container.innerHTML = `
        <div class="p-6 text-center text-slate-400 text-xs flex flex-col items-center justify-center space-y-1">
          <span class="text-rose-400">⚠️ Не удалось подключиться к Klipper</span>
          <span class="text-[10px] text-slate-500">Проверьте соединение с Moonraker на 192.168.1.21:7125</span>
        </div>
      `;
    }
  }

  function renderFilesList(files) {
    const container = document.getElementById('filesContainer');
    if (!container) return;

    if (!files || files.length === 0) {
      container.innerHTML = `
        <div class="p-8 text-center text-slate-500 text-xs">
          Файлы G-кода не найдены. Перетащите файл в зону выше или отправьте боту.
        </div>
      `;
      return;
    }

    container.innerHTML = files.map(f => {
      const filename = f.filename || '';
      const safeName = (f.displayName || filename).replace(/'/g, "\\'");
      const timeStr = f.estimatedTime || f.time || '--';
      const weightStr = f.filamentWeight || '--';
      const matStr = f.material || 'PETG';
      const thumbUrl = f.thumbnail || '';

      return `
        <div class="bg-surface rounded-2xl p-3 border border-surfaceBorder hover:border-white/20 transition-all duration-200 flex items-center justify-between gap-3 shadow-md">
          <div class="w-13 h-13 rounded-xl bg-black/60 p-1 border border-white/10 shrink-0 flex items-center justify-center overflow-hidden" style="width:52px; height:52px;">
            ${thumbUrl ? `<img src="${thumbUrl}" class="w-full h-full object-contain" alt="3D" onerror="this.src=''; this.parentElement.innerHTML='🧊';">` : `<span class="text-xl">🧊</span>`}
          </div>
          <div class="flex-1 truncate">
            <h3 class="text-xs font-bold text-white truncate" title="${filename}">${f.displayName || filename}</h3>
            <div class="flex items-center gap-2 text-[10px] text-slate-400 mt-1 font-mono tabular-nums">
              <span class="text-emerald-400 font-bold">${timeStr}</span>
              <span>•</span>
              <span>${weightStr}</span>
              <span>•</span>
              <span class="text-slate-400 px-1 py-0.2 rounded bg-white/5">${matStr}</span>
            </div>
          </div>
          <div class="flex flex-col gap-1.5 shrink-0">
            <button onclick="openStartModal('${filename}', '${safeName}', '${timeStr}', '${weightStr}', '${matStr}', '${thumbUrl}')" class="btn-tactile px-3 py-1.5 rounded-xl bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 font-bold text-xs border border-emerald-500/30" style="min-height:34px;">
              Печать
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  function filterFilesList(query) {
    const q = (query || '').toLowerCase().trim();
    const clearBtn = document.getElementById('btnClearSearch');
    if (clearBtn) {
      if (q.length > 0) clearBtn.classList.remove('hidden');
      else clearBtn.classList.add('hidden');
    }

    if (!q) {
      renderFilesList(filesCatalogCache);
      return;
    }

    const filtered = filesCatalogCache.filter(f => {
      const name = (f.filename || f.displayName || '').toLowerCase();
      const mat = (f.material || '').toLowerCase();
      return name.includes(q) || mat.includes(q);
    });

    renderFilesList(filtered);
  }

  function clearFileSearch() {
    const input = document.getElementById('fileSearchInput');
    if (input) {
      input.value = '';
      filterFilesList('');
    }
  }

  // =========================================================================
  // DRAG & DROP STL / G-CODE UPLOAD ZONE
  // =========================================================================
  function initDropZone() {
    const dropZone = document.getElementById('dropZone');
    if (!dropZone) return;

    ['dragenter', 'dragover'].forEach(eventName => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('dropzone-active');
      }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('dropzone-active');
      }, false);
    });

    dropZone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      const files = dt.files;
      if (files && files.length > 0) {
        processUploadedFile(files[0]);
      }
    }, false);
  }

  function triggerFileInput() {
    haptic('light');
    const input = document.getElementById('fileInput');
    if (input) input.click();
  }

  function handleFileSelect(event) {
    const files = event.target.files;
    if (files && files.length > 0) {
      processUploadedFile(files[0]);
    }
  }

  async function processUploadedFile(file) {
    haptic('medium');
    const fileName = file.name.toLowerCase();

    // 1. G-code file -> Direct Upload to Moonraker
    if (fileName.endsWith('.gcode') || fileName.endsWith('.bgcode') || fileName.endsWith('.gco')) {
      showToast(`📤 Загрузка ${file.name}...`, 'info', 5000);
      try {
        await window.klipperApi.uploadFile(file, {
          onProgress: (pct) => {
            showToast(`📤 Загрузка: ${pct}%`, 'info', 1000);
          }
        });
        haptic('success');
        showToast(`✅ ${file.name} загружен в Klipper!`, 'success');
        loadFilesCatalog();
      } catch (err) {
        haptic('error');
        showToast(`❌ Ошибка загрузки: ${err.message}`, 'error');
      }
      return;
    }

    // 2. STL file -> Preview in 3D & Notify OrcaSlicer Slicing
    if (fileName.endsWith('.stl')) {
      showToast(`📦 STL модель "${file.name}" получена!`, 'info');

      // If Three.js viewer is available, render interactive preview on 3D Bed
      if (window.viewer3D && typeof window.viewer3D.loadModelPreview === 'function') {
        const reader = new FileReader();
        reader.onload = async (e) => {
          try {
            await window.viewer3D.loadModelPreview(e.target.result);
            switchTab('camera');
            switchViewportSubTab('3d');
            showToast('🧊 3D предпросмотр STL размещён на столе', 'success');
          } catch (e) {}
        };
        reader.readAsArrayBuffer(file);
      }

      // Notify Telegram Bot or ntfy for cloud slicing
      if (window.klipperApi && typeof window.klipperApi._sendNtfyRelay === 'function') {
        window.klipperApi._sendNtfyRelay('STL_DROPPED', { name: file.name, size: file.size });
      }
      return;
    }

    showToast('⚠️ Поддерживаются форматы .STL и .GCODE', 'warning');
  }

  // =========================================================================
  // QUICK ACTIONS: PREHEAT, FAN, SPEED, Z-OFFSET
  // =========================================================================
  async function preheat(profile) {
    haptic('medium');
    showToast(`🔥 Преднагрев ${profile}...`, 'info');
    try {
      await window.klipperApi.preheat(profile);
      haptic('success');
    } catch (err) {
      haptic('error');
      showToast(`❌ Ошибка преднагрева: ${err.message}`, 'error');
    }
  }

  async function adjustZOffset(delta) {
    haptic('medium');
    const zOffsetEl = document.getElementById('currentZOffset');
    if (zOffsetEl) {
      const cur = parseFloat(zOffsetEl.textContent) || 0;
      const next = cur + delta;
      zOffsetEl.textContent = (next >= 0 ? '+' : '') + next.toFixed(3) + ' мм';
    }

    try {
      await window.klipperApi.adjustZOffset(delta);
      showToast(`📐 Z-Offset ${delta > 0 ? '+' : ''}${delta} мм`);
    } catch (err) {
      showToast(`❌ Ошибка Z-Offset: ${err.message}`, 'error');
    }
  }

  async function setFanSpeed(pct) {
    haptic('light');
    try {
      await window.klipperApi.setFanSpeed(pct);
      showToast(`🌀 Обдув 5015: ${pct}%`);
    } catch (err) {}
  }

  async function setSpeedFactor(pct) {
    haptic('light');
    try {
      await window.klipperApi.setSpeedFactor(pct);
      showToast(`⚡ Скорость M220: ${pct}%`);
    } catch (err) {}
  }

  // =========================================================================
  // MANUAL MOTION & JOGGING
  // =========================================================================
  function setJogStep(step) {
    haptic('light');
    currentJogStepMm = parseFloat(step);

    const stepBtns = document.querySelectorAll('.jog-step-btn');
    stepBtns.forEach(b => {
      const s = parseFloat(b.textContent);
      if (s === currentJogStepMm) {
        b.className = 'jog-step-btn px-2 py-0.5 rounded-lg text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
      } else {
        b.className = 'jog-step-btn px-2 py-0.5 rounded-lg text-[10px] font-mono font-bold text-slate-400';
      }
    });
  }

  async function jogMove(axis, dir) {
    haptic('medium');
    const dist = (dir * currentJogStepMm).toFixed(2);
    try {
      await window.klipperApi.jogMove(axis, dist);
    } catch (err) {
      showToast(`❌ Ошибка перемещения: ${err.message}`, 'error');
    }
  }

  async function homeAxes(axes = 'ALL') {
    haptic('heavy');
    showToast(`🏠 Калибровка Home (${axes})...`, 'info');
    try {
      await window.klipperApi.home(axes === 'ALL' ? 'XYZ' : axes);
      haptic('success');
    } catch (err) {
      haptic('error');
      showToast(`❌ Ошибка парковки: ${err.message}`, 'error');
    }
  }

  async function extrudeFilament(lengthMm) {
    haptic('medium');
    try {
      if (lengthMm > 0) {
        await window.klipperApi.extrude(lengthMm);
        showToast(`⬇️ Выдавливание ${lengthMm} мм филамента`);
      } else {
        await window.klipperApi.retract(Math.abs(lengthMm));
        showToast(`⬆️ Откат ${Math.abs(lengthMm)} мм филамента`);
      }
    } catch (err) {
      showToast(`❌ Ошибка экструдера: ${err.message}`, 'error');
    }
  }

  async function runBedMeshCalibrate() {
    haptic('heavy');
    showToast('📐 Запуск построения сетки стола BED_MESH_CALIBRATE...', 'info');
    try {
      await window.klipperApi.sendGcode('BED_MESH_CALIBRATE');
      haptic('success');
    } catch (err) {
      showToast(`❌ Ошибка сетки стола: ${err.message}`, 'error');
    }
  }

  // =========================================================================
  // CAMERA HUD ACTION HANDLERS
  // =========================================================================
  function captureCameraSnapshot() {
    haptic('medium');
    if (window.cameraHUD && typeof window.cameraHUD.takeSnapshot === 'function') {
      window.cameraHUD.takeSnapshot();
    } else {
      showToast('📷 Снимок с Tapo C210 зафиксирован');
    }
  }

  function toggleCameraNightMode() {
    haptic('light');
    isNightVisionActive = !isNightVisionActive;
    const feed = document.getElementById('cameraFeed');
    if (feed) {
      if (isNightVisionActive) {
        feed.style.filter = 'grayscale(100%) contrast(140%) brightness(110%)';
        showToast('🌙 Режим ночного видения: ВКЛ');
      } else {
        feed.style.filter = 'none';
        showToast('☀️ Дневной режим: ВКЛ');
      }
    }
  }

  function refreshCameraStream() {
    haptic('light');
    const feed = document.getElementById('cameraFeed');
    if (feed) {
      feed.src = `http://192.168.1.21:8889/snapshot?t=${Date.now()}`;
    }
    showToast('🔄 Видеопоток обновлён');
  }

  function toggleCameraFullscreen() {
    haptic('light');
    const container = document.getElementById('cameraContainer');
    if (!container) return;

    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  // 3D Viewport Controls
  function reset3DView() {
    haptic('light');
    if (window.viewer3D && typeof window.viewer3D.resetCamera === 'function') {
      window.viewer3D.resetCamera();
    }
  }

  function centerNozzle3D() {
    haptic('light');
    if (window.viewer3D && typeof window.viewer3D.focusToolhead === 'function') {
      window.viewer3D.focusToolhead();
    }
  }

  function toggleBedGrid3D() {
    haptic('light');
    if (window.viewer3D && typeof window.viewer3D.toggleGrid === 'function') {
      window.viewer3D.toggleGrid();
    }
  }

  // Header Lights & Telemetry Reload
  function toggleLight(zone = 'nozzle') {
    haptic('medium');
    nozzleLightState = !nozzleLightState;
    const icon = document.getElementById('iconNozzleLight');
    const btn = document.getElementById('btnNozzleLight');

    if (nozzleLightState) {
      if (btn) btn.className = 'p-2 rounded-xl bg-amber-500/20 text-amber-300 border border-amber-500/40 btn-tactile';
      showToast('💡 Подсветка сопла включена');
      window.klipperApi.sendGcode('LIGHT_NOZZLE_ON').catch(() => {});
    } else {
      if (btn) btn.className = 'p-2 rounded-xl bg-surface hover:bg-surfaceHover border border-surfaceBorder text-slate-300 btn-tactile';
      showToast('💡 Подсветка сопла выключена');
      window.klipperApi.sendGcode('LIGHT_NOZZLE_OFF').catch(() => {});
    }
  }

  function manualRefreshTelemetry() {
    haptic('medium');
    const icon = document.getElementById('refreshIcon');
    if (icon) icon.classList.add('animate-spin');

    window.klipperApi.queryStatus().finally(() => {
      setTimeout(() => {
        if (icon) icon.classList.remove('animate-spin');
      }, 600);
    });
    showToast('🔄 Телеметрия обновлена');
  }

  // =========================================================================
  // PRINT JOB CONTROLS & MODALS
  // =========================================================================
  async function pausePrint() {
    haptic('warning');
    showToast('⏸ Приостановка печати...', 'warning');
    try {
      await window.klipperApi.pausePrint();
    } catch (err) {
      showToast(`❌ Ошибка паузы: ${err.message}`, 'error');
    }
  }

  async function resumePrint() {
    haptic('medium');
    showToast('▶️ Возобновление печати...', 'info');
    try {
      await window.klipperApi.resumePrint();
    } catch (err) {
      showToast(`❌ Ошибка возобновления: ${err.message}`, 'error');
    }
  }

  // Stop Print Modal
  function openStopModal() {
    haptic('warning');
    const m = document.getElementById('stopModalBackdrop');
    if (m) m.classList.add('show');
  }

  function closeStopModal() {
    haptic('light');
    const m = document.getElementById('stopModalBackdrop');
    if (m) m.classList.remove('show');
  }

  async function confirmStopPrint() {
    haptic('heavy');
    closeStopModal();
    showToast('⏹ Отмена задания печати...', 'warning');
    try {
      await window.klipperApi.cancelPrint();
      haptic('success');
      showToast('Печать остановлена. Сопло остывает.', 'info');
    } catch (err) {
      haptic('error');
      showToast(`❌ Ошибка отмены: ${err.message}`, 'error');
    }
  }

  // Start Print Modal
  function openStartModal(filename, displayName, timeStr, weightStr, mat, thumbUrl) {
    haptic('medium');
    pendingPrintFilename = filename;

    const nameEl = document.getElementById('startModalName');
    const detEl = document.getElementById('startModalDetails');
    const matEl = document.getElementById('startModalMat');
    const thumbEl = document.getElementById('startModalThumb');

    if (nameEl) nameEl.textContent = displayName || filename;
    if (detEl) detEl.textContent = `⏱ ${timeStr || '--'} • ⚖️ ${weightStr || '--'}`;
    if (matEl) matEl.textContent = mat || 'PETG';

    if (thumbEl) {
      if (thumbUrl) {
        thumbEl.src = thumbUrl;
        thumbEl.classList.remove('hidden');
      } else {
        thumbEl.classList.add('hidden');
      }
    }

    const modal = document.getElementById('startModalBackdrop');
    if (modal) modal.classList.add('show');
  }

  function closeStartModal() {
    haptic('light');
    const modal = document.getElementById('startModalBackdrop');
    if (modal) modal.classList.remove('show');
    pendingPrintFilename = null;
  }

  async function confirmStartPrint() {
    haptic('heavy');
    const file = pendingPrintFilename;
    closeStartModal();

    if (!file) return;

    showToast(`🚀 Запуск печати "${file}"...`, 'info');
    try {
      await window.klipperApi.startPrint(file);
      haptic('success');
      showToast('Печать запущена!', 'success');
      switchTab('dashboard');
    } catch (err) {
      haptic('error');
      showToast(`❌ Не удалось запустить: ${err.message}`, 'error');
    }
  }

  // Safe Power Modal
  function openPowerModal() {
    haptic('warning');
    const m = document.getElementById('powerModalBackdrop');
    if (m) m.classList.add('show');
  }

  function closePowerModal() {
    haptic('light');
    const m = document.getElementById('powerModalBackdrop');
    if (m) m.classList.remove('show');
  }

  async function executeSafePowerOff() {
    haptic('warning');
    closePowerModal();
    showToast('🛡️ Безопасное выключение: охлаждение сопла...', 'info', 4000);
    try {
      await window.klipperApi.sendGcode('SAFE_POWER_OFF');
    } catch (e) {}
  }

  async function executeForcePowerOff() {
    haptic('heavy');
    closePowerModal();
    showToast('⚡ Обесточивание розетки...', 'warning');
    try {
      await window.klipperApi.sendGcode('POWER_SOCKET_OFF');
    } catch (e) {}
  }

  // =========================================================================
  // BOOTSTRAP ON DOM READY
  // =========================================================================
  function initApp() {
    // 1. Telegram SDK
    initTelegramWebApp();

    // 2. Drag & Drop Zone
    initDropZone();

    // 3. Mount 3D Bed Viewport if container & class exist
    const bedContainer = document.getElementById('bed3dContainer');
    if (bedContainer && window.Ender3DViewer) {
      try {
        window.viewer3D = new window.Ender3DViewer(bedContainer);
      } catch (err) {
        console.warn('[App] 3D Viewer init warning:', err);
      }
    }

    // 4. Mount Tapo C210 Camera HUD if container & class exist
    const cameraContainer = document.getElementById('cameraContainer');
    if (cameraContainer && window.CameraHUD) {
      try {
        window.cameraHUD = new window.CameraHUD(cameraContainer);
      } catch (err) {
        console.warn('[App] Camera HUD init warning:', err);
      }
    }

    // 5. Connect Klipper API Telemetry
    if (window.klipperApi) {
      window.klipperApi.on('telemetry', (state) => {
        renderTelemetry(state);

        // Update 3D toolhead position
        if (window.viewer3D && state.toolhead && Array.isArray(state.toolhead)) {
          window.viewer3D.updateToolPosition(state.toolhead[0], state.toolhead[1], state.toolhead[2]);
        }
      });

      window.klipperApi.on('connection', ({ connected, ws }) => {
        const badge = document.getElementById('liveStreamBadge');
        const text = document.getElementById('liveStreamText');
        if (badge && text) {
          if (connected) {
            badge.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-[10px] font-mono font-bold text-emerald-400';
            text.textContent = ws ? 'WS LIVE' : 'LIVE';
          } else {
            badge.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-500/10 border border-rose-500/30 text-[10px] font-mono font-bold text-rose-400';
            text.textContent = 'OFFLINE';
          }
        }
      });

      // Start Klipper WebSocket & polling loop
      window.klipperApi.init();
    }

    // 6. Preload G-code Catalog
    loadFilesCatalog();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }

  // =========================================================================
  // EXPORT GLOBAL HANDLERS TO WINDOW SCOPE
  // =========================================================================
  window.haptic = haptic;
  window.triggerHaptic = triggerHaptic;
  window.showToast = showToast;
  window.switchTab = switchTab;
  window.switchViewportSubTab = switchViewportSubTab;
  window.preheat = preheat;
  window.adjustZOffset = adjustZOffset;
  window.setFanSpeed = setFanSpeed;
  window.setSpeedFactor = setSpeedFactor;
  window.setJogStep = setJogStep;
  window.jogMove = jogMove;
  window.homeAxes = homeAxes;
  window.extrudeFilament = extrudeFilament;
  window.runBedMeshCalibrate = runBedMeshCalibrate;
  window.runScrewsTiltCalculate = runScrewsTiltCalculate;
  window.loadFilesCatalog = loadFilesCatalog;
  window.filterFilesList = filterFilesList;
  window.clearFileSearch = clearFileSearch;
  window.triggerFileInput = triggerFileInput;
  window.handleFileSelect = handleFileSelect;
  window.captureCameraSnapshot = captureCameraSnapshot;
  window.toggleCameraNightMode = toggleCameraNightMode;
  window.refreshCameraStream = refreshCameraStream;
  window.toggleCameraFullscreen = toggleCameraFullscreen;
  window.reset3DView = reset3DView;
  window.centerNozzle3D = centerNozzle3D;
  window.toggleBedGrid3D = toggleBedGrid3D;
  window.toggleLight = toggleLight;
  window.manualRefreshTelemetry = manualRefreshTelemetry;
  window.pausePrint = pausePrint;
  window.resumePrint = resumePrint;
  window.openStopModal = openStopModal;
  window.closeStopModal = closeStopModal;
  window.confirmStopPrint = confirmStopPrint;
  window.openStartModal = openStartModal;
  window.closeStartModal = closeStartModal;
  window.confirmStartPrint = confirmStartPrint;
  window.openPowerModal = openPowerModal;
  window.closePowerModal = closePowerModal;
  window.executeSafePowerOff = executeSafePowerOff;
  window.executeForcePowerOff = executeForcePowerOff;

})(window, document);
