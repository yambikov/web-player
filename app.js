/* global videojs */

(function () {
  'use strict';

  // ===========================================================================
  // Constants & utilities
  // ===========================================================================

  const STORAGE_KEY = 'web-player.session.v1';
  const MANIFEST_PATH = 'data/index.json';
  const SKIP_SECONDS = 10;
  const DOUBLE_TAP_MS = 350;
  const SAVE_THROTTLE_MS = 4000;
  const RESTORE_LOOKBACK_SECONDS = 2;
  const RESTART_THRESHOLD_RATIO = 0.95;
  const IMMERSIVE_CONTROLS_HIDE_MS = 2500;

  const isIOS = (() => {
    const ua = navigator.userAgent || '';
    const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    return /iPad|iPhone|iPod/.test(ua) || iPadOS;
  })();

  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  const $ = (sel, root = document) => root.querySelector(sel);

  function throttle(fn, wait) {
    let last = 0;
    let timer = null;
    return function (...args) {
      const now = Date.now();
      const remaining = wait - (now - last);
      if (remaining <= 0) {
        if (timer) { clearTimeout(timer); timer = null; }
        last = now;
        fn.apply(this, args);
      } else if (!timer) {
        timer = setTimeout(() => {
          last = Date.now();
          timer = null;
          fn.apply(this, args);
        }, remaining);
      }
    };
  }

  function formatMMSS(totalSec) {
    if (!Number.isFinite(totalSec) || totalSec < 0) totalSec = 0;
    const m = Math.floor(totalSec / 60);
    const s = Math.floor(totalSec % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  function pad2(n) { return n.toString().padStart(2, '0'); }

  const ICONS = {
    play: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.55.83l10-6.5a1 1 0 0 0 0-1.66l-10-6.5A1 1 0 0 0 8 5.5z"/></svg>',
    pause: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M6 5h4v14H6V5zm8 0h4v14h-4V5z"/></svg>',
    moon: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M21.64 13a1 1 0 0 0-1.05-.14 8.05 8.05 0 0 1-3.37.73 8.15 8.15 0 0 1-8.14-8.1 8.59 8.59 0 0 1 .25-2 1 1 0 0 0-.32-1A1 1 0 0 0 8 2.36a10.14 10.14 0 1 0 14 11.69 1 1 0 0 0-.36-1.05z"/></svg>',
    airplay: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h4v-2H3V5h18v12h-4v2h4c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM6 21h12l-6-6-6 6z"/></svg>',
    fsEnter: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M5 5h5V3H3v7h2V5zm9-2v2h5v5h2V3h-7zM5 14H3v7h7v-2H5v-5zm14 5h-5v2h7v-7h-2v5z"/></svg>',
    fsExit: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>',
    pipEnter: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z"/></svg>',
    pipExit: '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H3V5h18v14h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-4 12H9V7h8v8z"/></svg>',
  };

  function isStandalonePWA() {
    return window.navigator.standalone === true
      || window.matchMedia('(display-mode: standalone)').matches;
  }

  function isPiPSupported() {
    if (isStandalonePWA()) return false;
    return document.pictureInPictureEnabled !== false
      && typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function';
  }

  function getPlayerVideoEl(player) {
    return player.tech({ IWillNotUseThisInPlugins: true }).el();
  }

  function stripButtonTitle(el) {
    if (el) el.removeAttribute('title');
  }

  function setAriaPressed(el, pressed) {
    if (el) el.setAttribute('aria-pressed', String(Boolean(pressed)));
  }

  /** Hide Video.js font icon and mount custom graphic as sibling */
  function hideDefaultIcon(el) {
    if (!el) return;
    el.classList.add('has-custom-icon');
    const native = el.querySelector('.vjs-icon-placeholder');
    if (native) native.classList.add('ctrl-btn__native-icon');
  }

  function mountControlGraphic(component, html) {
    const el = component.el();
    if (!el) return null;
    hideDefaultIcon(el);
    let graphic = el.querySelector(':scope > .ctrl-btn__graphic');
    if (!graphic) {
      graphic = document.createElement('span');
      graphic.className = 'ctrl-btn__graphic';
      graphic.setAttribute('aria-hidden', 'true');
      el.insertBefore(graphic, el.firstChild);
    }
    graphic.innerHTML = html;
    return graphic;
  }

  function mountControlLabel(component, text) {
    const el = component.el();
    if (!el) return null;
    hideDefaultIcon(el);
    let label = el.querySelector(':scope > .ctrl-btn__label');
    if (!label) {
      label = document.createElement('span');
      label.className = 'ctrl-btn__label';
      label.setAttribute('aria-hidden', 'true');
      el.insertBefore(label, el.firstChild);
    }
    label.textContent = text;
    return label;
  }

  function decorateIconButton(component) {
    component.el().classList.add('ctrl-btn--icon');
    stripButtonTitle(component.el());
    return component.el();
  }

  function decoratePillButton(component) {
    component.el().classList.add('ctrl-btn--pill');
    stripButtonTitle(component.el());
    return component.el();
  }

  function watchTitleStrip(el) {
    if (!el || el._titleObserver) return;
    const observer = new MutationObserver(() => stripButtonTitle(el));
    observer.observe(el, { attributes: true, attributeFilter: ['title'] });
    el._titleObserver = observer;
  }

  // ===========================================================================
  // SessionStore — persists current series, episode, position and prefs
  // ===========================================================================

  const SessionStore = {
    read() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        return JSON.parse(raw) || {};
      } catch (_e) {
        return {};
      }
    },
    write(patch) {
      try {
        const current = this.read();
        const next = { ...current, ...patch, updatedAt: Date.now() };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (_e) { /* quota / privacy mode */ }
    },
    update(patch) { this.write(patch); },
    markEpisodeWatched(slug, episodeId) {
      const data = this.read();
      const watched = data.watched || {};
      const list = new Set(watched[slug] || []);
      list.add(episodeId);
      watched[slug] = Array.from(list);
      this.write({ watched });
    },
    isWatched(slug, episodeId) {
      const data = this.read();
      return Boolean(data.watched && data.watched[slug] && data.watched[slug].includes(episodeId));
    },
  };

  // ===========================================================================
  // Data loading
  // ===========================================================================

  async function loadJSON(path) {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
    return res.json();
  }

  async function loadManifest() {
    const manifest = await loadJSON(MANIFEST_PATH);
    if (!manifest || !Array.isArray(manifest.series) || !manifest.series.length) {
      throw new Error('Empty or invalid manifest');
    }
    return manifest;
  }

  async function loadSeriesData(series) {
    const seasons = await loadJSON(series.dataPath);
    const flat = [];
    seasons.forEach(season => {
      const seasonNum = season.season;
      (season.episodes || []).forEach((ep, idx) => {
        flat.push({
          ...ep,
          season: seasonNum,
          indexInSeason: idx,
          code: `S${pad2(seasonNum)}E${pad2(idx + 1)}`,
        });
      });
    });
    return { seasons, flat };
  }

  // ===========================================================================
  // Custom Video.js components
  // ===========================================================================

  function registerCustomComponents() {
    const Button = videojs.getComponent('Button');

    class SleepTimerButton extends Button {
      constructor(player, options) {
        super(player, options);
        this.controlText('Таймер сна');
        this.addClass('vjs-sleep-button');
        decoratePillButton(this);
        this.graphicEl_ = mountControlGraphic(this, ICONS.moon);
        this.countdownEl_ = videojs.dom.createEl('span', { className: 'vjs-sleep-countdown' });
        this.countdownEl_.hidden = true;
        this.countdownEl_.setAttribute('aria-hidden', 'true');
        this.el().appendChild(this.countdownEl_);
        watchTitleStrip(this.el());
      }
      handleClick() {
        const rect = this.el().getBoundingClientRect();
        document.dispatchEvent(new CustomEvent('player:open-sleep', {
          detail: { x: rect.left, y: rect.top, width: rect.width },
        }));
      }
      setCountdown(seconds) {
        if (seconds > 0) {
          const label = formatMMSS(seconds);
          this.addClass('is-active');
          this.countdownEl_.textContent = label;
          this.countdownEl_.hidden = false;
          if (this.graphicEl_) this.graphicEl_.hidden = true;
          this.controlText(`Таймер сна: ${label}`);
        } else {
          this.removeClass('is-active');
          this.countdownEl_.textContent = '';
          this.countdownEl_.hidden = true;
          if (this.graphicEl_) this.graphicEl_.hidden = false;
          this.controlText('Таймер сна');
        }
        stripButtonTitle(this.el());
      }
    }

    class AutoNextToggle extends Button {
      constructor(player, options) {
        super(player, options);
        this.controlText('Автозапуск выключен');
        this.addClass('vjs-autonext-button');
        decoratePillButton(this);
        mountControlLabel(this, 'AUTO');
        setAriaPressed(this.el(), false);
        watchTitleStrip(this.el());
      }
      handleClick() {
        document.dispatchEvent(new CustomEvent('player:toggle-autonext'));
      }
      setOn(on) {
        this.toggleClass('is-active', Boolean(on));
        setAriaPressed(this.el(), on);
        this.controlText(on ? 'Автозапуск включён' : 'Автозапуск выключен');
        stripButtonTitle(this.el());
      }
    }

    class AirPlayButton extends Button {
      constructor(player, options) {
        super(player, options);
        this.controlText('AirPlay');
        this.addClass('vjs-airplay-button');
        decorateIconButton(this);
        mountControlGraphic(this, ICONS.airplay);
        watchTitleStrip(this.el());
      }
      handleClick() {
        const video = this.player_.tech({ IWillNotUseThisInPlugins: true }).el();
        if (video && typeof video.webkitShowPlaybackTargetPicker === 'function') {
          try { video.webkitShowPlaybackTargetPicker(); } catch (_e) { /* noop */ }
        }
      }
    }

    class PictureInPictureButton extends Button {
      constructor(player, options) {
        super(player, options);
        this.controlText('Картинка в картинке');
        this.addClass('vjs-pip-button');
        decorateIconButton(this);
        this.graphicEl_ = mountControlGraphic(this, ICONS.pipEnter);
        setAriaPressed(this.el(), false);
        watchTitleStrip(this.el());
      }
      handleClick() {
        document.dispatchEvent(new CustomEvent('player:toggle-pip'));
      }
      setActive(on) {
        this.toggleClass('is-active', Boolean(on));
        setAriaPressed(this.el(), on);
        if (this.graphicEl_) {
          this.graphicEl_.innerHTML = on ? ICONS.pipExit : ICONS.pipEnter;
        }
        this.controlText(on ? 'Выйти из режима «картинка в картинке»' : 'Картинка в картинке');
        stripButtonTitle(this.el());
      }
    }

    class CustomFullscreenButton extends Button {
      constructor(player, options) {
        super(player, options);
        this.controlText('Полноэкранный режим');
        this.addClass('vjs-fs-button');
        decorateIconButton(this);
        this.graphicEl_ = mountControlGraphic(this, ICONS.fsEnter);
        setAriaPressed(this.el(), false);
        watchTitleStrip(this.el());
      }
      handleClick() {
        document.dispatchEvent(new CustomEvent('player:toggle-fullscreen'));
      }
      setExpanded(on) {
        this.toggleClass('is-active', Boolean(on));
        setAriaPressed(this.el(), on);
        if (this.graphicEl_) {
          this.graphicEl_.innerHTML = on ? ICONS.fsExit : ICONS.fsEnter;
        }
        this.controlText(on ? 'Выйти из полноэкранного режима' : 'Полноэкранный режим');
        stripButtonTitle(this.el());
      }
    }

    videojs.registerComponent('SleepTimerButton', SleepTimerButton);
    videojs.registerComponent('AutoNextToggle', AutoNextToggle);
    videojs.registerComponent('AirPlayButton', AirPlayButton);
    videojs.registerComponent('PictureInPictureButton', PictureInPictureButton);
    videojs.registerComponent('CustomFullscreenButton', CustomFullscreenButton);
  }

  function setupPlayButtonA11y(player) {
    const playBtn = player.controlBar.getChild('playToggle');
    if (!playBtn) return;

    decorateIconButton(playBtn);
    const graphicEl = mountControlGraphic(playBtn, ICONS.play);

    function sync() {
      const el = playBtn.el();
      const playing = !player.paused() && !player.ended();
      if (graphicEl) {
        graphicEl.innerHTML = playing ? ICONS.pause : ICONS.play;
      }
      playBtn.controlText(playing ? 'Пауза' : 'Воспроизвести');
      setAriaPressed(el, playing);
      stripButtonTitle(el);
    }

    player.on('play', sync);
    player.on('pause', sync);
    player.on('ended', sync);
    sync();
    watchTitleStrip(playBtn.el());
  }

  // ===========================================================================
  // App state & controllers
  // ===========================================================================

  const App = {
    manifest: null,
    currentSeries: null,
    currentSeriesData: null,
    currentEpisodeIndex: -1,
    player: null,

    sleepTimerId: null,
    sleepEndsAt: 0,
    sleepCountdownId: null,
    sleepTimerButton: null,
    autoNextEnabled: false,
    autoNextComponent: null,

    elements: {
      serialBtn: $('#serialBtn'),
      episodeBtn: $('#episodeBtn'),
      serialTitle: $('#serialTitle'),
      episodeCode: $('#episodeCode'),
      episodeName: $('#episodeName'),
      statusLine: $('#statusLine'),

      seriesSheet: $('#seriesSheet'),
      seriesList: $('#seriesList'),
      seasons: $('#seasons'),
      seriesDropdown: $('#seriesDropdown'),

      sleepPopover: $('#sleepPopover'),

      tapOverlay: $('#tapOverlay'),
      tapFbLeft: $('#tapFbLeft'),
      tapFbRight: $('#tapFbRight'),
      centerPlayBtn: $('#centerPlayBtn'),

      errorOverlay: $('#errorOverlay'),
      errorHint: $('#errorHint'),
      retryBtn: $('#retryBtn'),

      finishedOverlay: $('#finishedOverlay'),
      finishedChooseBtn: $('#finishedChooseBtn'),
      finishedRestartBtn: $('#finishedRestartBtn'),

      app: document.querySelector('.app'),
      playerStage: document.querySelector('.player-stage'),
    },

    fsCustomButton: null,
    pipButton: null,
    isFullWindow: false,
    isIOSNativeFullscreen: false,
    dockedControlsHeightSync: null,
  };

  // ===========================================================================
  // Player initialization
  // ===========================================================================

  function initPlayer() {
    registerCustomComponents();

    const player = videojs('player', {
      controls: true,
      preload: 'metadata',
      playsinline: true,
      fluid: false,
      fill: true,
      bigPlayButton: false,
      inactivityTimeout: 0,
      controlBar: {
        children: [
          'playToggle',
          'progressControl',
          'currentTimeDisplay',
          'timeDivider',
          'remainingTimeDisplay',
          'SleepTimerButton',
          'AutoNextToggle',
          ...(isIOS ? ['AirPlayButton'] : []),
          ...(isPiPSupported() ? ['PictureInPictureButton'] : []),
          'CustomFullscreenButton',
        ],
        volumePanel: false,
        pictureInPictureToggle: false,
      },
      html5: {
        nativeTextTracks: false,
        nativeAudioTracks: false,
        vhs: { overrideNative: !isSafari },
        nativeControlsForTouch: false,
      },
      userActions: {
        // Disable single-click toggle on the player so our tap overlay handles play/pause
        click: false,
        doubleClick: false,
      },
    });

    App.player = player;
    App.sleepTimerButton = player.controlBar.getChild('SleepTimerButton');
    App.autoNextComponent = player.controlBar.getChild('AutoNextToggle');
    App.fsCustomButton = player.controlBar.getChild('CustomFullscreenButton');
    App.pipButton = player.controlBar.getChild('PictureInPictureButton');

    setupPlayButtonA11y(player);
    setupPictureInPicture(player);
    setupIOSNativeFullscreen(player);
    setupImmersiveControlHooks(player);
    setupDockedControlsHeightSync(player);
    player.one('ready', () => setupPlayButtonA11y(player));

    // Force inline playback on iOS (extra safety)
    const techEl = player.tech({ IWillNotUseThisInPlugins: true }).el();
    if (techEl) {
      techEl.setAttribute('playsinline', '');
      techEl.setAttribute('webkit-playsinline', '');
      techEl.setAttribute('x5-playsinline', '');
      techEl.disableRemotePlayback = false;
    }

    // Player events
    player.on('error', () => showError(player.error()?.message));
    player.on('ended', onEpisodeEnded);
    player.on('play', () => updateCenterPlay());
    player.on('pause', () => updateCenterPlay());
    player.on('loadstart', () => updateCenterPlay());
    player.on('fullscreenchange', () => {
      if (App.fsCustomButton) {
        App.fsCustomButton.setExpanded(
          player.isFullscreen() || App.isFullWindow || App.isIOSNativeFullscreen
        );
      }
    });

    const saveProgressThrottled = throttle(saveProgress, SAVE_THROTTLE_MS);
    player.on('timeupdate', saveProgressThrottled);
    player.on('pause', saveProgress);
    player.on('seeked', saveProgress);
    player.on('volumechange', () => {
      SessionStore.update({
        volume: player.volume(),
        muted: player.muted(),
      });
    });
    window.addEventListener('beforeunload', saveProgress);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveProgress();
    });

    // Hook AirPlay availability for iOS
    if (isIOS && techEl) {
      const airBtn = player.controlBar.getChild('AirPlayButton');
      if (airBtn) airBtn.hide();
      techEl.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => {
        if (!airBtn) return;
        if (e.availability === 'available') airBtn.show(); else airBtn.hide();
      });
    } else {
      const airBtn = player.controlBar.getChild('AirPlayButton');
      if (airBtn) airBtn.hide();
    }

    syncImmersiveMode();
    return player;
  }

  function isImmersiveControlsMode() {
    return (App.isFullWindow || isAppFullscreen()) && !App.isIOSNativeFullscreen;
  }

  let immersiveControlsTimer = null;

  function clearImmersiveControlsTimer() {
    if (immersiveControlsTimer !== null) {
      clearTimeout(immersiveControlsTimer);
      immersiveControlsTimer = null;
    }
  }

  function setImmersiveControlsVisible(visible) {
    const player = App.player;
    if (!player) return;
    player.toggleClass('vjs-user-active', visible);
    player.toggleClass('vjs-user-inactive', !visible);
  }

  function scheduleImmersiveControlsHide() {
    clearImmersiveControlsTimer();
    if (!isImmersiveControlsMode() || !App.player) return;

    const player = App.player;
    if (player.paused() || player.ended()) {
      setImmersiveControlsVisible(true);
      return;
    }

    immersiveControlsTimer = setTimeout(() => {
      immersiveControlsTimer = null;
      if (!isImmersiveControlsMode() || !App.player) return;
      if (App.player.paused() || App.player.ended()) return;
      setImmersiveControlsVisible(false);
    }, IMMERSIVE_CONTROLS_HIDE_MS);
  }

  function bumpImmersiveControlsActivity() {
    if (!isImmersiveControlsMode() || !App.player) return;
    setImmersiveControlsVisible(true);
    scheduleImmersiveControlsHide();
  }

  function syncImmersiveControls() {
    if (!App.player) return;

    if (isImmersiveControlsMode()) {
      setImmersiveControlsVisible(true);
      scheduleImmersiveControlsHide();
    } else {
      clearImmersiveControlsTimer();
      setImmersiveControlsVisible(true);
    }
  }

  function setupImmersiveControlAutoHide() {
    const stage = App.elements.playerStage;
    if (!stage) return;

    const onActivity = throttle(() => {
      bumpImmersiveControlsActivity();
    }, 150);

    stage.addEventListener('mousemove', onActivity);
    stage.addEventListener('touchstart', onActivity, { passive: true });
  }

  function setupImmersiveControlHooks(player) {
    player.on('play', () => {
      if (isImmersiveControlsMode()) scheduleImmersiveControlsHide();
    });
    player.on('pause', () => {
      if (isImmersiveControlsMode()) {
        clearImmersiveControlsTimer();
        setImmersiveControlsVisible(true);
      }
    });
    player.on('useractive', () => {
      if (isImmersiveControlsMode()) scheduleImmersiveControlsHide();
    });
  }

  function setupDockedControlsHeightSync(player) {
    const stage = App.elements.playerStage;
    if (!stage) return;

    let controlBarEl = null;
    let observer = null;

    function syncDockedControlsHeight() {
      if (!stage.classList.contains('is-docked-controls')) {
        stage.style.removeProperty('--docked-controls-height');
        return;
      }

      const bar = controlBarEl || player.controlBar?.el?.();
      if (!bar) return;

      const height = Math.ceil(bar.getBoundingClientRect().height);
      if (height > 0) {
        stage.style.setProperty('--docked-controls-height', `${height}px`);
      }
    }

    function attach() {
      controlBarEl = player.controlBar?.el?.() || null;
      if (!controlBarEl) return;

      if (observer) observer.disconnect();
      observer = new ResizeObserver(syncDockedControlsHeight);
      observer.observe(controlBarEl);
      syncDockedControlsHeight();
    }

    player.ready(attach);
    player.on('resize', syncDockedControlsHeight);
    window.addEventListener('resize', syncDockedControlsHeight);

    App.dockedControlsHeightSync = syncDockedControlsHeight;
  }

  // ===========================================================================
  // Episode loading & UI updates
  // ===========================================================================

  function setStatus(text) {
    if (!text) {
      App.elements.statusLine.hidden = true;
      App.elements.statusLine.textContent = '';
    } else {
      App.elements.statusLine.hidden = false;
      App.elements.statusLine.textContent = text;
    }
  }

  function updateEpisodeInfo(episode) {
    App.elements.serialTitle.textContent = App.currentSeries.title;
    if (!episode) {
      App.elements.episodeCode.textContent = '—';
      App.elements.episodeName.textContent = '—';
      return;
    }
    App.elements.episodeCode.textContent = episode.code;
    App.elements.episodeName.textContent = episode.name || '';
  }

  function loadEpisode(index, { autoplay = false, startAt = 0 } = {}) {
    const list = App.currentSeriesData.flat;
    if (index < 0 || index >= list.length) return;

    App.currentEpisodeIndex = index;
    const ep = list[index];

    hideError();
    hideFinished();
    setStatus('');

    updateEpisodeInfo(ep);

    App.player.src({ src: ep.url, type: 'video/mp4' });
    App.player.one('loadedmetadata', () => {
      if (startAt > 0) {
        const duration = App.player.duration() || 0;
        const target = Math.min(Math.max(0, startAt), Math.max(0, duration - 1));
        App.player.currentTime(target);
      }
      if (autoplay) {
        const p = App.player.play();
        if (p && typeof p.catch === 'function') p.catch(() => { /* autoplay blocked */ });
      }
    });

    SessionStore.update({
      slug: App.currentSeries.slug,
      episodeId: ep.id,
      season: ep.season,
      indexInSeason: ep.indexInSeason,
      currentTime: startAt,
    });

    refreshEpisodesUI();
  }

  function saveProgress() {
    if (!App.player || App.currentEpisodeIndex < 0) return;
    const ep = App.currentSeriesData.flat[App.currentEpisodeIndex];
    if (!ep) return;
    const t = App.player.currentTime() || 0;
    SessionStore.update({
      slug: App.currentSeries.slug,
      episodeId: ep.id,
      season: ep.season,
      currentTime: t,
    });
  }

  function onEpisodeEnded() {
    const ep = App.currentSeriesData.flat[App.currentEpisodeIndex];
    if (ep) SessionStore.markEpisodeWatched(App.currentSeries.slug, ep.id);

    if (!App.autoNextEnabled) {
      refreshEpisodesUI();
      return;
    }

    const nextIdx = App.currentEpisodeIndex + 1;
    if (nextIdx >= App.currentSeriesData.flat.length) {
      setStatus('Сериал завершён');
      showFinished();
      return;
    }
    loadEpisode(nextIdx, { autoplay: true });
  }

  // ===========================================================================
  // Series & episode UI (bottom sheet)
  // ===========================================================================

  function renderSeasons() {
    const root = App.elements.seasons;
    root.innerHTML = '';
    if (!App.currentSeriesData) return;

    const currentEp = App.currentSeriesData.flat[App.currentEpisodeIndex];

    App.currentSeriesData.seasons.forEach((season) => {
      const seasonEl = document.createElement('div');
      seasonEl.className = 'season';

      const isCurrentSeason = currentEp && currentEp.season === season.season;
      if (isCurrentSeason) seasonEl.classList.add('is-open');

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'season__header';
      header.innerHTML = `
        <span>Сезон ${season.season}</span>
        <span class="season__chevron" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
        </span>
      `;
      header.addEventListener('click', () => seasonEl.classList.toggle('is-open'));
      seasonEl.appendChild(header);

      const listEl = document.createElement('div');
      listEl.className = 'season__list';

      season.episodes.forEach((ep, idx) => {
        const code = `S${pad2(season.season)}E${pad2(idx + 1)}`;
        const flatIndex = App.currentSeriesData.flat.findIndex(e => e.id === ep.id);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'episode ui-list-item';
        btn.dataset.flatIndex = String(flatIndex);

        const isCurrent = currentEp && currentEp.id === ep.id;
        const isWatched = SessionStore.isWatched(App.currentSeries.slug, ep.id);
        if (isCurrent) btn.classList.add('is-current');
        if (isWatched && !isCurrent) btn.classList.add('is-watched');

        let badge = '';
        if (isCurrent) badge = `<span class="episode__badge">Сейчас</span>`;
        else if (isWatched) badge = `<span class="episode__badge episode__badge--watched">Просмотрено</span>`;

        btn.innerHTML = `
          <span class="episode__code">${code}</span>
          <span class="episode__name">${escapeHtml(ep.name || '')}</span>
          ${badge}
        `;
        btn.addEventListener('click', () => onEpisodePicked(flatIndex));
        listEl.appendChild(btn);
      });

      seasonEl.appendChild(listEl);
      root.appendChild(seasonEl);
    });
  }

  function refreshEpisodesUI() {
    if (!App.elements.seriesSheet.hidden) {
      renderSeasons();
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ===========================================================================
  // Bottom sheet open/close (episodes)
  // ===========================================================================

  function openSheet() {
    hideFinished();
    renderSeasons();
    App.elements.seriesSheet.hidden = false;
    document.documentElement.style.overflow = 'hidden';
  }
  function closeSheet() {
    App.elements.seriesSheet.hidden = true;
    document.documentElement.style.overflow = '';
  }

  // ===========================================================================
  // Series dropdown
  // ===========================================================================

  function renderSeriesDropdown() {
    const dd = App.elements.seriesDropdown;
    if (!dd || !App.manifest) return;
    dd.innerHTML = '';
    App.manifest.series.forEach(s => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'dropdown__item ui-list-item';
      item.dataset.slug = s.slug;
      item.setAttribute('role', 'option');
      const isActive = App.currentSeries && App.currentSeries.slug === s.slug;
      item.classList.toggle('is-active', Boolean(isActive));
      item.innerHTML = `
        <span class="dropdown__title">${escapeHtml(s.title)}</span>
        <span class="dropdown__check" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>
        </span>
      `;
      item.addEventListener('click', () => {
        closeSeriesDropdown();
        if (App.currentSeries && App.currentSeries.slug === s.slug) return;
        onSeriesPicked(s);
      });
      dd.appendChild(item);
    });
  }

  function openSeriesDropdown() {
    const dd = App.elements.seriesDropdown;
    const btn = App.elements.serialBtn;
    if (!dd || !btn) return;
    renderSeriesDropdown();
    dd.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    // Position right under the trigger
    const r = btn.getBoundingClientRect();
    const top = r.bottom + 6;
    const minWidth = Math.max(220, r.width);
    dd.style.left = `${Math.max(8, r.left)}px`;
    dd.style.top = `${top}px`;
    dd.style.minWidth = `${minWidth}px`;
    dd.style.maxWidth = `${Math.min(window.innerWidth - 16, 360)}px`;
  }

  function closeSeriesDropdown() {
    const dd = App.elements.seriesDropdown;
    const btn = App.elements.serialBtn;
    if (dd) dd.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  async function onSeriesPicked(series) {
    if (App.currentSeries && App.currentSeries.slug === series.slug) {
      // Same series — keep open to choose episode
      return;
    }
    try {
      App.currentSeries = series;
      App.currentSeriesData = await loadSeriesData(series);

      // Load last watched in this series, or first episode
      const stored = SessionStore.read();
      let startIndex = 0;
      let startAt = 0;
      if (stored.slug === series.slug && stored.episodeId) {
        const idx = App.currentSeriesData.flat.findIndex(e => e.id === stored.episodeId);
        if (idx >= 0) {
          startIndex = idx;
          startAt = Math.max(0, (stored.currentTime || 0) - RESTORE_LOOKBACK_SECONDS);
        }
      }
      loadEpisode(startIndex, { startAt });
      renderSeasons();
    } catch (e) {
      showError(`Не удалось загрузить «${series.title}»`);
    }
  }

  function onEpisodePicked(flatIndex) {
    if (flatIndex < 0) return;
    closeSheet();
    loadEpisode(flatIndex, { autoplay: true });
  }

  // ===========================================================================
  // Tap overlay (left/center/right)
  // ===========================================================================

  function setupTapOverlay() {
    const overlay = App.elements.tapOverlay;
    let pointerDownInfo = null;
    let sideTapState = null;
    let lastSeekAt = 0;

    function bumpPlayerActivity() {
      const player = App.player;
      if (!player) return;
      try {
        if (isImmersiveControlsMode()) bumpImmersiveControlsActivity();
        else player.userActive(true);
      } catch (_e) { /* noop */ }
    }

    function togglePlayPause() {
      const player = App.player;
      if (!player) return;
      bumpPlayerActivity();
      if (player.paused()) {
        const p = player.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } else {
        player.pause();
      }
    }

    function seekSide(zone) {
      const now = Date.now();
      if (now - lastSeekAt < 120) return;
      lastSeekAt = now;

      const player = App.player;
      if (!player) return;
      bumpPlayerActivity();

      const dur = player.duration() || 0;
      const cur = player.currentTime() || 0;
      if (zone === 'left') {
        player.currentTime(Math.max(0, cur - SKIP_SECONDS));
        showTapFeedback('left');
      } else if (zone === 'right') {
        const target = dur > 0 ? Math.min(dur, cur + SKIP_SECONDS) : cur + SKIP_SECONDS;
        player.currentTime(target);
        showTapFeedback('right');
      }
    }

    function handleSideDoubleTap(zone, pointerType) {
      if (pointerType === 'mouse') return;

      const now = Date.now();
      if (sideTapState && sideTapState.zone === zone && now - sideTapState.time <= DOUBLE_TAP_MS) {
        sideTapState = null;
        seekSide(zone);
        return;
      }

      sideTapState = { zone, time: now };
      bumpPlayerActivity();
    }

    overlay.addEventListener('pointerdown', (e) => {
      const target = e.target.closest('.tap-overlay__zone');
      if (!target) return;
      pointerDownInfo = {
        x: e.clientX,
        y: e.clientY,
        zone: target.dataset.zone,
        pointerType: e.pointerType,
        t: Date.now(),
      };
    }, { passive: true });

    overlay.addEventListener('pointerup', (e) => {
      if (!pointerDownInfo) return;
      const dx = e.clientX - pointerDownInfo.x;
      const dy = e.clientY - pointerDownInfo.y;
      const dt = Date.now() - pointerDownInfo.t;
      const zone = pointerDownInfo.zone;
      const pointerType = pointerDownInfo.pointerType || e.pointerType;
      pointerDownInfo = null;

      if (Math.hypot(dx, dy) > 16 || dt > 600) return;
      if (!zone) return;

      if (zone === 'center') {
        togglePlayPause();
        return;
      }

      handleSideDoubleTap(zone, pointerType);
    }, { passive: true });

    overlay.addEventListener('dblclick', (e) => {
      const target = e.target.closest('.tap-overlay__zone');
      if (!target) return;
      const zone = target.dataset.zone;
      e.preventDefault();
      sideTapState = null;

      if (zone === 'left' || zone === 'right') {
        seekSide(zone);
      }
    });

    overlay.addEventListener('pointercancel', () => { pointerDownInfo = null; });
    overlay.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('player:tap-feedback', (e) => {
      showTapFeedback(e.detail.side);
    });
  }

  let fbTimers = { left: null, right: null };
  function showTapFeedback(side) {
    const el = side === 'left' ? App.elements.tapFbLeft : App.elements.tapFbRight;
    if (!el) return;
    el.classList.add('is-active');
    if (fbTimers[side]) clearTimeout(fbTimers[side]);
    fbTimers[side] = setTimeout(() => el.classList.remove('is-active'), 500);
  }

  // ===========================================================================
  // Sleep timer
  // ===========================================================================

  function openSleepPopover(anchor) {
    const pop = App.elements.sleepPopover;
    pop.hidden = false;
    // Position above the button
    const popRect = pop.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - popRect.width - 8, anchor.x - popRect.width / 2 + anchor.width / 2));
    const top = Math.max(8, anchor.y - popRect.height - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;

    // Highlight active
    pop.querySelectorAll('.popover__item').forEach(btn => {
      btn.classList.remove('is-active');
    });
    if (App.sleepTimerId) {
      const minutes = Math.round((App.sleepEndsAt - Date.now()) / 60000);
      const closest = [10, 20, 30, 60].find(m => m === minutes);
      if (closest) {
        const item = pop.querySelector(`[data-sleep="${closest}"]`);
        if (item) item.classList.add('is-active');
      }
    }
  }

  function closeSleepPopover() {
    App.elements.sleepPopover.hidden = true;
  }

  function setSleepTimer(minutes) {
    clearSleepTimer();
    if (minutes <= 0) return;

    App.sleepEndsAt = Date.now() + minutes * 60 * 1000;
    App.sleepTimerId = setTimeout(() => {
      if (App.player && !App.player.paused()) App.player.pause();
      clearSleepTimer();
    }, minutes * 60 * 1000);

    updateSleepCountdown();
    App.sleepCountdownId = setInterval(updateSleepCountdown, 1000);
  }

  function clearSleepTimer() {
    if (App.sleepTimerId) clearTimeout(App.sleepTimerId);
    if (App.sleepCountdownId) clearInterval(App.sleepCountdownId);
    App.sleepTimerId = null;
    App.sleepCountdownId = null;
    App.sleepEndsAt = 0;
    if (App.sleepTimerButton) App.sleepTimerButton.setCountdown(0);
  }

  function updateSleepCountdown() {
    if (!App.sleepTimerButton) return;
    if (!App.sleepEndsAt) { App.sleepTimerButton.setCountdown(0); return; }
    const remaining = Math.max(0, App.sleepEndsAt - Date.now());
    App.sleepTimerButton.setCountdown(remaining / 1000);
  }

  // ===========================================================================
  // Auto-next toggle
  // ===========================================================================

  function setAutoNext(enabled) {
    App.autoNextEnabled = enabled;
    if (App.autoNextComponent) App.autoNextComponent.setOn(enabled);
    SessionStore.update({ autoplayNext: enabled });
  }

  function toggleAutoNext() {
    setAutoNext(!App.autoNextEnabled);
  }

  // ===========================================================================
  // Error overlay
  // ===========================================================================

  let lastErrorRecoveryAttempt = 0;
  function showError(message) {
    App.elements.errorHint.textContent = message ? message : 'Проверьте интернет-соединение и попробуйте снова.';
    App.elements.errorOverlay.hidden = false;
    updateCenterPlay();
  }
  function hideError() {
    App.elements.errorOverlay.hidden = true;
    updateCenterPlay();
  }

  function retryPlayback() {
    if (!App.player || App.currentEpisodeIndex < 0) return;
    const ep = App.currentSeriesData.flat[App.currentEpisodeIndex];
    if (!ep) return;
    hideError();
    const sinceLast = Date.now() - lastErrorRecoveryAttempt;
    lastErrorRecoveryAttempt = Date.now();

    if (sinceLast > 4000) {
      // First-line retry: reload current source
      App.player.src({ src: ep.url, type: 'video/mp4' });
      const p = App.player.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } else {
      // Aggressive retry: reinitialize the player
      try { App.player.dispose(); } catch (_e) { /* noop */ }
      const wrap = document.querySelector('.player-stage');
      const old = document.getElementById('player');
      if (old) old.remove();
      const v = document.createElement('video');
      v.id = 'player';
      v.className = 'video-js vjs-default-skin vjs-big-play-centered';
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      v.setAttribute('x5-playsinline', '');
      v.setAttribute('preload', 'metadata');
      wrap.prepend(v);
      App.player = null;
      initPlayer();
      loadEpisode(App.currentEpisodeIndex, { autoplay: true });
    }
  }

  // ===========================================================================
  // Finished overlay
  // ===========================================================================

  function showFinished() { App.elements.finishedOverlay.hidden = false; updateCenterPlay(); }
  function hideFinished() { App.elements.finishedOverlay.hidden = true; updateCenterPlay(); }

  // ===========================================================================
  // Center play button (visible when paused)
  // ===========================================================================

  function updateCenterPlay() {
    const btn = App.elements.centerPlayBtn;
    if (!btn || !App.player) return;
    const player = App.player;
    const paused = player.paused();
    const ended = player.ended();
    const errorVisible = !App.elements.errorOverlay.hidden;
    const finishedVisible = !App.elements.finishedOverlay.hidden;
    let hasStarted = false;
    try { hasStarted = player.played() && player.played().length > 0; } catch (_e) { hasStarted = false; }
    btn.hidden = !paused || ended || errorVisible || finishedVisible || !hasStarted;
    btn.setAttribute('aria-label', paused ? 'Воспроизвести' : 'Пауза');
  }

  // ===========================================================================
  // Picture-in-Picture
  // ===========================================================================

  function setupPictureInPicture(player) {
    if (!isPiPSupported()) return;

    const video = getPlayerVideoEl(player);
    if (!video) return;

    const sync = () => {
      if (App.pipButton) {
        App.pipButton.setActive(document.pictureInPictureElement === video);
      }
    };

    video.addEventListener('enterpictureinpicture', sync);
    video.addEventListener('leavepictureinpicture', sync);
    sync();
  }

  async function togglePictureInPicture() {
    const player = App.player;
    if (!player || !isPiPSupported()) return;

    const video = getPlayerVideoEl(player);
    if (!video) return;

    try {
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch (_e) { /* blocked by browser policy or unsupported source */ }
  }

  // ===========================================================================
  // Fullscreen handling (iOS native player + desktop Fullscreen API)
  // ===========================================================================

  function setupIOSNativeFullscreen(player) {
    if (!isIOS) return;

    const video = getPlayerVideoEl(player);
    if (!video) return;

    video.addEventListener('webkitbeginfullscreen', () => {
      App.isIOSNativeFullscreen = true;
      syncImmersiveMode();
      if (App.fsCustomButton) App.fsCustomButton.setExpanded(true);
    });

    video.addEventListener('webkitendfullscreen', () => {
      App.isIOSNativeFullscreen = false;
      syncImmersiveMode();
      if (App.fsCustomButton) App.fsCustomButton.setExpanded(false);
    });
  }

  function enterIOSNativeFullscreen(video) {
    if (typeof video.webkitEnterFullscreen !== 'function') return false;
    try {
      video.webkitEnterFullscreen();
      return true;
    } catch (_e) {
      return false;
    }
  }

  function exitIOSNativeFullscreen(video) {
    if (typeof video.webkitExitFullscreen !== 'function') return false;
    try {
      video.webkitExitFullscreen();
      return true;
    } catch (_e) {
      return false;
    }
  }

  function syncImmersiveMode() {
    const immersive = App.isFullWindow || isInFullscreen() || App.isIOSNativeFullscreen;
    document.documentElement.classList.toggle('is-immersive', immersive);
    document.body.classList.toggle('is-immersive', immersive);
    if (App.elements.playerStage) {
      App.elements.playerStage.classList.toggle('is-docked-controls', !immersive);
    }
    syncImmersiveControls();
    if (App.dockedControlsHeightSync) App.dockedControlsHeightSync();
  }

  function enterFullWindow() {
    App.isFullWindow = true;
    App.elements.app.classList.add('is-fullwindow');
    syncImmersiveMode();
    if (App.fsCustomButton) App.fsCustomButton.setExpanded(true);
  }

  function exitFullWindow() {
    if (!App.isFullWindow) return;
    App.isFullWindow = false;
    App.elements.app.classList.remove('is-fullwindow');
    syncImmersiveMode();
    if (App.fsCustomButton && !App.isIOSNativeFullscreen && !isInFullscreen()) {
      App.fsCustomButton.setExpanded(false);
    }
  }

  function isInFullscreen() {
    return Boolean(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.webkitCurrentFullScreenElement
    );
  }

  function isAppFullscreen() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    return Boolean(
      fsEl &&
      (fsEl === App.elements.playerStage || fsEl.contains(App.elements.playerStage))
    );
  }

  function toggleFullscreen() {
    const player = App.player;
    if (!player) return;

    if (isIOS) {
      const video = getPlayerVideoEl(player);
      if (!video) return;

      if (App.isIOSNativeFullscreen) {
        exitIOSNativeFullscreen(video);
        return;
      }
      if (App.isFullWindow) {
        exitFullWindow();
        return;
      }

      if (!enterIOSNativeFullscreen(video)) {
        enterFullWindow();
      }
      return;
    }

    const fsTarget = App.elements.playerStage;
    if (!isInFullscreen()) {
      const req = fsTarget && (
        fsTarget.requestFullscreen ||
        fsTarget.webkitRequestFullscreen ||
        fsTarget.webkitRequestFullScreen
      );
      if (req) {
        try {
          req.call(fsTarget);
          return;
        } catch (_e) { /* fallback below */ }
      }
      enterFullWindow();
    } else {
      const exit = document.exitFullscreen || document.webkitExitFullscreen || document.webkitCancelFullScreen;
      if (exit) {
        try { exit.call(document); } catch (_e) { /* noop */ }
      }
    }
  }

  // Keep CSS class in sync with native fullscreen events
  function attachFullscreenListeners() {
    const sync = () => {
      const isFs = isAppFullscreen();
      App.elements.app.classList.toggle('is-fullscreen', isFs);
      syncImmersiveMode();
      if (App.fsCustomButton) {
        App.fsCustomButton.setExpanded(isFs || App.isFullWindow || App.isIOSNativeFullscreen);
      }
    };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
  }

  // ===========================================================================
  // Wire up DOM events
  // ===========================================================================

  function wireUI() {
    App.elements.serialBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (App.elements.seriesDropdown.hidden) openSeriesDropdown(); else closeSeriesDropdown();
    });
    if (App.elements.episodeBtn) {
      App.elements.episodeBtn.addEventListener('click', () => openSheet());
    }
    App.elements.seriesSheet.addEventListener('click', (e) => {
      if (e.target.closest('[data-close-sheet]')) closeSheet();
    });

    if (App.elements.centerPlayBtn) {
      App.elements.centerPlayBtn.addEventListener('click', () => {
        if (!App.player) return;
        const p = App.player.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      });
    }

    document.addEventListener('player:toggle-fullscreen', toggleFullscreen);
    document.addEventListener('player:toggle-pip', () => { togglePictureInPicture(); });
    attachFullscreenListeners();
    setupImmersiveControlAutoHide();

    // Click-outside for the series dropdown
    document.addEventListener('click', (e) => {
      if (App.elements.seriesDropdown.hidden) return;
      if (e.target.closest('#seriesDropdown') || e.target.closest('#serialBtn')) return;
      closeSeriesDropdown();
    });
    window.addEventListener('resize', () => {
      if (!App.elements.seriesDropdown.hidden) openSeriesDropdown();
    });

    if (App.elements.retryBtn) {
      App.elements.retryBtn.addEventListener('click', retryPlayback);
    }
    if (App.elements.finishedChooseBtn) {
      App.elements.finishedChooseBtn.addEventListener('click', () => {
        hideFinished();
        setStatus('');
        openSheet();
      });
    }
    if (App.elements.finishedRestartBtn) {
      App.elements.finishedRestartBtn.addEventListener('click', () => {
        hideFinished();
        setStatus('');
        if (App.currentEpisodeIndex >= 0) {
          loadEpisode(App.currentEpisodeIndex, { autoplay: true, startAt: 0 });
        }
      });
    }

    App.elements.sleepPopover.addEventListener('click', (e) => {
      const item = e.target.closest('.popover__item');
      if (!item) return;
      const minutes = parseInt(item.dataset.sleep, 10);
      setSleepTimer(minutes);
      closeSleepPopover();
    });

    document.addEventListener('click', (e) => {
      if (!App.elements.sleepPopover.hidden) {
        if (!e.target.closest('#sleepPopover') && !e.target.closest('.vjs-sleep-button')) {
          closeSleepPopover();
        }
      }
    }, true);

    document.addEventListener('player:open-sleep', (e) => {
      const pop = App.elements.sleepPopover;
      if (!pop.hidden) { closeSleepPopover(); return; }
      openSleepPopover(e.detail);
    });

    document.addEventListener('player:toggle-autonext', toggleAutoNext);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!App.elements.seriesSheet.hidden) closeSheet();
        if (!App.elements.sleepPopover.hidden) closeSleepPopover();
        if (!App.elements.seriesDropdown.hidden) closeSeriesDropdown();
        if (App.isFullWindow || App.isIOSNativeFullscreen || isAppFullscreen()) toggleFullscreen();
      }
    });
  }

  // ===========================================================================
  // Bootstrap
  // ===========================================================================

  async function bootstrap() {
    initPlayer();
    setupTapOverlay();
    wireUI();

    let manifest;
    try {
      manifest = await loadManifest();
    } catch (e) {
      showError('Не удалось загрузить список сериалов');
      return;
    }
    App.manifest = manifest;

    // Restore previous session, fall back to default
    const stored = SessionStore.read();
    const slug = stored.slug || manifest.defaultSlug;
    const series = manifest.series.find(s => s.slug === slug) || manifest.series[0];

    // Restore prefs
    if (typeof stored.volume === 'number') App.player.volume(stored.volume);
    if (typeof stored.muted === 'boolean') App.player.muted(stored.muted);
    setAutoNext(Boolean(stored.autoplayNext));

    try {
      App.currentSeries = series;
      App.currentSeriesData = await loadSeriesData(series);
    } catch (e) {
      showError(`Не удалось загрузить «${series.title}»`);
      return;
    }

    let startIndex = 0;
    let startAt = 0;
    if (stored.slug === series.slug && stored.episodeId) {
      const idx = App.currentSeriesData.flat.findIndex(e => e.id === stored.episodeId);
      if (idx >= 0) {
        startIndex = idx;
        const dur = stored.currentTime || 0;
        startAt = Math.max(0, dur - RESTORE_LOOKBACK_SECONDS);
        // If close to the end, restart from the beginning
        if (typeof stored.duration === 'number' && stored.duration > 0) {
          if (dur / stored.duration > RESTART_THRESHOLD_RATIO) startAt = 0;
        }
      }
    }

    loadEpisode(startIndex, { startAt, autoplay: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
